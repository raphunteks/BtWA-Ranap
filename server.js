import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import process from 'process';
import cors from 'cors'; // Ditambahkan untuk bypass blokir Vercel

// Import Handler Logika Bot
import setupMessageHandler from './src/messageHandler.js';

const logger = pino({ level: 'silent' });
const sessionPath = './session';

// Setup Express & Socket.io
const app = express();
const server = http.createServer(app);

// Proteksi CORS Ekstra agar web Vercel tidak diblokir
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json());

const io = new Server(server, { 
    cors: { 
        origin: '*',
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000 
});

const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('<h2>✅ WhatsApp Bot API & Engine is Running Successfully!</h2>');
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

// ==========================================
// STATE MANAGEMENT (SUPER UPGRADE)
// ==========================================
let sock;
let currentQR = null;
let isConnected = false; // Pelacak status asli anti-bug loading

// Handle koneksi Web (Socket.io)
io.on('connection', (socket) => {
    console.log('🌐 Web client terhubung ke Socket.io:', socket.id);
    
    // Cek akurat menggunakan flag boolean
    if (isConnected) {
        socket.emit('wa_status', 'connected');
    } else if (currentQR) {
        socket.emit('qr', currentQR);
    }

    // Mendengarkan permintaan Pairing Code dari Web
    socket.on('request_pairing', async (phoneNumber) => {
        console.log(`📱 Meminta Pairing Code untuk nomor: ${phoneNumber}`);
        if (sock && !isConnected) {
            // Berikan jeda sebentar agar engine WA siap memproses pairing
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(phoneNumber);
                    // Format kode agar rapi (cth: ABCD-EFGH)
                    code = code?.match(/.{1,4}/g)?.join("-") || code; 
                    socket.emit('pairing_code', code);
                } catch (error) {
                    console.error('❌ Gagal menghasilkan pairing code:', error);
                    socket.emit('error', 'Gagal generate kode. Pastikan nomor benar.');
                }
            }, 2000);
        } else if (isConnected) {
            socket.emit('wa_status', 'connected');
        } else {
            socket.emit('error', 'WA Engine belum siap, tunggu sebentar.');
        }
    });

    // Mendengarkan permintaan LOGOUT dari Web
    socket.on('logout', async () => {
        console.log('🚪 Menerima instruksi LOGOUT dari Web Portal');
        if (sock && isConnected) {
            try {
                // Memanggil fungsi logout bawaan Baileys
                await sock.logout();
                isConnected = false;
                currentQR = null;
                // UI tidak perlu dipaksa update di sini, karena sock.logout() akan 
                // memicu event connection.update = 'close' di bawah yang mengurus sisanya
            } catch (err) {
                console.error('❌ Gagal melakukan proses logout:', err);
            }
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
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: Browsers.ubuntu('Chrome'), 
        markOnlineOnConnect: true,
        getMessage: async () => ({ conversation: 'Bot is running' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Handle QR Code
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
            isConnected = false; // Matikan status connected
            io.emit('wa_status', 'disconnected'); // Lempar sinyal putus ke UI
            
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWhatsApp(), 3000);
            } else { 
                clearZombieSession(); 
                setTimeout(() => connectToWhatsApp(), 3000); 
            }
        } else if (connection === 'open') {
            currentQR = null;
            isConnected = true; // Kunci status connected
            console.log('✅ Bot berhasil terhubung ke WhatsApp!');
            io.emit('wa_status', 'connected'); // Lempar sinyal tersambung ke UI
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
