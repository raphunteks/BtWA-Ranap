import fs from 'fs';
import process from 'process';
import os from 'os';
import path from 'path';
import { 
    jidNormalizedUser, 
    isPnUser, 
    isLidUser, 
    areJidsSameUser, 
    jidDecode, 
    jidEncode,
    downloadMediaMessage,
    getContentType,
    WA_DEFAULT_EPHEMERAL
} from '@whiskeysockets/baileys';
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// =========================================================================
// KONFIGURASI GLOBAL, STATE & PERSISTENSI
// =========================================================================
// Helper Sanitasi JID WhatsApp (Mencegah Corrupted Domain @lid@s.whatsapp.net)
function cleanJid(jid) {
    if (!jid) return '';
    let clean = String(jid).trim().replace(/:[0-9]+/g, '');
    if (clean.includes('@lid')) return clean.split('@lid')[0] + '@lid';
    if (clean.includes('@s.whatsapp.net')) return clean.split('@s.whatsapp.net')[0] + '@s.whatsapp.net';
    if (clean.includes('@g.us')) return clean.split('@g.us')[0] + '@g.us';
    if (!clean.includes('@')) {
        clean = clean.replace(/[^0-9]/g, '');
        if (clean.startsWith('0')) clean = '62' + clean.slice(1);
        if (clean.startsWith('8')) clean = '62' + clean;
        return clean + '@s.whatsapp.net';
    }
    return jidNormalizedUser(clean);
}

function formatPhoneToJid(phone) {
    if (!phone) return '';
    let clean = String(phone).trim().replace(/:[0-9]+/g, '');
    if (clean.endsWith('@lid') || clean.endsWith('@s.whatsapp.net') || clean.endsWith('@g.us')) return clean;
    let p = clean.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (p.startsWith('8')) p = '62' + p;
    return p + "@s.whatsapp.net";
}

// Konfigurasi Owner Eksplisit (Nomor Telepon & Akun LID Baileys v7 Sesuai Memori Skrip V4/V5)
const ownerNumber = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";
const ownerLid = process.env.OWNER_LID || "247922893566044@lid";
const ownerPureJid = cleanJid(ownerNumber); 
const ownerPureLid = cleanJid(ownerLid);

const GAS_URL = "https://script.google.com/macros/s/AKfycbzhDou1e-e4QXDILWfM_mkyagViYOvcpLLv7xL-kJ6cVhpR_R5_bVICdnUYxp0AA90/exec";
const botStartTime = new Date(); 

const sessionPath = './session';
const schedulesFile = `${sessionPath}/schedules.json`; 
const settingsFile = `${sessionPath}/settings.json`; 
const adminsFile = `${sessionPath}/admins.json`;

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

// Load Binary JPEG Thumbnail untuk Baileys externalAdReply (Mencegah Crash/Stanza Drop di WhatsApp iOS)
const thumbPath = path.resolve('./thumb.jpg');
let thumbBuffer = null;
if (fs.existsSync(thumbPath)) {
    try {
        thumbBuffer = fs.readFileSync(thumbPath);
    } catch(e) {
        console.error("[Thumbnail] Gagal membaca thumb.jpg:", e);
    }
}

// Bot Admins Memory & Persistence (Memori V4/V5 + LID)
let botAdmins = [
    ownerNumber, 
    ownerLid, 
    "6285256739684@s.whatsapp.net", 
    "247922893566044@lid"
];

if (fs.existsSync(adminsFile)) {
    try { 
        const savedAdmins = JSON.parse(fs.readFileSync(adminsFile, 'utf-8')); 
        if (Array.isArray(savedAdmins)) {
            botAdmins = [...new Set([...botAdmins, ...savedAdmins])];
        }
    } catch(e) {}
} else {
    try { fs.writeFileSync(adminsFile, JSON.stringify(botAdmins, null, 2)); } catch(e) {}
}

function saveAdmins() {
    try { fs.writeFileSync(adminsFile, JSON.stringify(botAdmins, null, 2)); } catch(e) {}
}

let botSchedules = [];
let botSettings = { 
    autoRanap: [], 
    autoRajal: [], 
    autoSholat: [], 
    autoWeather: [],
    antiCall: false,
    lastDailySholatSent: null,
    lastDailyWeatherSent: null
};

if (fs.existsSync(schedulesFile)) {
    try { botSchedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8')); } catch (e) { }
}
if (fs.existsSync(settingsFile)) {
    try { botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) }; } catch (e) { }
}

// Memastikan field pengaturan selalu terinisialisasi
if (!botSettings.autoSholat) botSettings.autoSholat = [];
if (!botSettings.autoWeather) botSettings.autoWeather = [];
if (!botSettings.autoRanap) botSettings.autoRanap = [];
if (!botSettings.autoRajal) botSettings.autoRajal = [];
if (typeof botSettings.antiCall !== 'boolean') botSettings.antiCall = false;

let configChanged = false;
// Memastikan Owner terdaftar tanpa suffix JID untuk fitur default
if (!botSettings.autoSholat.includes(ownerPureJid) && !botSettings.autoSholat.includes(ownerNumber)) {
    botSettings.autoSholat.push(ownerPureJid);
    configChanged = true;
}
if (!botSettings.autoWeather.includes(ownerPureJid) && !botSettings.autoWeather.includes(ownerNumber)) {
    botSettings.autoWeather.push(ownerPureJid);
    configChanged = true;
}
if (configChanged) saveSettings();

function saveSchedules() { 
    try { fs.writeFileSync(schedulesFile, JSON.stringify(botSchedules, null, 2)); } catch(e) {}
}
function saveSettings() { 
    try { fs.writeFileSync(settingsFile, JSON.stringify(botSettings, null, 2)); } catch(e) {}
}

