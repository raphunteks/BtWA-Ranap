import process from 'process';
import os from 'os';

import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ====================================================================
// 🚀 KONFIGURASI REST API GATEWAY & DATABASE CLOUD DEPT. RKG
// ====================================================================
const RKG_API_BASE_URL = process.env.RKG_API_URL || "https://absensi.maksaarsyad.xyz/api/wa";

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
// 📁 FORMATTER & SAFE PARSER UTILITIES (SUPER UPGRADE)
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

function getWitaTime() {
    const d = new Date();
    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    return new Date(utc + (3600000 * 8)); 
}

const getLocalYYYYMMDD = (dateInput) => {
    const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// Fungsi kebal Crash untuk memastikan Object ditarik sebagai Array asli
const safeParse = (data) => {
    let parsed = data || [];
    let depth = 0;
    while (typeof parsed === 'string' && depth < 3) {
        try { parsed = JSON.parse(parsed); } catch(e) { break; }
        depth++;
    }
    return Array.isArray(parsed) ? parsed : [];
};

const triggerWA_API = async (noHp, scenarioId, payloadData) => {
    if (!noHp) return;
    try {
        await fetch(RKG_API_BASE_URL, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ no_hp: noHp, scenario: scenarioId, data: payloadData })
        });
    } catch(e) { console.error(`[Cron Trigger Error]:`, e.message); }
};

