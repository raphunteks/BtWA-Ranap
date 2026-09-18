import process from 'process';
import os from 'os';

// Jika Anda masih menyimpan command eksternal, biarkan import ini
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ====================================================================
// 🚀 KONFIGURASI API E-VOTING BEM FKG UMI
// ====================================================================
const EVOT_API_URL = process.env.EVOT_API_URL || "https://script.google.com/macros/s/AKfycbxw3v9--RsgQoXMRpwTvApotQZ-UmlTuH_mHpRGZIiMryxirWPSJjPcSwdtMUngcBEn/exec";

// ====================================================================
// 📁 FORMATTER UTILITIES
// ====================================================================
function formatWaNumber(id) {
    if (!id) return "";
    // Membuang @s.whatsapp.net, @lid, atau : dari string ID
    let p = String(id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    
    // Konversi cerdas: Hanya konversi ke 62 jika itu terlihat seperti nomor HP lokal
    // (Abaikan jika itu adalah deretan angka LID acak)
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
// 🚀 MAIN HANDLER BOT E-VOTING (PULL ARCHITECTURE)
// ====================================================================
export default async function setupMessageHandler(sock) {
    console.log("[System] BOT E-VOTING MURNI PUBLIK Aktif!");
    console.log("[System] Fitur Auto-Pull & Dual JID/LID Resolver Berjalan di Background.");

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
                    // SUPER UPGRADE: Membungkus eksekusi pengiriman dengan Try-Catch Anti-Crash
                    try {
                        // 1. Standarisasi Format WA untuk Pengiriman (Memastikan 62...)
                        let rawWa = msgData.wa;
                        if (rawWa.startsWith('0')) rawWa = '62' + rawWa.substring(1);
                        
                        let targetWaLid = rawWa + '@s.whatsapp.net';
                        let finalLid = targetWaLid;

                        // Mencari ID Utama / Resolve ke server WA
                        try {
                            const [result] = await sock.onWhatsApp(targetWaLid);
                            if (result && result.exists) {
                                finalLid = result.jid; 
                                console.log(`[Resolver] Nomor ${rawWa} dipetakan ke JID Utama: ${finalLid}`);
                            }
                        } catch (e) {
                            console.log(`[Resolver] Gagal resolve untuk ${rawWa}, mencoba format standar.`);
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
                            txt += `Pendaftaran DPT E-Voting BEM FKG UMI Anda telah berhasil dikonfirmasi.\n\n`;
                        }
                        
                        txt += `🆔 *NIM:* ${msgData.nim}\n`;
                        txt += `🔑 *TOKEN RAHASIA:* \n*${msgData.token}*\n\n`;
                        txt += `_Gunakan NIM dan Token di atas untuk login ke website pemilihan. Jangan bagikan token ini kepada siapapun demi kerahasiaan suara Anda!_\n\n`;
                        txt += `Ketik *!menu* untuk melihat layanan bantuan.`;

                        // 3. Eksekusi Pengiriman Pesan
                        await sock.sendMessage(finalLid, { text: txt });
                        console.log(`[Auto-Send 🚀] Pesan (${msgData.context}) terkirim sukses ke ${rawWa}.`);

                        // 4. POST KE GOOGLE SHEETS UNTUK MENYIMPAN ID UTAMA (KOLOM F)
                        try {
                            await fetch(EVOT_API_URL, {
                                method: "POST",
                                headers: { "Content-Type": "text/plain;charset=utf-8" },
                                body: JSON.stringify({
                                    action: "update_lid",
                                    data: { nim: msgData.nim, lid: finalLid }
                                })
                            });
                        } catch (err) {
                            console.log(`[Database Error] Gagal simpan LID ke Sheets: ${err.message}`);
                        }

                    } catch (fatalErr) {
                        // TANGKAPAN ERROR FATAL (Nomor tidak terdaftar, nomor hangus, dsb)
                        // Bot tidak akan mati, hanya melompati nomor yang error ini.
                        console.log(`[Auto-Send ❌ GAGAL] Tidak dapat mengirim pesan ke WA: ${msgData.wa}. Alasan: ${fatalErr.message}`);
                    }
                    
                    // Jeda 2 detik antar pesan agar tidak terkena ban spam WhatsApp
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        } catch (err) {
            // Error request fetch API di-silence agar bot tetap berjalan mulus walau jaringan fluktuatif
        }
    }, 5000); 

    // ====================================================================
    // INCOMING CHAT HANDLER (BOT PUBLIK)
    // ====================================================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            let text = '';
            if (msg.message.conversation) text = msg.message.conversation;
            else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
                         
            const prefix = '!'; 
            if (!text || !text.startsWith(prefix)) return;

            const args = text.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            
            const replyJid = msg.key.remoteJid; 
            
            // Ekstraksi ID Pengirim
            let senderId = msg.key.remoteJid; 
            if (senderId.endsWith('@g.us')) senderId = msg.key.participant || senderId;

            // ====================================================
            // 🌟 SUPER UPGRADE: DUAL-RESOLVER JID & LID SEKALIGUS
            // ====================================================
            // Semua jenis perangkat yang digunakan mahasiswa (WA Web, Aplikasi HP, Perangkat Taut)
            // Dapat langsung terdeteksi. Tidak ada lagi pemblokiran.
            
            const userWaFormat = formatWaNumber(senderId); // Menghasilkan 628... murni (Nomor WA Asli)
            const cleanId = encodeURIComponent(senderId); // Menghasilkan format URL-Safe (JID/LID utuh)
            
            console.log(`[COMMAND Publik] ${command} diakses oleh ID: ${senderId} (Parsed WA: ${userWaFormat})`);

            switch (command) {
                case 'token':
                case 'minta-token':
                    await sock.sendMessage(replyJid, { text: "⏳ _Mencari identitas Anda di sistem KPU..._" }, { quoted: msg });
                    try {
                        // API Akan mengecek KEDUA parameter ini sekaligus ke Spreadsheet
                        const res = await fetch(`${EVOT_API_URL}?action=botApi&command=GET_TOKEN&lid=${cleanId}&wa=${userWaFormat}`);
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
                            await sock.sendMessage(replyJid, { text: `❌ *Data Tidak Ditemukan*\nNomor WhatsApp Anda belum diaktivasi di website. Silakan aktivasi akun terlebih dahulu di web E-Voting.` }, { quoted: msg });
                        }
                    } catch(err) {
                        await sock.sendMessage(replyJid, { text: "❌ Sistem Server sedang sibuk. Coba beberapa saat lagi." }, { quoted: msg });
                    }
                    break;

                case 'reset':
                case 'lupatoken':
                    await sock.sendMessage(replyJid, { text: "⏳ _Memproses reset token keamanan Anda..._" }, { quoted: msg });
                    try {
                        const checkReq = await fetch(`${EVOT_API_URL}?action=botApi&command=CHECK_STATUS&lid=${cleanId}&wa=${userWaFormat}`);
                        const checkData = await checkReq.json();

                        if (checkData.status === 'success') {
                            if (checkData.data.status_vote === "Sudah") {
                                return await sock.sendMessage(replyJid, { text: `⚠️ *Akses Ditolak*\nAnda sudah memberikan suara! Token tidak dapat di-reset kembali.` }, { quoted: msg });
                            }

                            const res = await fetch(`${EVOT_API_URL}?action=botApi&command=RESET_TOKEN&lid=${cleanId}&wa=${userWaFormat}`);
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
                        const res = await fetch(`${EVOT_API_URL}?action=botApi&command=CHECK_STATUS&lid=${cleanId}&wa=${userWaFormat}`);
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
                    await sock.sendMessage(replyJid, { text: `*ℹ️ INFORMASI SINKRONISASI ID*\n\n*ID Platform:* \n${senderId}\n*WA Asli Terdeteksi:* ${userWaFormat}` }, { quoted: msg });
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