// Helper verifikasi identitas Owner Baileys v7 (Mendukung PN, LID, & Multi-Admin)
function isOwner(sender, sock) {
    if (!sender) return false;
    try {
        const cSender = cleanJid(sender);
        const cOwnerNum = cleanJid(ownerNumber);
        const cOwnerLid = cleanJid(ownerLid);

        if (cSender === cOwnerNum || cSender === cOwnerLid) return true;
        if (areJidsSameUser(cSender, cOwnerNum) || areJidsSameUser(cSender, cOwnerLid)) return true;

        if (cSender.includes('6285256739684') || cSender.includes('247922893566044')) return true;

        if (Array.isArray(botAdmins) && botAdmins.some(admin => {
            const cAdmin = cleanJid(admin);
            return cSender === cAdmin || areJidsSameUser(cSender, cAdmin) || cSender.includes(cAdmin.split('@')[0]);
        })) return true;

        const myJid = sock?.user?.id ? cleanJid(sock.user.id) : null;
        if (myJid && areJidsSameUser(cSender, myJid)) return true;
    } catch(e) {}
    return false;
}

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} hari lalu`; if (h > 0) return `${h} jam lalu`; if (m > 0) return `${m} menit lalu`;
    return `${Math.floor(seconds)} detik lalu`;
}

function formatWITA(dateObj) {
    return new Intl.DateTimeFormat('id-ID', { 
        timeZone: 'Asia/Makassar', 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric', 
        hour: 'numeric', 
        minute: 'numeric', 
        hour12: false 
    }).format(dateObj);
}

// =========================================================================
// 1. STATE & FUNGSI JADWAL SHOLAT KENDARI (ALADHAN API)
// =========================================================================
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

// =========================================================================
// 2. FUNGSI PINTAR: CUACA KENDARI (OPEN-METEO API)
// =========================================================================
let lastDailyWeatherSent = null;

function getWeatherDesc(code) {
    const map = {
        0: '☀️ Cerah', 1: '🌤️ Cerah Berawan', 2: '⛅ Berawan Sebagian', 3: '☁️ Mendung',
        45: '🌫️ Berkabut', 48: '🌫️ Kabut Tebal',
        51: '🌧️ Gerimis Ringan', 53: '🌧️ Gerimis Sedang', 55: '🌧️ Gerimis Lebat',
        61: '🌧️ Hujan Ringan', 63: '🌧️ Hujan Sedang', 65: '🌧️ Hujan Lebat',
        71: '🌨️ Salju Ringan', 73: '🌨️ Salju Sedang', 75: '🌨️ Salju Lebat',
        80: '🌦️ Hujan Showers Ringan', 81: '🌦️ Hujan Showers Sedang', 82: '🌦️ Hujan Showers Lebat',
        95: '⛈️ Badai Petir Ringan/Sedang', 96: '⛈️ Badai Petir & Hujan Es', 99: '⛈️ Badai Petir Hebat'
    };
    return map[code] || `❓ Tidak Diketahui (${code})`;
}

async function fetchWeatherKendari() {
    try {
        const res = await fetch("https://api.open-meteo.com/v1/forecast?latitude=-3.945&longitude=122.4989&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&current_weather=true&timezone=Asia%2FMakassar");
        const data = await res.json();
        
        const current = data.current_weather;
        const daily = data.daily;
        
        const desc = getWeatherDesc(current.weathercode);
        const dailyDesc = getWeatherDesc(daily.weathercode[0]);
        
        return `*Saat Ini:*\n` +
               `🌡️ Suhu: ${current.temperature}°C\n` +
               `💨 Angin: ${current.windspeed} km/h\n` +
               `📝 Kondisi: ${desc}\n\n` +
               `*Prakiraan Hari Ini:*\n` +
               `🌡️ Min/Max: ${daily.temperature_2m_min[0]}°C / ${daily.temperature_2m_max[0]}°C\n` +
               `🌧️ Curah Hujan: ${daily.precipitation_sum[0]} mm\n` +
               `📝 Kondisi: ${dailyDesc}\n\n` +
               `_Data otomatis dari Open-Meteo_`;
    } catch (e) {
        console.error("Gagal fetch cuaca:", e);
        return null;
    }
}

function parseWeatherQuery(query) {
    if (!query) return null;
    query = query.toLowerCase().trim();
    
    if (query === 'besok') {
        let t = new Date(); t.setDate(t.getDate() + 1);
        let d = t.toISOString().split('T')[0];
        return { start: d, end: d, label: 'Besok' };
    }
    if (query === 'lusa') {
        let t = new Date(); t.setDate(t.getDate() + 2);
        let d = t.toISOString().split('T')[0];
        return { start: d, end: d, label: 'Lusa' };
    }

    const rangeMatch = query.match(/(\d{1,2})\s*-\s*(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
    const singleMatch = query.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
    const strictRange = query.match(/(\d{1,2})-(\d{1,2})-(\d{4})\s*s\/?d\s*(\d{1,2})-(\d{1,2})-(\d{4})/); 
    const strictSingle = query.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);

    const months = { 'januari': '01', 'jan': '01', 'februari': '02', 'feb': '02', 'maret': '03', 'mar': '03', 'april': '04', 'apr': '04', 'mei': '05', 'juni': '06', 'jun': '06', 'juli': '07', 'jul': '07', 'agustus': '08', 'agu': '08', 'september': '09', 'sep': '09', 'oktober': '10', 'okt': '10', 'november': '11', 'nov': '11', 'desember': '12', 'des': '12' };

    if (rangeMatch) {
        let startD = rangeMatch[1].padStart(2, '0'); let endD = rangeMatch[2].padStart(2, '0');
        let m = months[rangeMatch[3]]; let y = rangeMatch[4];
        if (m) return { start: `${y}-${m}-${startD}`, end: `${y}-${m}-${endD}`, label: `${startD} s/d ${endD} ${rangeMatch[3]} ${y}` };
    }
    if (singleMatch) {
        let d = singleMatch[1].padStart(2, '0'); let m = months[singleMatch[2]]; let y = singleMatch[3];
        if (m) return { start: `${y}-${m}-${d}`, end: `${y}-${m}-${d}`, label: `${d} ${singleMatch[2]} ${y}` };
    }
    if (strictRange) {
        let sD = strictRange[1].padStart(2, '0'), sM = strictRange[2].padStart(2, '0'), sY = strictRange[3];
        let eD = strictRange[4].padStart(2, '0'), eM = strictRange[5].padStart(2, '0'), eY = strictRange[6];
        return { start: `${sY}-${sM}-${sD}`, end: `${eY}-${eM}-${eD}`, label: `${sD}/${sM}/${sY} s/d ${eD}/${eM}/${eY}` };
    }
    if (strictSingle) {
        let d = strictSingle[1].padStart(2, '0'); let m = strictSingle[2].padStart(2, '0'); let y = strictSingle[3];
        return { start: `${y}-${m}-${d}`, end: `${y}-${m}-${d}`, label: `${d}/${m}/${y}` };
    }
    return null;
}

async function fetchAdvancedWeather(startDate, endDate, label) {
    try {
        const now = new Date(); const end = new Date(endDate);
        const isArchive = end < now && (now - end) > (1000 * 60 * 60 * 24 * 5);
        let baseUrl = isArchive ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";

        const url = `${baseUrl}?latitude=-3.945&longitude=122.4989&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia%2FMakassar&start_date=${startDate}&end_date=${endDate}`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data.daily || !data.daily.time) return `❌ Data cuaca untuk tanggal tersebut tidak tersedia. Pastikan jarak tanggal tidak lebih dari masa berlaku API.`;

        let msg = `☁️ *DATA CUACA KENDARI*\n📅 *Periode:* ${label}\n\n`;
        for (let i = 0; i < data.daily.time.length; i++) {
            msg += `*${data.daily.time[i]}*\n`;
            msg += `🌡️ Suhu: ${data.daily.temperature_2m_min[i]}°C - ${data.daily.temperature_2m_max[i]}°C\n`;
            msg += `🌧️ Hujan: ${data.daily.precipitation_sum[i]} mm\n`;
            msg += `📝 Kondisi: ${getWeatherDesc(data.daily.weathercode[i])}\n\n`;
            
            if (i >= 30) {
                msg += `_... dan seterusnya (Dibatasi 31 hari laporan)._\n`; break;
            }
        }
        msg += `_Sumber Data: Open-Meteo ${isArchive ? 'Archive' : 'Forecast'} API_`;
        return msg;
    } catch (e) {
        console.error("Advanced weather error:", e);
        return `❌ *Gagal mengambil data dari server Open-Meteo.*`;
    }
}

// =========================================================================
// 3. FUNGSI EXTRA: GEMPA BMKG TERKINI
// =========================================================================
async function fetchGempa() {
    try {
        const res = await fetch('https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json');
        const json = await res.json();
        const g = json.Infogempa.gempa;
        let msg = `🚨 *INFO GEMPA TERKINI (BMKG)* 🚨\n\n`;
        msg += `📅 *Waktu:* ${g.Tanggal} | ${g.Jam}\n`;
        msg += `📍 *Koordinat:* ${g.Coordinates}\n`;
        msg += `📊 *Magnitudo:* ${g.Magnitude} SR\n`;
        msg += `🌊 *Kedalaman:* ${g.Kedalaman}\n`;
        msg += `🗺️ *Wilayah:* ${g.Wilayah}\n`;
        msg += `🛑 *Potensi Tsunami:* ${g.Potensi}\n`;
        msg += `👀 *Dirasakan:* ${g.Dirasakan}\n\n`;
        msg += `_Tetap waspada dan ikuti arahan keselamatan setempat._`;
        return msg;
    } catch (e) {
        return `❌ *Gagal mengambil data gempa dari server BMKG.*`;
    }
}

// =========================================================================
// 4. FUNGSI PINTAR: FETCH WITH FALLBACK (VERCEL -> GAS) RSUD KENDARI
// =========================================================================
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

// =========================================================================
// 5. SMART CHRONOLOGICAL SORTING & DIFF ALGORITHM RSUD KENDARI
// =========================================================================
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
    } catch (e) {
        console.error("Gagal load primer Ranap:", e);
    }
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
    } catch (e) {
        console.error("Gagal load primer Rajal:", e);
    }
}

// Polling otomatis RSUD Kendari
async function checkApiUpdates(sock) {
    if (!sock) return;
    try {
        const resTrigger = await fetch('https://ishiprsud.vercel.app/api/trigger');
        const dataTrigger = await resTrigger.json();
        if (dataTrigger.notify && dataTrigger.notify.trim() !== "") {
            await sock.sendMessage(ownerPureJid, { text: dataTrigger.notify });
        }

        // 1. AUTO INFO: RANAP
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
                        for (const jid of botSettings.autoRanap) {
                            try { await sock.sendMessage(jid, { text: msg }); } catch(e){}
                        }
                    }
                }
                lastRanapData = currentRanap;
            }
        }

        // 2. AUTO INFO: RAJAL (4 KLINIK)
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

                    msg += formatEndo.txt;
                    msg += formatPerio.txt;
                    msg += formatBM.txt;
                    msg += formatUmum.txt;

                    msg += `📊 *Total Antrean (BARU: BELUM DIKERJA):* Endo (${formatEndo.baru}), BM (${formatBM.baru}), Perio (${formatPerio.baru}), Umum (${formatUmum.baru})\n`;
                    msg += `📊 *Total Antrean (SELESAI/BATAL):* Endo (${formatEndo.selesai}), BM (${formatBM.selesai}), Perio (${formatPerio.selesai}), Umum (${formatUmum.selesai})`;
                    
                    for (const jid of botSettings.autoRajal) {
                        try { await sock.sendMessage(jid, { text: msg }); } catch(e){}
                    }
                }
            }
            lastRajalEndoData = currentEndo;
            lastRajalBMData = currentBM;
            lastRajalPerioData = currentPerio;
            lastRajalUmumData = currentUmum;
        }
    } catch (e) { console.error("[Auto Info] Error polling API:", e); }
}

async function checkSholatAndWeather(sock) {
    if (!sock) return;
    
    try {
        const now = new Date();
        const dateWITA = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' }); 
        const timeWITA = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' });

        // 1. CEK WAKTU & INFO SHOLAT
        if (botSettings.autoSholat.length > 0) {
            if (notifiedPrayers.date !== dateWITA) {
                notifiedPrayers = { Fajr: false, Dhuhr: false, Asr: false, Maghrib: false, Isha: false, date: dateWITA };
                todaySholatTimes = await fetchSholatKendari();
            }

            if (botSettings.lastDailySholatSent !== dateWITA && todaySholatTimes) {
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
                    try { await sock.sendMessage(cleanJid(jid), { text: sholatMsg }); } catch(e){}
                }
                botSettings.lastDailySholatSent = dateWITA;
                saveSettings();
            }

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
                            try { await sock.sendMessage(cleanJid(jid), { text: alertMsg }); } catch(e){}
                        }
                        notifiedPrayers[prayer.id] = true; 
                    }
                }
            }
        }

        // 2. CEK INFO CUACA HARIAN (JAM 06:00 WITA)
        if (botSettings.autoWeather.length > 0) {
            const currentHour = parseInt(timeWITA.split(':')[0]);
            
            if (botSettings.lastDailyWeatherSent !== dateWITA && currentHour >= 6) {
                const wMsg = await fetchWeatherKendari();
                if (wMsg) {
                    const finalWeatherMsg = `🌅 *SELAMAT PAGI*\nBerikut prakiraan cuaca hari ini:\n\n${wMsg}`;
                    for (const jid of botSettings.autoWeather) {
                        try { await sock.sendMessage(cleanJid(jid), { text: finalWeatherMsg }); } catch(e){}
                    }
                    botSettings.lastDailyWeatherSent = dateWITA;
                    saveSettings();
                }
            }
        }
        
    } catch (e) {
        console.error("Gagal memeriksa jadwal harian:", e);
    }
}

// =========================================================================
// 6. EXPORT MESSAGE HANDLER & EVENT LISTENERS
// =========================================================================
let isIntervalStarted = false;
let currentSock = null;

export default function setupMessageHandler(sock) {
    currentSock = sock; 

    // Mencegah duplikasi interval saat socket reconnect
    if (!isIntervalStarted) {
        setInterval(async () => {
            if (!currentSock) return;
            const now = Date.now(); let hasChanges = false;
            for (let i = 0; i < botSchedules.length; i++) {
                const jadwal = botSchedules[i];
                if (jadwal.status === 'pending' && now >= jadwal.timestamp) {
                    try { 
                        await currentSock.sendMessage(jadwal.target, { text: jadwal.pesan }); 
                        jadwal.status = 'sent'; 
                        hasChanges = true; 
                    } catch (err) { 
                        jadwal.status = 'failed'; 
                        hasChanges = true; 
                    }
                }
            }
            if (hasChanges) { 
                botSchedules = botSchedules.filter(s => s.status === 'pending'); 
                saveSchedules(); 
            }
        }, 30000); 

        setInterval(() => {
            if (currentSock) checkApiUpdates(currentSock);
        }, 60000);

        setInterval(() => {
            if (currentSock) checkSholatAndWeather(currentSock);
        }, 30000);

        isIntervalStarted = true;
    }

    // =====================================================================
    // ADVANCED: LISTENER PANGGILAN SUARA/VIDEO (ANTI-CALL HANDLER)
    // =====================================================================
    sock.ev.on('call', async (calls) => {
        if (!botSettings.antiCall || !Array.isArray(calls)) return;
        for (const call of calls) {
            if (call.status === 'offer') {
                try {
                    await sock.rejectCall(call.id, call.from);
                    console.log(`📵 [Anti-Call] Menolak panggilan dari ${call.from}`);
                    await sock.sendMessage(call.from, { 
                        text: `⚠️ *PEMBERITAHUAN OTOMATIS:*\n\nMaaf, nomor ini adalah nomor WhatsApp Bot otomatis (*Dents Web BOT Multi-Device Engine*). Kami tidak dapat menerima panggilan telepon maupun video call.` 
                    });
                } catch(e) {
                    console.error('Gagal reject panggilan:', e);
                }
            }
        }
    });

    // =====================================================================
    // LISTENER PESAN MASUK (MESSAGES.UPSERT)
    // =====================================================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            // Ekstraksi teks pesan dari berbagai format
            const msgType = getContentType(msg.message);
            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || 
                         msg.message.videoMessage?.caption || 
                         msg.message.pollCreationMessage?.name || 
                         '';

            // Ekstrak pengirim dengan sanitasi anti-corrupted JID
            const rawSender = msg.key.remoteJid;
            const isGroup = rawSender ? rawSender.endsWith('@g.us') : false;
            
            // JID target balasan (chat id bersih)
            let sender = cleanJid(rawSender);
            // JID pembuat pesan asli (participant jika di grup)
            let participant = isGroup ? cleanJid(msg.key.participant || msg.participant) : sender;
            let pureSender = participant || sender;

            // Resolusi otomatis LID ke Nomor HP (jika chat pribadi via akun LID)
            if (!isGroup && sender.endsWith('@lid')) {
                try {
                    const resolved = await sock?.signalRepository?.lidToJid?.(sender);
                    if (resolved) sender = cleanJid(resolved);
                } catch(e) {}
                if (sender.includes('247922893566044')) {
                    sender = ownerPureJid;
                }
            }

            const prefix = '!';
            if (!text.startsWith(prefix) && !text.startsWith('.')) return;

            const usedPrefix = text[0];
            const args = text.slice(usedPrefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            console.log(`[COMMAND] '${command}' dari ${pureSender} di ${isGroup ? 'Grup (' + sender + ')' : 'Private'}`);

            // Helper ekstraksi quoted message key
            const quotedContext = msg.message.extendedTextMessage?.contextInfo;
            const hasQuoted = !!quotedContext?.stanzaId;
            const quotedKey = hasQuoted ? {
                remoteJid: sender,
                id: quotedContext.stanzaId,
                participant: isGroup ? quotedContext.participant : undefined,
                fromMe: areJidsSameUser(quotedContext.participant || sender, sock.user?.id)
            } : msg.key;

            // =============================================================
            // ROUTE KHUSUS: CEK RAWAT JALAN RSUD KENDARI
            // =============================================================
            const isRajal = command.startsWith('cekrajal');

            if (isRajal) {
                await sock.sendPresenceUpdate('composing', sender);
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

            // =============================================================
            // DISPATCHER COMMANDS LENGKAP
            // =============================================================
            switch (command) {

                // =========================================================
                // MENU UTAMA MODERN BERGAYA GBR 2 (LOCATION HEADER & BOX-DRAWING)
                // =========================================================
                case 'menu':
                case 'help':
                case 'menupeta': {
                    await sock.sendPresenceUpdate('composing', sender);

                    const uptimeSec = process.uptime();
                    const rHours = Math.floor(uptimeSec / 3600);
                    const rMinutes = Math.floor((uptimeSec % 3600) / 60);
                    const rSeconds = Math.floor(uptimeSec % 60);
                    const uptimeStr = `${rHours > 0 ? rHours + ' jam ' : ''}${rMinutes} menit ${rSeconds} detik`;

                    const pushName = msg.pushName || 'Pengguna';
                    const greeting = new Date().getHours() < 12 ? 'Pagi' : (new Date().getHours() < 15 ? 'Siang' : (new Date().getHours() < 18 ? 'Sore' : 'Malam'));

                    const bodyText = 
`Hii, Selamat *${greeting}*!
Aku *Dents Web BOT*, siap membantu kamu.

