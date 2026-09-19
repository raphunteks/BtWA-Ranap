import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    Browsers,
    jidNormalizedUser,
    isPnUser,
    isLidUser,
    areJidsSameUser
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import pino from 'pino';
import fs from 'fs';
import process from 'process';
import cors from 'cors';
import path from 'path';
import { pathToFileURL } from 'url';

// =========================================================================
// CACHE & MESSAGE STORE (BAILEYS V7 RELIABILITY & ANTI BAD-MAC)
// =========================================================================
const msgRetryCounterCache = new NodeCache();
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

// In-Memory Message Store untuk penanganan retry dan reply pesan (max 2000 pesan)
const messageStore = new Map();
const MAX_MESSAGE_STORE = 2000;

function storeMessage(key, message) {
    if (!key?.id || !message) return;
    const remoteJid = key.remoteJid || '';
    const id = `${remoteJid}:${key.id}`;
    messageStore.set(id, message);
    if (messageStore.size > MAX_MESSAGE_STORE) {
        const firstKey = messageStore.keys().next().value;
        messageStore.delete(firstKey);
    }
}

// =========================================================================
// LOGGER & TERMINAL INTERCEPTOR (LIVE LOGS KE DASHBOARD WEB)
// =========================================================================
const MAX_LOG_HISTORY = 120;
const logHistory = [];

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

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

// =========================================================================
// KONFIGURASI UPSTASH REDIS CLOUD (STATE STORAGE)
// =========================================================================
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

// =========================================================================
// MULTI-BOT INSTANCE STATE & MANAGEMENT
// =========================================================================
const bots = new Map();

function getSafeBotState(botId) {
    const bot = bots.get(botId);
    if (!bot) return null;
    let phoneNumber = null;
    if (bot.sock?.user?.id) {
        try {
            phoneNumber = jidNormalizedUser(bot.sock.user.id).split('@')[0];
        } catch(e) {
            phoneNumber = bot.sock.user.id.split(':')[0].split('@')[0];
        }
    }
    const pushName = bot.sock?.user?.name || bot.id;
    return {
        id: bot.id,
        script: bot.script || 'messageHandler.js',
        status: bot.status,
        qr: bot.qr,
        startTime: bot.startTime,
        phoneNumber: phoneNumber,
        pushName: pushName,
        baileysVersion: bot.baileysVersion || 'v7.0.0-rc14'
    };
}

async function saveBotsConfig() {
    const configList = Array.from(bots.values()).map(b => ({ id: b.id, script: b.script || 'messageHandler.js' }));
    await redisSet('bots_config', configList);
}

function getAvailableScripts() {
    try {
        const files = fs.readdirSync(scriptsPath).filter(f => f.endsWith('.js'));
        return files.length > 0 ? files : ['messageHandler.js'];
    } catch (e) { 
        return ['messageHandler.js']; 
    }
}

// =========================================================================
// ANTI-CRASH & GRACEFUL SHUTDOWN (RAILWAY RELIABILITY)
// =========================================================================
process.on('uncaughtException', err => {
    if (String(err).includes('conflict') || String(err).includes('EADDRINUSE')) return;
    console.error('Caught exception: ', err.message || err);
});
process.on('unhandledRejection', reason => {
    if (String(reason).includes('conflict') || String(reason).includes('EADDRINUSE')) return;
    console.error('Unhandled Rejection: ', reason.message || reason);
});

