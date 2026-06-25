import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import process from 'process';
import cors from 'cors';
import path from 'path';
import { pathToFileURL } from 'url';

// ==========================================
// LOGGER & TERMINAL INTERCEPTOR
// ==========================================
const MAX_LOG_HISTORY = 100;
const logHistory = [];

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10mb' }));

const io = new Server(server, { 
    cors: { origin: '*', methods: ["GET", "POST"], credentials: true },
    pingTimeout: 60000 
});

function broadcastLog(message, type = 'info') {
    const logEntry = {
        time: new Date().toLocaleTimeString('id-ID', { hour12: false }),
        message: String(message).trim(),
        type: type
    };
    if (!logEntry.message) return;
    
    logHistory.push(logEntry);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift();
    
    io.emit('terminal_log', logEntry);
}

// Menyadap console standard Node.js
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = function (...args) {
    broadcastLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'info');
    originalLog.apply(console, args);
};
console.error = function (...args) {
    broadcastLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'error');
    originalError.apply(console, args);
};
console.warn = function (...args) {
    broadcastLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'warn');
    originalWarn.apply(console, args);
};

const logger = pino({ level: 'silent' });
const sessionsPath = './sessions';
const scriptsPath = './src';

if (!fs.existsSync(sessionsPath)) fs.mkdirSync(sessionsPath, { recursive: true });
if (!fs.existsSync(scriptsPath)) fs.mkdirSync(scriptsPath, { recursive: true });

// ==========================================
// KONFIGURASI UPSTASH REDIS
// ==========================================
const KV_REST_API_URL = process.env.KV_REST_API_URL || "https://stable-gazelle-127629.upstash.io";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "gQAAAAAAAfKNAAIgcDEyZWI1YmIzNDBmNWQ0ZjY1YjI5NTZmOTU2NjMyZDFhMg";

async function redisGet(key) {
    try {
        const res = await fetch(`${KV_REST_API_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` } });
        const json = await res.json();
        return json.result ? JSON.parse(json.result) : null;
    } catch (e) { return null; }
}

async function redisSet(key, value) {
    try {
        await fetch(`${KV_REST_API_URL}/set/${key}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(value)
        });
    } catch (e) { console.error('Redis Set Error:', e); }
}

async function redisKeys(pattern) {
    try {
        const res = await fetch(`${KV_REST_API_URL}/keys/${pattern}`, { headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` } });
        const json = await res.json();
        return json.result || [];
    } catch (e) { return []; }
}

async function redisDelete(key) {
    try {
        await fetch(`${KV_REST_API_URL}/del/${key}`, { headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` } });
    } catch (e) {}
}

// ==========================================
// STATE MANAGEMENT (MULTI-BOT)
// ==========================================
const bots = new Map();

function getSafeBotState(botId) {
    const bot = bots.get(botId);
    if (!bot) return null;
    return {
        id: bot.id,
        script: bot.script,
        status: bot.status,
        qr: bot.qr,
        startTime: bot.startTime
    };
}

async function saveBotsConfig() {
    const configList = Array.from(bots.values()).map(b => ({ id: b.id, script: b.script }));
    await redisSet('bots_config', configList);
}

function getAvailableScripts() {
    try {
        return fs.readdirSync(scriptsPath).filter(f => f.endsWith('.js'));
    } catch (e) { return ['messageHandler.js']; }
}

const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('<h2>✅ Multi-Device WhatsApp Bot API is Running!</h2>'); });

// ==========================================
// ANTI-CRASH & GRACEFUL SHUTDOWN (RAILWAY FIX)
// ==========================================
process.on('uncaughtException', err => {
    if (String(err).includes('conflict') || String(err).includes('EADDRINUSE')) return;
    console.error('Caught exception: ', err.message || err);
});
process.on('unhandledRejection', reason => {
    if (String(reason).includes('conflict') || String(reason).includes('EADDRINUSE')) return;
    console.error('Unhandled Rejection: ', reason.message || reason);
});

// Menangkap sinyal SIGTERM dari Railway (saat restart/redeploy) agar tidak dianggap error oleh NPM
const gracefulShutdown = () => {
    console.log('🛑 Sinyal SIGTERM/SIGINT diterima dari Railway. Mematikan server secara aman...');
    server.close(() => {
        console.log('✅ Server HTTP ditutup.');
        process.exit(0);
    });
    
    // Paksa mati jika proses tersangkut lebih dari 10 detik
    setTimeout(() => {
        console.error('⚠️ Force shutdown karena timeout.');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);


// ==========================================
// ENGINE WA (MULTI-INSTANCE) FIXED FOR BAD MAC
// ==========================================
async function startBot(botId, scriptName = 'messageHandler.js') {
    if (bots.has(botId) && bots.get(botId).status === 'connected') return;

    console.log(`🔄 Memulai koneksi untuk Bot: ${botId} (Script: ${scriptName})`);
    const sessionDir = `${sessionsPath}/${botId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version, 
        logger, 
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: Browsers.ubuntu('Chrome'), 
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false, // Hemat RAM
        syncFullHistory: false, // Mencegah crash memori saat inisialisasi awal
        getMessage: async (key) => {
            // WAJIB ADA: Mencegah error 'Failed to decrypt message' (Bad MAC) saat melakukan reply
            return {
                conversation: 'Pesan referensi untuk bot.'
            };
        },
        // 🚀 UPGRADE BESAR: Patch Otomatis untuk Button/List/Interactive Message (Native Flow)
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(
                message.buttonsMessage ||
                message.templateMessage ||
                message.listMessage ||
                message.interactiveMessage
            );
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 2,
                                deviceListMetadata: {},
                            },
                            ...message,
                        },
                    },
                };
            }
            return message;
        }
    });

    const serverStartTime = Date.now() - Math.floor(process.uptime() * 1000);
    const botState = { id: botId, script: scriptName, sock, qr: null, status: 'connecting', startTime: serverStartTime };
    bots.set(botId, botState);
    io.emit('bot_updated', getSafeBotState(botId));

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) {
                    botState.qr = url;
                    botState.status = 'qr';
                    io.emit('bot_updated', getSafeBotState(botId));
                }
            });
        }

        if (connection === 'close') {
            botState.qr = null;
            botState.status = 'disconnected';
            io.emit('bot_updated', getSafeBotState(botId));
            
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.warn(`🔄 Koneksi terputus. Mencoba reconnect bot ${botId}...`);
                setTimeout(() => startBot(botId, scriptName), 5000);
            } else { 
                console.log(`🚪 Bot ${botId} Logged Out secara manual!`);
                botState.status = 'logged_out';
                io.emit('bot_updated', getSafeBotState(botId));
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e){}
            }
        } else if (connection === 'open') {
            botState.qr = null;
            botState.status = 'connected';
            console.log(`✅ Bot ${botId} Berhasil Terhubung dan Siap Digunakan!`);
            io.emit('bot_updated', getSafeBotState(botId));
        }
    });

    sock.ev.on('creds.update', saveCreds);

    try {
        const absoluteScriptPath = path.resolve(scriptsPath, scriptName);
        if (fs.existsSync(absoluteScriptPath)) {
            const fileUrl = pathToFileURL(absoluteScriptPath).href + `?t=${Date.now()}`;
            const handlerModule = await import(fileUrl);
            if (handlerModule.default) {
                handlerModule.default(sock); 
            }
        } else {
            console.warn(`⚠️ Peringatan: Script '${scriptName}' tidak ditemukan di sistem lokal (${absoluteScriptPath}). Bot mungkin tidak bisa memproses command sebelum script tersedia.`);
        }
    } catch (err) {
        console.error(`❌ Gagal meload script '${scriptName}' untuk bot ${botId}:`, err.message || err);
    }
}