╭ ⏱️ *Uptime*  : ${uptimeStr}
├ 🤖 *Name*    : Dents Web BOT Engine
├ 📦 *Version* : 7.0.0-rc14 (Latest)
├ 👑 *Owner*   : @${ownerPureJid.split('@')[0]}
├ 🌐 *Mode*    : Multi-Tenant Gateway
├ 👤 *User*    : ${pushName}
╰ 🚀 *Engine*  : Baileys v7 ESM

*─── 🏥 RSUD KENDARI MONITORING ───*
├ !jadwalranap - Manifest pasien rawat inap
├ !cekrajalriwayatendo / !cekrajalantrianpxendo
├ !cekrajalriwayatbm / !cekrajalantrianpxbm
├ !cekrajalriwayatperio / !cekrajalantrianpxperio
├ !cekrajalriwayatumum / !cekrajalantrianpxumum
├ _(Tambahkan 'bsk' di akhir untuk jadwal besok)_
├ !autoranap on/off - Notif realtime pasien masuk/keluar
├ !autorajal on/off - Notif realtime antrean 4 poli
╰ !refresh - Kirim sinyal scraping ke Ekstensi PC

*─── 🕌 SHOLAT, CUACA & BMKG ───*
├ !autoinfosholat on/off - Jadwal sholat & pengingat azan
├ !autoweather on/off - Prakiraan cuaca jam 06:00 WITA
├ !cuaca - Cuaca Kendari saat ini
├ !cuaca besok / !cuaca <tanggal> - Prakiraan spesifik
├ !gempa - Info gempa BMKG terkini
╰ !addsholat / !delsholat / !addweather / !delweather

*─── 📖 AL-QURAN CLOUD API ───*
├ !listsurah - Daftar 114 Surah Al-Quran
├ !surah <nomor> - Info detail surah
├ !ayat <surah> <ayat> - Teks ayat + Audio Murottal
├ !ayat <surah> <awal>-<akhir> - Rentang ayat penuh
╰ !ayat <surah> full - Satu surah penuh

*─── ✉️ MESSAGE ACTIONS (GBR 1) ───*
├ !react <emoji> - Balas emoji ke pesan (reply pesan)
├ !edit <teks_baru> - Edit pesan bot yang sudah dikirim
├ !delete / !del - Hapus pesan bot untuk semua orang
├ !pin <24h|7d|30d> - Sematkan pesan di chat
├ !unpin - Lepas sematan pesan
├ !star / !unstar - Beri/hapus bintang pada pesan
├ !read - Tandai pesan sudah dibaca (centang biru)
├ !poll <Tanya> | <Opsi1> | <Opsi2> - Buat polling
├ !location <lat> <long> [nama] - Kirim titik lokasi
├ !contact <nama> <nomor> - Kirim kartu kontak vCard
├ !forward <target> - Teruskan pesan ke target
├ !ephemeral <on|off|24h|7d|90d> - Pesan sementara
╰ !carousel - Contoh kartu geser interaktif (GBR 1)

*─── 👥 GROUP & ADMIN MANAGEMENT ───*
├ !addadmin <nomor/lid> - Tambah admin bot baru (Owner)
├ !deladmin <nomor/lid> - Hapus admin bot (Owner)
├ !listadmin - Lihat daftar admin bot terdaftar
├ !creategroup <nama> <nomor1> [nomor2] - Buat grup
├ !add <nomor> - Masukkan member ke grup
├ !kick <nomor|tag> - Keluarkan member dari grup
├ !promote / !demote <nomor|tag> - Atur admin grup
├ !setgroupname <nama> - Ganti judul grup
├ !setgroupdesc <deskripsi> - Ganti info grup
├ !grouplink / !revokelink - Link undangan grup
├ !group <buka|tutup> - Siapa yang boleh chat
├ !grouplock <lock|unlock> - Siapa yang boleh edit info
├ !grouppending - Daftar permintaan gabung grup
├ !groupapprove / !groupreject <nomor> - Konfirmasi join
├ !tagall - Mention semua anggota grup
├ !groupinfo - Informasi lengkap grup saat ini
╰ !leave - Perintahkan bot keluar grup

*─── 🔒 PRIVACY & CALLS ───*
├ !anticall on/off - Auto-reject panggilan telepon masuk
├ !block / !unblock <nomor> - Blokir kontak WhatsApp
├ !blocklist - Lihat daftar kontak yang diblokir
├ !privacysettings - Lihat pengaturan privasi bot
├ !setlastseen <all|contacts|none>
├ !setonline <all|match_last_seen>
├ !setppprivacy <all|contacts|none>
├ !setstatusprivacy <all|contacts|none>
╰ !setreadreceipts <all|none>

*─── 📢 STORIES & BROADCAST ───*
├ !story <teks> - Bikin Status Story WhatsApp (Teks)
├ !storyimage [caption] - Bikin Status Story (Reply Foto)
╰ !broadcast <pesan> - Kirim broadcast ke langganan

*─── ⚙️ UTILITAS & AI ───*
├ !ai <pertanyaan> - Chatbot AI Pintar
├ !sticker / !s - Konversi gambar ke stiker WebP
├ !vn - Ubah audio reply jadi voice note PTT
├ !viewonce - Ubah media reply jadi Sekali Lihat
├ !calc <ekspresi> - Kalkulator cerdas
├ !addjadwal / !listjadwal / !deljadwal - Pengingat cron
├ !typing / !recording / !online / !offline - Presence
├ !settings - Status langganan bot di chat ini
├ !runtime - Info spek hardware server & VPS
╰ !ping - Cek latensi respon bot

_Ketik perintah di atas untuk menggunakan fitur._`;

                    // Mengirim sebagai Pesan Biasa (Reply Pesan Pengirim di Grup maupun Private - 100% Support & Tampil di iOS & Android)
                    try {
                        await sock.sendMessage(sender, {
                            text: bodyText,
                            mentions: [ownerPureJid, ownerPureLid].filter(Boolean)
                        }, { quoted: msg });
                    } catch(e) {
                        console.error("[Menu/Help] Error reply message:", e);
                        // Fallback jika quoted msg bermasalah
                        await sock.sendMessage(sender, { 
                            text: bodyText, 
                            mentions: [ownerPureJid, ownerPureLid].filter(Boolean) 
                        });
                    }
                    break;
                }

                // =========================================================
                // CONTOH CAROUSEL MESSAGE (GBR 1: NATIVE FLOW CARDS)
                // =========================================================
                case 'carousel': {
                    await sock.sendPresenceUpdate('composing', sender);
                    const carouselText = 
`📱 *WHATSAPP INTERACTIVE CAROUSEL (GBR 1)*

Fitur Carousel memungkinkan WhatsApp bot mengirimkan beberapa kartu (*cards*) horizontal yang bisa di-geser (swipe) ke samping secara interaktif.

*Spesifikasi Kartu:*
1. *Kartu 1: @dentswebbot*
   • Deskripsi: Membangun bot WhatsApp modern, ringan, dan scalable.
   • Aksi: Tautan media sosial Instagram.
2. *Kartu 2: @dentswebbot_explore*
   • Deskripsi: Eksplorasi fitur mutakhir Baileys v7 Multi-Device.
   • Aksi: Tautan Threads / Komunitas.

