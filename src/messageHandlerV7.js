import process from 'process';
import os from 'os';

// Jika Anda masih menyimpan command eksternal, biarkan import ini
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ====================================================================
// 🚀 KONFIGURASI REST API GATEWAY & DATABASE CLOUD DEPT. RKG
// ====================================================================
const RKG_API_BASE_URL = process.env.RKG_API_URL || "https://absensi.maksaarsyad.xyz/api/wa";

// Redis Client untuk keperluan Cron Job Backend
class Redis {
    constructor(config) {
        this.url = config.url || '';
        this.token = config.token || '';
        if (this.url.endsWith('/')) this.url = this.url.slice(0, -1);
    }
    
    static fromEnv() {
        let url = process.env.NEXT_PUBLIC_UPSTASH_REDIS_REST_URL || process.env.NEXT_PUBLIC_KV_REST_API_URL || '';
        let token = process.env.NEXT_PUBLIC_UPSTASH_REDIS_REST_TOKEN || process.env.NEXT_PUBLIC_KV_REST_API_TOKEN || '';
        return new Redis({ url, token });
    }

    async get(key) {
        if (!this.url || !this.token) return null;
        try {
            const res = await fetch(this.url, { 
                method: 'POST',
                headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify(["GET", key]), 
                cache: 'no-store' 
            });
            if (!res.ok) throw new Error('Fetch failed');
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (data.result === null || data.result === undefined) return null;
            try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } 
            catch (e) { return data.result; }
        } catch (e) { return null; }
    }

    async set(key, value) {
        if (!this.url || !this.token) return;
        try {
            const strVal = typeof value === 'string' ? value : JSON.stringify(value);
            const res = await fetch(this.url, { 
                method: 'POST', 
                headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify(["SET", key, strVal]) 
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            return data;
        } catch (e) { throw e; }
    }
}

// ====================================================================
// 📁 FORMATTER UTILITIES
// ====================================================================
function formatWaNumber(id) {
    if (!id) return "";
    let p = String(id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    else if (p.startsWith('8')) p = '62' + p;
    return p;
}

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} hari yang lalu`; if (h > 0) return `${h} jam yang lalu`; if (m > 0) return `${m} menit yang lalu`;
    return `${Math.floor(seconds)} detik yang lalu`;
}

// Helper Tanggal Local (WITA)
const getLocalYYYYMMDD = (dateInput) => {
    const d = new Date(dateInput);
    d.setHours(d.getHours() + 8); // Offset UTC to WITA (Asia/Makassar)
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// ====================================================================
// 🚀 MAIN HANDLER BOT DEPT. RKG
// ====================================================================
export default async function setupMessageHandler(sock) {
    console.log("[System] BOT ABSENSI DEPT. RKG Aktif!");
    console.log("[System] Fitur Auto-Pull Queue Message & Cron Job 24/7 Berjalan di Background.");

    // MENGAKTIFKAN MESIN CRON JOB (BAGIAN 2)
    startCronJob(sock);

    // ====================================================================
    // 🔄 AUTO-POLLING API (PULL METHOD SETIAP 5 DETIK)
    // ====================================================================
    setInterval(async () => {
        try {
            const res = await fetch(`${RKG_API_BASE_URL}?action=pull`, { method: "GET" });
            const json = await res.json();
            
            if (json.success && json.queue && json.queue.length > 0) {
                console.log(`[Auto-Pull 📥] Ditemukan ${json.queue.length} antrian pesan Notifikasi RKG!`);
                
                for (const msgData of json.queue) {
                    try {
                        let rawWa = msgData.target_number;
                        if (rawWa.startsWith('0')) rawWa = '62' + rawWa.substring(1);
                        
                        let targetWaLid = rawWa + '@s.whatsapp.net';
                        let finalLid = targetWaLid;

                        try {
                            const [result] = await sock.onWhatsApp(targetWaLid);
                            if (result && result.exists) {
                                finalLid = result.jid; 
                            }
                        } catch (e) {
                            console.log(`[Resolver] Gagal resolve untuk ${rawWa}, mencoba format standar.`);
                        }

                        // Eksekusi Pengiriman Pesan
                        await sock.sendMessage(finalLid, { text: msgData.formatted_message });
                        console.log(`[Auto-Send 🚀] Pesan terkirim sukses ke ${rawWa}.`);

                        // Hapus antrian jika berhasil
                        try {
                            await fetch(RKG_API_BASE_URL, {
                                method: "DELETE",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ message_id: msgData.id })
                            });
                        } catch (err) {
                            console.log(`[Database Error] Gagal menghapus antrian: ${err.message}`);
                        }

                    } catch (fatalErr) {
                        console.log(`[Auto-Send ❌ GAGAL] Tidak dapat mengirim pesan ke WA: ${msgData.target_number}. Alasan: ${fatalErr.message}`);
                    }
                    
                    // Jeda 2 detik antar pesan agar aman dari deteksi SPAM WhatsApp
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        } catch (err) {
            // Error request fetch API di-silence agar bot tetap berjalan
        }
    }, 5000); 

    // ====================================================================
    // INCOMING CHAT HANDLER (COMMAND INTERAKTIF)
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
            
            let senderId = msg.key.remoteJid; 
            if (senderId.endsWith('@g.us')) senderId = msg.key.participant || senderId;

            const userWaFormat = formatWaNumber(senderId); 

            console.log(`[COMMAND Publik] ${command} diakses oleh (Parsed WA: ${userWaFormat})`);

            switch (command) {
                case 'portal':
                case 'absen':
                    await sock.sendMessage(replyJid, { text: `🏥 *PORTAL ABSENSI DEPT. RKG*\n\nSilakan klik tautan di bawah ini untuk mengakses dashboard absensi Anda:\n🔗 https://absensi.maksaarsyad.xyz/` }, { quoted: msg });
                    break;
                
                case 'bantuan':
                case 'admin':
                    await sock.sendMessage(replyJid, { text: `⚠️ Jika Anda mengalami kendala saat absensi (seperti salah lokasi, akun terkunci di HP lain, atau lupa sandi), segera laporkan kepada Koordinator Admin Dept. RKG untuk ditindaklanjuti.` }, { quoted: msg });
                    break;

                // ============================================================
                // FITUR COMMAND BARU: RESET PASS & LOGOUT PERANGKAT
                // ============================================================
                case 'logout':
                    await sock.sendMessage(replyJid, { text: "⏳ Sistem sedang memproses permintaan pelepasan perangkat (Logout) Anda..." }, { quoted: msg });
                    try {
                        await fetch(RKG_API_BASE_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ no_hp: userWaFormat, scenario: 16 })
                        });
                        // Pesan balasan akan dirakit oleh API dan dikirim via Auto-Pull Queue
                    } catch (e) {
                        await sock.sendMessage(replyJid, { text: "❌ Sistem Cloud sibuk. Coba beberapa saat lagi." }, { quoted: msg });
                    }
                    break;

                case 'reset':
                    await sock.sendMessage(replyJid, { text: "⏳ Sistem sedang mereset kata sandi Anda..." }, { quoted: msg });
                    try {
                        await fetch(RKG_API_BASE_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ no_hp: userWaFormat, scenario: 19 })
                        });
                    } catch (e) {
                        await sock.sendMessage(replyJid, { text: "❌ Sistem Cloud sibuk. Coba beberapa saat lagi." }, { quoted: msg });
                    }
                    break;

                case 'menu':
                case 'help':
                    let manualMenuText = `🏥 *LAYANAN BOT ABSENSI DEPT. RKG* 🏥\n\n`;
                    manualMenuText += `Halo! Saya adalah Bot Notifikasi Resmi. Silakan gunakan perintah publik berikut:\n\n`;
                    manualMenuText += `*👤 MAHASISWA STASE:*\n`;
                    manualMenuText += `> *!portal* (Dapatkan link web absensi)\n`;
                    manualMenuText += `> *!logout* (Pelepasan perangkat / Unlink Device)\n`;
                    manualMenuText += `> *!reset* (Generate Ulang Password Akun)\n`;
                    manualMenuText += `> *!bantuan* (Info kendala sistem)\n\n`;
                    manualMenuText += `*✨ LAINNYA:*\n> !ai <pertanyaan> (Tanya AI)\n> !s (Buat Stiker)\n> !runtime (Status Server)`;
                    await sock.sendMessage(replyJid, { text: manualMenuText }, { quoted: msg });
                    break;

                case 'myid': case 'cekid':
                    await sock.sendMessage(replyJid, { text: `*ℹ️ INFORMASI ID ANDA*\n\n*WA Asli Terdeteksi:* ${userWaFormat}` }, { quoted: msg });
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
// --- AKHIR BAGIAN 1 ---
