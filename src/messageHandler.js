import fs from 'fs';
import process from 'process';
import os from 'os';
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ==========================================
// KONFIGURASI GLOBAL & STATE
// ==========================================
const ownerNumber = "6285256739684@s.whatsapp.net";
const GAS_URL = "https://script.google.com/macros/s/AKfycbzhDou1e-e4QXDILWfM_mkyagViYOvcpLLv7xL-kJ6cVhpR_R5_bVICdnUYxp0AA90/exec";
const botStartTime = new Date(); 

const sessionPath = './session';
const schedulesFile = `${sessionPath}/schedules.json`; 
const settingsFile = `${sessionPath}/settings.json`; 

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

let botSchedules = [];
// Menambahkan autoSholat ke botSettings
let botSettings = { autoRanap: [], autoRajal: [], autoSholat: [] };

if (fs.existsSync(schedulesFile)) {
    try { botSchedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8')); } catch (e) { }
}
if (fs.existsSync(settingsFile)) {
    try { botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) }; } catch (e) { }
}

// DEFAULT ON UNTUK OWNER (JIKA KOSONG)
if (!botSettings.autoSholat.includes(ownerNumber)) {
    botSettings.autoSholat.push(ownerNumber);
    saveSettings();
}

function saveSchedules() { fs.writeFileSync(schedulesFile, JSON.stringify(botSchedules, null, 2)); }
function saveSettings() { fs.writeFileSync(settingsFile, JSON.stringify(botSettings, null, 2)); }

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} days ago`; if (h > 0) return `${h} hours ago`; if (m > 0) return `${m} minutes ago`;
    return `${Math.floor(seconds)} seconds ago`;
}

function formatWITA(dateObj) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Makassar', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true }).format(dateObj);
}

// ==========================================
// STATE & FUNGSI JADWAL SHOLAT KENDARI
// ==========================================
let todaySholatTimes = null;
let lastDailySholatSent = null; 
let notifiedPrayers = { Fajr: false, Dhuhr: false, Asr: false, Maghrib: false, Isha: false, date: null };

async function fetchSholatKendari() {
    try {
        const res = await fetch("https://api.aladhan.com/v1/timingsByCity?city=Kendari&country=Indonesia&method=20");
        const json = await res.json();
        if (json.code === 200) return json.data.timings;
        return null;
    } catch (e) {
        console.error("Gagal fetch API Sholat:", e);
        return null;
    }
}

// ==========================================
// FUNGSI PINTAR: FETCH WITH FALLBACK (VERCEL -> GAS)
// ==========================================
async function fetchWithFallback(endpointName, queryParams = "") {
    try {
        const vercelUrl = `https://ishiprsud.vercel.app/api/${endpointName}${queryParams ? '?' + queryParams : ''}`;
        const res = await fetch(vercelUrl);
        const data = await res.json();
        
        if (data.status && data.data && data.data.length > 0) return data;
        throw new Error("Vercel Kosong/Down");
    } catch (e) {
        console.log(`[API Fallback] Vercel gagal/kosong untuk ${endpointName}, memanggil Google Sheets API...`);
        try {
            const gasUrl = `${GAS_URL}?type=${endpointName}`;
            const gasRes = await fetch(gasUrl);
            const gasData = await gasRes.json();
            
            if (gasData.status && gasData.data) {
                let finalData = gasData.data;
                if (queryParams.includes('tanggal=')) {
                    const tglMatch = queryParams.match(/tanggal=([^&]+)/);
                    if (tglMatch) {
                        const [y, m, d] = tglMatch[1].split('-');
                        const fmt = `${d}-${m}-${y}`; 
                        finalData = finalData.filter(i => 
                            (i.tanggal_masuk && i.tanggal_masuk.includes(fmt)) || 
                            (i.tanggal_kunjungan && i.tanggal_kunjungan.includes(fmt))
                        );
                    }
                }
                gasData.data = finalData;
                gasData.total_data = finalData.length;
                return gasData;
            }
        } catch (err) {
            console.log(`[API Fallback] GAS juga gagal untuk ${endpointName}`);
        }
        return { status: false, data: [] };
    }
}

// ==========================================
// SMART CHRONOLOGICAL SORTING & DIFF ALGORITHM
// ==========================================
let lastRanapData = null;
let lastRajalEndoData = null;
let lastRajalBMData = null;
let lastRajalPerioData = null; 
let lastRajalUmumData = null; 

function sortChronologically(oldList, newList) {
    const makeKey = (p) => `${p.no_rm}_${p.nama_pasien}`;
    const oldMap = new Map(oldList.map((p, index) => [makeKey(p), index]));

    return [...newList].sort((a, b) => {
        const idxA = oldMap.has(makeKey(a)) ? oldMap.get(makeKey(a)) : Infinity;
        const idxB = oldMap.has(makeKey(b)) ? oldMap.get(makeKey(b)) : Infinity;
        
        if (idxA !== Infinity && idxB !== Infinity) return idxA - idxB;
        else if (idxA === Infinity && idxB !== Infinity) return 1; 
        else if (idxA !== Infinity && idxB === Infinity) return -1;
        else return 0;
    });
}

function getDifferences(oldList, newList) {
    const makeKey = (p) => `${p.no_rm}_${p.nama_pasien}`;
    const oldMap = new Map(oldList.map(p => [makeKey(p), p]));
    const newMap = new Map(newList.map(p => [makeKey(p), p]));
    
    const added = newList.filter(p => !oldMap.has(makeKey(p)));
    const removed = oldList.filter(p => !newMap.has(makeKey(p)));
    
    const changed = newList.filter(p => {
        if (oldMap.has(makeKey(p))) {
            const oldP = oldMap.get(makeKey(p));
            const oldStatus = (oldP.status || "").toUpperCase();
            const newStatus = (p.status || "").toUpperCase();
            if (oldStatus !== newStatus) return true;
        }
        return false;
    });
    
    return { added, removed, changed, hasDiff: added.length > 0 || removed.length > 0 || changed.length > 0 };
}

