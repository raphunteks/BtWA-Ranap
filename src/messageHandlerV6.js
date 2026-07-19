import process from 'process';
import os from 'os';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys'; 
import express from 'express'; 

// Handler perintah eksternal (Pastikan file ini ada di folder /commands Anda)
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ====================================================================
// 🚀 KONFIGURASI API E-VOTING BEM FKG UMI
// ====================================================================
// PASTE URL ENDPOINT GAS ANDA DI SINI (Yang berakhir dengan /exec)
const EVOT_API_URL = process.env.EVOT_API_URL || "https://script.google.com/macros/s/AKfycbxw3v9--RsgQoXMRpwTvApotQZ-UmlTuH_mHpRGZIiMryxirWPSJjPcSwdtMUngcBEn/exec";

// ====================================================================
// 📁 UTILITY & FORMATTER (ANTI-CRASH)
// ====================================================================
// Standarisasi Sempurna: Paksa nomor WA menjadi format Internasional (628...) 
function formatWaNumber(jid) {
    if (!jid) return "";
    let p = String(jid).split('@')[0].replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    else if (p.startsWith('8')) p = '62' + p;
    return p;
}

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} hari yang lalu`; if (h > 0) return `${h} jam yang lalu`; if (m > 0) return `${m} menit yang lalu`;
    return `${Math.floor(seconds)} detik yang lalu`;
}

// ====================================================================
// 🚀 MAIN HANDLER BOT E-VOTING (100% PUBLIC SYSTEM + RAILWAY READY)
// ====================================================================
export default async function setupMessageHandler(sock) {
    console.log("[System] BOT E-VOTING BEM FKG UMI Handler Aktif!");
    console.log("[System] Mode: PUBLIK MURNI (Standarisasi 628... & Railway Webhook Ready)");

    // ====================================================================
    // 🌐 WEBHOOK SERVER: MENERIMA TRIGGER PUSH DARI GOOGLE APPS SCRIPT
    // ====================================================================
    const app = express();
    app.use(express.json()); // Wajib agar bisa baca payload JSON dari GAS
    
    // UPGRADE RAILWAY: Deteksi Port Dinamis 
    const WEBHOOK_PORT = process.env.PORT || process.env.WEBHOOK_PORT || 3000;

    // 🚀 RAILWAY HEALTH CHECK (SANGAT WAJIB!)
    // Mencegah Railway mematikan server bot Anda karena dianggap "Unhealthy"
    app.get('/', (req, res) => {
        res.status(200).send("Bot WA KPU UMI is Running and Healthy!");
    });

    // 🚀 ENDPOINT UTAMA UNTUK MENERIMA TEMBAKAN DARI GAS
    app.post('/webhook/evot', async (req, res) => {
        try {
            const data = req.body;
            console.log(`[Webhook Masuk 📥] Action: ${data.action} | Context: ${data.context} | Target: ${data.wa}`);

            // Validasi keamanan: Pastikan payload dari code.gs memiliki action 'send_token'
            if (data && data.action === 'send_token') {
                
                // Pastikan format tujuan adalah JID WhatsApp yang sah (628...@s.whatsapp.net)
                let targetWaBase = formatWaNumber(data.wa); 
                let targetWaJid = targetWaBase + '@s.whatsapp.net';

                // Susun Template Pesan
                let txt = '';
                if (data.context === 'lupa_token') {
                    txt = `🔄 *PERMINTAAN RESET TOKEN KPU* 🔄\n\n`;
                    txt += `Halo *${data.nama.toUpperCase()}*,\n`;
                    txt += `Sistem telah mereset dan menerbitkan ulang Token Anda sesuai permintaan dari Website Pemilihan.\n\n`;
                } else {
                    txt = `🎓 *SELAMAT, AKTIVASI BERHASIL!* 🎓\n\n`;
                    txt += `Halo *${data.nama.toUpperCase()}*,\n`;
                    txt += `Pendaftaran DPT E-Voting BEM FKG UMI Anda telah berhasil dikonfirmasi oleh sistem.\n\n`;
                }
                
                txt += `🆔 *NIM:* ${data.nim}\n`;
                txt += `🔑 *TOKEN RAHASIA:* \n*${data.token}*\n\n`;
                txt += `_Gunakan NIM dan Token di atas untuk login ke website pemilihan. Jangan bagikan token ini kepada siapapun demi kerahasiaan suara Anda!_\n\n`;
                txt += `Ketik *!menu* untuk melihat layanan bantuan.`;

                // Eksekusi pengiriman pesan langsung ke Mahasiswa (Tanpa perlu Mahasiswa chat duluan)
                await sock.sendMessage(targetWaJid, { text: txt });
                console.log(`[Webhook 🚀] Token BERHASIL TERKIRIM ke: ${data.nama} (${targetWaJid})`);
                
                // Beri respon ke GAS agar script GAS selesai dengan status OK
                return res.status(200).json({ status: 'success', message: 'Pesan otomatis berhasil dikirim' });
            }
            res.status(400).json({ status: 'error', message: 'Action webhook tidak valid' });
        } catch (error) {
            console.error('[Webhook Error ❌]', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // Binding ke 0.0.0.0 agar port terbuka ke jaringan publik Railway
    app.listen(WEBHOOK_PORT, '0.0.0.0', () => {
        console.log(`[System 🌐] Webhook Listener KPU Aktif Terbuka di Port: ${WEBHOOK_PORT}`);
    });

    // ====================================================================
    // INCOMING CHAT HANDLER (BOT COMMANDS) - PUBLIK MURNI
    // ====================================================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            // Tangkap Input Teks atau Interaktif (Buttons/List)
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

            // Standarisasi nomor user yang nge-chat bot, pasti jadi format 628...
            const userWaFormat = formatWaNumber(senderJid); 

            console.log(`[COMMAND] ${command} dieksekusi oleh ID: ${senderJid} (Parsed Standar: ${userWaFormat})`);

            switch (command) {
                // ==========================================
                // 🎓 FITUR MAHASISWA / PEMILIH
                // ==========================================
                case 'token':
                case 'minta-token':
                    await sock.sendMessage(replyJid, { text: "⏳ _Mencari data aktivasi Anda di sistem KPU..._" }, { quoted: msg });
                    try {
                        // Mencocokkan dengan parameter WA yang 100% berformat 628...
                        const res = await fetch(`${EVOT_API_URL}?action=botApi&command=GET_TOKEN&wa=${userWaFormat}`);
                        const data = await res.json();
                        
                        if(data.status === 'success') {
                            let statusText = data.data.status_vote === "Sudah" ? "✅ SUDAH MEMILIH" : "⚠️ BELUM MEMILIH";
                            let txt = `🎓 *HALO, ${data.data.nama.toUpperCase()}*\n\n`;
                            txt += `Pendaftaran DPT E-Voting BEM FKG UMI Anda telah terkonfirmasi.\n\n`;
                            txt += `🆔 *NIM:* ${data.data.nim}\n`;
                            txt += `🔑 *TOKEN RAHASIA:* \n*${data.data.token}*\n\n`;
                            txt += `📊 *Status Pemilihan:* ${statusText}\n\n`;
                            txt += `_Gunakan NIM dan Token di atas untuk masuk ke website pemilihan. Jangan bagikan token ini kepada siapapun!_`;
                            
                            await sock.sendMessage(replyJid, { text: txt }, { quoted: msg });
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ *Data Tidak Ditemukan*\nNomor WhatsApp Anda (${userWaFormat}) belum diaktivasi di website. Silakan aktivasi akun terlebih dahulu di web E-Voting.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Sistem GAS sedang sibuk. Coba beberapa saat lagi." }, { quoted: msg });
                    }
                    break;

                case 'reset':
                case 'lupatoken':
                    await sock.sendMessage(replyJid, { text: "⏳ _Memproses reset token keamanan Anda..._" }, { quoted: msg });
                    try {
                        const checkReq = await fetch(`${EVOT_API_URL}?action=botApi&command=CHECK_STATUS&wa=${userWaFormat}`);
                        const checkData = await checkReq.json();

                        if (checkData.status === 'success') {
                            if (checkData.data.status_vote === "Sudah") {
                                return await sock.sendMessage(replyJid, { text: `⚠️ *Akses Ditolak*\nAnda sudah memberikan suara! Token tidak dapat di-reset kembali.` }, { quoted: msg });
                            }

                            const res = await fetch(`${EVOT_API_URL}?action=botApi&command=RESET_TOKEN&wa=${userWaFormat}`);
                            const data = await res.json();
                            
                            if(data.status === 'success') {
                                let txt = `🔄 *TOKEN BERHASIL DI-RESET*\n\n`;
                                txt += `Sistem telah mengacak ulang token keamanan Anda:\n\n`;
                                txt += `🔑 *TOKEN BARU:* \n*${data.data.token}*\n\n`;
                                txt += `_Silakan gunakan token baru ini untuk login. Token lama Anda sudah hangus._`;
                                await sock.sendMessage(replyJid, { text: txt }, { quoted: msg });
                            }
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ Nomor WhatsApp (${userWaFormat}) belum terdaftar di sistem. Silakan aktivasi dulu di web.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Gagal mereset token, server sedang sibuk." }, { quoted: msg });
                    }
                    break;

                case 'status':
                case 'ceksuara':
                    try {
                        const res = await fetch(`${EVOT_API_URL}?action=botApi&command=CHECK_STATUS&wa=${userWaFormat}`);
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
                            await sock.sendMessage(replyJid, { text: `❌ Nomor Anda (${userWaFormat}) belum diaktivasi.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Server timeout." }, { quoted: msg });
                    }
                    break;

                // ==========================================
                // ⚙️ MENU & TOOLS UTAMA
                // ==========================================
                case 'menu':
                case 'help':
                    let manualMenuText = `🎓 *LAYANAN BOT KPU BEM FKG UMI* 🎓\n\n`;
                    manualMenuText += `Halo! Saya adalah Asisten Virtual E-Voting. Silakan gunakan perintah berikut:\n\n`;
                    manualMenuText += `*👤 PESERTA / DPT:*\n`;
                    manualMenuText += `> *!token* (Cek NIM & Token Anda)\n`;
                    manualMenuText += `> *!reset* (Acak ulang token keamanan)\n`;
                    manualMenuText += `> *!status* (Cek status pemilihan)\n\n`;
                    manualMenuText += `*✨ LAINNYA:*\n> !ai <pertanyaan> (Tanya AI)\n> !s (Buat Stiker)\n> !runtime (Status Server)\n> !myid (Cek ID Anda)`;

                    await sock.sendMessage(replyJid, { text: manualMenuText }, { quoted: msg });
                    break;

                case 'myid': case 'cekid':
                    await sock.sendMessage(replyJid, { text: `*ℹ️ INFORMASI ID ANDA*\n\n*ID Mentah:* \n${senderJid}\n*Parsed Format (Yang Dikenali Database):*\n${userWaFormat}` }, { quoted: msg });
                    break;

                case 'ping':
                    const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
                    await sock.sendMessage(replyJid, { text: `🏓 *Pong!*\n⚡ *Kecepatan Response:* ${pingProcess} ms` }, { quoted: msg }); 
                    break;
                    
                case 'runtime':
                    const uptime = process.uptime();
                    await sock.sendMessage(replyJid, { text: `⏳ *Bot Uptime:* ${getRelativeTime(uptime)}\n🖥️ *OS Memory:* ${Math.round(os.freemem()/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB` }, { quoted: msg });
                    break;
                
                // Eksekusi Command Eksternal jika ada (Pastikan file ada di folder commands/)
                case 'ai': if(typeof handleAiCommand === 'function') await handleAiCommand(sock, msg, args); break;
                case 'sticker': case 's': if(typeof handleStickerCommand === 'function') await handleStickerCommand(sock, msg); break;

                default:
                    // Mengabaikan pesan yang bukan command terdaftar tanpa spam
                    break;
            }
        } catch (error) { console.error('[Handler Error]', error); }
    });
}
