import fs from 'fs';
import process from 'process';
import os from 'os';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys'; 
import express from 'express'; // 🚀 UPGRADE: Tambahkan library express untuk menerima Webhook dari Google Apps Script

// Handler perintah eksternal (Pastikan file ini ada di folder /commands Anda)
// Jika tidak ada, bisa di-comment saja agar tidak error
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ====================================================================
// 🚀 KONFIGURASI API E-VOTING BEM FKG UMI
// ====================================================================
const ownerNumber = process.env.OWNER_NUMBER || "247922893566044@lid";

// PASTE URL ENDPOINT GAS ANDA DI SINI
const EVOT_API_URL = process.env.EVOT_API_URL || "https://script.google.com/macros/s/AKfycbxw3v9--RsgQoXMRpwTvApotQZ-UmlTuH_mHpRGZIiMryxirWPSJjPcSwdtMUngcBEn/exec";

// ====================================================================
// 📁 SESSION & MULTI-ADMIN LOGIC
// ====================================================================
const sessionPath = './session';
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log("[System] Folder session dibuat.");
}

const adminsFile = `${sessionPath}/admins.json`;
let botAdmins = [ownerNumber, "247922893566044@lid", "6282122224408@s.whatsapp.net"]; 

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

function formatPhoneToJid(phone) {
    if (phone.endsWith('@lid') || phone.endsWith('@s.whatsapp.net') || phone.endsWith('@g.us')) return phone;
    let p = phone.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (p.startsWith('8')) p = '62' + p;
    return p + "@s.whatsapp.net";
}

