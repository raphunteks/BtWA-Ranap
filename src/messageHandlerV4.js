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
// 📁 SESSION, MULTI-ADMIN & SETTINGS LOGIC
// ====================================================================
const sessionPath = './session';
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log("[System] Folder session dibuat.");
}

const adminsFile = `${sessionPath}/admins.json`;
const settingsFile = `${sessionPath}/settings.json`;

// 🚀 BUGFIX: Memasukkan nomor owner dan ID @lid yang bermasalah sebagai Admin Permanen
let botAdmins = [ownerNumber, "247922893566044@lid"]; 

if (fs.existsSync(adminsFile)) {
    try { 
        let savedAdmins = JSON.parse(fs.readFileSync(adminsFile, 'utf-8')); 
        botAdmins = [...new Set([...botAdmins, ...savedAdmins])];
    } catch(e){}
} else {
    fs.writeFileSync(adminsFile, JSON.stringify(botAdmins));
}

function saveAdmins() {
    fs.writeFileSync(adminsFile, JSON.stringify(botAdmins, null, 2));
}

// Global Settings untuk Fitur Sholat dsb
let botSettings = { autoSholat: true };
if (fs.existsSync(settingsFile)) {
    try {
        let savedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        botSettings = { ...botSettings, ...savedSettings };
    } catch (e) {}
} else {
    fs.writeFileSync(settingsFile, JSON.stringify(botSettings, null, 2));
}

function saveSettings() {
    fs.writeFileSync(settingsFile, JSON.stringify(botSettings, null, 2));
}

// Helper Format Nomor HP
function formatPhoneToJid(phone) {
    if (phone.endsWith('@lid') || phone.endsWith('@s.whatsapp.net') || phone.endsWith('@g.us')) return phone;
    let p = phone.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (p.startsWith('8')) p = '62' + p;
    return p + "@s.whatsapp.net";
}

// ====================================================================
// 🕌 JADWAL SHOLAT & WAKTU (KENDARI - WITA)
// ====================================================================
let todayPrayerTimes = null;
let lastFetchDate = null;

// Fungsi Helper untuk Waktu WITA (Asia/Makassar)
function getWitaTime() {
    const now = new Date();
    const witaString = now.toLocaleString("en-US", { timeZone: "Asia/Makassar" });
    return new Date(witaString);
}

