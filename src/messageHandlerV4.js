import fs from 'fs';
import process from 'process';
import os from 'os';
import http from 'http'; // 🚀 Modul Webhook Receiver

// Handler perintah eksternal
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

const ownerNumber = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

// URL PHOTOBOOTH KIOSK
const PHOTOBOOTH_GAS_URL = process.env.PHOTOBOOTH_GAS_URL || "https://script.google.com/macros/s/AKfycbxdyXI5z-RMC9LYaXiuJEsVDpfFOw44uTjP56dYec5V7HU2Vd06-X3dKDBUpyUD8hRi/exec";

// SESSION LOGIC
const sessionPath = './session';
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log("[System] Folder session dibuat.");
}

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); 
    const h = Math.floor(seconds / 3600); 
    const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} days ago`; 
    if (h > 0) return `${h} hours ago`; 
    if (m > 0) return `${m} minutes ago`;
    return `${Math.floor(seconds)} seconds ago`;
}

export default function setupMessageHandler(sock) {
    console.log("[System] ZettBOT Photobooth & Utility Handler Aktif!");

    // ====================================================================
    // 🚀 INTERNAL WEBHOOK SERVER (SUPPORT RAILWAY/HEROKU)
    // ====================================================================
    try {
        const server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/api/new-order') {
                let body = '';
                req.on('data', chunk => body += chunk.toString());
                req.on('end', async () => {
                    try {
                        const data = JSON.parse(body);
                        // Bot langsung mengirim pesan notif order baru ke Owner!
                        await sock.sendMessage(ownerNumber, { text: data.pesanFormat });
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({status: 'success'}));
                    } catch(e) {
                        console.error("[Webhook Error]", e);
                        res.writeHead(500);
                        res.end('Error parsing JSON');
                    }
                });
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        
        // MENGGUNAKAN DYNAMIC PORT RAILWAY (process.env.PORT)
        const port = process.env.PORT || 3000;
        server.listen(port, '0.0.0.0', () => {
            console.log(`[System] Webhook Listener Aktif di Port ${port}`);
        });
    } catch(err) {
        console.log('[System] Gagal menginisialisasi server Webhook: ' + err.message);
    }
    // ====================================================================

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || 
                         msg.message.videoMessage?.caption || '';
                         
            const prefix = '!'; 
            if (!text.startsWith(prefix)) return;

            const args = text.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const sender = msg.key.remoteJid;

            console.log(`[COMMAND] ${command} dari ${sender}`);

            switch (command) {
                case 'menu':
                case 'help':
                    const menuText = `*🤖 BOT PHOTOBOOTH & UTILITY 🤖*\n\n` +
                                     `*📷 PHOTOBOOTH:*\n` +
                                     `* !konfirmasi <ID>* - Konfirmasi Pelunasan Order Kiosk\n\n` +
                                     `*✨ AI & MEDIA:*\n` +
                                     `* !ai <pesan>* - Chat dengan AI\n` +
                                     `* !sticker / !s* - Buat sticker dari gambar\n\n` +
                                     `*⚙️ UTILITAS:*\n` +
                                     `* !runtime* - Cek status & memori server\n` +
                                     `* !ping* - Cek kecepatan respon bot\n`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;

                case 'konfirmasi':
                    if (!args[0]) {
                        await sock.sendMessage(sender, { 
                            text: "⚠️ *Format Salah*\nGunakan format: *!konfirmasi <ID_Transaksi>*\n\nContoh: !konfirmasi MALL-20260616-0001" 
                        }, { quoted: msg });
                        break;
                    }
                    
                    const orderId = args[0];
                    await sock.sendMessage(sender, { text: `⏳ _Memproses pelunasan untuk ID ${orderId}..._` }, { quoted: msg });
                    
                    try {
                        const response = await fetch(PHOTOBOOTH_GAS_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                action: "konfirmasi_lunas",
                                orderId: orderId
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (result.status === "success") {
                            await sock.sendMessage(sender, { 
                                text: `✅ *KONFIRMASI LUNAS BERHASIL*\n\nID: ${orderId}\nSistem Kiosk di mall telah otomatis dilanjutkan ke sesi kamera!` 
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(sender, { 
                                text: `❌ *Gagal Konfirmasi:*\n${result.message}` 
                            }, { quoted: msg });
                        }
                    } catch (err) {
                        console.error("[Photobooth Error]", err);
                        await sock.sendMessage(sender, { 
                            text: `❌ *Gagal terhubung ke Server Photobooth.*\nPastikan URL App Script sedang online.` 
                        }, { quoted: msg });
                    }
                    break;

                case 'ping':
                    const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
                    await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingProcess} ms` }, { quoted: msg }); 
                    break;
                    
                case 'runtime':
                    const uptime = process.uptime();
                    await sock.sendMessage(sender, { 
                        text: `⏳ *Bot Uptime:* ${getRelativeTime(uptime)}\n🖥️ *OS Memory:* ${Math.round(os.freemem()/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB` 
                    }, { quoted: msg });
                    break;
                
                case 'ai': 
                    if(typeof handleAiCommand === 'function') await handleAiCommand(sock, msg, args); 
                    break;
                    
                case 'sticker': 
                case 's': 
                    if(typeof handleStickerCommand === 'function') await handleStickerCommand(sock, msg); 
                    break;
            }
        } catch (error) { 
            console.error('Error proses pesan:', error); 
        }
    });
}