// Convert JID (628...) ke format Lokal (08...) untuk pencocokan Database Google Sheets
function formatJidToLocal(jid) {
    let p = jid.split('@')[0].replace(/[^0-9]/g, '');
    if (p.startsWith('62')) p = '0' + p.slice(2);
    return p;
}

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} hari yang lalu`; if (h > 0) return `${h} jam yang lalu`; if (m > 0) return `${m} menit yang lalu`;
    return `${Math.floor(seconds)} detik yang lalu`;
}

// ====================================================================
// 🚀 MAIN HANDLER BOT E-VOTING
// ====================================================================
export default async function setupMessageHandler(sock) {
    console.log("[System] BOT E-VOTING BEM FKG UMI Handler Aktif!");

    // ====================================================================
    // 🌐 WEBHOOK SERVER: MENERIMA TRIGGER OTOMATIS DARI GOOGLE APPS SCRIPT
    // ====================================================================
    const app = express();
    app.use(express.json());
    const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;

    app.post('/webhook/evot', async (req, res) => {
        try {
            const data = req.body;
            if (data && data.action === 'send_token') {
                
                // 1. Konversi format nomor web (08...) ke format JID WhatsApp (628...@s.whatsapp.net)
                let targetWa = data.wa;
                if (targetWa.startsWith('0')) targetWa = '62' + targetWa.slice(1);
                if (!targetWa.includes('@')) targetWa = targetWa + '@s.whatsapp.net';

                // 2. Template Pesan WA yang akan dikirim OTOMATIS
                let txt = `🎓 *SELAMAT, AKTIVASI BERHASIL!* 🎓\n\n`;
                txt += `Halo *${data.nama.toUpperCase()}*,\n`;
                txt += `Pendaftaran DPT E-Voting BEM FKG UMI Anda telah berhasil dikonfirmasi oleh sistem.\n\n`;
                txt += `🆔 *NIM:* ${data.nim}\n`;
                txt += `🔑 *TOKEN RAHASIA:* \n*${data.token}*\n\n`;
                txt += `_Gunakan NIM dan Token di atas untuk login ke website pemilihan. Jangan bagikan token ini kepada siapapun demi kerahasiaan suara Anda!_\n\n`;
                txt += `Ketik *!menu* untuk melihat layanan bantuan.`;

                // 3. Eksekusi pengiriman pesan tanpa delay
                await sock.sendMessage(targetWa, { text: txt });
                console.log(`[Webhook 🚀] Token otomatis terkirim ke: ${data.nama} (${data.wa})`);
                
                return res.status(200).json({ status: 'success', message: 'Pesan otomatis berhasil dikirim' });
            }
            res.status(400).json({ status: 'error', message: 'Action webhook tidak valid' });
        } catch (error) {
            console.error('[Webhook Error ❌]', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    app.listen(WEBHOOK_PORT, () => {
        console.log(`[System 🌐] Webhook Listener KPU Aktif!`);
        console.log(`[System 🌐] Menunggu trigger dari GAS di port ${WEBHOOK_PORT} (http://localhost:${WEBHOOK_PORT}/webhook/evot)`);
    });
    // ====================================================================

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            // Tangkap Input Teks atau Interaktif
            let text = '';
            if (msg.message.conversation) text = msg.message.conversation;
            else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
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

            const senderNum = senderJid.split('@')[0];
            const isAdmin = botAdmins.some(adminStr => adminStr.startsWith(senderNum));
            const userWaLocal = formatJidToLocal(senderJid); // Hasil: 081234567890
            
            // 🚀 PROTEKSI COMMAND ADMIN 
            const adminCommands = ['addadmin', 'deladmin', 'listadmin', 'restart'];
            if (adminCommands.includes(command) && !isAdmin) {
                return await sock.sendMessage(replyJid, { text: "⚠️ *Akses Ditolak*\nMaaf, perintah tersebut khusus untuk Panitia/Admin KPU." }, { quoted: msg });
            }

            console.log(`[COMMAND] ${command} dieksekusi oleh: ${senderJid} (Lokal: ${userWaLocal})`);

            switch (command) {
                // ==========================================
                // 🎓 FITUR MAHASISWA / PEMILIH
                // ==========================================
                case 'token':
                case 'minta-token':
                    await sock.sendMessage(replyJid, { text: "⏳ _Mencari data aktivasi Anda di sistem KPU..._" }, { quoted: msg });
                    try {
                        const res = await fetch(`${EVOT_API_URL}?action=botApi&command=GET_TOKEN&wa=${userWaLocal}`);
                        const data = await res.json();
                        
                        if(data.status === 'success') {
                            let statusText = data.data.status_vote === "Sudah" ? "✅ SUDAH MEMILIH" : "⚠️ BELUM MEMILIH";
                            let txt = `🎓 *HALO, ${data.data.nama.toUpperCase()}*\n\n`;
                            txt += `Pendaftaran DPT E-Voting BEM FKG UMI Anda telah berhasil dikonfirmasi.\n\n`;
                            txt += `🆔 *NIM:* ${data.data.nim}\n`;
                            txt += `🔑 *TOKEN RAHASIA:* \n*${data.data.token}*\n\n`;
                            txt += `📊 *Status Pemilihan:* ${statusText}\n\n`;
                            txt += `_Gunakan NIM dan Token di atas untuk masuk ke website pemilihan. Jangan bagikan token ini kepada siapapun!_`;
                            
                            await sock.sendMessage(replyJid, { text: txt }, { quoted: msg });
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ *Data Tidak Ditemukan*\nNomor WhatsApp Anda (*${userWaLocal}*) belum diaktivasi di website. Silakan aktivasi akun terlebih dahulu di web E-Voting.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Sistem sedang sibuk. Coba beberapa saat lagi." }, { quoted: msg });
                    }
                    break;

                case 'reset':
                case 'lupatoken':
                    await sock.sendMessage(replyJid, { text: "⏳ _Memproses reset token keamanan Anda..._" }, { quoted: msg });
                    try {
                        // Tarik status dulu
                        const checkReq = await fetch(`${EVOT_API_URL}?action=botApi&command=CHECK_STATUS&wa=${userWaLocal}`);
                        const checkData = await checkReq.json();

                        if (checkData.status === 'success') {
                            if (checkData.data.status_vote === "Sudah") {
                                return await sock.sendMessage(replyJid, { text: `⚠️ *Akses Ditolak*\nAnda sudah memberikan suara! Token tidak dapat di-reset kembali.` }, { quoted: msg });
                            }

                            const res = await fetch(`${EVOT_API_URL}?action=botApi&command=RESET_TOKEN&wa=${userWaLocal}`);
                            const data = await res.json();
                            
                            if(data.status === 'success') {
                                let txt = `🔄 *TOKEN BERHASIL DI-RESET*\n\n`;
                                txt += `Sistem telah mengacak ulang token keamanan Anda:\n\n`;
                                txt += `🔑 *TOKEN BARU:* \n*${data.data.token}*\n\n`;
                                txt += `_Silakan gunakan token baru ini untuk login. Token lama Anda sudah hangus._`;
                                await sock.sendMessage(replyJid, { text: txt }, { quoted: msg });
                            }
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ Nomor WhatsApp Anda belum terdaftar di sistem. Silakan aktivasi dulu di web.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Gagal mereset token, server sedang sibuk." }, { quoted: msg });
                    }
                    break;

                case 'status':
                case 'ceksuara':
                    try {
                        const res = await fetch(`${EVOT_API_URL}?action=botApi&command=CHECK_STATUS&wa=${userWaLocal}`);
                        const data = await res.json();
                        
                        if(data.status === 'success') {
                            let icon = data.data.status_vote === "Sudah" ? "✅" : "⚠️";
                            let txt = `📊 *STATUS PEMILIHAN*\n\n`;
                            txt += `Nama: ${data.data.nama}\n`;
                            txt += `NIM: ${data.data.nim}\n`;
                            txt += `Status Vote: ${icon} *${data.data.status_vote.toUpperCase()}*\n\n`;
                            
                            if(data.data.status_vote === "Sudah") {
                                txt += `_Terima kasih telah berpartisipasi dalam pemilihan BEM FKG UMI. Suara Anda menentukan masa depan fakultas._`;
                            } else {
                                txt += `_Ketik *!token* untuk melihat token Anda dan segera selesaikan pemilihan._`;
                            }
                            await sock.sendMessage(replyJid, { text: txt }, { quoted: msg });
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ Nomor Anda belum diaktivasi.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Server timeout." }, { quoted: msg });
                    }
                    break;

                // ==========================================
                // ⚙️ MENU & ADMIN COMMANDS
                // ==========================================
                case 'menu':
                case 'help':
                    let manualMenuText = `🎓 *LAYANAN BOT KPU BEM FKG UMI* 🎓\n\n`;
                    manualMenuText += `Halo! Saya adalah Asisten Virtual E-Voting BEM FKG UMI. Silakan gunakan perintah berikut:\n\n`;
                    manualMenuText += `*👤 PESERTA / DPT:*\n`;
                    manualMenuText += `> *!token* (Cek NIM & Token Anda)\n`;
                    manualMenuText += `> *!reset* (Acak ulang token keamanan)\n`;
                    manualMenuText += `> *!status* (Cek status pemilihan)\n\n`;
                    
                    if (isAdmin) {
                        manualMenuText += `*⚙️ PENGATURAN (Admin KPU):*\n`;
                        manualMenuText += `> *!addadmin* <Nomor_WA>\n`;
                        manualMenuText += `> *!deladmin* <Nomor_WA>\n`;
                        manualMenuText += `> *!listadmin*\n`;
                        manualMenuText += `> *!restart*\n\n`;
                    }
                    
                    manualMenuText += `*✨ LAINNYA:*\n> !ai <pertanyaan> (Tanya AI)\n> !s (Buat Stiker)\n> !runtime (Status Server)`;

                    await sock.sendMessage(replyJid, { text: manualMenuText }, { quoted: msg });
                    break;

                case 'myid': case 'cekid':
                    await sock.sendMessage(replyJid, { text: `*ℹ️ INFORMASI ID ANDA*\n\n*ID Pengirim:* \n${senderJid}\n*Nomor Lokal:* ${userWaLocal}` }, { quoted: msg });
                    break;

                case 'ping':
                    const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
                    await sock.sendMessage(replyJid, { text: `🏓 *Pong!*\n⚡ *Kecepatan Response:* ${pingProcess} ms` }, { quoted: msg }); 
                    break;
                    
                case 'runtime':
                    const uptime = process.uptime();
                    await sock.sendMessage(replyJid, { text: `⏳ *Bot Uptime:* ${getRelativeTime(uptime)}\n🖥️ *OS Memory:* ${Math.round(os.freemem()/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB` }, { quoted: msg });
                    break;
                
                case 'ai': if(typeof handleAiCommand === 'function') await handleAiCommand(sock, msg, args); break;
                case 'sticker': case 's': if(typeof handleStickerCommand === 'function') await handleStickerCommand(sock, msg); break;

                case 'addadmin':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!addadmin 628xxx* atau LID" });
                    const newAdmin = formatPhoneToJid(args[0]);
                    if (!botAdmins.includes(newAdmin)) {
                        botAdmins.push(newAdmin); saveAdmins();
                        await sock.sendMessage(replyJid, { text: `✅ Berhasil! Nomor/ID ${newAdmin} sukses ditambahkan sebagai Admin KPU.` }, { quoted: msg });
                    } else await sock.sendMessage(replyJid, { text: `⚠️ Nomor/ID tersebut sudah menjadi admin.` }, { quoted: msg });
                    break;

                case 'deladmin':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!deladmin 628xxx* atau LID" });
                    const delTarget = formatPhoneToJid(args[0]);
                    if (delTarget === ownerNumber || delTarget === "6282122224408@s.whatsapp.net") return await sock.sendMessage(replyJid, { text: "❌ Anda tidak bisa menghapus ID Utama/Developer." });
                    if (botAdmins.includes(delTarget)) {
                        botAdmins = botAdmins.filter(a => a !== delTarget); saveAdmins();
                        await sock.sendMessage(replyJid, { text: `✅ Berhasil! Nomor/ID ${delTarget} sukses dicabut hak Admin-nya.` }, { quoted: msg });
                    } else await sock.sendMessage(replyJid, { text: `⚠️ Nomor/ID tidak ditemukan dalam daftar admin.` }, { quoted: msg });
                    break;

                case 'listadmin':
                    let adList = "👥 *DAFTAR ADMIN KPU*\n\n";
                    botAdmins.forEach((a, i) => adList += `${i+1}. ${a.split('@')[0]}\n`);
                    await sock.sendMessage(replyJid, { text: adList }, { quoted: msg });
                    break;
                    
                case 'restart':
                    await sock.sendMessage(replyJid, { text: "🔄 *Restarting Bot...*\nSistem sedang dimuat ulang." }, { quoted: msg });
                    setTimeout(() => { process.exit(1); }, 2000);
                    break;

                default:
                    // Fallback jika tidak ada perintah yang cocok
                    break;
            }
        } catch (error) { console.error('Error proses pesan:', error); }
    });
}
