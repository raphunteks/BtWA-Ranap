import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import process from 'process';
import cors from 'cors';
import path from 'path'; // Diperlukan untuk resolusi path absolut
import { pathToFileURL } from 'url'; // Diperlukan untuk konversi path ESM yang aman di Railway/Docker

const logger = pino({ level: 'silent' });
const sessionsPath = './sessions'; // Folder jama untuk multi-session
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
const bots = new Map(); // Menyimpan state semua bot

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

// ==========================================
// SETUP EXPRESS & SOCKET.IO
// ==========================================
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10mb' }));

const io = new Server(server, { 
    cors: { origin: '*', methods: ["GET", "POST"], credentials: true },
    pingTimeout: 60000 
});

const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('<h2>✅ Multi-Device WhatsApp Bot API is Running!</h2>'); });

process.on('uncaughtException', err => {
    if (String(err).includes('conflict') || String(err).includes('EADDRINUSE')) return;
    console.log('Caught exception: ', err);
});
process.on('unhandledRejection', reason => {
    if (String(reason).includes('conflict') || String(reason).includes('EADDRINUSE')) return;
    console.log('Unhandled Rejection: ', reason);
});

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
        // PENAMBAHAN FIX: Mencegah error Bad MAC dan crash memori
        syncFullHistory: false, 
        getMessage: async (key) => {
            // Ini WAJIB untuk mencegah "Failed to decrypt message" saat mereply pesan
            return {
                conversation: 'Pesan referensi untuk bot.'
            };
        }
    });

    const botState = { id: botId, script: scriptName, sock, qr: null, status: 'connecting', startTime: null };
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
                setTimeout(() => startBot(botId, scriptName), 5000);
            } else { 
                console.log(`🚪 Bot ${botId} Logged Out!`);
                botState.status = 'logged_out';
                io.emit('bot_updated', getSafeBotState(botId));
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e){}
            }
        } else if (connection === 'open') {
            botState.qr = null;
            botState.status = 'connected';
            botState.startTime = Date.now();
            console.log(`✅ Bot ${botId} Berhasil Terhubung!`);
            io.emit('bot_updated', getSafeBotState(botId));
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ==========================================
    // FIXED DYNAMIC MODULE RESOLUTION (RAILWAY BYPASS)
    // ==========================================
    try {
        const absoluteScriptPath = path.resolve(scriptsPath, scriptName);
        if (fs.existsSync(absoluteScriptPath)) {
            // Gunakan pathToFileURL untuk mengonversi path lokal absolut Linux menjadi format file:/// URI yang valid di ES Module
            const fileUrl = pathToFileURL(absoluteScriptPath).href + `?t=${Date.now()}`;
            const handlerModule = await import(fileUrl);
            if (handlerModule.default) {
                handlerModule.default(sock); 
            }
        } else {
            console.warn(`⚠️ Script ${scriptName} tidak ditemukan di sistem lokal: ${absoluteScriptPath}`);
        }
    } catch (err) {
        console.error(`❌ Gagal meload script ${scriptName} untuk bot ${botId}:`, err);
    }
}

// ==========================================
// SOCKET.IO EVENT HANDLER (MULTI-DEVICE)
// ==========================================
io.on('connection', (socket) => {
    console.log('🌐 Web client terhubung:', socket.id);
    
    // Kirim state awal
    socket.emit('init_state', {
        bots: Array.from(bots.values()).map(b => getSafeBotState(b.id)),
        scripts: getAvailableScripts()
    });

    // Request buat bot baru
    socket.on('create_bot', async ({ botId, scriptName }) => {
        if (!botId || botId.trim() === '') return socket.emit('error', 'Nama Bot tidak boleh kosong!');
        if (bots.has(botId)) return socket.emit('error', 'Bot dengan nama tersebut sudah ada!');
        
        await startBot(botId, scriptName);
        await saveBotsConfig();
    });

    // Request Pairing Code Spesifik Bot
    socket.on('request_pairing', async ({ botId, phoneNumber }) => {
        const bot = bots.get(botId);
        if (bot && bot.sock && bot.status !== 'connected') {
            setTimeout(async () => {
                try {
                    let code = await bot.sock.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code; 
                    socket.emit('pairing_code', { botId, code });
                } catch (error) {
                    socket.emit('error', 'Gagal generate kode. Pastikan nomor benar.');
                }
            }, 2000);
        } else {
            socket.emit('error', 'Bot tidak ditemukan atau sudah terhubung.');
        }
    });

    // Hapus dan Logout Bot
    socket.on('delete_bot', async ({ botId }) => {
        const bot = bots.get(botId);
        if (bot) {
            if (bot.status === 'connected' && bot.sock) {
                try { await bot.sock.logout(); } catch(e){}
            }
            bots.delete(botId);
            try { fs.rmSync(`${sessionsPath}/${botId}`, { recursive: true, force: true }); } catch(e){}
            await saveBotsConfig();
            io.emit('bot_removed', botId);
        }
    });

    // Upload Script Handler Baru
    socket.on('upload_script', async ({ fileName, content }) => {
        if (!fileName.endsWith('.js')) return socket.emit('error', 'Hanya file .js yang diperbolehkan');
        try {
            // Simpan ke local storage backend
            fs.writeFileSync(`${scriptsPath}/${fileName}`, content);
            // Backup ke Upstash Redis
            await redisSet(`script:${fileName}`, JSON.stringify(content));
            
            socket.emit('script_uploaded', fileName);
            io.emit('init_state', {
                bots: Array.from(bots.values()).map(b => getSafeBotState(b.id)),
                scripts: getAvailableScripts()
            });
        } catch (err) {
            socket.emit('error', 'Gagal menyimpan script');
        }
    });
});

// ==========================================
// INISIALISASI STARTUP (SYNC REDIS)
// ==========================================
async function initializeSystem() {
    console.log('🔄 Sinkronisasi dengan Upstash Redis...');
    
    // 1. Sync Scripts
    const scriptKeys = await redisKeys('script:*');
    for (const key of scriptKeys) {
        const contentStr = await redisGet(key);
        if (contentStr) {
            const fileName = key.replace('script:', '');
            fs.writeFileSync(`${scriptsPath}/${fileName}`, JSON.parse(contentStr));
            console.log(`📄 Script diunduh dari Redis: ${fileName}`);
        }
    }

    // 2. Sync Bots Configuration
    const configs = await redisGet('bots_config') || [];
    console.log(`🤖 Ditemukan ${configs.length} konfigurasi bot.`);
    
    for (const conf of configs) {
        startBot(conf.id, conf.script);
    }
}

server.listen(port, () => {
    console.log(`🌐 Multi-Device Bot Server berjalan di port ${port}`);
    initializeSystem();
});