// ==========================================
// FORMATTING LIST RAJAL (Selesai/Batal di atas, Baru berurutan di bawah)
// ==========================================
function formatKlinikList(namaKlinik, iconKlinik, currentList, removedList) {
    let resultTxt = `${iconKlinik} *Klinik ${namaKlinik}*:\n`;
    let countBaru = 0;
    let countSelesai = 0;

    let listSelesai = [];
    let listBaru = [];

    if (removedList && removedList.length > 0) {
        removedList.forEach(p => {
            listSelesai.push(`${p.nama_pasien} *(SELESAI)*`);
            countSelesai++;
        });
    }

    currentList.forEach(p => {
        const st = (p.status || "").toUpperCase();
        
        if (st.includes("BATAL")) {
            listSelesai.push(`${p.nama_pasien} *(BATAL)*`);
            countSelesai++;
        } 
        else if (st.includes("ASUHAN KEPERAWATAN")) {
            listBaru.push(`${p.nama_pasien} *(BARU)*`);
            countBaru++;
        } 
        else if (st.includes("PULANG") || st.includes("SELESAI") || st.includes("DIPULANGKAN") || st.includes("SATUSEHAT")) {
            listSelesai.push(`${p.nama_pasien} *(SELESAI)*`);
            countSelesai++;
        } 
        else {
            listBaru.push(`${p.nama_pasien} *(BARU)*`);
            countBaru++;
        }
    });

    let combinedList = [...listSelesai, ...listBaru];

    if (combinedList.length === 0) {
        resultTxt += `_(Tidak ada pasien)_\n\n`;
    } else {
        combinedList.forEach((item, index) => {
            resultTxt += `${index + 1}. ${item}\n`;
        });
        resultTxt += `\n`;
    }

    return { txt: resultTxt, baru: countBaru, selesai: countSelesai };
}

// ==========================================
// FUNGSI PENGIRIMAN DATA PRIMER (SAAT ON)
// ==========================================
async function forceSendRanapPrimer(sock, jid) {
    try {
        await sock.sendMessage(jid, { text: `⏳ _Menyiapkan Data Primer Rawat Inap..._` });
        const dataRanap = await fetchWithFallback('Ranap');
        if (dataRanap.status) {
            const currentRanap = dataRanap.data || [];
            lastRanapData = currentRanap; 
            let msg = `🏥 *AUTO INFO: RAWAT INAP (DATA PRIMER)*\n_Berikut adalah baseline pasien saat ini._\n\n`;
            if (currentRanap.length > 0) {
                currentRanap.forEach((p, i) => msg += `${i+1}. ${p.nama_pasien}\n   🛏️ ${p.ruangan}\n`);
            } else {
                msg += `_(Tidak ada pasien rawat inap saat ini)_\n`;
            }
            msg += `\n📊 *Total Saat Ini:* ${currentRanap.length} Pasien`;
            await sock.sendMessage(jid, { text: msg });
        }
    } catch (e) { console.error("Gagal load primer Ranap:", e); }
}

async function forceSendRajalPrimer(sock, jid) {
    try {
        await sock.sendMessage(jid, { text: `⏳ _Menyiapkan Data Primer Rawat Jalan..._` });
        const dateWITA = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' }); 
        
        const [dataEndo, dataBM, dataPerio, dataUmum] = await Promise.all([
            fetchWithFallback('RajalEndo_RiwayatAntrianPx', `tanggal=${dateWITA}`),
            fetchWithFallback('RajalBM_RiwayatAntrianPx', `tanggal=${dateWITA}`),
            fetchWithFallback('RajalPerio_RiwayatAntrianPx', `tanggal=${dateWITA}`),
            fetchWithFallback('RajalUmum_RiwayatAntrianPx', `tanggal=${dateWITA}`)
        ]);

        const currentEndoRaw = dataEndo.data || [];
        const currentBMRaw = dataBM.data || [];
        const currentPerioRaw = dataPerio.data || [];
        const currentUmumRaw = dataUmum.data || [];

        const currentEndo = sortChronologically(lastRajalEndoData || [], currentEndoRaw);
        const currentBM = sortChronologically(lastRajalBMData || [], currentBMRaw);
        const currentPerio = sortChronologically(lastRajalPerioData || [], currentPerioRaw);
        const currentUmum = sortChronologically(lastRajalUmumData || [], currentUmumRaw);

        lastRajalEndoData = currentEndo;
        lastRajalBMData = currentBM;
        lastRajalPerioData = currentPerio;
        lastRajalUmumData = currentUmum;

        let msg = `🏥 *AUTO INFO: RAWAT JALAN (DATA PRIMER)*\n_Baseline antrean tanggal ${dateWITA}._\n\n`;
        
        const formatEndo = formatKlinikList("ENDODONSI", "🦷", currentEndo, []);
        const formatPerio = formatKlinikList("PERIODONSIA", "🩺", currentPerio, []);
        const formatBM = formatKlinikList("Bedah Mulut", "💉", currentBM, []);
        const formatUmum = formatKlinikList("Gigi/Umum", "🪥", currentUmum, []);

        msg += formatEndo.txt;
        msg += formatPerio.txt;
        msg += formatBM.txt;
        msg += formatUmum.txt;

        msg += `📊 *Total Antrean (BARU: BELUM DIKERJA):* Endo (${formatEndo.baru}), BM (${formatBM.baru}), Perio (${formatPerio.baru}), Umum (${formatUmum.baru})\n`;
        msg += `📊 *Total Antrean (SELESAI/BATAL):* Endo (${formatEndo.selesai}), BM (${formatBM.selesai}), Perio (${formatPerio.selesai}), Umum (${formatUmum.selesai})`;
        
        await sock.sendMessage(jid, { text: msg });
    } catch (e) { console.error("Gagal load primer Rajal:", e); }
}

