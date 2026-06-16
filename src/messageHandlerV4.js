import fs from 'fs';
import process from 'process';
import os from 'os';

// Handler perintah eksternal
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

const ownerNumber = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

// URL PHOTOBOOTH KIOSK
const PHOTOBOOTH_GAS_URL = process.env.PHOTOBOOTH_GAS_URL || "https://script.google.com/macros/s/AKfycbxdyXI5z-RMC9LYaXiuJEsVDpfFOw44uTjP56dYec5V7HU2Vd06-X3dKDBUpyUD8hRi/exec";

// ====================================================================
// 📁 SESSION & MULTI-ADMIN LOGIC
// ====================================================================
const sessionPath = './session';
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log("[System] Folder session dibuat.");
}

const adminsFile = `${sessionPath}/admins.json`;
let botAdmins = [ownerNumber]; // Owner default
if (fs.existsSync(adminsFile)) {
    try { botAdmins = JSON.parse(fs.readFileSync(adminsFile, 'utf-8')); } catch(e){}
} else {
    fs.writeFileSync(adminsFile, JSON.stringify(botAdmins));
}

function saveAdmins() {
    fs.writeFileSync(adminsFile, JSON.stringify(botAdmins, null, 2));
}

// 🚀 Helper Format Nomor HP (08xx atau 8xx jadi 628xx)
function formatPhoneToJid(phone) {
    let p = phone.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (p.startsWith('8')) p = '62' + p;
    return p + "@s.whatsapp.net";
}