// ==========================================
// SOCKET.IO EVENT HANDLER
// ==========================================
io.on('connection', (socket) => {
    console.log('🌐 Web client terhubung:', socket.id);
    
    socket.emit('init_state', {
        bots: Array.from(bots.values()).map(b => getSafeBotState(b.id)),
        scripts: getAvailableScripts()
    });
    socket.emit('init_logs', logHistory);

    socket.on('create_bot', async ({ botId, scriptName }) => {
        if (!botId || botId.trim() === '') return socket.emit('error', 'Nama Bot tidak boleh kosong!');
        if (bots.has(botId)) return socket.emit('error', 'Bot dengan nama tersebut sudah ada!');
        
        await startBot(botId, scriptName);
        await saveBotsConfig();
    });

    socket.on('request_pairing', async ({ botId, phoneNumber }) => {
        const bot = bots.get(botId);
        if (bot && bot.sock && bot.status !== 'connected') {
            setTimeout(async () => {
                try {
                    let code = await bot.sock.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code; 
                    socket.emit('pairing_code', { botId, code });
                    console.log(`🔑 Pairing Code diminta untuk nomor ${phoneNumber}`);
                } catch (error) {
                    console.error('Pairing error:', error.message || error);
                    socket.emit('error', 'Gagal generate kode. Pastikan nomor benar tanpa tanda + atau 0 di depan (contoh 62812...).');
                }
            }, 2000);
        } else {
            socket.emit('error', 'Bot tidak ditemukan atau sudah terhubung.');
        }
    });

    socket.on('delete_bot', async ({ botId }) => {
        const bot = bots.get(botId);
        if (bot) {
            console.log(`🗑️ Menghapus dan Melogout bot ${botId}...`);
            if (bot.status === 'connected' && bot.sock) {
                try { await bot.sock.logout(); } catch(e){}
            }
            bots.delete(botId);
            try { fs.rmSync(`${sessionsPath}/${botId}`, { recursive: true, force: true }); } catch(e){}
            await saveBotsConfig();
            io.emit('bot_removed', botId);
        }
    });

    socket.on('upload_script', async ({ fileName, content }) => {
        if (!fileName.endsWith('.js')) return socket.emit('error', 'Hanya file .js yang diperbolehkan');
        try {
            console.log(`📥 Menerima upload script baru: ${fileName}`);
            fs.writeFileSync(`${scriptsPath}/${fileName}`, content);
            await redisSet(`script:${fileName}`, JSON.stringify(content));
            
            socket.emit('script_uploaded', fileName);
            io.emit('init_state', {
                bots: Array.from(bots.values()).map(b => getSafeBotState(b.id)),
                scripts: getAvailableScripts()
            });
        } catch (err) {
            console.error('Upload Error:', err.message || err);
            socket.emit('error', 'Gagal menyimpan script');
        }
    });
});

async function initializeSystem() {
    console.log('🔄 Sinkronisasi dengan Upstash Redis...');
    const scriptKeys = await redisKeys('script:*');
    for (const key of scriptKeys) {
        const contentStr = await redisGet(key);
        if (contentStr) {
            const fileName = key.replace('script:', '');
            fs.writeFileSync(`${scriptsPath}/${fileName}`, JSON.parse(contentStr));
            console.log(`📄 Script diunduh dari Redis: ${fileName}`);
        }
    }

    const configs = await redisGet('bots_config') || [];
    console.log(`🤖 Ditemukan ${configs.length} konfigurasi bot.`);
    
    for (const conf of configs) {
        startBot(conf.id, conf.script);
    }
}

// BINDING PORT 0.0.0.0 - MENCEGAH RAILWAY TIMEOUT/CRASH
server.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Server Berjalan! Membuka port ${port} (0.0.0.0)...`);
    initializeSystem();
});