// ==========================================
// POLLING API AUTO-UPDATE & JADWAL SHOLAT
// ==========================================
async function checkApiUpdates(sock) {
    if (!sock) return;
    try {
        const resTrigger = await fetch('https://ishiprsud.vercel.app/api/trigger');
        const dataTrigger = await resTrigger.json();
        if (dataTrigger.notify && dataTrigger.notify.trim() !== "") {
            await sock.sendMessage(ownerNumber, { text: dataTrigger.notify });
        }

        // =======================================
        // 1. AUTO INFO: RANAP
        // =======================================
        if (botSettings.autoRanap.length > 0) {
            const dataRanap = await fetchWithFallback('Ranap');
            if (dataRanap.status) {
                const currentRanap = dataRanap.data || [];
                if (lastRanapData !== null) {
                    const { added, removed } = getDifferences(lastRanapData, currentRanap);
                    if (added.length > 0 || removed.length > 0) {
                        let msg = `🏥 *AUTO INFO: RAWAT INAP*\n_Mendeteksi perubahan data manifest._\n\n`;
                        if (added.length > 0) {
                            msg += `🟢 *PASIEN MASUK/BARU (${added.length}):*\n`;
                            added.forEach((p, i) => msg += `${i+1}. ${p.nama_pasien} *(BARU)*\n   🛏️ ${p.ruangan}\n`);
                            msg += `\n`;
                        }
                        if (removed.length > 0) {
                            msg += `🔴 *PASIEN KELUAR/PULANG (${removed.length}):*\n`;
                            removed.forEach((p, i) => msg += `${i+1}. ${p.nama_pasien} *(PULANG / SELESAI)*\n   🛏️ ${p.ruangan}\n`);
                            msg += `\n`;
                        }
                        msg += `📊 *Total Saat Ini:* ${currentRanap.length} Pasien`;
                        for (const jid of botSettings.autoRanap) await sock.sendMessage(jid, { text: msg });
                    }
                }
                lastRanapData = currentRanap;
            }
        }

        // =======================================
        // 2. AUTO INFO: RAJAL (4 KLINIK)
        // =======================================
        if (botSettings.autoRajal.length > 0) {
            const dateWITA = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' }); 
            const [dataEndo, dataBM, dataPerio, dataUmum] = await Promise.all([
                fetchWithFallback('RajalEndo_RiwayatAntrianPx', `tanggal=${dateWITA}`),
                fetchWithFallback('RajalBM_RiwayatAntrianPx', `tanggal=${dateWITA}`),
                fetchWithFallback('RajalPerio_RiwayatAntrianPx', `tanggal=${dateWITA}`),
                fetchWithFallback('RajalUmum_RiwayatAntrianPx', `tanggal=${dateWITA}`)
            ]);

            const currentEndoRaw = dataEndo.data || [];
            const currentBMRaw = dataBM.data || [];
            const currentPerioRaw = dataPerio.data || [];
            const currentUmumRaw = dataUmum.data || [];

            const currentEndo = sortChronologically(lastRajalEndoData || [], currentEndoRaw);
            const currentBM = sortChronologically(lastRajalBMData || [], currentBMRaw);
            const currentPerio = sortChronologically(lastRajalPerioData || [], currentPerioRaw);
            const currentUmum = sortChronologically(lastRajalUmumData || [], currentUmumRaw);

            if (lastRajalEndoData !== null && lastRajalBMData !== null && lastRajalPerioData !== null && lastRajalUmumData !== null) {
                const diffEndo = getDifferences(lastRajalEndoData, currentEndo);
                const diffBM = getDifferences(lastRajalBMData, currentBM);
                const diffPerio = getDifferences(lastRajalPerioData, currentPerio);
                const diffUmum = getDifferences(lastRajalUmumData, currentUmum);
                
                if (diffEndo.hasDiff || diffBM.hasDiff || diffPerio.hasDiff || diffUmum.hasDiff) {
                    let msg = `🏥 *AUTO INFO: RAWAT JALAN*\n_Perubahan antrean tanggal ${dateWITA}._\n\n`;
                    const formatEndo = formatKlinikList("ENDODONSI", "🦷", currentEndo, diffEndo.removed);
                    const formatPerio = formatKlinikList("PERIODONSIA", "🩺", currentPerio, diffPerio.removed);
                    const formatBM = formatKlinikList("Bedah Mulut", "💉", currentBM, diffBM.removed);
                    const formatUmum = formatKlinikList("Gigi/Umum", "🪥", currentUmum, diffUmum.removed);

                    msg += formatEndo.txt + formatPerio.txt + formatBM.txt + formatUmum.txt;
                    msg += `📊 *Total Antrean (BARU: BELUM DIKERJA):* Endo (${formatEndo.baru}), BM (${formatBM.baru}), Perio (${formatPerio.baru}), Umum (${formatUmum.baru})\n`;
                    msg += `📊 *Total Antrean (SELESAI/BATAL):* Endo (${formatEndo.selesai}), BM (${formatBM.selesai}), Perio (${formatPerio.selesai}), Umum (${formatUmum.selesai})`;
                    
                    for (const jid of botSettings.autoRajal) await sock.sendMessage(jid, { text: msg });
                }
            }
            lastRajalEndoData = currentEndo;
            lastRajalBMData = currentBM;
            lastRajalPerioData = currentPerio;
            lastRajalUmumData = currentUmum;
        }
    } catch (e) { console.error("[Auto Info] Error polling API:", e); }
}