// SMART POLLER STATE
const notifiedOrders = new Set();

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
    // 🚀 API PULLING SYSTEM (Mengecek Google Sheet setiap 10 Detik)
    // ====================================================================
    setInterval(async () => {
        try {
            const response = await fetch(PHOTOBOOTH_GAS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: "get_pending_orders" })
            });
            
            const result = await response.json();
            
            if (result.status === "success" && result.data && result.data.length > 0) {
                for (const order of result.data) {
                    if (!notifiedOrders.has(order.orderId)) {
                        const hargaFormat = parseInt(order.harga).toLocaleString('id-ID');
                        
                        // 🚀 UPGRADE: Split menjadi 2 Pesan terpisah
                        const msg1 = `🔔 *PESANAN PHOTOBOOTH BARU*\n\nID: ${order.orderId}\nPaket: ${order.paket}\nTotal: Rp${hargaFormat}\nWaktu: ${order.waktu}\n\nSilakan COPY pesan di bawah yang saya berikan\n\nUntuk menyalakan kamera Kiosk secara otomatis.`;
                        const msg2 = `!konfirmasi ${order.orderId}`;
                        
                        // Broadcast ke seluruh Admin terdaftar
                        for (const adminId of botAdmins) {
                            try {
                                await sock.sendMessage(adminId, { text: msg1 });
                                await sock.sendMessage(adminId, { text: msg2 });
                            } catch(err){}
                        }
                        
                        notifiedOrders.add(order.orderId);
                        console.log(`[Photobooth] Broadcast notifikasi dikirim untuk order: ${order.orderId}`);
                    }
                }
            }
        } catch (err) {}
    }, 10000); 
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

            // Keamanan: Tolak jika bukan bagian dari admin (khusus command Photobooth & Admin)
            const isAdmin = botAdmins.includes(sender);
            const adminCommands = ['konfirmasi', 'listorder', 'addadmin', 'deladmin', 'listadmin'];
            
            if (adminCommands.includes(command) && !isAdmin) {
                return; // Abaikan jika bukan admin mencoba command sensitif
            }

            console.log(`[COMMAND] ${command} dari ${sender}`);

            switch (command) {
                case 'menu':
                case 'help':
                    const menuText = `*🤖 BOT PHOTOBOOTH & UTILITY 🤖*\n\n` +
                                     `*📷 PHOTOBOOTH:*\n` +
                                     `* !konfirmasi <ID>* - Konfirmasi Pelunasan Order\n` +
                                     `* !listorder* - Rekap transaksi hari ini\n\n` +
                                     `*👥 MANAJEMEN ADMIN:*\n` +
                                     `* !addadmin <no_hp>* - Tambah Admin Notif\n` +
                                     `* !deladmin <no_hp>* - Hapus Admin\n` +
                                     `* !listadmin* - Daftar Admin\n\n` +
                                     `*✨ AI & MEDIA:*\n` +
                                     `* !ai <pesan>* - Chat dengan AI\n` +
                                     `* !sticker / !s* - Buat sticker dari gambar\n\n` +
                                     `*⚙️ UTILITAS:*\n` +
                                     `* !runtime* - Cek status & memori server\n` +
                                     `* !ping* - Cek kecepatan respon bot\n`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;

                // ====================================================================
                // 🚀 MANAJEMEN MULTI-ADMIN
                // ====================================================================
                case 'addadmin':
                    if (!args[0]) return await sock.sendMessage(sender, { text: "⚠️ Format: *!addadmin 628xxx*" });
                    const newAdmin = formatPhoneToJid(args[0]);
                    if (!botAdmins.includes(newAdmin)) {
                        botAdmins.push(newAdmin);
                        saveAdmins();
                        await sock.sendMessage(sender, { text: `✅ Nomor ${newAdmin.split('@')[0]} sukses ditambahkan sebagai Admin.` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: `⚠️ Nomor sudah menjadi admin.` }, { quoted: msg });
                    }
                    break;

                case 'deladmin':
                    if (!args[0]) return await sock.sendMessage(sender, { text: "⚠️ Format: *!deladmin 628xxx*" });
                    const delTarget = formatPhoneToJid(args[0]);
                    if (delTarget === ownerNumber) return await sock.sendMessage(sender, { text: "❌ Anda tidak bisa menghapus nomor Owner utama." });
                    
                    if (botAdmins.includes(delTarget)) {
                        botAdmins = botAdmins.filter(a => a !== delTarget);
                        saveAdmins();
                        await sock.sendMessage(sender, { text: `✅ Nomor ${delTarget.split('@')[0]} sukses dihapus dari Admin.` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: `⚠️ Nomor tidak ditemukan dalam daftar admin.` }, { quoted: msg });
                    }
                    break;

                case 'listadmin':
                    let adList = "👥 *DAFTAR ADMIN PHOTOBOOTH*\n\n";
                    botAdmins.forEach((a, i) => adList += `${i+1}. ${a.split('@')[0]}\n`);
                    await sock.sendMessage(sender, { text: adList }, { quoted: msg });
                    break;
                // ====================================================================

                // ====================================================================
                // 🚀 REKAP ORDER HARI INI
                // ====================================================================
                case 'listorder':
                    await sock.sendMessage(sender, { text: `⏳ _Menarik data orderan hari ini dari Database..._` }, { quoted: msg });
                    try {
                        const response = await fetch(PHOTOBOOTH_GAS_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: "get_today_orders" })
                        });
                        const result = await response.json();
                        
                        if (result.status === "success") {
                            let orderList = `📋 *REKAP ORDERAN HARI INI*\n\n`;
                            let totalPendapatan = 0;
                            
                            if (result.data.length === 0) {
                                orderList += `_Belum ada transaksi hari ini._`;
                            } else {
                                result.data.forEach((o, i) => {
                                    const hargaFormat = parseInt(o.harga).toLocaleString('id-ID');
                                    orderList += `*${i+1}. ${o.orderId}*\n⏱️ ${o.waktu.split(' ')[1] || o.waktu}\n📦 ${o.paket} (Rp${hargaFormat})\n💳 ${o.metode}\n📌 Status: ${o.status}\n\n`;
                                    if(o.status.toUpperCase() === "LUNAS") totalPendapatan += parseInt(o.harga);
                                });
                                orderList += `💰 *TOTAL LUNAS:* Rp${totalPendapatan.toLocaleString('id-ID')}`;
                            }
                            await sock.sendMessage(sender, { text: orderList }, { quoted: msg });
                        } else {
                            await sock.sendMessage(sender, { text: `❌ Gagal: ${result.message}` }, { quoted: msg });
                        }
                    } catch (e) {
                        await sock.sendMessage(sender, { text: `❌ Error terhubung ke database.` }, { quoted: msg });
                    }
                    break;
                // ====================================================================

                // ====================================================================
                // 🚀 KONFIRMASI LUNAS
                // ====================================================================
                case 'konfirmasi':
                    if (!args[0]) {
                        await sock.sendMessage(sender, { 
                            text: "⚠️ *Format Salah*\nGunakan format: *!konfirmasi <ID_Transaksi>*\n\nContoh: !konfirmasi MALL-20260616-0001" 
                        }, { quoted: msg });
                        break;
                    }
                    
                    const orderId = args[0];
                    const adminPhone = sender.split('@')[0]; // Mendapatkan no HP admin yang menekan
                    await sock.sendMessage(sender, { text: `⏳ _Memproses pelunasan untuk ID ${orderId}..._` }, { quoted: msg });
                    
                    try {
                        const response = await fetch(PHOTOBOOTH_GAS_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                action: "konfirmasi_lunas",
                                orderId: orderId,
                                confirmedBy: "Admin " + adminPhone // 🚀 Tracking Identitas Admin
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (result.status === "success") {
                            await sock.sendMessage(sender, { 
                                text: `✅ *KONFIRMASI LUNAS BERHASIL*\n\nID: ${orderId}\nSistem Kiosk di mall telah otomatis dilanjutkan ke sesi kamera!` 
                            }, { quoted: msg });
                            
                            // 🚀 BROADCAST KE ADMIN LAIN
                            for (const adminId of botAdmins) {
                                if (adminId !== sender) {
                                    try {
                                        await sock.sendMessage(adminId, { 
                                            text: `ℹ️ *INFO SISTEM*\nPesanan ${orderId} telah dikonfirmasi lunas oleh Admin ${adminPhone}.` 
                                        });
                                    } catch(e){}
                                }
                            }

                        } else {
                            await sock.sendMessage(sender, { text: `❌ *Gagal Konfirmasi:*\n${result.message}` }, { quoted: msg });
                        }
                    } catch (err) {
                        await sock.sendMessage(sender, { text: `❌ *Gagal terhubung ke Server Photobooth.*` }, { quoted: msg });
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