const gracefulShutdown = () => {
    console.log('🛑 Sinyal SIGTERM/SIGINT diterima. Menutup server dengan aman...');
    server.close(() => {
        console.log('✅ Server HTTP ditutup.');
        process.exit(0);
    });
    setTimeout(() => {
        console.error('⚠️ Force shutdown karena timeout.');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// =========================================================================
// BAILEYS WHATSAPP ENGINE V7 LATEST (MULTI-TENANT MULTI-DEVICE)
// =========================================================================
async function startBot(botId, scriptName = 'messageHandler.js') {
    if (!scriptName || scriptName.trim() === '') scriptName = 'messageHandler.js';

    if (bots.has(botId) && bots.get(botId).status === 'connected') {
        console.log(`ℹ️ Bot ${botId} sudah aktif dan terhubung.`);
        return;
    }

    console.log(`🔄 Memulai Baileys v7 untuk Bot: "${botId}" (Script: ${scriptName})`);
    const sessionDir = `${sessionsPath}/${botId}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    const versionStr = Array.isArray(version) ? version.join('.') : '7.0.0-rc14';
    console.log(`📦 Baileys Version: ${versionStr} (Latest: ${isLatest ? 'Yes' : 'Checking'})`);
    
    const sock = makeWASocket({
        version, 
        logger, 
        auth: { 
            creds: state.creds, 
            keys: makeCacheableSignalKeyStore(state.keys, logger) 
        },
        browser: Browsers.macOS('Chrome'), 
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        msgRetryCounterCache,
        maxMsgRetryCount: 5,
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
        getMessage: async (key) => {
            if (key?.remoteJid && key?.id) {
                const id = `${key.remoteJid}:${key.id}`;
                const stored = messageStore.get(id);
                if (stored) return stored;
            }
            return {
                conversation: 'Pesan referensi untuk bot.'
            };
        },
        // Patch Otomatis untuk Button/List/Interactive Message (Native Flow)
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

    // Menghangatkan cache grup ketika ada update
    sock.ev.on('groups.update', async ([event]) => {
        try {
            if (event?.id) {
                const metadata = await sock.groupMetadata(event.id);
                groupCache.set(event.id, metadata);
            }
        } catch (e) {}
    });
    sock.ev.on('group-participants.update', async (event) => {
        try {
            if (event?.id) {
                const metadata = await sock.groupMetadata(event.id);
                groupCache.set(event.id, metadata);
            }
        } catch (e) {}
    });

    // Otomatis simpan pesan ke messageStore untuk getMessage reliability
    sock.ev.on('messages.upsert', ({ messages }) => {
        if (!Array.isArray(messages)) return;
        for (const msg of messages) {
            if (msg?.key?.id && msg?.message) {
                storeMessage(msg.key, msg.message);
            }
        }
    });

    const serverStartTime = Date.now() - Math.floor(process.uptime() * 1000);
    const botState = { 
        id: botId, 
        script: scriptName, 
        sock, 
        qr: null, 
        status: 'connecting', 
        startTime: serverStartTime,
        baileysVersion: versionStr
    };
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
                console.warn(`🔄 Koneksi terputus (Status: ${statusCode || 'N/A'}). Auto-reconnecting bot ${botId}...`);
                setTimeout(() => startBot(botId, scriptName), 5000);
            } else { 
                console.log(`🚪 Bot ${botId} Logged Out dari WhatsApp! Menghapus sesi...`);
                botState.status = 'logged_out';
                io.emit('bot_updated', getSafeBotState(botId));
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e){}
            }
        } else if (connection === 'open') {
            botState.qr = null;
            botState.status = 'connected';
            const userPhone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
            console.log(`✅ [DENTS WEB BOT GATEWAY] Bot ${botId} (+${userPhone}) Berhasil Terhubung! Engine: ${scriptName}`);
            io.emit('bot_updated', getSafeBotState(botId));
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Dynamic Module Loader untuk Script Handler
    try {
        const absoluteScriptPath = path.resolve(scriptsPath, scriptName);
        if (fs.existsSync(absoluteScriptPath)) {
            const fileUrl = pathToFileURL(absoluteScriptPath).href + `?t=${Date.now()}`;
            const handlerModule = await import(fileUrl);
            if (handlerModule.default) {
                handlerModule.default(sock); 
                console.log(`⚡ Script handler '${scriptName}' sukses di-load untuk bot ${botId}.`);
            }
        } else {
            console.warn(`⚠️ Peringatan: Script '${scriptName}' tidak ditemukan di ${absoluteScriptPath}. Menggunakan fallback messageHandler.js jika tersedia.`);
            if (scriptName !== 'messageHandler.js') {
                const fallbackPath = path.resolve(scriptsPath, 'messageHandler.js');
                if (fs.existsSync(fallbackPath)) {
                    const fallbackUrl = pathToFileURL(fallbackPath).href + `?t=${Date.now()}`;
                    const fbModule = await import(fallbackUrl);
                    if (fbModule.default) fbModule.default(sock);
                }
            }
        }
    } catch (err) {
        console.error(`❌ Gagal me-load script '${scriptName}' untuk bot ${botId}:`, err.message || err);
    }
}

// Me-restart bot tanpa menghapus sesi
async function restartBot(botId) {
    const bot = bots.get(botId);
    if (!bot) throw new Error(`Bot [${botId}] tidak ditemukan.`);
    const scriptName = bot.script || 'messageHandler.js';
    console.log(`🔄 Me-restart bot instance: ${botId}...`);
    if (bot.sock) {
        try {
            bot.sock.ev.removeAllListeners();
            bot.sock.end();
        } catch (e) {}
    }
    bot.status = 'connecting';
    bot.qr = null;
    io.emit('bot_updated', getSafeBotState(botId));
    await startBot(botId, scriptName);
}

// Helper Sanitasi JID WhatsApp (Mendukung PN, LID, & Group)
function cleanJid(jid) {
    if (!jid) return '';
    let clean = String(jid).trim().replace(/:[0-9]+/g, '');
    if (clean.includes('@lid')) return clean.split('@lid')[0] + '@lid';
    if (clean.includes('@s.whatsapp.net')) return clean.split('@s.whatsapp.net')[0] + '@s.whatsapp.net';
    if (clean.includes('@g.us')) return clean.split('@g.us')[0] + '@g.us';
    if (!clean.includes('@')) {
        clean = clean.replace(/[^0-9]/g, '');
        if (clean.startsWith('0')) clean = '62' + clean.slice(1);
        return clean + '@s.whatsapp.net';
    }
    return jidNormalizedUser(clean);
}

// Kirim pesan WhatsApp melalui bot tertentu (Fitur Dents Web BOT Gateway)
async function sendBotMessage(botId, target, message) {
    const bot = bots.get(botId);
    if (!bot || !bot.sock || bot.status !== 'connected') {
        throw new Error(`Bot [${botId}] tidak ditemukan atau belum berstatus connected.`);
    }
    const cleanTarget = cleanJid(target);
    return await bot.sock.sendMessage(cleanTarget, { text: message });
}

// =========================================================================
// REST API ENDPOINTS (DENTS WEB BOT WHATSAPP GATEWAY API)
// =========================================================================
app.get('/', (req, res) => { 
    res.send(`
        <html>
            <head><title>Dents Web BOT WhatsApp Gateway API</title></head>
            <body style="font-family: sans-serif; padding: 2rem; background: #0b0b0c; color: #fff;">
                <h2>🚀 Dents Web BOT WhatsApp Gateway Multi-Device Engine</h2>
                <p>Status: <span style="color: #4ade80;">Active & Running</span></p>
                <p>Uptime: ${Math.floor(process.uptime())} seconds | Active Bots: ${bots.size}</p>
                <hr style="border-color: #2a2a30;">
                <p>Endpoints: <code>GET /api/status</code> | <code>GET /api/bots</code> | <code>POST /api/send-message</code> | <code>POST /api/restart-bot</code></p>
            </body>
        </html>
    `); 
});

app.get('/api/status', (req, res) => {
    const uptimeSec = Math.floor(process.uptime());
    const memoryUsage = process.memoryUsage();
    res.json({
        success: true,
        gateway: 'Dents Web BOT WhatsApp Gateway Multi-Device Engine',
        status: 'online',
        uptime: uptimeSec,
        uptimeFormatted: `${Math.floor(uptimeSec / 3600)}j ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}d`,
        memory: {
            rssMB: (memoryUsage.rss / 1024 / 1024).toFixed(2),
            heapUsedMB: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2)
        },
        totalBots: bots.size,
        activeBots: Array.from(bots.values()).filter(b => b.status === 'connected').length
    });
});

app.get('/api/bots', (req, res) => {
    res.json({
        success: true,
        bots: Array.from(bots.values()).map(b => getSafeBotState(b.id)),
        scripts: getAvailableScripts()
    });
});

app.post('/api/send-message', async (req, res) => {
    const { botId, target, message } = req.body;
    if (!botId || !target || !message) {
        return res.status(400).json({ success: false, error: 'botId, target, dan message wajib diisi!' });
    }
    try {
        const result = await sendBotMessage(botId, target, message);
        res.json({ success: true, message: 'Pesan berhasil dikirim via Dents Web BOT Gateway!', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/restart-bot', async (req, res) => {
    const { botId } = req.body;
    if (!botId) return res.status(400).json({ success: false, error: 'botId wajib diisi!' });
    try {
        await restartBot(botId);
        res.json({ success: true, message: `Bot ${botId} sedang di-restart.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// SOCKET.IO EVENT HANDLER (REAL-TIME PORTAL COMMUNICATION)
// =========================================================================
io.on('connection', (socket) => {
    console.log('🌐 Web Dashboard Dents Web BOT terhubung:', socket.id);
    
    // Inisialisasi state untuk client baru
    socket.emit('init_state', {
        bots: Array.from(bots.values()).map(b => getSafeBotState(b.id)),
        scripts: getAvailableScripts()
    });
    socket.emit('init_logs', logHistory);

    // Buat bot baru (default script: messageHandler.js)
    socket.on('create_bot', async ({ botId, scriptName }) => {
        if (!botId || botId.trim() === '') return socket.emit('error', 'Nama/ID Bot tidak boleh kosong!');
        const cleanBotId = botId.trim().replace(/[^a-zA-Z0-9_-]/g, '');
        if (bots.has(cleanBotId)) return socket.emit('error', 'Bot dengan ID tersebut sudah terdaftar!');
        
        const targetScript = (scriptName && scriptName.trim() !== '') ? scriptName.trim() : 'messageHandler.js';
        await startBot(cleanBotId, targetScript);
        await saveBotsConfig();
    });

    // Minta Pairing Code (Tanpa Scan QR)
    socket.on('request_pairing', async ({ botId, phoneNumber }) => {
        const bot = bots.get(botId);
        if (bot && bot.sock && bot.status !== 'connected') {
            setTimeout(async () => {
                try {
                    let cleanPhone = phoneNumber.replace(/\D/g, '');
                    if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
                    
                    let code = await bot.sock.requestPairingCode(cleanPhone);
                    code = code?.match(/.{1,4}/g)?.join("-") || code; 
                    socket.emit('pairing_code', { botId, code });
                    console.log(`🔑 Pairing Code diminta untuk bot [${botId}] nomor +${cleanPhone}: ${code}`);
                } catch (error) {
                    console.error('Pairing error:', error.message || error);
                    socket.emit('error', 'Gagal meminta pairing code. Pastikan nomor diawali kode negara 62 (contoh: 6281234567890).');
                }
            }, 1500);
        } else {
            socket.emit('error', 'Bot tidak ditemukan atau sudah terhubung.');
        }
    });

    // Restart Bot
    socket.on('restart_bot', async ({ botId }) => {
        try {
            await restartBot(botId);
            socket.emit('bot_restarted', { botId, success: true });
        } catch (err) {
            socket.emit('error', 'Gagal me-restart bot: ' + err.message);
        }
    });

    // Kirim Pesan Uji Coba dari Web Portal
    socket.on('send_test_message', async ({ botId, targetNumber, message }) => {
        try {
            await sendBotMessage(botId, targetNumber, message);
            socket.emit('message_sent_result', { success: true, botId, target: targetNumber });
            console.log(`✉️ [Web Test] Pesan terkirim dari ${botId} ke ${targetNumber}`);
        } catch (err) {
            socket.emit('message_sent_result', { success: false, error: err.message });
        }
    });

    // Hapus & Logout Bot
    socket.on('delete_bot', async ({ botId }) => {
        const bot = bots.get(botId);
        if (bot) {
            console.log(`🗑️ Menghapus bot [${botId}]...`);
            if (bot.status === 'connected' && bot.sock) {
                try { await bot.sock.logout(); } catch(e){}
            }
            bots.delete(botId);
            try { fs.rmSync(`${sessionsPath}/${botId}`, { recursive: true, force: true }); } catch(e){}
            await saveBotsConfig();
            io.emit('bot_removed', botId);
        }
    });

    // Upload script handler baru
    socket.on('upload_script', async ({ fileName, content }) => {
        if (!fileName || !fileName.endsWith('.js')) return socket.emit('error', 'Hanya file .js yang diperbolehkan.');
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
            socket.emit('error', 'Gagal menyimpan script ke server.');
        }
    });
});

// =========================================================================
// SISTEM INISIALISASI & STARTUP SERVER
// =========================================================================
async function initializeSystem() {
    console.log('🔄 Sinkronisasi awal dengan Upstash Redis Cloud...');
    const scriptKeys = await redisKeys('script:*');
    for (const key of scriptKeys) {
        const contentStr = await redisGet(key);
        if (contentStr) {
            const fileName = key.replace('script:', '');
            fs.writeFileSync(`${scriptsPath}/${fileName}`, JSON.parse(contentStr));
            console.log(`📄 Script disinkronkan dari Redis: ${fileName}`);
        }
    }

    const configs = await redisGet('bots_config') || [];
    console.log(`🤖 Ditemukan ${configs.length} konfigurasi bot tersimpan.`);
    
    for (const conf of configs) {
        startBot(conf.id, conf.script || 'messageHandler.js');
    }
}

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 Dents Web BOT WhatsApp Gateway Server Berjalan di Port ${port}`);
    console.log(`🌐 Host: 0.0.0.0:${port} | REST API: /api/status, /api/bots`);
    console.log(`=======================================================`);
    initializeSystem();
});