async function checkSholatSchedule(sock) {
    if (!sock || botSettings.autoSholat.length === 0) return;
    
    try {
        const now = new Date();
        const dateWITA = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' }); 
        const timeWITA = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' });

        // Reset state jika berganti hari
        if (notifiedPrayers.date !== dateWITA) {
            notifiedPrayers = { Fajr: false, Dhuhr: false, Asr: false, Maghrib: false, Isha: false, date: dateWITA };
            todaySholatTimes = await fetchSholatKendari();
        }

        // Broadcast Daily Jam 00:01 (Atau saat bot baru restart di hari tsb)
        if (lastDailySholatSent !== dateWITA && todaySholatTimes) {
            const sholatMsg = `🕌 *JADWAL SHOLAT KENDARI & SEKITARNYA*\n🗓️ *Tanggal:* ${dateWITA}\n\n` +
                              `🌅 Imsak: ${todaySholatTimes.Imsak} WITA\n` +
                              `🌄 *Subuh:* ${todaySholatTimes.Fajr} WITA\n` +
                              `☀️ Terbit: ${todaySholatTimes.Sunrise} WITA\n` +
                              `🕛 *Dzuhur:* ${todaySholatTimes.Dhuhr} WITA\n` +
                              `🕝 *Ashar:* ${todaySholatTimes.Asr} WITA\n` +
                              `🌇 *Maghrib:* ${todaySholatTimes.Maghrib} WITA\n` +
                              `🌃 *Isya:* ${todaySholatTimes.Isha} WITA\n\n` +
                              `_Bot akan memberikan notifikasi saat memasuki waktu sholat._`;
            
            for (const jid of botSettings.autoSholat) {
                await sock.sendMessage(jid, { text: sholatMsg });
            }
            lastDailySholatSent = dateWITA;
        }

        // Pengecekan Waktu Masuk Sholat (Real-time)
        if (todaySholatTimes) {
            const prayersToCheck = [
                { id: 'Fajr', name: 'Subuh', emoji: '🌄' },
                { id: 'Dhuhr', name: 'Dzuhur', emoji: '🕛' },
                { id: 'Asr', name: 'Ashar', emoji: '🕝' },
                { id: 'Maghrib', name: 'Maghrib', emoji: '🌇' },
                { id: 'Isha', name: 'Isya', emoji: '🌃' }
            ];

            for (const prayer of prayersToCheck) {
                if (timeWITA === todaySholatTimes[prayer.id] && !notifiedPrayers[prayer.id]) {
                    const alertMsg = `${prayer.emoji} *PENGINGAT WAKTU SHOLAT*\n\n` +
                                     `Telah masuk waktu sholat *${prayer.name}* (${timeWITA} WITA) untuk wilayah Kendari dan sekitarnya.\n\n` +
                                     `_Mari sejenak hentikan aktivitas dan laksanakan sholat._`;
                    
                    for (const jid of botSettings.autoSholat) {
                        await sock.sendMessage(jid, { text: alertMsg });
                    }
                    notifiedPrayers[prayer.id] = true; // Tandai sudah dikirim
                }
            }
        }
    } catch (e) {
        console.error("Gagal memeriksa jadwal sholat:", e);
    }
}

// ==========================================
// EXPORT HANDLER
// ==========================================
let isIntervalStarted = false;
let currentSock = null;

