import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import process from 'process';

// Import Handler Logika Bot
import setupMessageHandler from './src/messageHandler.js';

const logger = pino({ level: 'silent' });
const sessionPath = './session';

// Setup Express & Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('WhatsApp Bot API & Engine is Running Successfully!');
});

// Penanganan Error agar Server Tidak Crash
process.on('uncaughtException', function (err) {
    let e = String(err);
    if (e.includes('conflict') || e.includes('timeout') || e.includes('not-authorized') || e.includes('Bad MAC') || e.includes('EADDRINUSE') || e.includes('Connection Closed')) return;
    console.log('Caught exception: ', err);
});
process.on('unhandledRejection', function (reason, p) {
    let e = String(reason);
    if (e.includes('conflict') || e.includes('timeout') || e.includes('not-authorized') || e.includes('Bad MAC') || e.includes('EADDRINUSE') || e.includes('Connection Closed')) return;
    console.log('Unhandled Rejection at: Promise ', p, ' reason: ', reason);
});

function clearZombieSession() {
    console.log('\n⚠️ MENGHAPUS SESI LAMA YANG LOGOUT/KORUP...');
    if (fs.existsSync(sessionPath)) {
        fs.readdirSync(sessionPath).forEach(file => {
            if (file !== 'schedules.json' && file !== 'settings.json') {
                try { fs.unlinkSync(`${sessionPath}/${file}`); } catch (e) {}
            }
        });
        console.log('✅ Data sesi lama berhasil dibersihkan! Memulai ulang sistem...\n');
    }
}

let sock;
let currentQR = null;

// Handle koneksi Web (Socket.io)
io.on('connection', (socket) => {
    console.log('🌐 Web client terhubung ke Socket.io');
    
    if (sock?.authState?.creds?.registered) {
        socket.emit('wa_status', 'connected');
    } else if (currentQR) {
        socket.emit('qr', currentQR);
    }

    // Mendengarkan permintaan Pairing Code dari Web
    socket.on('request_pairing', async (phoneNumber) => {
        console.log(`📱 Meminta Pairing Code untuk nomor: ${phoneNumber}`);
        if (sock && !sock.authState.creds.registered) {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                socket.emit('pairing_code', code);
            } catch (error) {
                console.error('❌ Gagal menghasilkan pairing code:', error);
            }
        } else if (sock?.authState?.creds?.registered) {
            socket.emit('wa_status', 'connected');
        }
    });
});

async function connectToWhatsApp() {
    console.log('🔄 Memulai koneksi ke WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version, 
        logger, 
        printQRInTerminal: true, // Tetap print di terminal sbg fallback
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: Browsers.ubuntu('Chrome'), 
        markOnlineOnConnect: true,
        getMessage: async () => ({ conversation: 'Bot is running' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Handle QR Code untuk dikirim ke Web
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) {
                    currentQR = url;
                    io.emit('qr', url);
                }
            });
        }

        if (connection === 'close') {
            currentQR = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWhatsApp(), 3000);
            } else { 
                clearZombieSession(); 
                setTimeout(() => connectToWhatsApp(), 3000); 
            }
        } else if (connection === 'open') {
            currentQR = null;
            console.log('✅ Bot berhasil terhubung ke WhatsApp!');
            io.emit('wa_status', 'connected');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Kirim socket ke Message Handler agar logika bot terhubung
    setupMessageHandler(sock);
}

server.listen(port, () => {
    console.log(`🌐 Server Backend & WebSockets berjalan di port ${port}`);
    connectToWhatsApp();
});