// ====================================================================
// ⚙️ MESIN CRON JOB (JADWAL ABSENSI OTOMATIS 24/7)
// ====================================================================
function startCronJob(sock) {
    console.log("[Cron Job] Mesin waktu otomatis berhasil dihidupkan, berjalan 24/7!");
    
    setInterval(async () => {
        if (!sock || !sock.user) return; 

        try {
            const redis = Redis.fromEnv();
            const now = getWitaTime();
            const dayOfWeek = now.getDay(); 
            const todayStr = getLocalYYYYMMDD(now);

            // 🔥 SUPER FIX: Perbaikan format Jam manual menjadi "HH:mm" (Menggunakan Titik Dua, bukan Titik)
            const currentH = String(now.getHours()).padStart(2, '0');
            const currentM = String(now.getMinutes()).padStart(2, '0');
            const currentHHMM = `${currentH}:${currentM}`;

            let holidays = safeParse(await redis.get('axaxyz_holidays'));
            
            const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
            const isCustomHoliday = holidays.some(h => h.date === todayStr);

            if (isWeekend || isCustomHoliday) return;

            let sessions = safeParse(await redis.get('axaxyz_sessions'));
            let students = safeParse(await redis.get('axaxyz_students'));
            let logs = safeParse(await redis.get('axaxyz_logs'));
            let clusters = safeParse(await redis.get('axaxyz_clusters'));
            let admins = safeParse(await redis.get('axaxyz_admins'));

            for (const sess of sessions) {
                if (!sess.isActive) continue;

                // [SKENARIO 1] PEMBUKAAN SESI ABSENSI
                if (sess.startTime === currentHHMM) {
                    const flagKey = `wa_scen1_${todayStr}_${sess.id}`;
                    const isSent = await redis.get(flagKey);
                    if (!isSent) {
                        await redis.set(flagKey, true);
                        students.forEach(st => {
                            const c = clusters.find(cl => cl.id === st.clusterId);
                            triggerWA_API(st.noHp, 1, { namaLengkap: st.name, kelompok: c?.name, shift: sess.name, jamSesi: sess.startTime, jamTutup: sess.endTime });
                        });
                    }
                }

                // [SKENARIO 2] PENGINGAT SISA WAKTU
                if (sess.endTime === currentHHMM) {
                    const flagKey = `wa_scen2_${todayStr}_${sess.id}`;
                    const isSent = await redis.get(flagKey);
                    if (!isSent) {
                        await redis.set(flagKey, true);
                        students.forEach(st => {
                            const hasLogged = logs.some(l => l.nim === st.nim && l.sessionName === sess.name && getLocalYYYYMMDD(l.timestamp) === todayStr);
                            if (!hasLogged && st.noHp) {
                                triggerWA_API(st.noHp, 2, { namaLengkap: st.name, shift: sess.name, jamTutup: sess.endTime });
                            }
                        });
                    }
                }

                // [SKENARIO 4 & 9] REKAP AKHIR SESI & SP OTOMATIS
                const [endH, endM] = sess.endTime.split(':').map(Number);
                const endTotal = endH * 60 + endM + (sess.toleranceMinutes || 15);
                const currentTotal = now.getHours() * 60 + now.getMinutes();

                if (currentTotal === endTotal + 1) { 
                    const flagKey = `wa_scen4_${todayStr}_${sess.id}`;
                    const isSent = await redis.get(flagKey);
                    if (!isSent) {
                        await redis.set(flagKey, true);
                        students.forEach(async (st) => {
                            const c = clusters.find(cl => cl.id === st.clusterId);
                            const log = logs.find(l => l.nim === st.nim && l.sessionName === sess.name && getLocalYYYYMMDD(l.timestamp) === todayStr);
                            const stAkhir = log ? log.status : 'Alpha';
                            const jAbsen = log ? new Date(log.timestamp).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'}) : '-';
                            
                            triggerWA_API(st.noHp, 4, { namaLengkap: st.name, shift: sess.name, jamTutup: sess.endTime, statusAkhir: stAkhir, jamAbsen: jAbsen, kelompok: c?.name });

                            if (stAkhir === 'Alpha') {
                                let totalAlphaHist = 0; let totalTelatHist = 0;
                                if (c && c.startDate) {
                                    const startD = new Date(c.startDate);
                                    const endD = getWitaTime();
                                    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
                                        if (d > getWitaTime()) break;
                                        
                                        const dateStrLocal = getLocalYYYYMMDD(d);
                                        const loopDayOfWeek = d.getDay();
                                        if ((loopDayOfWeek === 0 || loopDayOfWeek === 6) || holidays.some(h => h.date === dateStrLocal)) continue;

                                        sessions.forEach(s => {
                                            if (s.isActive) {
                                                const pastLog = logs.find(l => l.nim === st.nim && getLocalYYYYMMDD(l.timestamp) === dateStrLocal && l.sessionName === s.name);
                                                if (pastLog) {
                                                    if (pastLog.status === 'Terlambat') totalTelatHist++;
                                                } else {
                                                    const [eH, eM] = s.endTime.split(':').map(Number);
                                                    const eTotal = eH * 60 + eM + (s.toleranceMinutes || 15);
                                                    if (dateStrLocal === todayStr) {
                                                        const cMins = getWitaTime().getHours() * 60 + getWitaTime().getMinutes();
                                                        if (cMins > eTotal) totalAlphaHist++;
                                                    } else {
                                                        if (d < new Date(getWitaTime().setHours(0,0,0,0))) totalAlphaHist++;
                                                    }
                                                }
                                            }
                                        });
                                    }
                                }
                                if (totalAlphaHist >= 3) { 
                                    const spFlagKey = `wa_scen9_${st.nim}_${totalAlphaHist}`;
                                    const isSpSent = await redis.get(spFlagKey);
                                    if (!isSpSent) {
                                        await redis.set(spFlagKey, true);
                                        triggerWA_API(st.noHp, 9, { namaLengkap: st.name, kelompok: c?.name, totalAlpha: totalAlphaHist, totalTerlambat: totalTelatHist });
                                    }
                                }
                            }
                        });
                    }
                }
            }

            if (currentHHMM === '10:00') {
                const flagKey = `wa_scen17_${todayStr}`;
                const isSent = await redis.get(flagKey);
                if (!isSent) {
                    await redis.set(flagKey, true);
                    students.forEach(st => {
                        const c = clusters.find(cl=>cl.id === st.clusterId);
                        if (c && c.endDate === todayStr) { triggerWA_API(st.noHp, 17, { namaLengkap: st.name, kelompok: c.name }); }
                    });
                }
            }

            if (currentHHMM === '23:50') {
                const flagKey = `wa_scen20_${todayStr}`;
                const isSent = await redis.get(flagKey);
                if (!isSent) {
                    await redis.set(flagKey, true);
                    const tHadir = logs.filter(l => getLocalYYYYMMDD(l.timestamp) === todayStr && l.status === 'Hadir').length;
                    const tTelat = logs.filter(l => getLocalYYYYMMDD(l.timestamp) === todayStr && l.status === 'Terlambat').length;
                    const activeSessCount = sessions.filter(s => s.isActive).length;
                    const tAlpha = (students.length * activeSessCount) - (tHadir + tTelat);
                    
                    admins.forEach(ad => { 
                        if (ad.noHp) {
                            triggerWA_API(ad.noHp, 20, {
                                tanggal: now.toLocaleDateString('id-ID', {weekday: 'long', day:'numeric', month:'long'}),
                                totalMhs: students.length, totalHadir: tHadir, totalTerlambat: tTelat, totalAlpha: tAlpha > 0 ? tAlpha : 0
                            });
                        }
                    });
                }
            }
        } catch (err) { }
    }, 60000); 
}