export default function setupMessageHandler(sock) {
    currentSock = sock; 

    if (!isIntervalStarted) {
        // Interval Tugas Tertunda (30s)
        setInterval(async () => {
            if (!currentSock) return;
            const now = Date.now(); let hasChanges = false;
            for (let i = 0; i < botSchedules.length; i++) {
                const jadwal = botSchedules[i];
                if (jadwal.status === 'pending' && now >= jadwal.timestamp) {
                    try { await currentSock.sendMessage(jadwal.target, { text: jadwal.pesan }); jadwal.status = 'sent'; hasChanges = true; } 
                    catch (err) { jadwal.status = 'failed'; hasChanges = true; }
                }
            }
            if (hasChanges) { botSchedules = botSchedules.filter(s => s.status === 'pending'); saveSchedules(); }
        }, 30000); 

        // Interval Cek RSUD (60s)
        setInterval(() => {
            if (currentSock) checkApiUpdates(currentSock);
        }, 60000);

        // Interval Cek Sholat (setiap 30s agar lebih akurat)
        setInterval(() => {
            if (currentSock) checkSholatSchedule(currentSock);
        }, 30000);

        isIntervalStarted = true;
    }

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';
            const prefix = '!'; if (!text.startsWith(prefix)) return;

            const args = text.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const sender = msg.key.remoteJid;

            console.log(`[COMMAND] ${command} dari ${sender}`);

            const isRajal = command.startsWith('cekrajal');

            if (isRajal) {
                await sock.sendMessage(sender, { text: `⏳ _Sedang mengambil data rawat jalan dari server..._` }, { quoted: msg });
                try {
                    const isEndo = command.includes('endo'); 
                    const isPerio = command.includes('perio');
                    const isUmum = command.includes('umum') || command.includes('gigi'); 
                    const isRiwayat = command.includes('riwayat');
                    const isBesok = command.endsWith('bsk');

                    let endpointName = '';
                    let baseEndpoint = '';

                    if (isEndo) baseEndpoint = 'RajalEndo';
                    else if (isPerio) baseEndpoint = 'RajalPerio';
                    else if (isUmum) baseEndpoint = 'RajalUmum';
                    else baseEndpoint = 'RajalBM';

                    if (isRiwayat) endpointName = `${baseEndpoint}_RiwayatAntrianPx`;
                    else endpointName = `${baseEndpoint}_AntrianPx`;

                    const namaPoli = isEndo ? 'ENDODONSI' : (isPerio ? 'PERIODONSI' : (isUmum ? 'KLINIK GIGI/UMUM' : 'BEDAH MULUT'));
                    const namaJenis = isRiwayat ? 'Riwayat Antrian' : 'Antrian Pasien';
                    
                    let targetDate = new Date(); 
                    if (isBesok) targetDate.setDate(targetDate.getDate() + 1);
                    const dateWITA = targetDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' }); 
                    
                    const result = await fetchWithFallback(endpointName, `tanggal=${dateWITA}`);

                    if (!result.status || result.data.length === 0) {
                        await sock.sendMessage(sender, { text: `📭 *Tidak ada data ${namaJenis} ${namaPoli} untuk tanggal ${dateWITA}.*` }, { quoted: msg });
                        return;
                    }

                    let replyTxt = `🏥 *${namaJenis.toUpperCase()} (${namaPoli})*\n📅 *Tanggal Kunjungan:* ${dateWITA}\n\n`;
                    replyTxt += `📊 *Total Pasien:* ${result.total_data}\n`;
                    replyTxt += `⏱️ *Update Terakhir:* ${result.last_updated || 'Terbaru'}\n\n`;

                    result.data.forEach((p, i) => {
                        replyTxt += `*${i + 1}. ${p.nama_pasien}*\n`;
                        replyTxt += ` 🆔 RM: ${p.no_rm}\n`;
                        replyTxt += ` ⏰ Kunjungan: ${p.tanggal_kunjungan}\n`;
                        replyTxt += ` 👨‍⚕️ Dokter: ${p.dokter}\n`;
                        replyTxt += ` 🏷️ Penjamin: ${p.penjamin}\n`;
                        replyTxt += ` 📌 Status: ${p.status}\n\n`;
                    });

                    replyTxt += `*_Data disinkronkan otomatis dari Web RSUD Kendari._*`;
                    await sock.sendMessage(sender, { text: replyTxt }, { quoted: msg });

                } catch (error) {
                    console.error(`Error fetching ${command}:`, error);
                    await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel maupun Google Sheets.*\nPastikan Ekstensi Auto-Scrape di PC menyala.' }, { quoted: msg });
                }
                return; 
            }

            switch (command) {
                case 'menu':
                case 'help':
                    const menuText = `*🤖 BOT MENU 🤖*\n\n` +
                                     `*🏥 DAFTAR PERINTAH KLINIK:*\n` +
                                     `* !jadwalranap* - Cek pasien Rawat Inap\n\n` +
                                     `*(HARI INI)*\n` +
                                     `* !cekrajalriwayatendo*\n` +
                                     `* !cekrajalantrianpxendo*\n` +
                                     `* !cekrajalriwayatbm*\n` +
                                     `* !cekrajalantrianpxbm*\n` +
                                     `* !cekrajalriwayatperio*\n` +
                                     `* !cekrajalantrianpxperio*\n` +
                                     `* !cekrajalriwayatumum*\n` +
                                     `* !cekrajalantrianpxumum*\n\n` +
                                     `*(BESOK)*\n` +
                                     `* !cekrajalriwayatendobsk*\n` +
                                     `* !cekrajalantrianpxendobsk*\n` +
                                     `* !cekrajalriwayatbmbsk*\n` +
                                     `* !cekrajalantrianpxbmbsk*\n` +
                                     `* !cekrajalriwayatperiobsk*\n` +
                                     `* !cekrajalantrianpxperiobsk*\n` +
                                     `* !cekrajalriwayatumumbsk*\n` +
                                     `* !cekrajalantrianpxumumbsk*\n\n` +
                                     `*🔔 AUTO INFO (GROUP/CHAT):*\n` +
                                     `* !autoranap on/off* - Notif Otomatis Ranap\n` +
                                     `* !autorajal on/off* - Notif Otomatis Rajal\n` +
                                     `* !autoinfosholat on/off* - Notif & Pengingat Sholat\n\n` +
                                     `*📖 AL-QURAN & ISLAMI:*\n` +
                                     `* !listsurah* - Menampilkan daftar ke-114 Surah\n` +
                                     `* !surah <nomor>* - Menampilkan info Surah spesifik\n` +
                                     `* !ayat <surah> <ayat>* - Teks, Arti, & Audio Ayat\n\n` +
                                     `*⚙️ SISTEM & LAINNYA:*\n` +
                                     `* !settings* - Lihat fitur otomatis yang aktif\n` +
                                     `* !refresh* - 🔄 Paksa Ekstensi Scrape!\n` +
                                     `* !addjadwal* - Tambah auto-send\n` +
                                     `* !listjadwal* - Lihat auto-send\n` +
                                     `* !deljadwal <id>* - Hapus auto-send\n` +
                                     `* !ping* - Cek ping bot\n` +
                                     `* !runtime* - Cek sistem info\n` +
                                     `* !tagall* - Tag semua member grup\n`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;

                case 'settings':
                    const ranapActive = botSettings.autoRanap.includes(sender) ? '✅ AKTIF' : '❌ NONAKTIF';
                    const rajalActive = botSettings.autoRajal.includes(sender) ? '✅ AKTIF' : '❌ NONAKTIF';
                    const sholatActive = botSettings.autoSholat.includes(sender) ? '✅ AKTIF' : '❌ NONAKTIF';
                    
                    let setsMsg = `⚙️ *PENGATURAN BOT DI CHAT INI*\n\n` +
                                  `🏥 *Auto Info Rawat Inap:* ${ranapActive}\n` +
                                  `🏥 *Auto Info Rawat Jalan:* ${rajalActive}\n` +
                                  `🕌 *Auto Info Sholat (Kendari):* ${sholatActive}\n\n` +
                                  `_Gunakan command *!autoranap on*, *!autorajal on*, atau *!autoinfosholat on* untuk mengaktifkan fitur._`;
                    
                    await sock.sendMessage(sender, { text: setsMsg }, { quoted: msg });
                    break;

                case 'autoinfosholat':
                    if (args[0] === 'on') {
                        if (!botSettings.autoSholat.includes(sender)) botSettings.autoSholat.push(sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info & Pengingat Sholat AKTIF* di obrolan ini.\nBot akan otomatis mengirim jadwal pada 00:01 WITA dan mengingatkan tepat pada waktu sholat (Khusus Kendari).' }, { quoted: msg });
                        
                        // Cek jika data hari ini sudah ada, langsung kirim baselinenya ke chat tsb
                        if (todaySholatTimes) {
                            const sholatMsg = `🕌 *JADWAL SHOLAT KENDARI HARI INI*\n\n` +
                                              `🌅 Imsak: ${todaySholatTimes.Imsak} WITA\n` +
                                              `🌄 *Subuh:* ${todaySholatTimes.Fajr} WITA\n` +
                                              `🕛 *Dzuhur:* ${todaySholatTimes.Dhuhr} WITA\n` +
                                              `🕝 *Ashar:* ${todaySholatTimes.Asr} WITA\n` +
                                              `🌇 *Maghrib:* ${todaySholatTimes.Maghrib} WITA\n` +
                                              `🌃 *Isya:* ${todaySholatTimes.Isha} WITA`;
                            await sock.sendMessage(sender, { text: sholatMsg });
                        }
                    } else if (args[0] === 'off') {
                        botSettings.autoSholat = botSettings.autoSholat.filter(jid => jid !== sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info & Pengingat Sholat NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autoinfosholat on* atau *!autoinfosholat off*' }, { quoted: msg });
                    }
                    break;

                case 'autoranap':
                    if (args[0] === 'on') {
                        if (!botSettings.autoRanap.includes(sender)) botSettings.autoRanap.push(sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info Rawat Inap AKTIF* di obrolan ini.\nBot akan otomatis mengirim pesan laporan jika mendeteksi ada pasien yang masuk atau keluar (pulang).' }, { quoted: msg });
                        await forceSendRanapPrimer(sock, sender);
                    } else if (args[0] === 'off') {
                        botSettings.autoRanap = botSettings.autoRanap.filter(jid => jid !== sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info Rawat Inap NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autoranap on* atau *!autoranap off*' }, { quoted: msg });
                    }
                    break;

                case 'autorajal':
                    if (args[0] === 'on') {
                        if (!botSettings.autoRajal.includes(sender)) botSettings.autoRajal.push(sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info Rawat Jalan AKTIF* di obrolan ini.\nBot akan otomatis mengirim laporan ke obrolan ini setiap kali antrean Klinik bertambah atau berkurang pada hari ini.' }, { quoted: msg });
                        await forceSendRajalPrimer(sock, sender);
                    } else if (args[0] === 'off') {
                        botSettings.autoRajal = botSettings.autoRajal.filter(jid => jid !== sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info Rawat Jalan NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autorajal on* atau *!autorajal off*' }, { quoted: msg });
                    }
                    break;

                case 'listsurah':
                    await sock.sendMessage(sender, { text: '⏳ _Mengambil daftar Surah..._' }, { quoted: msg });
                    try {
                        const res = await fetch("http://api.alquran.cloud/v1/surah");
                        const json = await res.json();
                        let reply = `📖 *DAFTAR 114 SURAH AL-QURAN*\n\n`;
                        json.data.forEach(s => {
                            reply += `*${s.number}. ${s.englishName}* (${s.name}) - ${s.numberOfAyahs} Ayat\n`;
                        });
                        reply += `\n_Ketik *!surah <nomor>* untuk detail info Surah._\n_Ketik *!ayat <nomor_surah> <nomor_ayat>* untuk dengar audio ayat._`;
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(sender, { text: '❌ *Gagal memuat API Al-Quran.*' }); }
                    break;

                case 'surah':
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ *Sertakan nomor surah!*\nContoh: !surah 1 (Untuk Al-Fatihah)' }, { quoted: msg });
                    try {
                        const num = parseInt(args[0]);
                        const res = await fetch(`http://api.alquran.cloud/v1/surah/${num}`);
                        const json = await res.json();
                        if (json.code !== 200) return await sock.sendMessage(sender, { text: `❌ Surah tidak ditemukan.` });
                        
                        const s = json.data;
                        const info = `📖 *INFORMASI SURAH*\n\n` +
                                     `🔢 *Nomor:* ${s.number}\n` +
                                     `📜 *Nama:* ${s.englishName} (${s.name})\n` +
                                     `📝 *Arti:* ${s.englishNameTranslation}\n` +
                                     `📍 *Turun di:* ${s.revelationType === 'Meccan' ? 'Makkah' : 'Madinah'}\n` +
                                     `📏 *Jumlah Ayat:* ${s.numberOfAyahs} Ayat\n\n` +
                                     `_Gunakan *!ayat ${s.number} 1* untuk melihat & memutar audio ayat pertama dari surah ini._`;
                        await sock.sendMessage(sender, { text: info }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(sender, { text: '❌ *Gagal memuat API Al-Quran.*' }); }
                    break;

                case 'ayat':
                    if (args.length < 2) return await sock.sendMessage(sender, { text: '⚠️ *Format Salah!*\nGunakan: *!ayat <nomor_surah> <nomor_ayat>*\nContoh: *!ayat 1 2* (Untuk Al-Fatihah ayat 2)' }, { quoted: msg });
                    await sock.sendMessage(sender, { text: '⏳ _Mengambil Teks & Audio Murottal..._' }, { quoted: msg });
                    try {
                        const surahNum = args[0];
                        const ayatNum = args[1];
                        
                        // Fetching 3 edisi sekaligus: Arabic (Teks), Indonesian (Arti), ar.alafasy (Audio)
                        const res = await fetch(`http://api.alquran.cloud/v1/ayah/${surahNum}:${ayatNum}/editions/quran-uthmani,id.indonesian,ar.alafasy`);
                        const json = await res.json();
                        
                        if (json.code !== 200) return await sock.sendMessage(sender, { text: `❌ Gagal mengambil data. Pastikan nomor Surah dan Ayat valid.` }, { quoted: msg });

                        const arabicData = json.data[0];
                        const indoData = json.data[1];
                        const audioData = json.data[2];

                        const txt = `📖 *Surah ${arabicData.surah.englishName}* (${arabicData.surah.name}) - Ayat ${arabicData.numberInSurah}\n\n` +
                                    `*${arabicData.text}*\n\n` +
                                    `📝 *Terjemahan (ID):*\n_${indoData.text}_\n\n` +
                                    `🎧 _Mengirimkan audio murottal Syeikh Mishari Rasyid Al-Afasi..._`;

                        // Send Text
                        await sock.sendMessage(sender, { text: txt }, { quoted: msg });
                        // Send Audio File
                        if (audioData.audio) {
                            await sock.sendMessage(sender, { 
                                audio: { url: audioData.audio }, 
                                mimetype: 'audio/mp4', 
                                ptt: false // Set false agar terkirim sebagai File Musik, bukan Voice Note
                            }, { quoted: msg });
                        }
                    } catch (e) { 
                        console.error("Error Quran:", e);
                        await sock.sendMessage(sender, { text: '❌ *Gagal memuat atau mengirim dari API Al-Quran.*' }); 
                    }
                    break;

                case 'refresh':
                    await sock.sendMessage(sender, { text: '⏳ _Mengirim sinyal refresh ke Ekstensi Chrome..._' }, { quoted: msg });
                    try {
                        await fetch('https://ishiprsud.vercel.app/api/trigger', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ refresh: true })
                        });
                        await sock.sendMessage(sender, { text: '✅ *Sinyal terkirim!*\n\nEkstensi Chrome di PC Anda akan mendeteksinya dalam waktu 20 detik dan langsung melakukan tarikan data baru.' }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(sender, { text: '❌ *Gagal mengirim sinyal ke Vercel.*' }, { quoted: msg });
                    }
                    break;

                case 'jadwalranap':
                    await sock.sendMessage(sender, { text: '⏳ _Sedang mengambil data jadwal rawat inap dari server..._' }, { quoted: msg });
                    try {
                        const result = await fetchWithFallback('Ranap');

                        if (!result.status || result.data.length === 0) {
                            await sock.sendMessage(sender, { text: result.message || '📭 *Tidak ada data jadwal pasien rawat inap saat ini.*' }, { quoted: msg });
                            break;
                        }

                        let replyTxt = `🏥 *MANIFEST PASIEN RAWAT INAP*\n\n📊 *Total Pasien:* ${result.total_data}\n⏱️ *Update Terakhir:* ${result.last_updated || 'Terbaru'}\n\n`;

                        result.data.forEach((p, i) => {
                            replyTxt += `*${i + 1}. ${p.nama_pasien}*\n 🛏️ Ruang: ${p.ruangan} (${p.no_kamar})\n 🆔 RM: ${p.no_rm} | Usia: ${p.usia}\n 👨‍⚕️ DPJP: ${p.dpjp_utama}\n`;
                            if (p.dokter_rawat_bersama !== '-') replyTxt += ` 👨‍⚕️ Bersama: ${p.dokter_rawat_bersama}\n`;
                            replyTxt += ` 🗓️ Masuk: ${p.tanggal_masuk}\n ⏳ Lama Rawat: ${p.lama_rawat}\n\n`;
                        });

                        replyTxt += `*_Data disinkronkan otomatis dari Web RSUD Kendari._*`;
                        await sock.sendMessage(sender, { text: replyTxt }, { quoted: msg });
                    } catch (error) { await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel maupun Google Sheets.*\nPastikan Ekstensi di PC menyala.' }, { quoted: msg }); }
                    break;
                    
                case 'addjadwal':
                    const jadwalArgs = args.join(' ').split('|').map(s => s.trim());
                    
                    if (jadwalArgs.length < 3) {
                        const panduan = `⚠️ *Format Pembuatan Jadwal Salah!*\n\n` +
                                        `Gunakan pemisah tanda palang ( | ) antara waktu, nomor tujuan, dan pesannya.\n\n` +
                                        `*Format:*\n!addjadwal DD-MM-YYYY HH:mm | Nomor/GrupID | Pesan\n\n` +
                                        `*Contoh untuk nomor:* \n!addjadwal 01-05-2026 10:30 | 6281234567890 | Halo bos!\n\n` +
                                        `*Contoh untuk grup:* \n!addjadwal 01-05-2026 14:00 | 123456-123456@g.us | Info rapat guys!`;
                        await sock.sendMessage(sender, { text: panduan }, { quoted: msg });
                        break;
                    }

                    const [waktuInput, targetInput, ...pesanArr] = jadwalArgs;
                    const pesanTeks = pesanArr.join(' | ');
                    
                    const waktuSplit = waktuInput.split(' ');
                    if (waktuSplit.length !== 2) {
                        await sock.sendMessage(sender, { text: `⚠️ *Format Tanggal/Jam Salah!*\n\nHarus persis seperti ini: DD-MM-YYYY HH:mm\nContoh: 31-12-2026 23:59` }, { quoted: msg });
                        break;
                    }

                    const [tgl, bln, thn] = waktuSplit[0].split('-');
                    const jamMnt = waktuSplit[1];

                    if (!tgl || !bln || !thn || !jamMnt) {
                        await sock.sendMessage(sender, { text: `⚠️ *Format Tanggal/Jam Salah!*\n\nHarus persis seperti ini: DD-MM-YYYY HH:mm\nContoh: 31-12-2026 23:59` }, { quoted: msg });
                        break;
                    }

                    const isoString = `${thn}-${bln}-${tgl}T${jamMnt}:00+08:00`;
                    const timestampWITA = Date.parse(isoString);

                    if (isNaN(timestampWITA)) {
                        await sock.sendMessage(sender, { text: `⚠️ *Format Tanggal/Jam Tidak Valid!*\n\nPastikan angka tanggal dan jam benar.\nContoh: 31-12-2026 23:59` }, { quoted: msg });
                        break;
                    }

                    let finalTarget = targetInput;
                    if (!finalTarget.includes('@')) {
                        finalTarget = finalTarget.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    }

                    const jadwalId = Math.floor(Math.random() * 900000 + 100000).toString(); 
                    const newJadwal = {
                        id: jadwalId,
                        waktu: waktuInput,
                        timestamp: timestampWITA,
                        target: finalTarget,
                        pesan: pesanTeks,
                        status: 'pending'
                    };

                    botSchedules.push(newJadwal);
                    saveSchedules();

                    const suksesMsg = `✅ *Jadwal Berhasil Ditambahkan!*\n\n` +
                                      `🔖 *ID:* ${newJadwal.id}\n` +
                                      `⏰ *Waktu:* ${newJadwal.waktu} WITA\n` +
                                      `🎯 *Tujuan:* ${targetInput}\n` +
                                      `💬 *Pesan:* ${newJadwal.pesan.substring(0, 50)}${newJadwal.pesan.length > 50 ? '...' : ''}`;
                    await sock.sendMessage(sender, { text: suksesMsg }, { quoted: msg });
                    break;

                case 'listjadwal':
                    const pendingSchedules = botSchedules.filter(s => s.status === 'pending');
                    
                    if (pendingSchedules.length === 0) {
                        await sock.sendMessage(sender, { text: '📭 *Tidak ada jadwal antrean pesan yang aktif saat ini.*' }, { quoted: msg });
                        break;
                    }

                    let listTxt = `🗓️ *DAFTAR ANTREAN JADWAL*\n\n`;
                    pendingSchedules.forEach((j, i) => {
                        listTxt += `*${i+1}. [ID: ${j.id}]*\n` +
                                   ` ⏰ ${j.waktu} WITA\n` +
                                   ` 🎯 Ke: ${j.target.split('@')[0]}\n` +
                                   ` 💬 Psn: ${j.pesan.substring(0, 30)}...\n\n`;
                    });
                    listTxt += `_Ketik !deljadwal <ID> untuk membatalkan pesan._`;
                    
                    await sock.sendMessage(sender, { text: listTxt }, { quoted: msg });
                    break;

                case 'deljadwal':
                    if (!args[0]) {
                        await sock.sendMessage(sender, { text: '⚠️ *Masukkan ID jadwal yang mau dibatalkan/dihapus.*\nContoh: !deljadwal 123456' }, { quoted: msg });
                        break;
                    }
                    
                    const hapusId = args[0];
                    const idx = botSchedules.findIndex(s => s.id === hapusId);
                    
                    if (idx !== -1) {
                        botSchedules.splice(idx, 1);
                        saveSchedules();
                        await sock.sendMessage(sender, { text: `🗑️ *Jadwal dengan ID ${hapusId} berhasil dibatalkan dan dihapus!*` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: `❌ *Jadwal dengan ID ${hapusId} tidak ditemukan di antrean.*` }, { quoted: msg });
                    }
                    break;

                case 'runtime':
                    const uptimeSec = process.uptime();
                    const rHours = Math.floor(uptimeSec / 3600).toString().padStart(2, '0');
                    const rMinutes = Math.floor((uptimeSec % 3600) / 60).toString().padStart(2, '0');
                    const rSeconds = Math.floor(uptimeSec % 60).toString().padStart(2, '0');
                    
                    const formattedUptime = `${rHours}:${rMinutes}:${rSeconds}`;
                    const relativeText = getRelativeTime(uptimeSec);
                    const startTimeString = formatWITA(botStartTime);

                    const memUsage = process.memoryUsage();
                    const rssMB = (memUsage.rss / 1024 / 1024).toFixed(2);
                    const heapMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);

                    const osType = os.type();
                    const osRelease = os.release();
                    const osPlatform = os.platform();
                    const osArch = os.arch();
                    const cpus = os.cpus();
                    const cpuModel = cpus[0]?.model.trim() || 'Unknown CPU';
                    const cpuSpeed = cpus[0]?.speed || 0;
                    const totalRamGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
                    const freeRamGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);

                    let groupCount = 0;
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        groupCount = Object.keys(groups).length;
                    } catch (e) {
                        groupCount = 'Error';
                    }

                    const runtimeReply = `⏱️ *Runtime Bot*\n` +
                                         `• Uptime      : ${formattedUptime} (sejak ${relativeText})\n` +
                                         `• Start Time  : ${startTimeString} WITA\n` +
                                         `• Guilds      : ${groupCount}\n` +
                                         `• Node.js     : ${process.version}\n` +
                                         `• Memory (RSS): ${rssMB} MB\n` +
                                         `• Heap Used   : ${heapMB} MB\n\n` +
                                         `🖥️ *Spesifikasi Core VPS*\n` +
                                         `• OS          : ${osType} ${osRelease} (${osPlatform}/${osArch})\n` +
                                         `• CPU         : ${cpuModel}\n` +
                                         `• CPU Cores   : ${cpus.length} cores @ ${cpuSpeed} MHz\n` +
                                         `• RAM (Total) : ${totalRamGB} GB\n` +
                                         `• RAM (Free)  : ${freeRamGB} GB`;

                    await sock.sendMessage(sender, { text: runtimeReply }, { quoted: msg });
                    break;

                case 'tagall':
                    if (!sender.endsWith('@g.us')) return;
                    const groupMetadata = await sock.groupMetadata(sender);
                    const tagParticipants = groupMetadata.participants.map(p => p.id);
                    let mentionText = `*📢 PERHATIAN SEMUA 📢*\n\n`;
                    tagParticipants.forEach(p => mentionText += `👉 @${p.split('@')[0]}\n`);
                    await sock.sendMessage(sender, { text: mentionText, mentions: tagParticipants }, { quoted: msg });
                    break;

                case 'ping':
                    await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${Date.now() - (msg.messageTimestamp * 1000)} ms` }, { quoted: msg }); 
                    break;
                    
                case 'ai': 
                    await handleAiCommand(sock, msg, args); 
                    break;
                    
                case 'sticker': 
                case 's': 
                    await handleStickerCommand(sock, msg); 
                    break;
            }
        } catch (error) { console.error('Error proses pesan:', error); }
    });
}
