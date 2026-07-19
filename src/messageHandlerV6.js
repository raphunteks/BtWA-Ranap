import process from 'process';
import os from 'os';

// Jika Anda masih menyimpan command eksternal, biarkan import ini
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ====================================================================
// 🚀 KONFIGURASI API E-VOTING BEM FKG UMI
// ====================================================================
// PASTE URL ENDPOINT GAS ANDA DI SINI (Pastikan yang paling baru di-deploy)
const EVOT_API_URL = process.env.EVOT_API_URL || "https://script.google.com/macros/s/AKfycbxw3v9--RsgQoXMRpwTvApotQZ-UmlTuH_mHpRGZIiMryxirWPSJjPcSwdtMUngcBEn/exec";

// ====================================================================
// 📁 FORMATTER UTILITIES
// ====================================================================
function formatWaNumber(jid) {
    if (!jid) return "";
    let p = String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    else if (p.startsWith('8')) p = '62' + p;
    return p;
}

function formatJidToLocal(jid) {
    let p = formatWaNumber(jid);
    if (p.startsWith('62')) p = '0' + p.slice(2);
    return p;
}

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} hari yang lalu`; if (h > 0) return `${h} jam yang lalu`; if (m > 0) return `${m} menit yang lalu`;
    return `${Math.floor(seconds)} detik yang lalu`;
}

// ====================================================================
// 🚀 MAIN HANDLER BOT E-VOTING (PULL ARCHITECTURE + JID RESOLVER)
// ====================================================================
export default async function setupMessageHandler(sock) {
    console.log("[System] BOT E-VOTING MURNI PUBLIK Aktif!");
    console.log("[System] Fitur PULL & Auto JID-Resolver Berjalan di Background.");

    // ====================================================================
    // 🔄 AUTO-POLLING API (PULL METHOD SETIAP 5 DETIK)
    // ====================================================================
    setInterval(async () => {
        try {
            const res = await fetch(`${EVOT_API_URL}?action=botApi&command=GET_PENDING_MESSAGES`);
            const json = await res.json();
            
            if (json.status === 'success' && json.data && json.data.length > 0) {
                console.log(`[Auto-Pull 📥] Ditemukan ${json.data.length} antrian pesan WA!`);
                
                for (const msgData of json.data) {
                    // 1. Mengubah format WA (cth: 62852...)
                    let rawWa = msgData.wa;
                    if (rawWa.startsWith('0')) rawWa = '62' + rawWa.substring(1);
                    
                    let targetWaJid = rawWa + '@s.whatsapp.net';
                    let finalJid = targetWaJid; // Fallback jika gagal dideteksi

                    // ====================================================
                    // 🌟 SUPER FITUR: MENCARI JID ASLI (RESOLVER BAILEYS)
                    // ====================================================
                    try {
                        const [result] = await sock.onWhatsApp(targetWaJid);
                        if (result && result.exists) {
                            finalJid = result.jid; // Mengambil JID Asli/Official (bisa berakhiran @lid dsb)
                            console.log(`[JID Resolver] Nomor ${rawWa} terdeteksi sebagai JID: ${finalJid}`);
                        }
                    } catch (e) {
                        console.log(`[JID Resolver] Gagal resolve JID untuk ${rawWa}, mencoba mengirim dengan format standar.`);
                    }

                    // 2. Menyusun Template Pesan
                    let txt = '';
                    if (msgData.context === 'lupa_token') {
                        txt = `🔄 *PERMINTAAN RESET TOKEN KPU* 🔄\n\n`;
                        txt += `Halo *${msgData.nama.toUpperCase()}*,\n`;
                        txt += `Sistem telah mereset dan menerbitkan ulang Token Anda sesuai permintaan dari Website Pemilihan.\n\n`;
                    } else {
                        txt = `🎓 *SELAMAT, AKTIVASI BERHASIL!* 🎓\n\n`;
                        txt += `Halo *${msgData.nama.toUpperCase()}*,\n`;
                        txt += `Pendaftaran DPT E-Voting BEM FKG UMI Anda telah berhasil dikonfirmasi oleh sistem.\n\n`;
                    }
                    
                    txt += `🆔 *NIM:* ${msgData.nim}\n`;
                    txt += `🔑 *TOKEN RAHASIA:* \n*${msgData.token}*\n\n`;
                    txt += `_Gunakan NIM dan Token di atas untuk login ke website pemilihan. Jangan bagikan token ini kepada siapapun demi kerahasiaan suara Anda!_\n\n`;
                    txt += `Ketik *!menu* untuk melihat layanan bantuan.`;

                    // 3. Eksekusi Pengiriman ke JID ASLI
                    await sock.sendMessage(finalJid, { text: txt });
                    console.log(`[Auto-Send 🚀] Pesan (${msgData.context}) terkirim sukses ke JID: ${finalJid}`);

                    // ====================================================
                    // 🌟 POST KE GOOGLE SHEETS UNTUK MENYIMPAN JID (KOLOM F)
                    // ====================================================
                    try {
                        await fetch(EVOT_API_URL, {
                            method: "POST",
                            headers: { "Content-Type": "text/plain;charset=utf-8" },
                            body: JSON.stringify({
                                action: "update_jid",
                                data: { nim: msgData.nim, jid: finalJid }
                            })
                        });
                        console.log(`[Database 💾] JID ${finalJid} berhasil disinkronisasi ke Google Sheets.`);
                    } catch (err) {
                        console.log(`[Database Error] Gagal simpan JID ke Sheets: ${err.message}`);
                    }
                    
                    // Jeda 2 detik anti-spam/banned
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        } catch (err) {
            // Error di-silence agar bot tetap berjalan mulus walau jaringan fluktuatif
        }
    }, 5000); 

    // ====================================================================
    // INCOMING CHAT HANDLER (BOT PUBLIK)
    // ====================================================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            // Membaca Teks
            let text = '';
            if (msg.message.conversation) text = msg.message.conversation;
            else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
                         
            const prefix = '!'; 
            if (!text || !text.startsWith(prefix)) return;

            const args = text.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            
            // Mengambil JID dari Bot dan memformat WA-nya
            const replyJid = msg.key.remoteJid; 
            let senderJid = msg.key.remoteJid; // BISA SAJA 247922893566044@lid
            if (senderJid.endsWith('@g.us')) senderJid = msg.key.participant || senderJid;

            // Untuk dicocokkan dengan Database jika JID tidak ditemukan
            const userWaFormat = formatWaNumber(senderJid); // Jadi 628...
            const cleanJid = encodeURIComponent(senderJid); // Persiapan buat URL Fetch
            
            console.log(`[COMMAND Publik] ${command} diakses oleh ID: ${senderJid}`);

            switch (command) {
                case 'token':
                case 'minta-token':
                    await sock.sendMessage(replyJid, { text: "⏳ _Mencari identitas Anda di sistem KPU..._" }, { quoted: msg });
                    try {
                        // KITA LEMPAR KEDUANYA (JID DAN WA) KE GAS, GAS AKAN MENCOCOKKAN SALAH SATUNYA!
                        const res = await fetch(`${EVOT_API_URL}?action=botApi&command=GET_TOKEN&jid=${cleanJid}&wa=${userWaFormat}`);
                        const data = await res.json();
                        
                        if(data.status === 'success') {
                            let statusText = data.data.status_vote === "Sudah" ? "✅ SUDAH MEMILIH" : "⚠️ BELUM MEMILIH";
                            let txt = `🎓 *HALO, ${data.data.nama.toUpperCase()}*\n\n`;
                            txt += `Pendaftaran DPT E-Voting Anda telah terkonfirmasi.\n\n`;
                            txt += `🆔 *NIM:* ${data.data.nim}\n`;
                            txt += `🔑 *TOKEN RAHASIA:* \n*${data.data.token}*\n\n`;
                            txt += `📊 *Status Pemilihan:* ${statusText}\n\n`;
                            txt += `_Gunakan NIM dan Token di atas untuk masuk ke website pemilihan. Jangan bagikan token ini kepada siapapun!_`;
                            
                            await sock.sendMessage(replyJid, { text: txt }, { quoted: msg });
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ *Data Tidak Ditemukan*\nNomor/ID WhatsApp Anda belum diaktivasi di website. Silakan aktivasi akun terlebih dahulu di web E-Voting.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Sistem Server sedang sibuk. Coba beberapa saat lagi." }, { quoted: msg });
                    }
                    break;

                case 'reset':
                case 'lupatoken':
                    await sock.sendMessage(replyJid, { text: "⏳ _Memproses reset token keamanan Anda..._" }, { quoted: msg });
                    try {
                        const checkReq = await fetch(`${EVOT_API_URL}?action=botApi&command=CHECK_STATUS&jid=${cleanJid}&wa=${userWaFormat}`);
                        const checkData = await checkReq.json();

                        if (checkData.status === 'success') {
                            if (checkData.data.status_vote === "Sudah") {
                                return await sock.sendMessage(replyJid, { text: `⚠️ *Akses Ditolak*\nAnda sudah memberikan suara! Token tidak dapat di-reset kembali.` }, { quoted: msg });
                            }

                            const res = await fetch(`${EVOT_API_URL}?action=botApi&command=RESET_TOKEN&jid=${cleanJid}&wa=${userWaFormat}`);
                            const data = await res.json();
                            
                            if(data.status === 'success') {
                                let txt = `🔄 *TOKEN BERHASIL DI-RESET*\n\n`;
                                txt += `Sistem telah mengacak ulang token keamanan Anda:\n\n`;
                                txt += `🔑 *TOKEN BARU:* \n*${data.data.token}*\n\n`;
                                txt += `_Silakan gunakan token baru ini untuk login. Token lama Anda sudah hangus._`;
                                await sock.sendMessage(replyJid, { text: txt }, { quoted: msg });
                            }
                        } else {
                            await sock.sendMessage(replyJid, { text: `❌ Nomor/ID WhatsApp Anda belum terdaftar di sistem. Silakan aktivasi dulu di web.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Gagal mereset token, server sedang sibuk." }, { quoted: msg });
                    }
                    break;

                case 'status':
                case 'ceksuara':
                    try {
                        const res = await fetch(`${EVOT_API_URL}?action=botApi&command=CHECK_STATUS&jid=${cleanJid}&wa=${userWaFormat}`);
                        const data = await res.json();
                        
                        if(data.status === 'success') {
                            let icon = data.data.status_vote === "Sudah" ? "✅" : "⚠️";
                            let txt = `📊 *STATUS PEMILIHAN*\n\n`;
                            txt += `Nama: ${data.data.nama}\n`;
                            txt += `NIM: ${data.data.nim}\n`;
                            txt += `Status Vote: ${icon} *${data.data.status_vote.toUpperCase()}*\n\n`;
                            
                            if(data.data.status_vote === "Sudah") {
                                txt += `_Terima kasih telah berpartisipasi dalam pemilihan BEM FKG UMI._`;
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

                case 'menu':
                case 'help':
                    let manualMenuText = `🎓 *LAYANAN BOT KPU BEM FKG UMI* 🎓\n\n`;
                    manualMenuText += `Halo! Saya adalah Asisten Virtual E-Voting. Silakan gunakan perintah publik berikut:\n\n`;
                    manualMenuText += `*👤 PESERTA / DPT:*\n`;
                    manualMenuText += `> *!token* (Cek NIM & Token Anda)\n`;
                    manualMenuText += `> *!reset* (Acak ulang token keamanan)\n`;
                    manualMenuText += `> *!status* (Cek status pemilihan)\n\n`;
                    manualMenuText += `*✨ LAINNYA:*\n> !ai <pertanyaan> (Tanya AI)\n> !s (Buat Stiker)\n> !runtime (Status Server)`;

                    await sock.sendMessage(replyJid, { text: manualMenuText }, { quoted: msg });
                    break;

                case 'myid': case 'cekid':
                    await sock.sendMessage(replyJid, { text: `*ℹ️ INFORMASI ID ANDA*\n\n*ID Sistem:* \n${senderJid}\n*Nomor Terdeteksi:* ${userWaFormat}` }, { quoted: msg });
                    break;

                case 'ping':
                    const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
                    await sock.sendMessage(replyJid, { text: `🏓 *Pong!*\n⚡ *Response:* ${pingProcess} ms` }, { quoted: msg }); 
                    break;
                    
                case 'runtime':
                    const uptime = process.uptime();
                    await sock.sendMessage(replyJid, { text: `⏳ *Uptime:* ${getRelativeTime(uptime)}\n🖥️ *Memory:* ${Math.round(os.freemem()/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB` }, { quoted: msg });
                    break;
                
                case 'ai': if(typeof handleAiCommand === 'function') await handleAiCommand(sock, msg, args); break;
                case 'sticker': case 's': if(typeof handleStickerCommand === 'function') await handleStickerCommand(sock, msg); break;

                default: break;
            }
        } catch (error) { console.error('[Handler Error]', error); }
    });
}
