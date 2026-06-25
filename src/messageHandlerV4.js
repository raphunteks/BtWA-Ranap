import fs from 'fs';
import process from 'process';
import os from 'os';

// 🚀 UPGRADE: Import generateWAMessageFromContent & proto untuk Bypass WA Business
import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys'; 

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

let botSettings = { autoSholat: true, autoGempa: true, autoCuaca: true };
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

function formatPhoneToJid(phone) {
    if (phone.endsWith('@lid') || phone.endsWith('@s.whatsapp.net') || phone.endsWith('@g.us')) return phone;
    let p = phone.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (p.startsWith('8')) p = '62' + p;
    return p + "@s.whatsapp.net";
}

function getWitaTime() {
    const now = new Date();
    const witaString = now.toLocaleString("en-US", { timeZone: "Asia/Makassar" });
    return new Date(witaString);
}
function formatTimeWita(date) { return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function getDateStringWita(date) { return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; }

// ====================================================================
// 🌍 MODUL API: JADWAL SHOLAT, CUACA & GEMPA
// ====================================================================

// 1. SHOLAT (KENDARI)
let todayPrayerTimes = null;
let lastFetchDate = null;

async function fetchPrayerTimes() {
    try {
        const res = await fetch("https://api.aladhan.com/v1/timingsByCity?city=Kendari&country=Indonesia&method=20");
        const data = await res.json();
        if (data.code === 200) {
            const t = data.data.timings;
            todayPrayerTimes = { Subuh: t.Fajr, Dzuhur: t.Dhuhr, Ashar: t.Asr, Maghrib: t.Maghrib, Isya: t.Isha };
            lastFetchDate = getDateStringWita(getWitaTime());
            return true;
        }
    } catch (e) { console.error("[System] Gagal fetch jadwal sholat", e); }
    return false;
}

// 2. CUACA (KENDARI)
const WMO_CODES = { 0: "Cerah ☀️", 1: "Cerah Berawan 🌤️", 2: "Berawan ⛅", 3: "Mendung ☁️", 45: "Berkabut 🌫️", 48: "Kabut Tebal 🌫️", 51: "Gerimis 🌧️", 53: "Gerimis 🌧️", 55: "Gerimis Lebat 🌧️", 61: "Hujan Ringan 🌧️", 63: "Hujan Sedang 🌧️", 65: "Hujan Lebat 🌧️", 80: "Hujan Lokal 🌦️", 81: "Hujan Lokal 🌦️", 82: "Hujan Lokal Lebat 🌧️", 95: "Badai Petir ⛈️" };

async function fetchCuaca() {
    try {
        const res = await fetch("https://api.open-meteo.com/v1/forecast?latitude=-3.9985&longitude=122.5156&daily=weather_code,temperature_2m_max,temperature_2m_min&current_weather=true&timezone=Asia%2FMakassar");
        return await res.json();
    } catch(e) { console.error("[System] Gagal fetch cuaca", e); }
    return null;
}

async function formatCuacaMsg(tipe = "hari_ini") {
    const data = await fetchCuaca();
    if(!data) return "⚠️ Maaf, gagal mengambil data cuaca saat ini.";
    
    let index = tipe === "besok" ? 1 : 0;
    let title = tipe === "besok" ? "PRAKIRAAN CUACA BESOK" : "INFO CUACA HARI INI";
    
    const wcode = data.daily.weather_code[index];
    const kondisi = WMO_CODES[wcode] || "Tidak Diketahui";
    const tMax = data.daily.temperature_2m_max[index];
    const tMin = data.daily.temperature_2m_min[index];
    const tgl = data.daily.time[index];

    let msg = `🌤️ *${title}*\n📍 Kota Kendari & Sekitarnya\n🗓️ Tanggal: ${tgl}\n\n`;
    msg += `> *Kondisi:* ${kondisi}\n`;
    msg += `> *Suhu:* ${tMin}°C - ${tMax}°C\n\n`;
    
    if (tipe === "hari_ini") {
        const curCode = data.current_weather.weathercode;
        msg += `🌡️ *Saat Ini:* ${WMO_CODES[curCode] || "-"} (${data.current_weather.temperature}°C)\n`;
    }
    return msg;
}

// 3. GEMPA (BMKG)
let lastGempaId = null;

async function checkGempa() {
    try {
        const res = await fetch("https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json");
        const data = await res.json();
        return data.Infogempa.gempa;
    } catch(e) { console.error("[System] Gagal fetch gempa", e); }
    return null;
}

function createGempaMessage(gempa, isBroadcast = false) {
    const title = isBroadcast ? "🚨 *PERINGATAN GEMPA BARU DARI BMKG* 🚨" : "🌋 *INFO GEMPA TERAKHIR*";
    const msg = `${title}\n\n📅 Waktu: ${gempa.Tanggal} | ${gempa.Jam}\n📍 Lokasi: ${gempa.Wilayah}\n🎛️ Magnitudo: *${gempa.Magnitude} SR*\n🌊 Kedalaman: ${gempa.Kedalaman}\n\n⚠️ *Potensi:* ${gempa.Potensi}\n🗺️ Dirasakan: ${gempa.Dirasakan || "-"}\n\n_Sumber: BMKG_`;
    
    return {
        image: { url: `https://data.bmkg.go.id/DataMKG/TEWS/${gempa.Shakemap}` },
        caption: msg
    };
}

// 🚀 UPGRADE: BROADCAST HELPER UNTUK ANTI-BLOCK WA BUSINESS
async function broadcastToAdmins(sock, messagePayload, fallbackText = null) {
    for (const adminId of botAdmins) {
        try { 
            if (typeof messagePayload === 'string') { 
                await sock.sendMessage(adminId, { text: messagePayload }); 
            } else if (messagePayload.isInteractive) {
                try {
                    const msgContent = generateWAMessageFromContent(adminId, {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                                interactiveMessage: messagePayload.payload
                            }
                        }
                    }, { userJid: sock.user?.id || sock.user?.jid });

                    await sock.relayMessage(adminId, msgContent.message, { messageId: msgContent.key.id });
                } catch (err) {
                    console.error(`[System] Gagal kirim List Message ke ${adminId}, menggunakan Fallback Text.`);
                    if (fallbackText) await sock.sendMessage(adminId, { text: fallbackText });
                }
            } else { 
                await sock.sendMessage(adminId, messagePayload); 
            }
        } catch(err){}
    }
}