_Status Protocol: Baileys v7.0.0-rc14 Interactive Message Supported._`;
                    
                    await sock.sendMessage(sender, {
                        text: carouselText,
                        contextInfo: {
                            isForwarded: true,
                            forwardingScore: 999,
                            externalAdReply: {
                                title: "Dents Web BOT Engine",
                                body: "Baileys v7 Multi-Device Enterprise Gateway",
                                mediaType: 1,
                                ...(thumbBuffer ? { thumbnail: thumbBuffer } : {}),
                                thumbnailUrl: "https://dentsweb-portal.vercel.app/axalogo.png",
                                sourceUrl: "https://dentsweb-portal.vercel.app/",
                                showAdAttribution: true
                            }
                        }
                    }, { quoted: msg });
                    break;
                }

                // =========================================================
                // MESSAGE ACTIONS: REACT, EDIT, DELETE, PIN, UNPIN, STAR, READ
                // =========================================================
                case 'react': {
                    if (!hasQuoted) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) pesan yang ingin diberi reaksi emoji!\nContoh: Reply pesan dengan `!react ❤️`' }, { quoted: msg });
                    }
                    const emoji = args[0] || '👍';
                    await sock.sendMessage(sender, {
                        react: {
                            text: emoji,
                            key: quotedKey
                        }
                    });
                    break;
                }

                case 'edit': {
                    if (!hasQuoted) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) pesan bot yang ingin diedit!\nContoh: `!edit teks baru yang telah diperbaiki`' }, { quoted: msg });
                    }
                    if (!args[0]) {
                        return await sock.sendMessage(sender, { text: '⚠️ Masukkan teks baru untuk pesan yang diedit.' }, { quoted: msg });
                    }
                    const newText = args.join(' ');
                    try {
                        await sock.sendMessage(sender, {
                            text: newText,
                            edit: quotedKey
                        });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengedit pesan. Anda hanya dapat mengedit pesan yang dikirim oleh bot dalam kurun waktu 15 menit.' }, { quoted: msg });
                    }
                    break;
                }

                case 'delete':
                case 'del': {
                    if (!hasQuoted) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) pesan yang ingin dihapus untuk semua orang!' }, { quoted: msg });
                    }
                    try {
                        await sock.sendMessage(sender, { delete: quotedKey });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal menghapus pesan. Pastikan bot adalah Admin jika menghapus pesan orang lain di grup.' }, { quoted: msg });
                    }
                    break;
                }

                case 'pin': {
                    if (!hasQuoted) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) pesan yang ingin disematkan (pin)!\nContoh: `!pin 24h` atau `!pin 7d` atau `!pin 30d`' }, { quoted: msg });
                    }
                    let pinSeconds = 86400; // default 24 jam
                    if (args[0] === '7d') pinSeconds = 604800;
                    else if (args[0] === '30d') pinSeconds = 2592000;
                    
                    try {
                        await sock.sendMessage(sender, {
                            pin: {
                                type: 1,
                                time: pinSeconds,
                                key: quotedKey
                            }
                        });
                        await sock.sendMessage(sender, { text: `📌 Pesan berhasil disematkan untuk ${args[0] || '24 jam'}.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal menyematkan pesan: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'unpin': {
                    if (!hasQuoted) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) pesan yang ingin dilepas sematannya!' }, { quoted: msg });
                    }
                    try {
                        await sock.sendMessage(sender, {
                            pin: {
                                type: 0,
                                key: quotedKey
                            }
                        });
                        await sock.sendMessage(sender, { text: `📌 Sematan pesan telah dicabut.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal melepas sematan: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'star': {
                    if (!hasQuoted) return await sock.sendMessage(sender, { text: '⚠️ Balas pesan yang ingin dibintangi!' }, { quoted: msg });
                    try {
                        await sock.chatModify({
                            star: {
                                messages: [{ id: quotedKey.id, fromMe: quotedKey.fromMe || false }],
                                star: true
                            }
                        }, sender);
                        await sock.sendMessage(sender, { text: '⭐ Pesan berhasil dibintangi.' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal membintangi pesan: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'unstar': {
                    if (!hasQuoted) return await sock.sendMessage(sender, { text: '⚠️ Balas pesan yang ingin dicabut bintangnya!' }, { quoted: msg });
                    try {
                        await sock.chatModify({
                            star: {
                                messages: [{ id: quotedKey.id, fromMe: quotedKey.fromMe || false }],
                                star: false
                            }
                        }, sender);
                        await sock.sendMessage(sender, { text: '⭐ Tanda bintang pesan telah dihapus.' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal menghapus bintang: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'read': {
                    if (!hasQuoted) return await sock.sendMessage(sender, { text: '⚠️ Balas pesan yang ingin ditandai terbaca.' }, { quoted: msg });
                    try {
                        await sock.readMessages([quotedKey]);
                        await sock.sendMessage(sender, { text: '✅ Pesan ditandai sebagai terbaca (Read Receipt sent).' }, { quoted: msg });
                    } catch(e) {}
                    break;
                }

                case 'poll': {
                    const pollRaw = args.join(' ').split('|').map(s => s.trim());
                    if (pollRaw.length < 3) {
                        return await sock.sendMessage(sender, { text: '⚠️ *Format Polling Salah!*\nGunakan format: `!poll Pertanyaan | Opsi 1 | Opsi 2 | [Opsi 3...]`\nContoh: `!poll Mau rapat jam berapa? | Jam 10:00 | Jam 14:00 | Jam 16:00`' }, { quoted: msg });
                    }
                    const pollQuestion = pollRaw[0];
                    const pollOptions = pollRaw.slice(1);
                    await sock.sendMessage(sender, {
                        poll: {
                            name: pollQuestion,
                            values: pollOptions,
                            selectableCount: 1
                        }
                    });
                    break;
                }

                case 'location': {
                    if (args.length < 2) {
                        return await sock.sendMessage(sender, { text: '⚠️ Masukkan koordinat Latitude dan Longitude!\nContoh: `!location -3.945 122.4989 RSUD Kendari`' }, { quoted: msg });
                    }
                    const lat = parseFloat(args[0]);
                    const lng = parseFloat(args[1]);
                    const locName = args.slice(2).join(' ') || 'Titik Lokasi';
                    if (isNaN(lat) || isNaN(lng)) return await sock.sendMessage(sender, { text: '❌ Koordinat latitude / longitude tidak valid.' }, { quoted: msg });
                    
                    await sock.sendMessage(sender, {
                        location: {
                            degreesLatitude: lat,
                            degreesLongitude: lng,
                            name: locName
                        }
                    }, { quoted: msg });
                    break;
                }

                case 'contact': {
                    if (args.length < 2) {
                        return await sock.sendMessage(sender, { text: '⚠️ Masukkan Nama dan Nomor Telepon!\nContoh: `!contact Dr. Aksa 6285256739684`' }, { quoted: msg });
                    }
                    const contactName = args[0];
                    let contactPhone = args[1].replace(/[^0-9]/g, '');
                    if (contactPhone.startsWith('0')) contactPhone = '62' + contactPhone.slice(1);

                    const vcard = 'BEGIN:VCARD\n'
                                + 'VERSION:3.0\n'
                                + `FN:${contactName}\n`
                                + 'ORG:RSUD Kendari / Dents Web BOT Gateway;\n'
                                + `TEL;type=CELL;type=VOICE;waid=${contactPhone}:+${contactPhone}\n`
                                + 'END:VCARD';

                    await sock.sendMessage(sender, {
                        contacts: {
                            displayName: contactName,
                            contacts: [{ vcard }]
                        }
                    }, { quoted: msg });
                    break;
                }

                case 'send': {
                    if (!isOwner(pureSender, sock)) {
                        return await sock.sendMessage(sender, { text: '❌ Perintah ini khusus untuk Owner bot.' }, { quoted: msg });
                    }
                    if (args.length < 2) {
                        return await sock.sendMessage(sender, { text: '⚠️ Format: `!send <nomor/JID> <pesan>`\nContoh: `!send 6281234567890 Halo selamat pagi!`' }, { quoted: msg });
                    }
                    let targetJid = args[0].trim();
                    if (!targetJid.includes('@')) {
                        targetJid = targetJid.replace(/[^0-9]/g, '');
                        if (targetJid.startsWith('0')) targetJid = '62' + targetJid.slice(1);
                        targetJid += '@s.whatsapp.net';
                    }
                    const textToSend = args.slice(1).join(' ');
                    try {
                        await sock.sendMessage(targetJid, { text: textToSend });
                        await sock.sendMessage(sender, { text: `✅ Pesan berhasil dikirim ke ${targetJid}` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengirim pesan: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'forward': {
                    if (!hasQuoted) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) pesan yang ingin diteruskan (forward)!' }, { quoted: msg });
                    }
                    let targetForward = args[0] ? args[0].trim() : sender;
                    if (!targetForward.includes('@')) {
                        targetForward = targetForward.replace(/[^0-9]/g, '');
                        if (targetForward.startsWith('0')) targetForward = '62' + targetForward.slice(1);
                        targetForward += '@s.whatsapp.net';
                    }
                    try {
                        await sock.sendMessage(targetForward, { forward: { key: quotedKey, message: quotedContext.quotedMessage } });
                        if (targetForward !== sender) {
                            await sock.sendMessage(sender, { text: `✅ Pesan berhasil diteruskan ke ${targetForward}` }, { quoted: msg });
                        }
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal meneruskan pesan: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'ephemeral': {
                    let ephemSec = WA_DEFAULT_EPHEMERAL; // 7 hari
                    if (args[0] === 'off') ephemSec = 0;
                    else if (args[0] === '24h') ephemSec = 86400;
                    else if (args[0] === '7d') ephemSec = 604800;
                    else if (args[0] === '90d') ephemSec = 7776000;

                    try {
                        await sock.sendMessage(sender, { disappearingMessagesInChat: ephemSec });
                        await sock.sendMessage(sender, { text: `⏳ Pengaturan pesan sementara diatur ke: *${args[0] || '7 hari'}*.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengatur pesan sementara: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                // =========================================================
                // MEDIA ACTIONS: VIEWONCE & VOICE NOTE (PTT)
                // =========================================================
                case 'viewonce': {
                    if (!hasQuoted) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) foto atau video yang ingin dikirimkan ulang sebagai View-Once (Sekali Lihat)!' }, { quoted: msg });
                    }
                    try {
                        await sock.sendMessage(sender, { text: '⏳ Mengunduh & memproses media View-Once...' }, { quoted: msg });
                        const qMsg = quotedContext.quotedMessage;
                        const buffer = await downloadMediaMessage(
                            { message: qMsg },
                            'buffer',
                            {},
                            { logger: console }
                        );
                        if (qMsg.imageMessage) {
                            await sock.sendMessage(sender, { image: buffer, viewOnce: true, caption: qMsg.imageMessage.caption || '' });
                        } else if (qMsg.videoMessage) {
                            await sock.sendMessage(sender, { video: buffer, viewOnce: true, caption: qMsg.videoMessage.caption || '' });
                        } else if (qMsg.audioMessage) {
                            await sock.sendMessage(sender, { audio: buffer, viewOnce: true, mimetype: qMsg.audioMessage.mimetype });
                        } else {
                            await sock.sendMessage(sender, { text: '❌ Pesan yang dibalas bukan berupa gambar/video/audio.' }, { quoted: msg });
                        }
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal memproses View-Once: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'vn': {
                    if (!hasQuoted) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) file audio yang ingin diubah menjadi Voice Note (PTT)!' }, { quoted: msg });
                    }
                    try {
                        await sock.sendMessage(sender, { text: '🎧 Mengonversi ke Voice Note PTT...' }, { quoted: msg });
                        const qMsg = quotedContext.quotedMessage;
                        const buffer = await downloadMediaMessage(
                            { message: qMsg },
                            'buffer',
                            {},
                            { logger: console }
                        );
                        await sock.sendMessage(sender, { 
                            audio: buffer, 
                            mimetype: 'audio/ogg; codecs=opus', 
                            ptt: true 
                        }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal membuat Voice Note: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                // =========================================================
                // CHAT MANAGEMENT & PRESENCE UPDATES
                // =========================================================
                case 'archive': {
                    try {
                        await sock.chatModify({ archive: true, lastMessages: [msg] }, sender);
                        await sock.sendMessage(sender, { text: '📦 Chat berhasil diarsipkan.' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengarsipkan chat: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'unarchive': {
                    try {
                        await sock.chatModify({ archive: false, lastMessages: [msg] }, sender);
                        await sock.sendMessage(sender, { text: '📦 Chat dikeluarkan dari arsip.' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal batalkan arsip chat: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'mute': {
                    let muteDuration = 8 * 60 * 60 * 1000; // 8 jam
                    if (args[0] === '7d') muteDuration = 7 * 24 * 60 * 60 * 1000;
                    try {
                        await sock.chatModify({ mute: muteDuration }, sender);
                        await sock.sendMessage(sender, { text: `🔇 Notifikasi obrolan dibisukan selama ${args[0] || '8 jam'}.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mute chat: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'unmute': {
                    try {
                        await sock.chatModify({ mute: null }, sender);
                        await sock.sendMessage(sender, { text: '🔊 Notifikasi obrolan dibunyikan kembali (Unmuted).' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal unmute chat: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'clearchat': {
                    try {
                        await sock.chatModify({
                            clear: {
                                messages: [{
                                    id: msg.key.id,
                                    fromMe: msg.key.fromMe || false,
                                    timestamp: msg.messageTimestamp
                                }]
                            }
                        }, sender);
                        await sock.sendMessage(sender, { text: '🧹 Riwayat pesan obrolan telah dibersihkan.' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal membersihkan chat: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'typing': {
                    await sock.presenceSubscribe(sender);
                    await sock.sendPresenceUpdate('composing', sender);
                    await sock.sendMessage(sender, { text: '✍️ Status indikator: *Sedang mengetik (typing...)* aktif 10 detik.' }, { quoted: msg });
                    break;
                }

                case 'recording': {
                    await sock.presenceSubscribe(sender);
                    await sock.sendPresenceUpdate('recording', sender);
                    await sock.sendMessage(sender, { text: '🎙️ Status indikator: *Merekam audio (recording...)* aktif 10 detik.' }, { quoted: msg });
                    break;
                }

                case 'online': {
                    await sock.sendPresenceUpdate('available');
                    await sock.sendMessage(sender, { text: '🟢 Status kehadiran bot diset ke: *Online (Available)*.' }, { quoted: msg });
                    break;
                }

                case 'offline': {
                    await sock.sendPresenceUpdate('unavailable');
                    await sock.sendMessage(sender, { text: '⚪ Status kehadiran bot diset ke: *Offline (Unavailable)*.' }, { quoted: msg });
                    break;
                }

                // =========================================================
                // MULTI-ADMIN SYSTEM (MEMORI V4 / V5 + LID SUPPORT)
                // =========================================================
                case 'addadmin': {
                    if (!isOwner(pureSender, sock)) {
                        return await sock.sendMessage(sender, { text: '❌ Khusus untuk Owner bot utama.' }, { quoted: msg });
                    }
                    if (!args[0]) {
                        return await sock.sendMessage(sender, { text: '⚠️ Format: `!addadmin <nomor/lid>`\nContoh: `!addadmin 6281234567890` atau `!addadmin 247922893566044@lid`' }, { quoted: msg });
                    }
                    const newAdmin = formatPhoneToJid(args[0]);
                    if (!botAdmins.includes(newAdmin)) {
                        botAdmins.push(newAdmin);
                        saveAdmins();
                        await sock.sendMessage(sender, { text: `✅ Berhasil! ID *${newAdmin}* sukses ditambahkan sebagai Admin bot.` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: `⚠️ Nomor/ID *${newAdmin}* sudah terdaftar sebagai Admin.` }, { quoted: msg });
                    }
                    break;
                }

                case 'deladmin': {
                    if (!isOwner(pureSender, sock)) {
                        return await sock.sendMessage(sender, { text: '❌ Khusus untuk Owner bot utama.' }, { quoted: msg });
                    }
                    if (!args[0]) {
                        return await sock.sendMessage(sender, { text: '⚠️ Format: `!deladmin <nomor/lid>`\nContoh: `!deladmin 6281234567890` atau `!deladmin 247922893566044@lid`' }, { quoted: msg });
                    }
                    const delTarget = formatPhoneToJid(args[0]);
                    if (delTarget === ownerNumber || delTarget === ownerPureJid || delTarget === ownerLid || delTarget === ownerPureLid || delTarget.includes('6285256739684') || delTarget.includes('247922893566044')) {
                        return await sock.sendMessage(sender, { text: '❌ Anda tidak bisa menghapus ID Owner utama!' }, { quoted: msg });
                    }
                    if (botAdmins.includes(delTarget)) {
                        botAdmins = botAdmins.filter(a => a !== delTarget);
                        saveAdmins();
                        await sock.sendMessage(sender, { text: `✅ Berhasil! ID *${delTarget}* sukses dihapus dari Admin bot.` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: `⚠️ Nomor/ID *${delTarget}* tidak ditemukan dalam daftar admin.` }, { quoted: msg });
                    }
                    break;
                }

                case 'listadmin': {
                    let adList = '👑 *DAFTAR ADMIN & OWNER BOT*\n\n';
                    adList += `👑 *Owner Utama:* ${ownerNumber} (LID: ${ownerLid})\n\n`;
                    adList += `👥 *Daftar Admin Aktif:*\n`;
                    const uniqueAdmins = [...new Set(botAdmins)];
                    uniqueAdmins.forEach((a, i) => {
                        adList += `${i + 1}. ${a}\n`;
                    });
                    adList += `\n_Total: ${uniqueAdmins.length} Admin terdaftar._`;
                    await sock.sendMessage(sender, { text: adList }, { quoted: msg });
                    break;
                }

                // =========================================================
                // GROUP MANAGEMENT (ADMIN & MEMBER CONTROLS)
                // =========================================================
                case 'creategroup': {
                    if (!isOwner(pureSender, sock)) {
                        return await sock.sendMessage(sender, { text: '❌ Perintah membuat grup khusus untuk Owner.' }, { quoted: msg });
                    }
                    if (args.length < 2) {
                        return await sock.sendMessage(sender, { text: '⚠️ Format: `!creategroup <Nama Grup> <Nomor1> [Nomor2...]`\nContoh: `!creategroup Tim Medis RSUD 6281234567890 6285256739684`' }, { quoted: msg });
                    }
                    const groupTitle = args[0];
                    const membersToAdd = args.slice(1).map(n => {
                        let cl = n.replace(/[^0-9]/g, '');
                        if (cl.startsWith('0')) cl = '62' + cl.slice(1);
                        return cl + '@s.whatsapp.net';
                    });
                    try {
                        const newGrp = await sock.groupCreate(groupTitle, membersToAdd);
                        await sock.sendMessage(sender, { text: `✅ Grup *${groupTitle}* berhasil dibuat!\n🆔 ID Grup: ${newGrp.id || newGrp.gid}` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal membuat grup: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'add': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan nomor anggota yang ingin ditambahkan!\nContoh: `!add 6281234567890`' }, { quoted: msg });
                    let newMem = args[0].replace(/[^0-9]/g, '');
                    if (newMem.startsWith('0')) newMem = '62' + newMem.slice(1);
                    newMem += '@s.whatsapp.net';
                    try {
                        await sock.groupParticipantsUpdate(sender, [newMem], 'add');
                        await sock.sendMessage(sender, { text: `✅ Permintaan penambahan ${args[0]} berhasil diproses.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal menambahkan anggota. Pastikan bot adalah Admin grup.' }, { quoted: msg });
                    }
                    break;
                }

                case 'kick': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    let kickTarget = null;
                    if (hasQuoted && quotedContext.participant) {
                        kickTarget = quotedContext.participant;
                    } else if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                        kickTarget = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                    } else if (args[0]) {
                        kickTarget = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    }
                    if (!kickTarget) return await sock.sendMessage(sender, { text: '⚠️ Tag anggota atau reply pesannya untuk dikeluarkan!\nContoh: `!kick @user`' }, { quoted: msg });
                    try {
                        await sock.groupParticipantsUpdate(sender, [kickTarget], 'remove');
                        await sock.sendMessage(sender, { text: `👋 Anggota @${kickTarget.split('@')[0]} berhasil dikeluarkan dari grup.`, mentions: [kickTarget] }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengeluarkan anggota. Pastikan bot adalah Admin grup.' }, { quoted: msg });
                    }
                    break;
                }

                case 'promote': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    let targetProm = hasQuoted ? quotedContext.participant : (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null));
                    if (!targetProm) return await sock.sendMessage(sender, { text: '⚠️ Tag anggota atau reply pesan yang ingin dijadikan admin!' }, { quoted: msg });
                    try {
                        await sock.groupParticipantsUpdate(sender, [targetProm], 'promote');
                        await sock.sendMessage(sender, { text: `🎖️ Selamat @${targetProm.split('@')[0]}, Anda sekarang adalah Admin grup!`, mentions: [targetProm] }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal menaikkan admin: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'demote': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                    let targetDem = hasQuoted ? quotedContext.participant : (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null));
                    if (!targetDem) return await sock.sendMessage(sender, { text: '⚠️ Tag admin atau reply pesan yang ingin diturunkan jabatannya!' }, { quoted: msg });
                    try {
                        await sock.groupParticipantsUpdate(sender, [targetDem], 'demote');
                        await sock.sendMessage(sender, { text: `🔰 Jabatan admin @${targetDem.split('@')[0]} telah diturunkan menjadi member biasa.`, mentions: [targetDem] }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal menurunkan admin: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'setgroupname': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan nama/subjek grup baru!' }, { quoted: msg });
                    const newSubj = args.join(' ');
                    try {
                        await sock.groupUpdateSubject(sender, newSubj);
                        await sock.sendMessage(sender, { text: `✅ Nama grup berhasil diubah menjadi: *${newSubj}*` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengubah nama grup: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'setgroupdesc': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan deskripsi grup baru!' }, { quoted: msg });
                    const newDesc = args.join(' ');
                    try {
                        await sock.groupUpdateDescription(sender, newDesc);
                        await sock.sendMessage(sender, { text: `✅ Deskripsi grup berhasil diperbarui.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengubah deskripsi grup: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'grouplink': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    try {
                        const code = await sock.groupInviteCode(sender);
                        await sock.sendMessage(sender, { text: `🔗 *LINK UNDANGAN GRUP:*\nhttps://chat.whatsapp.com/${code}` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengambil tautan grup. Pastikan bot adalah Admin.' }, { quoted: msg });
                    }
                    break;
                }

                case 'revokelink': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    try {
                        const newCode = await sock.groupRevokeInvite(sender);
                        await sock.sendMessage(sender, { text: `🔄 *LINK GRUP TELAH DI-RESET:*\nLink baru: https://chat.whatsapp.com/${newCode}` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mereset link grup: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'group': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    if (args[0] === 'tutup' || args[0] === 'close') {
                        await sock.groupSettingUpdate(sender, 'announcement');
                        await sock.sendMessage(sender, { text: '🔒 *Grup Ditutup:* Sekarang hanya Admin yang dapat mengirim pesan.' }, { quoted: msg });
                    } else if (args[0] === 'buka' || args[0] === 'open') {
                        await sock.groupSettingUpdate(sender, 'not_announcement');
                        await sock.sendMessage(sender, { text: '🔓 *Grup Dibuka:* Seluruh anggota grup dapat mengirim pesan.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format: `!group buka` atau `!group tutup`' }, { quoted: msg });
                    }
                    break;
                }

                case 'grouplock': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    if (args[0] === 'lock') {
                        await sock.groupSettingUpdate(sender, 'locked');
                        await sock.sendMessage(sender, { text: '🔒 *Pengaturan Grup Dikunci:* Hanya admin yang dapat mengedit info grup.' }, { quoted: msg });
                    } else if (args[0] === 'unlock') {
                        await sock.groupSettingUpdate(sender, 'unlocked');
                        await sock.sendMessage(sender, { text: '🔓 *Pengaturan Grup Dibuka:* Semua anggota dapat mengedit info grup.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format: `!grouplock lock` atau `!grouplock unlock`' }, { quoted: msg });
                    }
                    break;
                }

                case 'grouppending': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    try {
                        const pendingList = await sock.groupRequestParticipantsList(sender);
                        if (!pendingList || pendingList.length === 0) {
                            return await sock.sendMessage(sender, { text: '📭 Tidak ada permintaan bergabung yang menunggu persetujuan.' }, { quoted: msg });
                        }
                        let pMsg = `📋 *PERMINTAAN GABUNG MENUNGGU PERSETUJUAN (${pendingList.length}):*\n\n`;
                        pendingList.forEach((p, i) => {
                            pMsg += `${i+1}. @${p.jid.split('@')[0]}\n`;
                        });
                        pMsg += `\n_Gunakan \`!groupapprove <nomor>\` atau \`!groupreject <nomor>\`._`;
                        await sock.sendMessage(sender, { text: pMsg, mentions: pendingList.map(p => p.jid) }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal membaca pending join requests: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'groupapprove': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan nomor yang ingin disetujui!' }, { quoted: msg });
                    let appTarget = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    try {
                        await sock.groupRequestParticipantsUpdate(sender, [appTarget], 'approve');
                        await sock.sendMessage(sender, { text: `✅ Permintaan bergabung ${args[0]} telah disetujui.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal memproses persetujuan: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'groupreject': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan nomor yang ingin ditolak!' }, { quoted: msg });
                    let rejTarget = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    try {
                        await sock.groupRequestParticipantsUpdate(sender, [rejTarget], 'reject');
                        await sock.sendMessage(sender, { text: `❌ Permintaan bergabung ${args[0]} telah ditolak.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal memproses penolakan: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'groupinfo': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    try {
                        const meta = await sock.groupMetadata(sender);
                        const admins = meta.participants.filter(p => p.admin).map(p => '@' + p.id.split('@')[0]);
                        let infoTxt = `👥 *INFORMASI METADATA GRUP*\n\n` +
                                      `📌 *Nama Grup:* ${meta.subject}\n` +
                                      `🆔 *ID Grup:* ${meta.id}\n` +
                                      `👑 *Pembuat:* ${meta.owner ? '@' + meta.owner.split('@')[0] : 'Tidak diketahui'}\n` +
                                      `👥 *Total Anggota:* ${meta.participants.length}\n` +
                                      `🛡️ *Admin (${admins.length}):* ${admins.join(', ')}\n` +
                                      `🔒 *Mode Pesan:* ${meta.announce ? 'Hanya Admin' : 'Semua Anggota'}\n` +
                                      `📝 *Deskripsi:*\n${meta.desc || '_(Tidak ada deskripsi)_'}`;
                        await sock.sendMessage(sender, { text: infoTxt, mentions: meta.participants.map(p => p.id) }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengambil info grup: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'leave': {
                    if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Khusus di dalam grup!' }, { quoted: msg });
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Hanya Owner bot yang dapat memerintahkan bot keluar grup.' }, { quoted: msg });
                    await sock.sendMessage(sender, { text: '👋 Selamat tinggal semuanya! Bot keluar atas perintah owner.' });
                    await sock.groupLeave(sender);
                    break;
                }

                // =========================================================
                // PRIVACY & CALL HANDLING
                // =========================================================
                case 'anticall': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus untuk Owner bot.' }, { quoted: msg });
                    if (args[0] === 'on') {
                        botSettings.antiCall = true;
                        saveSettings();
                        await sock.sendMessage(sender, { text: '🛡️ *Anti-Call AKTIF:*\nSetiap panggilan telepon suara/video WhatsApp yang masuk ke nomor bot akan otomatis ditolak (*auto-reject*) dengan pesan sopan.' }, { quoted: msg });
                    } else if (args[0] === 'off') {
                        botSettings.antiCall = false;
                        saveSettings();
                        await sock.sendMessage(sender, { text: '⚪ *Anti-Call NONAKTIF.* Panggilan masuk tidak akan otomatis ditolak.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format: `!anticall on` atau `!anticall off`' }, { quoted: msg });
                    }
                    break;
                }

                case 'block': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    let blockNum = hasQuoted ? (quotedContext.participant || sender) : (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
                    if (!blockNum) return await sock.sendMessage(sender, { text: '⚠️ Masukkan nomor atau reply pesan yang ingin diblokir!' }, { quoted: msg });
                    try {
                        await sock.updateBlockStatus(blockNum, 'block');
                        await sock.sendMessage(sender, { text: `🚫 Nomor ${blockNum} berhasil diblokir.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal memblokir: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'unblock': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan nomor yang ingin dibuka blokirnya!' }, { quoted: msg });
                    let unbNum = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    try {
                        await sock.updateBlockStatus(unbNum, 'unblock');
                        await sock.sendMessage(sender, { text: `✅ Nomor ${unbNum} berhasil dibuka dari blokir.` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal unblock: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'blocklist': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    try {
                        const bl = await sock.fetchBlocklist();
                        if (!bl || bl.length === 0) return await sock.sendMessage(sender, { text: '📭 Daftar blokir kosong. Tidak ada kontak yang diblokir.' }, { quoted: msg });
                        let blMsg = `🚫 *DAFTAR KONTAK TERBLOKIR (${bl.length}):*\n\n`;
                        bl.forEach((jid, i) => blMsg += `${i+1}. ${jid.split('@')[0]}\n`);
                        await sock.sendMessage(sender, { text: blMsg }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengambil blocklist: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'privacysettings': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    try {
                        const priv = await sock.fetchPrivacySettings(true);
                        let pMsg = `🔒 *PENGATURAN PRIVASI AKUN BOT:*\n\n` +
                                   `• Last Seen      : ${priv.readreceipts || priv.last || 'N/A'}\n` +
                                   `• Online Status  : ${priv.online || 'N/A'}\n` +
                                   `• Profile Photo  : ${priv.profile || 'N/A'}\n` +
                                   `• Status/Story   : ${priv.status || 'N/A'}\n` +
                                   `• Read Receipts  : ${priv.readreceipts || 'N/A'}\n` +
                                   `• Group Add Mode : ${priv.groupadd || 'N/A'}\n` +
                                   `• Anti-Call Bot  : ${botSettings.antiCall ? '✅ AKTIF' : '❌ NONAKTIF'}`;
                        await sock.sendMessage(sender, { text: pMsg }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengambil privacy settings: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'setlastseen': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    const val = args[0]; // 'all' | 'contacts' | 'none'
                    if (!['all', 'contacts', 'none'].includes(val)) return await sock.sendMessage(sender, { text: '⚠️ Pilihan valid: `all`, `contacts`, `none`' }, { quoted: msg });
                    try {
                        await sock.updateLastSeenPrivacy(val);
                        await sock.sendMessage(sender, { text: `✅ Privasi Last Seen diset ke: *${val}*` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengatur privasi: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'setonline': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    const val = args[0]; // 'all' | 'match_last_seen'
                    if (!['all', 'match_last_seen'].includes(val)) return await sock.sendMessage(sender, { text: '⚠️ Pilihan valid: `all`, `match_last_seen`' }, { quoted: msg });
                    try {
                        await sock.updateOnlinePrivacy(val);
                        await sock.sendMessage(sender, { text: `✅ Privasi Online diset ke: *${val}*` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengatur privasi online: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'setreadreceipts': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    const val = args[0]; // 'all' | 'none'
                    if (!['all', 'none'].includes(val)) return await sock.sendMessage(sender, { text: '⚠️ Pilihan valid: `all` (aktif), `none` (nonaktif)' }, { quoted: msg });
                    try {
                        await sock.updateReadReceiptsPrivacy(val);
                        await sock.sendMessage(sender, { text: `✅ Centang biru (Read Receipts) diset ke: *${val}*` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengatur read receipts: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                // =========================================================
                // STORIES & BROADCASTS
                // =========================================================
                case 'story': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan teks status yang ingin diunggah!\nContoh: `!story Halo semua, selamat beraktivitas!`' }, { quoted: msg });
                    const storyTxt = args.join(' ');
                    try {
                        const statusList = botSettings.autoSholat.concat(botSettings.autoWeather);
                        const uniqueRecipients = [...new Set(statusList)].filter(j => !j.endsWith('@g.us'));
                        
                        await sock.sendMessage('status@broadcast', {
                            text: storyTxt
                        }, {
                            broadcast: true,
                            statusJidList: uniqueRecipients.length > 0 ? uniqueRecipients : [ownerPureJid]
                        });
                        await sock.sendMessage(sender, { text: '📢 Status WhatsApp berhasil diunggah!' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengunggah story: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'storyimage': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    if (!hasQuoted || !quotedContext.quotedMessage?.imageMessage) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) foto dengan caption `!storyimage <keterangan>` untuk diunggah sebagai Story WhatsApp!' }, { quoted: msg });
                    }
                    try {
                        await sock.sendMessage(sender, { text: '⏳ Mengunduh dan mengunggah Story gambar...' }, { quoted: msg });
                        const buffer = await downloadMediaMessage(
                            { message: quotedContext.quotedMessage },
                            'buffer',
                            {},
                            { logger: console }
                        );
                        const caption = args.join(' ') || quotedContext.quotedMessage.imageMessage.caption || '';
                        const statusList = botSettings.autoSholat.concat(botSettings.autoWeather);
                        const uniqueRecipients = [...new Set(statusList)].filter(j => !j.endsWith('@g.us'));

                        await sock.sendMessage('status@broadcast', {
                            image: buffer,
                            caption: caption
                        }, {
                            broadcast: true,
                            statusJidList: uniqueRecipients.length > 0 ? uniqueRecipients : [ownerPureJid]
                        });
                        await sock.sendMessage(sender, { text: '📢 Status foto berhasil diunggah ke WhatsApp Stories!' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengunggah status foto: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'broadcast': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan pesan siaran!\nContoh: `!broadcast Pengumuman pemeliharaan server jam 22:00 WITA.`' }, { quoted: msg });
                    const bcMsg = `📢 *[SIARAN DENTS WEB BOT GATEWAY]* 📢\n\n${args.join(' ')}\n\n_Pesan otomatis dari Bot Administrator_`;
                    const targets = [...new Set([
                        ...botSettings.autoSholat, 
                        ...botSettings.autoWeather, 
                        ...botSettings.autoRanap, 
                        ...botSettings.autoRajal
                    ])];
                    
                    await sock.sendMessage(sender, { text: `⏳ Mengirim broadcast ke ${targets.length} obrolan/grup terdaftar...` }, { quoted: msg });
                    let sukses = 0; let gagal = 0;
                    for (const tJid of targets) {
                        try {
                            await sock.sendMessage(tJid, { text: bcMsg });
                            sukses++;
                        } catch(e) { gagal++; }
                    }
                    await sock.sendMessage(sender, { text: `✅ Broadcast Selesai!\n• Terkirim: ${sukses}\n• Gagal: ${gagal}` }, { quoted: msg });
                    break;
                }

                // =========================================================
                // USER & BOT PROFILE MANAGEMENT
                // =========================================================
                case 'checkwa': {
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan nomor yang ingin dicek!\nContoh: `!checkwa 6281234567890`' }, { quoted: msg });
                    let chkNum = args[0].replace(/[^0-9]/g, '');
                    if (chkNum.startsWith('0')) chkNum = '62' + chkNum.slice(1);
                    chkNum += '@s.whatsapp.net';
                    try {
                        const [res] = await sock.onWhatsApp(chkNum);
                        if (res?.exists) {
                            await sock.sendMessage(sender, { text: `✅ *Nomor Terdaftar di WhatsApp!*\n• Nomor : +${chkNum.split('@')[0]}\n• JID   : ${res.jid}` }, { quoted: msg });
                        } else {
                            await sock.sendMessage(sender, { text: `❌ Nomor +${chkNum.split('@')[0]} tidak terdaftar di WhatsApp.` }, { quoted: msg });
                        }
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal memeriksa nomor: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'statuswa': {
                    let targetBio = hasQuoted ? (quotedContext.participant || sender) : (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender);
                    try {
                        const statusObj = await sock.fetchStatus(targetBio);
                        await sock.sendMessage(sender, { text: `📝 *STATUS / BIO WHATSAPP:*\n\n"${statusObj?.status || 'Tidak ada status'}"\n\n_Disetel pada: ${statusObj?.setAt ? formatWITA(statusObj.setAt) : 'N/A'}_` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengambil status WA (mungkin disembunyikan oleh privasi pengguna).' }, { quoted: msg });
                    }
                    break;
                }

                case 'pp': {
                    let targetPP = hasQuoted ? (quotedContext.participant || sender) : (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender);
                    try {
                        const ppUrl = await sock.profilePictureUrl(targetPP, 'image');
                        await sock.sendMessage(sender, { image: { url: ppUrl }, caption: `🖼️ *Foto Profil WhatsApp:* @${targetPP.split('@')[0]}`, mentions: [targetPP] }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengambil foto profil (tidak ada foto profil atau disembunyikan oleh privasi).' }, { quoted: msg });
                    }
                    break;
                }

                case 'setbio': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan bio/status baru untuk bot!' }, { quoted: msg });
                    const newBio = args.join(' ');
                    try {
                        await sock.updateProfileStatus(newBio);
                        await sock.sendMessage(sender, { text: `✅ Bio bot berhasil diubah menjadi:\n"${newBio}"` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengubah bio bot: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'setname': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ Masukkan nama tampilan baru untuk bot!' }, { quoted: msg });
                    const newName = args.join(' ');
                    try {
                        await sock.updateProfileName(newName);
                        await sock.sendMessage(sender, { text: `✅ Nama profil bot diubah menjadi: *${newName}*` }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengubah nama: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                case 'setpp': {
                    if (!isOwner(pureSender, sock)) return await sock.sendMessage(sender, { text: '❌ Khusus Owner.' }, { quoted: msg });
                    if (!hasQuoted || !quotedContext.quotedMessage?.imageMessage) {
                        return await sock.sendMessage(sender, { text: '⚠️ Balas (reply) foto dengan command `!setpp` untuk dijadikan foto profil bot!' }, { quoted: msg });
                    }
                    try {
                        await sock.sendMessage(sender, { text: '⏳ Mengunduh & mengganti foto profil bot...' }, { quoted: msg });
                        const buffer = await downloadMediaMessage(
                            { message: quotedContext.quotedMessage },
                            'buffer',
                            {},
                            { logger: console }
                        );
                        await sock.updateProfilePicture(sock.user.id, buffer);
                        await sock.sendMessage(sender, { text: '✅ Foto profil bot berhasil diperbarui!' }, { quoted: msg });
                    } catch(e) {
                        await sock.sendMessage(sender, { text: '❌ Gagal mengubah foto profil: ' + (e.message || e) }, { quoted: msg });
                    }
                    break;
                }

                // =========================================================
                // PERINTAH EKSISTING RSUD KENDARI, SHOLAT, CUACA & SISTEM
                // =========================================================
                case 'jadwalranap': {
                    await sock.sendPresenceUpdate('composing', sender);
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
                    } catch (error) { 
                        await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel maupun Google Sheets.*\nPastikan Ekstensi di PC menyala.' }, { quoted: msg }); 
                    }
                    break;
                }

                case 'autoranap': {
                    if (args[0] === 'on') {
                        if (!botSettings.autoRanap.includes(pureSender)) botSettings.autoRanap.push(pureSender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info Rawat Inap AKTIF* di obrolan ini.\nBot akan otomatis mengirim pesan laporan jika mendeteksi ada pasien yang masuk atau keluar (pulang).' }, { quoted: msg });
                        await forceSendRanapPrimer(sock, sender);
                    } else if (args[0] === 'off') {
                        botSettings.autoRanap = botSettings.autoRanap.filter(jid => jid !== pureSender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info Rawat Inap NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autoranap on* atau *!autoranap off*' }, { quoted: msg });
                    }
                    break;
                }

                case 'autorajal': {
                    if (args[0] === 'on') {
                        if (!botSettings.autoRajal.includes(pureSender)) botSettings.autoRajal.push(pureSender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info Rawat Jalan AKTIF* di obrolan ini.\nBot akan otomatis mengirim laporan ke obrolan ini setiap kali antrean Klinik bertambah atau berkurang pada hari ini.' }, { quoted: msg });
                        await forceSendRajalPrimer(sock, sender);
                    } else if (args[0] === 'off') {
                        botSettings.autoRajal = botSettings.autoRajal.filter(jid => jid !== pureSender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info Rawat Jalan NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autorajal on* atau *!autorajal off*' }, { quoted: msg });
                    }
                    break;
                }

                case 'refresh': {
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
                }

                case 'settings': {
                    const ranapActive = botSettings.autoRanap.includes(pureSender) ? '✅ AKTIF' : '❌ NONAKTIF';
                    const rajalActive = botSettings.autoRajal.includes(pureSender) ? '✅ AKTIF' : '❌ NONAKTIF';
                    const sholatActive = botSettings.autoSholat.includes(pureSender) ? '✅ AKTIF' : '❌ NONAKTIF';
                    const weatherActive = botSettings.autoWeather.includes(pureSender) ? '✅ AKTIF' : '❌ NONAKTIF';
                    const antiCallActive = botSettings.antiCall ? '✅ AKTIF' : '❌ NONAKTIF';
                    
                    let setsMsg = `⚙️ *PENGATURAN BOT DI CHAT/GRUP INI*\n\n` +
                                  `🏥 *Auto Info Rawat Inap:* ${ranapActive}\n` +
                                  `🏥 *Auto Info Rawat Jalan:* ${rajalActive}\n` +
                                  `🕌 *Auto Info Sholat (Kendari):* ${sholatActive}\n` +
                                  `🌤️ *Auto Info Cuaca (Kendari):* ${weatherActive}\n` +
                                  `📵 *Anti-Call Protection:* ${antiCallActive}\n\n`;
                    
                    if (isOwner(pureSender, sock)) {
                        setsMsg += `👑 *STATISTIK GLOBAL (KHUSUS OWNER):*\n` +
                                   `👥 Berlangganan Sholat: ${botSettings.autoSholat.length} User/Grup\n` +
                                   `👥 Berlangganan Cuaca: ${botSettings.autoWeather.length} User/Grup\n` +
                                   `🏥 Berlangganan Ranap: ${botSettings.autoRanap.length} User/Grup\n` +
                                   `🏥 Berlangganan Rajal: ${botSettings.autoRajal.length} User/Grup\n\n`;
                    }
                    setsMsg += `_Gunakan command *!autoranap on*, *!autoinfosholat on*, dsb untuk mengaktifkan._`;
                    await sock.sendMessage(sender, { text: setsMsg }, { quoted: msg });
                    break;
                }

                case 'autoinfosholat': {
                    if (args[0] === 'on') {
                        if (!botSettings.autoSholat.includes(pureSender)) botSettings.autoSholat.push(pureSender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info & Pengingat Sholat AKTIF* di obrolan ini.\nBot otomatis mengirim jadwal di pagi hari dan mengingatkan waktu sholat.' }, { quoted: msg });
                    } else if (args[0] === 'off') {
                        botSettings.autoSholat = botSettings.autoSholat.filter(jid => jid !== pureSender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info & Pengingat Sholat NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else { await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autoinfosholat on/off*' }, { quoted: msg }); }
                    break;
                }

                case 'autoweather': {
                    if (args[0] === 'on') {
                        if (!botSettings.autoWeather.includes(pureSender)) botSettings.autoWeather.push(pureSender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Prakiraan Cuaca AKTIF* di obrolan ini.\nBot otomatis mengirim cuaca Kendari setiap jam 06:00 WITA.' }, { quoted: msg });
                    } else if (args[0] === 'off') {
                        botSettings.autoWeather = botSettings.autoWeather.filter(jid => jid !== pureSender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Prakiraan Cuaca NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else { await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autoweather on/off*' }, { quoted: msg }); }
                    break;
                }

                case 'addsholat': {
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ *Masukkan nomor!*\nContoh: !addsholat 6281234567890' }, { quoted: msg });
                    let targetAddS = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    if (!botSettings.autoSholat.includes(targetAddS)) {
                        botSettings.autoSholat.push(targetAddS); saveSettings();
                        await sock.sendMessage(sender, { text: `✅ Nomor ${args[0]} ditambahkan ke Auto Sholat.` }, { quoted: msg });
                    } else { await sock.sendMessage(sender, { text: `⚠️ Nomor sudah ada.` }, { quoted: msg }); }
                    break;
                }

                case 'delsholat': {
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ *Masukkan nomor!*\nContoh: !delsholat 6281234567890' }, { quoted: msg });
                    let targetDelS = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    if (botSettings.autoSholat.includes(targetDelS)) {
                        botSettings.autoSholat = botSettings.autoSholat.filter(n => n !== targetDelS); saveSettings();
                        await sock.sendMessage(sender, { text: `✅ Nomor ${args[0]} dihapus dari Auto Sholat.` }, { quoted: msg });
                    } else { await sock.sendMessage(sender, { text: `⚠️ Nomor tidak ditemukan.` }, { quoted: msg }); }
                    break;
                }

                case 'addweather': {
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ *Masukkan nomor!*\nContoh: !addweather 6281234567890' }, { quoted: msg });
                    let targetAddW = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    if (!botSettings.autoWeather.includes(targetAddW)) {
                        botSettings.autoWeather.push(targetAddW); saveSettings();
                        await sock.sendMessage(sender, { text: `✅ Nomor ${args[0]} ditambahkan ke Auto Cuaca.` }, { quoted: msg });
                    } else { await sock.sendMessage(sender, { text: `⚠️ Nomor sudah ada.` }, { quoted: msg }); }
                    break;
                }

                case 'delweather': {
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ *Masukkan nomor!*\nContoh: !delweather 6281234567890' }, { quoted: msg });
                    let targetDelW = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    if (botSettings.autoWeather.includes(targetDelW)) {
                        botSettings.autoWeather.filter(n => n !== targetDelW); saveSettings();
                        await sock.sendMessage(sender, { text: `✅ Nomor ${args[0]} dihapus dari Auto Cuaca.` }, { quoted: msg });
                    } else { await sock.sendMessage(sender, { text: `⚠️ Nomor tidak ditemukan.` }, { quoted: msg }); }
                    break;
                }

                case 'cuaca':
                case 'weather': {
                    await sock.sendPresenceUpdate('composing', sender);
                    if (args.length > 0) {
                        const queryStr = args.join(' ');
                        const parsedDates = parseWeatherQuery(queryStr);
                        if (parsedDates) {
                            await sock.sendMessage(sender, { text: `⏳ _Mengambil data cuaca untuk periode: ${parsedDates.label}..._` }, { quoted: msg });
                            const advWeather = await fetchAdvancedWeather(parsedDates.start, parsedDates.end, parsedDates.label);
                            await sock.sendMessage(sender, { text: advWeather }, { quoted: msg });
                        } else {
                            await sock.sendMessage(sender, { text: `⚠️ *Format tanggal tidak dikenali.*\nContoh:\n- !cuaca besok\n- !cuaca lusa\n- !cuaca 15 Januari 2026\n- !cuaca 01 - 20 Januari 2026\n- !cuaca 15-01-2026` }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(sender, { text: '⏳ _Mengambil data cuaca Kendari saat ini..._' }, { quoted: msg });
                        const cuacaData = await fetchWeatherKendari();
                        if (cuacaData) await sock.sendMessage(sender, { text: `☁️ *INFO CUACA KENDARI*\n\n${cuacaData}` }, { quoted: msg });
                        else await sock.sendMessage(sender, { text: '❌ *Gagal mengambil API Cuaca Open-Meteo.*' }, { quoted: msg });
                    }
                    break;
                }

                case 'gempa': {
                    await sock.sendPresenceUpdate('composing', sender);
                    await sock.sendMessage(sender, { text: '⏳ _Mengambil informasi BMKG gempa terbaru..._' }, { quoted: msg });
                    const infoGempa = await fetchGempa();
                    await sock.sendMessage(sender, { text: infoGempa }, { quoted: msg });
                    break;
                }

                case 'calc':
                case 'kalkulator': {
                    if (args.length === 0) return await sock.sendMessage(sender, { text: '⚠️ Masukkan operasi matematika.\nContoh: `!calc (50 * 2) - 10`' }, { quoted: msg });
                    const calcStr = args.join(' ');
                    try {
                        if (/^[0-9+\-*/().\s]+$/.test(calcStr)) {
                            const result = new Function(`return ${calcStr}`)();
                            await sock.sendMessage(sender, { text: `🧮 *Kalkulator Pintar*\n\nEkspresi: ${calcStr}\nHasil: *${result}*` }, { quoted: msg });
                        } else {
                            await sock.sendMessage(sender, { text: `⚠️ Format matematika tidak valid. Gunakan angka dan operator + - * / ( )` }, { quoted: msg });
                        }
                    } catch(e) { await sock.sendMessage(sender, { text: `❌ Ekspresi tidak dapat dihitung.` }, { quoted: msg }); }
                    break;
                }

                case 'listsurah': {
                    await sock.sendPresenceUpdate('composing', sender);
                    await sock.sendMessage(sender, { text: '⏳ _Mengambil daftar Surah..._' }, { quoted: msg });
                    try {
                        const res = await fetch("http://api.alquran.cloud/v1/surah"); const json = await res.json();
                        let reply = `📖 *DAFTAR 114 SURAH AL-QURAN*\n\n`;
                        json.data.forEach(s => { reply += `*${s.number}. ${s.englishName}* (${s.name}) - ${s.numberOfAyahs} Ayat\n`; });
                        reply += `\n_Ketik *!surah <nomor>* untuk detail info Surah._\n_Ketik *!ayat <nomor_surah> full* untuk isi seluruh surah._`;
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(sender, { text: '❌ *Gagal memuat API Al-Quran.*' }); }
                    break;
                }

                case 'surah': {
                    if (!args[0]) return await sock.sendMessage(sender, { text: '⚠️ *Sertakan nomor surah!*\nContoh: !surah 1 (Untuk Al-Fatihah)' }, { quoted: msg });
                    try {
                        const num = parseInt(args[0]);
                        const res = await fetch(`http://api.alquran.cloud/v1/surah/${num}`);
                        const json = await res.json();
                        if (json.code !== 200) return await sock.sendMessage(sender, { text: `❌ Surah tidak ditemukan.` });
                        const s = json.data;
                        const info = `📖 *INFORMASI SURAH*\n\n🔢 *Nomor:* ${s.number}\n📜 *Nama:* ${s.englishName} (${s.name})\n📝 *Arti:* ${s.englishNameTranslation}\n📍 *Turun di:* ${s.revelationType === 'Meccan' ? 'Makkah' : 'Madinah'}\n📏 *Jumlah Ayat:* ${s.numberOfAyahs} Ayat\n\n_Gunakan *!ayat ${s.number} full* untuk melihat teks penuh & link audio._`;
                        await sock.sendMessage(sender, { text: info }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(sender, { text: '❌ *Gagal memuat API Al-Quran.*' }); }
                    break;
                }

                case 'ayat': {
                    if (args.length < 2) return await sock.sendMessage(sender, { text: '⚠️ *Format Salah!*\nGunakan:\n*!ayat <surah> <ayat>* (Info 1 Ayat + Audio)\n*!ayat <surah> <awal>-<akhir>* (Rentang Ayat)\n*!ayat <surah> full* (Satu Surah Penuh)\n\nContoh:\n*!ayat 1 2*\n*!ayat 2 1-10*\n*!ayat 36 full*' }, { quoted: msg });
                    await sock.sendPresenceUpdate('composing', sender);
                    await sock.sendMessage(sender, { text: '⏳ _Mengambil Data Al-Quran..._' }, { quoted: msg });
                    try {
                        const surahNum = args[0]; const ayatParam = args[1].toLowerCase();
                        let startAyat = -1, endAyat = -1, isFull = false;
                        
                        if (ayatParam === 'full') { isFull = true; } 
                        else if (ayatParam.includes('-')) {
                            const parts = ayatParam.split('-'); startAyat = parseInt(parts[0]); endAyat = parseInt(parts[1]);
                        } else { startAyat = parseInt(ayatParam); endAyat = startAyat; }
                        
                        const res = await fetch(`http://api.alquran.cloud/v1/surah/${surahNum}/editions/quran-uthmani,id.indonesian,ar.alafasy`);
                        const json = await res.json();
                        if (json.code !== 200) return await sock.sendMessage(sender, { text: `❌ Gagal mengambil data. Pastikan nomor valid.` }, { quoted: msg });

                        const arabicSurah = json.data[0]; const indoSurah = json.data[1]; const audioSurah = json.data[2];
                        if (isFull) { startAyat = 1; endAyat = arabicSurah.numberOfAyahs; }
                        if (startAyat < 1 || endAyat > arabicSurah.numberOfAyahs || startAyat > endAyat) {
                            return await sock.sendMessage(sender, { text: `❌ Range tidak valid. Surah ini memiliki ${arabicSurah.numberOfAyahs} ayat.` }, { quoted: msg });
                        }
                        
                        let replyTexts = []; let currentChunk = `📖 *Surah ${arabicSurah.englishName}* (${arabicSurah.name})\nAyat: ${startAyat} - ${endAyat}\n\n`;
                        
                        for (let i = startAyat - 1; i < endAyat; i++) {
                            const ayatString = `*[ Ayat ${i + 1} ]*\n${arabicSurah.ayahs[i].text}\n_Arti: ${indoSurah.ayahs[i].text}_\n\n`;
                            if (currentChunk.length + ayatString.length > 3500) {
                                replyTexts.push(currentChunk); currentChunk = `_(Lanjutan Surah ${arabicSurah.englishName}...)_\n\n` + ayatString;
                            } else { currentChunk += ayatString; }
                        }
                        if (currentChunk.trim().length > 0) replyTexts.push(currentChunk);
                        
                        for (const txt of replyTexts) await sock.sendMessage(sender, { text: txt });
                        
                        if (startAyat === endAyat) {
                            const audioUrl = audioSurah.ayahs[startAyat - 1].audio;
                            await sock.sendMessage(sender, { text: `🎧 _Mengirim audio murottal Syeikh Mishary Rasyid..._` });
                            await sock.sendMessage(sender, { audio: { url: audioUrl }, mimetype: 'audio/mp4', ptt: false }, { quoted: msg });
                        } else if (isFull) {
                            const fullAudioUrl = `https://cdn.islamic.network/quran/audio-surah/128/ar.alafasy/${surahNum}.mp3`;
                            await sock.sendMessage(sender, { text: `🎧 _Audio Full Surah Murottal Syeikh Mishary Rasyid (1 File):\n${fullAudioUrl}` }, { quoted: msg });
                        }
                    } catch (e) { await sock.sendMessage(sender, { text: '❌ *Gagal memuat API Al-Quran.*' }); }
                    break;
                }

                case 'addjadwal': {
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
                }

                case 'listjadwal': {
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
                }

                case 'deljadwal': {
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
                }

                case 'runtime': {
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
                                         `• Engine      : Baileys v7.0.0-rc14 (ESM)\n` +
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
                }

                case 'tagall': {
                    if (!isGroup) return;
                    const groupMetadata = await sock.groupMetadata(sender);
                    const tagParticipants = groupMetadata.participants.map(p => p.id);
                    let mentionText = `*📢 PERHATIAN SEMUA 📢*\n\n`;
                    tagParticipants.forEach(p => mentionText += `👉 @${p.split('@')[0]}\n`);
                    await sock.sendMessage(sender, { text: mentionText, mentions: tagParticipants }, { quoted: msg });
                    break;
                }

                case 'ping': {
                    await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${Date.now() - (msg.messageTimestamp * 1000)} ms` }, { quoted: msg }); 
                    break;
                }
                    
                case 'ai': {
                    await handleAiCommand(sock, msg, args); 
                    break;
                }
                    
                case 'sticker': 
                case 's': {
                    await handleStickerCommand(sock, msg); 
                    break;
                }
            }
        } catch (error) { 
            console.error('Error proses pesan di messageHandler:', error); 
        }
    });
}