function formatTimeWita(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function getDateStringWita(date) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

async function fetchPrayerTimes() {
    try {
        const res = await fetch("https://api.aladhan.com/v1/timingsByCity?city=Kendari&country=Indonesia&method=20");
        const data = await res.json();
        if (data.code === 200) {
            const t = data.data.timings;
            todayPrayerTimes = {
                Subuh: t.Fajr,
                Dzuhur: t.Dhuhr,
                Ashar: t.Asr,
                Maghrib: t.Maghrib,
                Isya: t.Isha
            };
            lastFetchDate = getDateStringWita(getWitaTime());
            return true;
        }
    } catch (e) {
        console.error("[System] Gagal fetch jadwal sholat", e);
    }
    return false;
}

async function broadcastToAdmins(sock, text) {
    for (const adminId of botAdmins) {
        try { await sock.sendMessage(adminId, { text }); } catch(err){}
    }
}

async function sendDailyPrayerSchedule(sock) {
    if (!todayPrayerTimes) await fetchPrayerTimes();
    if (!todayPrayerTimes) return;
    
    let msg = `🕌 *JADWAL SHOLAT HARI INI*\n📍 Wilayah Kendari & Sekitarnya\n🗓️ Tanggal: ${getDateStringWita(getWitaTime())}\n\n`;
    for (const [name, time] of Object.entries(todayPrayerTimes)) {
        msg += `> *${name}:* ${time} WITA\n`;
    }
    msg += `\n_Sistem akan otomatis mengingatkan Admin saat waktu sholat tiba._\n_(Ketik !autoinfosholat off untuk mematikan)_`;
    
    await broadcastToAdmins(sock, msg);
}


// SMART POLLER STATE (Photobooth)
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

export default async function setupMessageHandler(sock) {
    console.log("[System] ZettBOT Photobooth, Utility & Prayer Handler Aktif!");

    // 🕌 EKSEKUSI JADWAL SHOLAT SAAT BOT BARU STARTUP
    if (botSettings.autoSholat) {
        console.log("[System] Mengirim Jadwal Sholat Kendari ke Admin (Startup)...");
        await sendDailyPrayerSchedule(sock);
    }

    // ====================================================================
    // 🕌 CRON-JOB JADWAL SHOLAT (Check Setiap 1 Menit)
    // ====================================================================
    let lastDailySentDate = getDateStringWita(getWitaTime()); // Supaya tidak ngirim double di jam yg sama saat startup
    let lastPrayerReminded = null; // Mencegah spam menit yang sama

    setInterval(async () => {
        if (!botSettings.autoSholat) return;

        const now = getWitaTime();
        const dateStr = getDateStringWita(now);
        const timeStr = formatTimeWita(now);

        // Fetch data baru jika ganti hari
        if (lastFetchDate !== dateStr) {
            await fetchPrayerTimes();
        }

        if (!todayPrayerTimes) return;

        // 1. Broadcast Jadwal Lengkap Jam 00:00 WITA
        if (timeStr === "00:00" && lastDailySentDate !== dateStr) {
            lastDailySentDate = dateStr;
            await sendDailyPrayerSchedule(sock);
        }

        // 2. Broadcast Pengingat Persis di Waktu Sholat
        for (const [name, time] of Object.entries(todayPrayerTimes)) {
            if (timeStr === time) {
                const reminderId = `${name}-${dateStr}`;
                if (lastPrayerReminded !== reminderId) {
                    lastPrayerReminded = reminderId;
                    const adzanMsg = `📢 *WAKTUNYA SHOLAT!*\n\nTelah masuk waktu *${name}* (${time} WITA) untuk wilayah Kota Kendari dan sekitarnya.\n\n_Selamat menunaikan ibadah sholat._ 🕌`;
                    await broadcastToAdmins(sock, adzanMsg);
                    console.log(`[Sholat] Pengingat sholat ${name} terkirim.`);
                }
            }
        }
    }, 60 * 1000); // 1 Menit sekali
    // ====================================================================


    // ====================================================================
    // 🚀 API PULLING SYSTEM (PHOTOBOOTH)
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
                        
                        const msg1 = `🔔 *PESANAN PHOTOBOOTH BARU*\n\nID: ${order.orderId}\nPaket: ${order.paket}\nTotal: Rp${hargaFormat}\nWaktu: ${order.waktu}\n\nSilakan COPY pesan di bawah yang saya berikan\n\nUntuk menyalakan kamera Kiosk secara otomatis.`;
                        const msg2 = `!konfirmasi ${order.orderId}`;
                        
                        await broadcastToAdmins(sock, msg1);
                        await broadcastToAdmins(sock, msg2);
                        
                        notifiedOrders.add(order.orderId);
                        console.log(`[Photobooth] Notifikasi order ${order.orderId} sukses di-broadcast.`);
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
            
            // JID SANITIZER
            const replyJid = msg.key.remoteJid; 
            let senderJid = msg.key.remoteJid; 
            
            if (senderJid.endsWith('@g.us')) {
                senderJid = msg.key.participant || senderJid;
            }
            if (senderJid.includes(':')) {
                senderJid = senderJid.substring(0, senderJid.indexOf(':')) + '@s.whatsapp.net';
            }
            if (senderJid.endsWith('@lid') && msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
                senderJid = msg.key.remoteJid;
                if (senderJid.includes(':')) {
                    senderJid = senderJid.substring(0, senderJid.indexOf(':')) + '@s.whatsapp.net';
                }
            }

            // Keamanan Admin
            const isAdmin = botAdmins.includes(senderJid);
            // Tambahkan autoinfosholat ke array command yang dijaga ketat
            const adminCommands = ['konfirmasi', 'listorder', 'addadmin', 'deladmin', 'listadmin', 'autoinfosholat'];
            
            if (adminCommands.includes(command) && !isAdmin) {
                console.log(`[Security] Akses ditolak untuk ${senderJid} pada command: ${command}`);
                return;
            }

            console.log(`[COMMAND] ${command} dieksekusi oleh: ${senderJid}`);

            switch (command) {
                case 'menu':
                case 'help':
                    const sholatStatus = botSettings.autoSholat ? "✅ ON" : "❌ OFF";
                    const menuText = `*🤖 BOT PHOTOBOOTH & UTILITY 🤖*\n\n` +
                                     `*📷 PHOTOBOOTH (Khusus Admin):*\n` +
                                     `* !konfirmasi <ID>* - Konfirmasi Pelunasan Order\n` +
                                     `* !listorder* - Rekap transaksi hari ini\n\n` +
                                     `*👥 MANAJEMEN ADMIN & SISTEM:*\n` +
                                     `* !addadmin <no_hp/ID>* - Tambah Admin Notif\n` +
                                     `* !deladmin <no_hp/ID>* - Hapus Admin\n` +
                                     `* !listadmin* - Daftar Admin\n` +
                                     `* !autoinfosholat on/off* - Pengingat Sholat [${sholatStatus}]\n\n` +
                                     `*✨ AI & MEDIA (Umum):*\n` +
                                     `* !ai <pesan>* - Chat dengan AI\n` +
                                     `* !sticker / !s* - Buat sticker dari gambar\n\n` +
                                     `*⚙️ UTILITAS (Umum):*\n` +
                                     `* !myid / !cekid* - Cek ID WA kamu\n` +
                                     `* !runtime* - Cek status & memori server\n` +
                                     `* !ping* - Cek kecepatan respon bot\n`;
                    await sock.sendMessage(replyJid, { text: menuText }, { quoted: msg });
                    break;

                // ====================================================================
                // 🚀 COMMAND UMUM
                // ====================================================================
                case 'myid':
                case 'cekid':
                    let idInfo = `*ℹ️ INFORMASI ID ANDA*\n\n*ID Pengirim:* \n${senderJid}\n\n_Ingin didaftarkan sebagai admin? Copy *ID Pengirim* di atas dan berikan ke Owner._\n\n_Owner dapat menambahkannya dengan cara:_\n*!addadmin ${senderJid}*`;
                    await sock.sendMessage(replyJid, { text: idInfo }, { quoted: msg });
                    break;

                case 'ping':
                    const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
                    await sock.sendMessage(replyJid, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingProcess} ms` }, { quoted: msg }); 
                    break;
                    
                case 'runtime':
                    const uptime = process.uptime();
                    await sock.sendMessage(replyJid, { 
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

                // ====================================================================
                // 🚀 COMMAND KHUSUS ADMIN
                // ====================================================================
                case 'autoinfosholat':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!autoinfosholat on* atau *!autoinfosholat off*" });
                    const param = args[0].toLowerCase();
                    if (param === 'on') {
                        botSettings.autoSholat = true;
                        saveSettings();
                        await sock.sendMessage(replyJid, { text: "✅ Fitur Pengingat Sholat (WITA) BERHASIL diaktifkan." });
                        await sendDailyPrayerSchedule(sock); // Langsung kirim jadwal setelah diaktifkan
                    } else if (param === 'off') {
                        botSettings.autoSholat = false;
                        saveSettings();
                        await sock.sendMessage(replyJid, { text: "❌ Fitur Pengingat Sholat (WITA) DIMATIKAN." });
                    } else {
                        await sock.sendMessage(replyJid, { text: "⚠️ Gunakan *on* atau *off*." });
                    }
                    break;

                case 'addadmin':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!addadmin 628xxx* atau *!addadmin id@lid*" });
                    const newAdmin = formatPhoneToJid(args[0]);
                    if (!botAdmins.includes(newAdmin)) {
                        botAdmins.push(newAdmin);
                        saveAdmins();
                        await sock.sendMessage(replyJid, { text: `✅ Berhasil! ID ${newAdmin} sukses ditambahkan sebagai Admin.` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(replyJid, { text: `⚠️ Nomor/ID tersebut sudah menjadi admin.` }, { quoted: msg });
                    }
                    break;

                case 'deladmin':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!deladmin 628xxx* atau *!deladmin id@lid*" });
                    const delTarget = formatPhoneToJid(args[0]);
                    if (delTarget === ownerNumber || delTarget === "247922893566044@lid") {
                        return await sock.sendMessage(replyJid, { text: "❌ Anda tidak bisa menghapus ID Owner utama." });
                    }
                    
                    if (botAdmins.includes(delTarget)) {
                        botAdmins = botAdmins.filter(a => a !== delTarget);
                        saveAdmins();
                        await sock.sendMessage(replyJid, { text: `✅ Berhasil! ID ${delTarget} sukses dihapus dari Admin.` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(replyJid, { text: `⚠️ Nomor/ID tidak ditemukan dalam daftar admin.` }, { quoted: msg });
                    }
                    break;

                case 'listadmin':
                    let adList = "👥 *DAFTAR ADMIN PHOTOBOOTH*\n\n";
                    botAdmins.forEach((a, i) => adList += `${i+1}. ${a}\n`);
                    await sock.sendMessage(replyJid, { text: adList }, { quoted: msg });
                    break;

                case 'listorder':
                    await sock.sendMessage(replyJid, { text: `⏳ _Menarik data orderan hari ini dari Database..._` }, { quoted: msg });
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
                            await sock.sendMessage(replyJid, { text: orderList }, { quoted: msg });
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ Gagal: ${result.message}` }, { quoted: msg });
                        }
                    } catch (e) {
                        await sock.sendMessage(replyJid, { text: `❌ Error terhubung ke database.` }, { quoted: msg });
                    }
                    break;

                case 'konfirmasi':
                    if (!args[0]) {
                        await sock.sendMessage(replyJid, { 
                            text: "⚠️ *Format Salah*\nGunakan format: *!konfirmasi <ID_Transaksi>*\n\nContoh: !konfirmasi MALL-20260616-0001" 
                        }, { quoted: msg });
                        break;
                    }
                    
                    const orderId = args[0];
                    const adminPhone = senderJid.split('@')[0]; 
                    await sock.sendMessage(replyJid, { text: `⏳ _Memproses pelunasan untuk ID ${orderId}..._` }, { quoted: msg });
                    
                    try {
                        const response = await fetch(PHOTOBOOTH_GAS_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                action: "konfirmasi_lunas",
                                orderId: orderId,
                                confirmedBy: "Admin " + adminPhone 
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (result.status === "success") {
                            await sock.sendMessage(replyJid, { 
                                text: `✅ *KONFIRMASI LUNAS BERHASIL*\n\nID: ${orderId}\nSistem Kiosk di mall telah otomatis dilanjutkan ke sesi kamera!` 
                            }, { quoted: msg });
                            
                            for (const adminId of botAdmins) {
                                if (adminId !== senderJid) { 
                                    try {
                                        await sock.sendMessage(adminId, { 
                                            text: `ℹ️ *INFO SISTEM*\nPesanan ${orderId} telah dikonfirmasi lunas oleh Admin ${adminPhone}.` 
                                        });
                                    } catch(e){}
                                }
                            }
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ *Gagal Konfirmasi:*\n${result.message}` }, { quoted: msg });
                        }
                    } catch (err) {
                        await sock.sendMessage(replyJid, { text: `❌ *Gagal terhubung ke Server Photobooth.*` }, { quoted: msg });
                    }
                    break;
            }
        } catch (error) { 
            console.error('Error proses pesan:', error); 
        }
    });
}