async function sendDailyPrayerSchedule(sock) {
    if (!todayPrayerTimes) await fetchPrayerTimes();
    if (!todayPrayerTimes) return;
    let msg = `🕌 *JADWAL SHOLAT HARI INI*\n📍 Wilayah Kendari\n🗓️ Tanggal: ${getDateStringWita(getWitaTime())}\n\n`;
    for (const [name, time] of Object.entries(todayPrayerTimes)) { msg += `> *${name}:* ${time} WITA\n`; }
    await broadcastToAdmins(sock, msg);
}

// ====================================================================
// 🚀 MAIN HANDLER & CRON JOBS
// ====================================================================
const notifiedOrders = new Set();

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} days ago`; if (h > 0) return `${h} hours ago`; if (m > 0) return `${m} minutes ago`;
    return `${Math.floor(seconds)} seconds ago`;
}

export default async function setupMessageHandler(sock) {
    console.log("[System] ZettBOT Photobooth, Utility, Prayer & BMKG Handler Aktif!");

    setTimeout(async () => {
        if (botSettings.autoSholat) await sendDailyPrayerSchedule(sock);
        if (botSettings.autoCuaca) {
            const cMsg = await formatCuacaMsg("hari_ini");
            await broadcastToAdmins(sock, cMsg);
        }
        if (botSettings.autoGempa) {
            const g = await checkGempa();
            if (g) {
                lastGempaId = g.DateTime; 
                await broadcastToAdmins(sock, createGempaMessage(g, false));
            }
        }
    }, 5000); 

    let lastDailySentDate = getDateStringWita(getWitaTime()); 
    let lastPrayerReminded = null; 

    setInterval(async () => {
        const now = getWitaTime();
        const dateStr = getDateStringWita(now);
        const timeStr = formatTimeWita(now);

        if (botSettings.autoSholat) {
            if (lastFetchDate !== dateStr) await fetchPrayerTimes();
            if (todayPrayerTimes) {
                if (timeStr === "00:00" && lastDailySentDate !== dateStr) {
                    lastDailySentDate = dateStr;
                    await sendDailyPrayerSchedule(sock);
                }
                for (const [name, time] of Object.entries(todayPrayerTimes)) {
                    if (timeStr === time) {
                        const reminderId = `${name}-${dateStr}`;
                        if (lastPrayerReminded !== reminderId) {
                            lastPrayerReminded = reminderId;
                            const adzanMsg = `📢 *WAKTUNYA SHOLAT!*\n\nTelah masuk waktu *${name}* (${time} WITA) untuk wilayah Kota Kendari dan sekitarnya.\n\n_Selamat menunaikan ibadah sholat._ 🕌`;
                            await broadcastToAdmins(sock, adzanMsg);
                        }
                    }
                }
            }
        }

        if (botSettings.autoCuaca) {
            if (timeStr === "06:00") { 
                const msg = await formatCuacaMsg("hari_ini");
                await broadcastToAdmins(sock, msg);
            }
            if (timeStr === "20:00") { 
                const msg = await formatCuacaMsg("besok");
                await broadcastToAdmins(sock, msg);
            }
        }

        if (botSettings.autoGempa) {
            const g = await checkGempa();
            if (g && lastGempaId !== g.DateTime) {
                lastGempaId = g.DateTime;
                await broadcastToAdmins(sock, createGempaMessage(g, true));
            }
        }
    }, 60 * 1000); 

    // ====================================================================
    // 📷 POLLER PHOTOBOOTH DENGAN QUICK REPLY BUTTON BYPASS
    // ====================================================================
    setInterval(async () => {
        try {
            const response = await fetch(PHOTOBOOTH_GAS_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: "get_pending_orders" })
            });
            const result = await response.json();
            
            if (result.status === "success" && result.data && result.data.length > 0) {
                for (const order of result.data) {
                    if (!notifiedOrders.has(order.orderId)) {
                        const hargaFormat = parseInt(order.harga).toLocaleString('id-ID');
                        
                        const interactivePayload = {
                            isInteractive: true,
                            payload: {
                                contextInfo: { isForwarded: true, forwardingScore: 999 },
                                header: { title: "Pesanan Masuk", hasMediaAttachment: false },
                                body: { text: `🔔 *PESANAN PHOTOBOOTH BARU*\n\nID: *${order.orderId}*\nPaket: ${order.paket}\nTotal: Rp${hargaFormat}\nWaktu: ${order.waktu}\n\n_Silakan ketuk tombol di bawah untuk menyalakan Kiosk._` },
                                footer: { text: "Kiosk Photobooth Bot" },
                                nativeFlowMessage: {
                                    buttons: [
                                        {
                                            name: "quick_reply",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "✅ Konfirmasi Lunas",
                                                id: `!konfirmasi ${order.orderId}`
                                            })
                                        }
                                    ]
                                }
                            }
                        };
                        
                        const fallbackOrderText = `🔔 *PESANAN PHOTOBOOTH BARU*\n\nID: *${order.orderId}*\nPaket: ${order.paket}\nTotal: Rp${hargaFormat}\nWaktu: ${order.waktu}\n\n*⚠️ Tombol Konfirmasi Gagal Dimuat*\nKetik manual untuk konfirmasi:\n*!konfirmasi ${order.orderId}*`;
                        
                        await broadcastToAdmins(sock, interactivePayload, fallbackOrderText);
                        notifiedOrders.add(order.orderId);
                    }
                }
            }
        } catch (err) {}
    }, 10000); 

    // ====================================================================
    // 💬 MESSAGE LISTENER & COMMANDS
    // ====================================================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            let text = '';
            if (msg.message.conversation) text = msg.message.conversation;
            else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
            else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;
            else if (msg.message.videoMessage?.caption) text = msg.message.videoMessage.caption;
            else if (msg.message.listResponseMessage?.singleSelectReply?.selectedRowId) text = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
            else if (msg.message.buttonsResponseMessage?.selectedButtonId) text = msg.message.buttonsResponseMessage.selectedButtonId;
            else if (msg.message.templateButtonReplyMessage?.selectedId) text = msg.message.templateButtonReplyMessage.selectedId;
            else if (msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
                try { 
                    let params = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson); 
                    text = params.id || ''; 
                } catch(e) {}
            }
                         
            const prefix = '!'; 
            if (!text || !text.startsWith(prefix)) return;

            const args = text.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            
            const replyJid = msg.key.remoteJid; 
            let senderJid = msg.key.remoteJid; 
            if (senderJid.endsWith('@g.us')) senderJid = msg.key.participant || senderJid;
            if (senderJid.includes(':')) senderJid = senderJid.substring(0, senderJid.indexOf(':')) + '@s.whatsapp.net';
            if (senderJid.endsWith('@lid') && msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
                senderJid = msg.key.remoteJid;
                if (senderJid.includes(':')) senderJid = senderJid.substring(0, senderJid.indexOf(':')) + '@s.whatsapp.net';
            }

            const isAdmin = botAdmins.includes(senderJid);
            const adminCommands = ['konfirmasi', 'listorder', 'addadmin', 'deladmin', 'listadmin', 'autoinfosholat', 'autocuaca', 'autogempa'];
            
            // 🚀 UPGRADE: Jika bukan admin tapi coba jalankan fitur Admin, beri peringatan bukan sekadar diam!
            if (adminCommands.includes(command) && !isAdmin) {
                return await sock.sendMessage(replyJid, { text: "⚠️ *Akses Ditolak*\nMaaf, perintah tersebut khusus untuk Admin sistem." }, { quoted: msg });
            }

            console.log(`[COMMAND] ${command} dieksekusi oleh: ${senderJid} (Admin: ${isAdmin})`);

            switch (command) {
                // 🚀 UPGRADE: MENU DINAMIS UNTUK PUBLIK & ADMIN (WA BUSINESS BYPASS)
                case 'menu':
                case 'help':
                    if (args[0] === 'ai') { return await sock.sendMessage(replyJid, { text: "🤖 *Cara Pakai AI:*\nKetik *!ai <pertanyaan>*\nContoh: !ai Siapa presiden indonesia?" }, { quoted: msg }); }
                    if (args[0] === 'sticker') { return await sock.sendMessage(replyJid, { text: "🖼️ *Cara Bikin Sticker:*\nKirimkan gambar dengan caption *!s* atau balas sebuah gambar dengan *!s*" }, { quoted: msg }); }

                    // 1. MEMBUAT LIST MENU SECARA DINAMIS (BEDA ADMIN BEDA USER BIASA)
                    const menuSections = [];

                    // Jika yang ketik adalah Admin, tambahkan Menu Khusus Admin
                    if (isAdmin) {
                        menuSections.push({
                            title: "📷 PHOTOBOOTH (Menu Admin)",
                            rows: [{ title: "📋 Rekap Transaksi", description: "Cek pendapatan & orderan hari ini", id: "!listorder" }]
                        });
                        menuSections.push({
                            title: "⚙️ TOGGLE SISTEM (Menu Admin)",
                            rows: [
                                { title: `🕌 Sholat: ${botSettings.autoSholat?"[ON]":"[OFF]"}`, description: "Pengingat Adzan", id: `!autoinfosholat ${botSettings.autoSholat?"off":"on"}` },
                                { title: `⛅ Cuaca: ${botSettings.autoCuaca?"[ON]":"[OFF]"}`, description: "Prakiraan Kendari", id: `!autocuaca ${botSettings.autoCuaca?"off":"on"}` },
                                { title: `🚨 Gempa: ${botSettings.autoGempa?"[ON]":"[OFF]"}`, description: "Notifikasi BMKG", id: `!autogempa ${botSettings.autoGempa?"off":"on"}` },
                                { title: "👥 Daftar Admin", description: "Lihat siapa saja Admin", id: "!listadmin" }
                            ]
                        });
                    }

                    // Menu Publik (Tampil untuk semua orang)
                    menuSections.push({
                        title: "✨ AI & MEDIA",
                        rows: [
                            { title: "🤖 Cara Pakai AI", description: "Bantuan chat AI", id: "!help ai" },
                            { title: "🖼️ Cara Bikin Sticker", description: "Bantuan stiker WA", id: "!help sticker" }
                        ]
                    });
                    menuSections.push({
                        title: "🛠️ INFO UTILITIES",
                        rows: [
                            { title: "🌋 Gempa Terakhir", description: "Info gempa BMKG saat ini", id: "!gempa" },
                            { title: "🌤️ Cuaca Kendari", description: "Info cuaca hari ini", id: "!cuaca" },
                            { title: "ℹ️ Cek ID Saya", description: "Untuk daftar Admin", id: "!myid" },
                            { title: "📈 Status Server", description: "Ping & Uptime", id: "!runtime" }
                        ]
                    });

                    // 2. PAYLOAD LIST MENU DENGAN BYPASS
                    const interactiveMenu = {
                        contextInfo: { isForwarded: true, forwardingScore: 999 },
                        header: { title: "🤖 MENU UTAMA", hasMediaAttachment: false },
                        body: { text: `👋 Halo! Ini adalah *ZettBOT Control Center*.\nSilakan tekan tombol di bawah untuk memunculkan pilihan menu yang tersedia.` },
                        footer: { text: "ZettBOT Utility & Photobooth" },
                        nativeFlowMessage: {
                            buttons: [
                                {
                                    name: "single_select",
                                    buttonParamsJson: JSON.stringify({
                                        title: "Buka Menu",
                                        sections: menuSections
                                    })
                                }
                            ]
                        }
                    };

                    // 3. FALLBACK TEXT DINAMIS (Jika tombol direject oleh WA Client)
                    let fallbackMenuText = `*🤖 MENU ZETTBOT (Mode Teks) 🤖*\n_Tombol interaktif gagal dimuat. Silakan ketik manual command di bawah:_\n\n`;
                    if (isAdmin) {
                        fallbackMenuText += `*📷 PHOTOBOOTH (Admin):*\n> !konfirmasi <ID>\n> !listorder\n\n` +
                        `*⚙️ TOGGLE SISTEM (Admin):*\n> !autoinfosholat [on/off]\n> !autocuaca [on/off]\n> !autogempa [on/off]\n> !addadmin <ID>\n> !deladmin <ID>\n> !listadmin\n\n`;
                    }
                    fallbackMenuText += `*✨ AI & UTILITIES:*\n> !ai <pertanyaan>\n> !s (untuk stiker)\n> !gempa\n> !cuaca\n> !myid\n> !runtime\n> !ping`;
                    
                    try {
                        const msgContent = generateWAMessageFromContent(replyJid, {
                            viewOnceMessage: {
                                message: {
                                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                                    interactiveMessage: interactiveMenu
                                }
                            }
                        }, { userJid: sock.user?.id || sock.user?.jid });

                        await sock.relayMessage(replyJid, msgContent.message, { messageId: msgContent.key.id });
                    } catch (err) {
                        console.error("[System] Tombol Menu Gagal dikirim, mengirim Teks Manual.", err);
                        await sock.sendMessage(replyJid, { text: fallbackMenuText }, { quoted: msg });
                    }
                    break;

                // ====================================================================
                case 'gempa':
                    await sock.sendMessage(replyJid, { text: "⏳ _Menarik data BMKG terbaru..._" }, { quoted: msg });
                    const g = await checkGempa();
                    if (g) await sock.sendMessage(replyJid, createGempaMessage(g, false), { quoted: msg });
                    else await sock.sendMessage(replyJid, { text: "❌ Gagal mengambil data BMKG." }, { quoted: msg });
                    break;

                case 'cuaca':
                    await sock.sendMessage(replyJid, { text: "⏳ _Mengecek langit Kendari..._" }, { quoted: msg });
                    const cMsg = await formatCuacaMsg("hari_ini");
                    await sock.sendMessage(replyJid, { text: cMsg }, { quoted: msg });
                    break;

                case 'autoinfosholat': case 'autocuaca': case 'autogempa':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: `⚠️ Format: *!${command} on* atau *!${command} off*` });
                    const param = args[0].toLowerCase();
                    const settingKey = command === 'autoinfosholat' ? 'autoSholat' : (command === 'autocuaca' ? 'autoCuaca' : 'autoGempa');
                    const label = command === 'autoinfosholat' ? 'Pengingat Sholat' : (command === 'autocuaca' ? 'Auto Cuaca' : 'Auto Gempa BMKG');
                    
                    if (param === 'on') {
                        botSettings[settingKey] = true; saveSettings();
                        await sock.sendMessage(replyJid, { text: `✅ Fitur *${label}* BERHASIL diaktifkan.` });
                        if (settingKey === 'autoSholat') await sendDailyPrayerSchedule(sock);
                        if (settingKey === 'autoCuaca') await broadcastToAdmins(sock, await formatCuacaMsg("hari_ini"));
                        if (settingKey === 'autoGempa') { const newG = await checkGempa(); if(newG) await broadcastToAdmins(sock, createGempaMessage(newG, false)); }
                    } else if (param === 'off') {
                        botSettings[settingKey] = false; saveSettings();
                        await sock.sendMessage(replyJid, { text: `❌ Fitur *${label}* DIMATIKAN.` });
                    }
                    break;

                case 'myid': case 'cekid':
                    await sock.sendMessage(replyJid, { text: `*ℹ️ INFORMASI ID ANDA*\n\n*ID Pengirim:* \n${senderJid}\n\n_Ingin didaftarkan sebagai admin? Copy *ID Pengirim* di atas dan berikan ke Owner._\n\n_Owner dapat menambahkannya dengan cara:_\n*!addadmin ${senderJid}*` }, { quoted: msg });
                    break;

                case 'ping':
                    const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
                    await sock.sendMessage(replyJid, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingProcess} ms` }, { quoted: msg }); 
                    break;
                    
                case 'runtime':
                    const uptime = process.uptime();
                    await sock.sendMessage(replyJid, { text: `⏳ *Bot Uptime:* ${getRelativeTime(uptime)}\n🖥️ *OS Memory:* ${Math.round(os.freemem()/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB` }, { quoted: msg });
                    break;
                
                case 'ai': if(typeof handleAiCommand === 'function') await handleAiCommand(sock, msg, args); break;
                case 'sticker': case 's': if(typeof handleStickerCommand === 'function') await handleStickerCommand(sock, msg); break;

                case 'addadmin':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!addadmin 628xxx* atau *!addadmin id@lid*" });
                    const newAdmin = formatPhoneToJid(args[0]);
                    if (!botAdmins.includes(newAdmin)) {
                        botAdmins.push(newAdmin); saveAdmins();
                        await sock.sendMessage(replyJid, { text: `✅ Berhasil! ID ${newAdmin} sukses ditambahkan sebagai Admin.` }, { quoted: msg });
                    } else await sock.sendMessage(replyJid, { text: `⚠️ Nomor/ID tersebut sudah menjadi admin.` }, { quoted: msg });
                    break;

                case 'deladmin':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!deladmin 628xxx* atau *!deladmin id@lid*" });
                    const delTarget = formatPhoneToJid(args[0]);
                    if (delTarget === ownerNumber || delTarget === "247922893566044@lid") return await sock.sendMessage(replyJid, { text: "❌ Anda tidak bisa menghapus ID Owner utama." });
                    if (botAdmins.includes(delTarget)) {
                        botAdmins = botAdmins.filter(a => a !== delTarget); saveAdmins();
                        await sock.sendMessage(replyJid, { text: `✅ Berhasil! ID ${delTarget} sukses dihapus dari Admin.` }, { quoted: msg });
                    } else await sock.sendMessage(replyJid, { text: `⚠️ Nomor/ID tidak ditemukan dalam daftar admin.` }, { quoted: msg });
                    break;

                case 'listadmin':
                    let adList = "👥 *DAFTAR ADMIN PHOTOBOOTH*\n\n";
                    botAdmins.forEach((a, i) => adList += `${i+1}. ${a}\n`);
                    await sock.sendMessage(replyJid, { text: adList }, { quoted: msg });
                    break;

                case 'listorder':
                    await sock.sendMessage(replyJid, { text: `⏳ _Menarik data orderan hari ini dari Database..._` }, { quoted: msg });
                    try {
                        const response = await fetch(PHOTOBOOTH_GAS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "get_today_orders" }) });
                        const result = await response.json();
                        
                        if (result.status === "success") {
                            let orderList = `📋 *REKAP ORDERAN HARI INI*\n\n`;
                            let totalPendapatan = 0;
                            if (result.data.length === 0) orderList += `_Belum ada transaksi hari ini._`;
                            else {
                                result.data.forEach((o, i) => {
                                    const hargaFormat = parseInt(o.harga).toLocaleString('id-ID');
                                    orderList += `*${i+1}. ${o.orderId}*\n⏱️ ${o.waktu.split(' ')[1] || o.waktu}\n📦 ${o.paket} (Rp${hargaFormat})\n💳 ${o.metode}\n📌 Status: ${o.status}\n\n`;
                                    if(o.status.toUpperCase() === "LUNAS") totalPendapatan += parseInt(o.harga);
                                });
                                orderList += `💰 *TOTAL LUNAS:* Rp${totalPendapatan.toLocaleString('id-ID')}`;
                            }
                            await sock.sendMessage(replyJid, { text: orderList }, { quoted: msg });
                        } else await sock.sendMessage(replyJid, { text: `❌ Gagal: ${result.message}` }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(replyJid, { text: `❌ Error terhubung ke database.` }, { quoted: msg }); }
                    break;

                case 'konfirmasi':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ *Format Salah*\nGunakan format: *!konfirmasi <ID_Transaksi>*\n\nContoh: !konfirmasi MALL-20260616-0001" }, { quoted: msg });
                    
                    const orderId = args[0];
                    const adminPhone = senderJid.split('@')[0]; 
                    await sock.sendMessage(replyJid, { text: `⏳ _Memproses pelunasan untuk ID ${orderId}..._` }, { quoted: msg });
                    
                    try {
                        const response = await fetch(PHOTOBOOTH_GAS_URL, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: "konfirmasi_lunas", orderId: orderId, confirmedBy: "Admin " + adminPhone })
                        });
                        const result = await response.json();
                        
                        if (result.status === "success") {
                            await sock.sendMessage(replyJid, { text: `✅ *KONFIRMASI LUNAS BERHASIL*\n\nID: ${orderId}\nSistem Kiosk di mall telah otomatis dilanjutkan ke sesi kamera!` }, { quoted: msg });
                            for (const adminId of botAdmins) {
                                if (adminId !== senderJid) { 
                                    try { await sock.sendMessage(adminId, { text: `ℹ️ *INFO SISTEM*\nPesanan ${orderId} telah dikonfirmasi lunas oleh Admin ${adminPhone}.` }); } catch(e){}
                                }
                            }
                        } else await sock.sendMessage(replyJid, { text: `❌ *Gagal Konfirmasi:*\n${result.message}` }, { quoted: msg });
                    } catch (err) { await sock.sendMessage(replyJid, { text: `❌ *Gagal terhubung ke Server Photobooth.*` }, { quoted: msg }); }
                    break;
            }
        } catch (error) { console.error('Error proses pesan:', error); }
    });
}