// ====================================================================
// 🚀 MAIN HANDLER BOT DEPT. RKG (PULL ARCHITECTURE)
// ====================================================================
export default async function setupMessageHandler(sock) {
    console.log("[System] BOT ABSENSI DEPT. RKG Aktif!");
    console.log("[System] Fitur Auto-Pull Queue Message & Cron Job Berjalan di Background.");

    startCronJob(sock);

    // ====================================================================
    // 🔄 AUTO-POLLING API (PULL METHOD SETIAP 5 DETIK)
    // ====================================================================
    setInterval(async () => {
        if (!sock || !sock.user) return;

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
                                
                                // Auto-LID Mapper
                                let resolvedId = finalLid.split('@')[0];
                                if (resolvedId !== rawWa) {
                                    const redis = Redis.fromEnv();
                                    let students = safeParse(await redis.get('axaxyz_students'));
                                    
                                    let sIndex = students.findIndex(s => {
                                        if (!s.noHp) return false;
                                        let sHp = String(s.noHp).replace(/[^0-9]/g, '');
                                        if (sHp.startsWith('0')) sHp = '62' + sHp.substring(1);
                                        return sHp === rawWa;
                                    });

                                    if (sIndex !== -1 && students[sIndex].lid !== resolvedId) {
                                        students[sIndex].lid = resolvedId;
                                        await redis.set('axaxyz_students', students);
                                    }
                                }
                            }
                        } catch (e) { }

                        await sock.sendMessage(finalLid, { text: msgData.formatted_message });
                        console.log(`[Auto-Send 🚀] Pesan terkirim sukses ke ${rawWa}.`);

                        try {
                            await fetch(RKG_API_BASE_URL, {
                                method: "DELETE",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ message_id: msgData.id })
                            });
                        } catch (err) { }

                    } catch (fatalErr) {
                        console.log(`[Auto-Send ❌ GAGAL] Tidak dapat mengirim pesan ke WA: ${msgData.target_number}. Alasan: ${fatalErr.message}`);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        } catch (err) { }
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

            let userWaFormat = formatWaNumber(senderId);
            if (!userWaFormat || userWaFormat.length < 10) userWaFormat = senderId.replace(/[^0-9]/g, '');

            const targetWaToProcess = args[0] ? formatWaNumber(args[0]) : userWaFormat;

            switch (command) {
                case 'portal':
                case 'absen':
                    await sock.sendMessage(replyJid, { text: `🏥 *PORTAL ABSENSI DEPT. RKG*\n\nSilakan klik tautan di bawah ini untuk mengakses dashboard absensi Anda:\n🔗 https://absensi.maksaarsyad.xyz/` }, { quoted: msg });
                    break;
                
                case 'bantuan':
                case 'admin':
                    await sock.sendMessage(replyJid, { text: `⚠️ Jika Anda mengalami kendala saat absensi (seperti salah lokasi, akun terkunci di HP lain, atau lupa sandi), segera laporkan kepada Koordinator Admin Dept. RKG untuk ditindaklanjuti.` }, { quoted: msg });
                    break;

                case 'logout':
                    await sock.sendMessage(replyJid, { text: "⏳ Memproses pelepasan perangkat (Logout)..." }, { quoted: msg });
                    try {
                        const resApi = await fetch(RKG_API_BASE_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ no_hp: targetWaToProcess, scenario: 16 })
                        });
                        const resJson = await resApi.json();
                        if (!resJson.success) await sock.sendMessage(replyJid, { text: `❌ Gagal: ${resJson.error}` }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(replyJid, { text: "❌ Sistem sibuk." }, { quoted: msg }); }
                    break;

                case 'reset':
                    await sock.sendMessage(replyJid, { text: "⏳ Memproses reset kata sandi..." }, { quoted: msg });
                    try {
                        const resApi = await fetch(RKG_API_BASE_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ no_hp: targetWaToProcess, scenario: 19 })
                        });
                        const resJson = await resApi.json();
                        if (!resJson.success) await sock.sendMessage(replyJid, { text: `❌ Gagal: ${resJson.error}` }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(replyJid, { text: "❌ Sistem sibuk." }, { quoted: msg }); }
                    break;

                case 'menu':
                case 'help':
                    let manualMenuText = `🏥 *LAYANAN BOT ABSENSI DEPT. RKG* 🏥\n\n*👤 MAHASISWA STASE:*\n> *!portal*\n> *!logout* ATAU *!logout 0812...*\n> *!reset* ATAU *!reset 0812...*\n> *!bantuan*\n\n*✨ LAINNYA:*\n> !ai <tanya>\n> !s (Stiker)\n> !runtime`;
                    await sock.sendMessage(replyJid, { text: manualMenuText }, { quoted: msg });
                    break;

                case 'myid': case 'cekid':
                    await sock.sendMessage(replyJid, { text: `*ℹ️ INFORMASI ID ANDA*\n\n*WA/LID Terdeteksi:* ${userWaFormat}` }, { quoted: msg });
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
