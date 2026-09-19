import fs from 'fs';
import process from 'process';
import os from 'os';
import path from 'path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// =========================================================================
// HANDLER PERINTAH EKSTERNAL (OPSIONAL DENGAN GRACEFUL FALLBACK)
// =========================================================================
let handleStickerCommand = null;
try {
    const stickerModule = await import('./commands/sticker.js').catch(() => null);
    if (stickerModule && (stickerModule.default || stickerModule.handleStickerCommand)) {
        handleStickerCommand = stickerModule.default || stickerModule.handleStickerCommand;
    }
} catch (e) {
    handleStickerCommand = null;
}

// =========================================================================
// KONFIGURASI SISTEM & REST API WEB ABSENSI V7 (DEPT. RADIOLOGI KEDOKTERAN GIGI)
// =========================================================================
const WEB_ABSENSI_API_URL = process.env.WEB_ABSENSI_API_URL || "https://absensi.maksaarsyad.xyz/api";
const WEB_PORTAL_URL = process.env.WEB_PORTAL_URL || "https://absensi.maksaarsyad.xyz";
const OWNER_NUMBER = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

// Daftar Administrator & Staf Dept. RKG FKG UMI
const ADMIN_JID_LIST = [
    OWNER_NUMBER,
    "6285256739684@s.whatsapp.net", // drg. M. Aksa Arsyad (Super Admin / Penanggung Jawab Sistem)
    "6282291675363@s.whatsapp.net"  // drg. Hj. Kurniawaty, Sp.KG / Staf Pengajar RKG
];

// Whitelist Model Groq AI untuk Fallback Tingkat Tinggi
const GROQ_ALLOWED_MODELS = [
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
    "groq/compound",
    "groq/compound-mini"
];

// =========================================================================
// DIRECT CLOUD UPSTASH REDIS CLIENT (KONEKSI RESMI MULTI-PLATFORM / RAILWAY)
// =========================================================================
const KV_REST_API_URL = process.env.KV_REST_API_URL || 
    process.env.UPSTASH_REDIS_REST_URL || 
    process.env.NEXT_PUBLIC_UPSTASH_REDIS_REST_URL ||
    "https://electric-pangolin-87989.upstash.io";

const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || 
    process.env.UPSTASH_REDIS_REST_TOKEN || 
    process.env.NEXT_PUBLIC_UPSTASH_REDIS_REST_TOKEN ||
    "gQAAAAAAAVe1AAIgcDJiYzYzOGIzNmQ5ZTQ0Yzg1OWQwZmYxNjU2MWY3NDMwNQ";

function safeParseJson(data) {
    if (data === null || data === undefined) return null;
    let parsed = data;
    let depth = 0;
    while (typeof parsed === 'string' && depth < 3) {
        try {
            parsed = JSON.parse(parsed);
        } catch (e) {
            break;
        }
        depth++;
    }
    return parsed;
}

async function redisDirectGet(key) {
    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return null;
    const cleanUrl = KV_REST_API_URL.replace(/\/+$/, '');
    try {
        const res = await fetch(cleanUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KV_REST_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(["GET", key]),
            cache: 'no-store'
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.error || data.result === null || data.result === undefined) return null;
        return safeParseJson(data.result);
    } catch (e) {
        return null;
    }
}

async function redisDirectSet(key, value, exSeconds = null) {
    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return false;
    const cleanUrl = KV_REST_API_URL.replace(/\/+$/, '');
    try {
        const strVal = typeof value === 'string' ? value : JSON.stringify(value);
        const command = (typeof exSeconds === 'number' && exSeconds > 0)
            ? ["SET", key, strVal, "EX", exSeconds]
            : ["SET", key, strVal];
        const res = await fetch(cleanUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KV_REST_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(command)
        });
        const data = await res.json();
        return !data.error;
    } catch (e) {
        return false;
    }
}

// =========================================================================
// NORMALISASI & SANITASI ROUTER AI
// =========================================================================
function normalize9RouterUrl(rawUrl) {
    let url = (rawUrl || '').trim();
    if (!url) return "http://43.134.43.146:20128/v1/chat/completions";
    url = url.replace(/\/+$/, '');
    if (!url.endsWith('/chat/completions')) {
        if (url.endsWith('/v1')) {
            url += '/chat/completions';
        } else {
            url += '/v1/chat/completions';
        }
    }
    return url;
}

function sanitize9RouterModel(rawModel) {
    let model = String(rawModel || 'auto').trim();
    model = model.replace(/\s*\([^)]*\)/g, '').trim();
    if (model.startsWith('gemini/gemini/')) {
        model = model.replace('gemini/gemini/', 'gemini/');
    }
    return model || 'auto';
}

// =========================================================================
// BIDIRECTIONAL LID & PHONE RESOLVER BESERTA PERSISTENT CACHE LOKAL
// =========================================================================
const sessionPath = './session';
const lidCacheFile = `${sessionPath}/lid_mappings.json`;
const studentCacheFile = `${sessionPath}/student_cache.json`;

if (!fs.existsSync(sessionPath)) {
    try {
        fs.mkdirSync(sessionPath, { recursive: true });
    } catch (e) { }
}

const lidToPhoneMap = new Map();
const phoneToLidMap = new Map();
const studentCacheMap = new Map(); // key: phone, lid, atau NIM

function formatToInternational(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/@.*$/, '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('08')) {
        digits = '628' + digits.slice(2);
    } else if (digits.startsWith('8')) {
        digits = '628' + digits.slice(1);
    } else if (!digits.startsWith('62') && digits.length >= 9 && digits.length <= 13) {
        digits = '62' + digits;
    }
    return digits.length >= 8 && digits.length <= 16 ? digits : null;
}

// Load Persistent LID Mappings dari Disk
try {
    if (fs.existsSync(lidCacheFile)) {
        const rawData = fs.readFileSync(lidCacheFile, 'utf8');
        const parsed = JSON.parse(rawData);
        if (parsed.lidToPhone) {
            for (const [k, v] of Object.entries(parsed.lidToPhone)) {
                lidToPhoneMap.set(k, v);
                phoneToLidMap.set(v, k);
            }
        }
        console.log(`[LID Cache] Memuat ${lidToPhoneMap.size} pemetaan LID terverifikasi dari disk.`);
    }
} catch (e) {
    console.warn('[LID Cache] Gagal membaca berkas cache:', e.message);
}

// Load Persistent Student Cache dari Disk
try {
    if (fs.existsSync(studentCacheFile)) {
        const rawData = fs.readFileSync(studentCacheFile, 'utf8');
        const parsed = JSON.parse(rawData);
        for (const [k, v] of Object.entries(parsed)) {
            studentCacheMap.set(k, v);
        }
        console.log(`[Student Cache] Memuat ${studentCacheMap.size} entri mahasiswa RKG dari disk.`);
    }
} catch (e) {
    console.warn('[Student Cache] Gagal membaca berkas cache:', e.message);
}

function persistLidMappings() {
    try {
        const obj = {
            lidToPhone: Object.fromEntries(lidToPhoneMap),
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(lidCacheFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) { }
}

function persistStudentCache() {
    try {
        fs.writeFileSync(studentCacheFile, JSON.stringify(Object.fromEntries(studentCacheMap), null, 2), 'utf8');
    } catch (e) { }
}

function registerIdentityMapping(lidDigits, phoneDigits) {
    if (!lidDigits || !phoneDigits) return;
    const cleanLid = String(lidDigits).replace(/\D/g, '');
    const cleanPhone = formatToInternational(phoneDigits);
    if (!cleanLid || !cleanPhone) return;

    const changed = (lidToPhoneMap.get(cleanLid) !== cleanPhone);
    lidToPhoneMap.set(cleanLid, cleanPhone);
    phoneToLidMap.set(cleanPhone, cleanLid);

    if (changed) {
        persistLidMappings();
    }
}

function cacheStudentObject(key, studentObj) {
    if (!key || !studentObj) return;
    const k = String(key).trim();
    studentCacheMap.set(k, studentObj);
    if (studentObj.nim) studentCacheMap.set(studentObj.nim, studentObj);
    if (studentObj.phone) {
        const cleanPhone = formatToInternational(studentObj.phone);
        if (cleanPhone) studentCacheMap.set(cleanPhone, studentObj);
    }
    persistStudentCache();
}

function getCachedStudentObject(key) {
    if (!key) return null;
    const k = String(key).trim();
    if (studentCacheMap.has(k)) return studentCacheMap.get(k);
    const clean = formatToInternational(k);
    if (clean && studentCacheMap.has(clean)) return studentCacheMap.get(clean);
    return null;
}

function parseSenderInfo(rawJid) {
    if (!rawJid) return { jid: '', id: '', isLid: false, targetJid: '' };
    const jid = String(rawJid).trim();
    const isLid = jid.endsWith('@lid');
    const id = jid.replace(/@.*$/, '');
    return {
        jid,
        id,
        isLid,
        targetJid: isLid ? `${id}@lid` : `${id}@s.whatsapp.net`
    };
}

function sanitizeNumber(rawNumber) {
    if (!rawNumber) return "";
    let clean = String(rawNumber).replace(/\D/g, '');
    if (clean.startsWith('08')) {
        clean = '628' + clean.slice(2);
    } else if (clean.startsWith('8')) {
        clean = '628' + clean.slice(1);
    }
    return clean;
}

// Memeriksa kesiapan socket Baileys sebelum mencoba mengirim pesan
// Menghindari exception fatal TypeError: Cannot read properties of undefined (reading 'id')
function isSocketReadyToSend(s) {
    if (!s || typeof s.sendMessage !== 'function') return false;
    
    // Periksa apakah user/identitas Baileys sudah terotentikasi di sesi
    const hasUser = Boolean(s.user?.id || s.user?.jid || s.authState?.creds?.me?.id);
    if (!hasUser) return false;

    // Periksa status websocket jika properti ws ada
    if (s.ws) {
        if (s.ws.isOpen === false || s.ws.readyState === 2 || s.ws.readyState === 3) {
            return false;
        }
    }
    return true;
}

function formatForWhatsApp(text) {
    if (!text) return "";
    let formatted = String(text);
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');
    formatted = formatted.replace(/### (.*?)\n/g, '*$1*\n');
    formatted = formatted.replace(/## (.*?)\n/g, '*$1*\n');
    formatted = formatted.replace(/# (.*?)\n/g, '*$1*\n');
    return formatted;
}

function getWitaTimeGreeting() {
    const nowUtc = new Date();
    const witaOffsetMs = 8 * 60 * 60 * 1000;
    const witaDate = new Date(nowUtc.getTime() + witaOffsetMs);

    const hours = witaDate.getUTCHours();
    const minutes = String(witaDate.getUTCMinutes()).padStart(2, '0');

    let greeting = "Halo Rekan Mahasiswa";
    if (hours >= 4 && hours < 11) {
        greeting = "Selamat Pagi";
    } else if (hours >= 11 && hours < 15) {
        greeting = "Selamat Siang";
    } else if (hours >= 15 && hours < 18) {
        greeting = "Selamat Sore";
    } else {
        greeting = "Selamat Malam";
    }

    const dayNames = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
    const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

    const dayName = dayNames[witaDate.getUTCDay()];
    const dateNum = witaDate.getUTCDate();
    const monthName = monthNames[witaDate.getUTCMonth()];
    const monthNum = witaDate.getUTCMonth() + 1;
    const yearNum = witaDate.getUTCFullYear();

    return {
        greeting,
        hours,
        minutes,
        dateNum,
        monthNum,
        yearNum,
        dateIso: `${yearNum}-${String(monthNum).padStart(2, '0')}-${String(dateNum).padStart(2, '0')}`,
        timeStr: `${String(hours).padStart(2, '0')}:${minutes} WITA`,
        fullWitaStr: `${dayName}, ${dateNum} ${monthName} ${yearNum} Pukul ${String(hours).padStart(2, '0')}:${minutes} WITA`
    };
}

function enrichSessionWithWitaStatus(s, currentWitaHours, currentWitaMinutes) {
    const currentMins = currentWitaHours * 60 + currentWitaMinutes;
    const startStr = s.startTime || s.start || "08:00";
    const endStr = s.endTime || s.end || "16:00";
    const tolMins = typeof s.toleranceMinutes === 'number' ? s.toleranceMinutes : 15;

    const [sH, sM] = startStr.split(':').map(Number);
    const [eH, eM] = endStr.split(':').map(Number);

    let closingH = eH;
    let closingM = eM;
    if (s.calculatedClosingTime) {
        const parts = s.calculatedClosingTime.split(':').map(Number);
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            closingH = parts[0];
            closingM = parts[1];
        }
    } else if (s.lateLimit && s.lateLimit !== endStr) {
        const parts = s.lateLimit.split(':').map(Number);
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            closingH = parts[0];
            closingM = parts[1];
        }
    } else {
        const totalClosing = eH * 60 + eM + tolMins;
        closingH = Math.floor((totalClosing / 60) % 24);
        closingM = totalClosing % 60;
    }

    const startTotal = sH * 60 + sM;
    const closingTotal = closingH * 60 + closingM;

    const closingTimeStr = `${String(closingH).padStart(2, '0')}:${String(closingM).padStart(2, '0')}`;
    const isRunningNow = !!s.active && (currentMins >= startTotal && currentMins <= closingTotal);
    const isUpcoming = !!s.active && (currentMins < startTotal);
    const isPassed = !!s.active && (currentMins > closingTotal);

    let remainingMinutes = 0;
    let minutesToStart = 0;
    if (isRunningNow) {
        remainingMinutes = closingTotal - currentMins;
    } else if (isUpcoming) {
        minutesToStart = startTotal - currentMins;
    }

    let statusLabel = "⚪ Non-Aktif";
    if (isRunningNow) {
        statusLabel = `🟢 Berlangsung (Sisa ${remainingMinutes} mnt)`;
    } else if (isUpcoming) {
        statusLabel = `🟡 Mulai dlm ${minutesToStart} mnt`;
    } else if (isPassed) {
        statusLabel = `🔴 Selesai`;
    }

    return {
        ...s,
        name: s.name || s.title || "Sesi Praktikum",
        startStr,
        endStr,
        closingTimeStr,
        isRunningNow,
        isUpcoming,
        isPassed,
        remainingMinutes,
        minutesToStart,
        statusLabel
    };
}


function enforceCorrectGreeting(text, correctGreeting) {
    if (!text || !correctGreeting) return text;
    return text.replace(/(selamat pagi|selamat siang|selamat sore|selamat malam)/gi, correctGreeting);
}

function compileTemplateText(templateStr, dataObj = {}) {
    if (!templateStr) return "";
    let compiled = templateStr;
    for (const [k, v] of Object.entries(dataObj)) {
        const regex = new RegExp(`{{${k}}}`, 'gi');
        compiled = compiled.replace(regex, v !== undefined && v !== null ? String(v) : '');
    }
    return compiled;
}

// =========================================================================
// KONTROL SESI PERCAKAPAN MAHASISWA & AI MEMORY
// =========================================================================
const userSessions = new Map();
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 Jam

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [key, session] of userSessions.entries()) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
            userSessions.delete(key);
        }
    }
}

function getRelativeTime(seconds) {
    const s = Math.floor(Number(seconds) || 0);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h} jam ${m % 60} mnt`;
    if (m > 0) return `${m} menit`;
    return `${s} detik`;
}

function extractDateFromText(text) {
    if (!text) return null;
    const match = text.match(/\b(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]20\d{2})\b/);
    if (match) {
        const raw = match[0].replace(/[-/.]/g, '-');
        const parts = raw.split('-');
        if (parts[0].length === 4) {
            return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
        } else {
            return `${parts[2]}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
        }
    }
    return null;
}

function extractNimFromText(text) {
    if (!text) return null;
    const match = text.match(/\b(16[12]20\d{5,7}|\d{9,11})\b/);
    return match ? match[0] : null;
}

function detectStudentIntent(rawText) {
    const t = (rawText || '').toLowerCase().trim();
    if (!t) return 'unknown';

    if (t.startsWith('!absen') || t.startsWith('/absen') || t.includes('cara absen') || t.includes('mau absen') || t.includes('link absen')) {
        return 'absen';
    }
    if (t.startsWith('!jadwal') || t.startsWith('/jadwal') || t.includes('jadwal sesi') || t.includes('jam praktikum') || t.includes('jadwal hari ini')) {
        return 'jadwal';
    }
    if (t.startsWith('!lokasi') || t.startsWith('!gps') || t.startsWith('!geofence') || t.includes('titik lokasi') || t.includes('radius absen') || t.includes('lokasi kampus')) {
        return 'lokasi';
    }
    if (t.startsWith('!rekap') || t.startsWith('/rekap') || t.includes('rekap kehadiran') || t.includes('riwayat absen') || t.includes('cek kehadiran')) {
        return 'rekap';
    }
    if (t.startsWith('!logout') || t.startsWith('/logout') || t.includes('lepas perangkat') || t.includes('ganti hp') || t.includes('reset device')) {
        return 'logout';
    }
    if (t.startsWith('!kalender') || t.startsWith('/kalender') || t.includes('hari libur') || t.includes('libur stase')) {
        return 'kalender';
    }
    if (t.startsWith('!reset') || t.startsWith('/reset') || t === 'reset') {
        return 'reset';
    }
    if (t.startsWith('!ping') || t.startsWith('/ping') || t === 'ping') {
        return 'ping';
    }
    if (t.startsWith('!menu') || t.startsWith('/menu') || t.startsWith('!help') || t.startsWith('/help') || t === 'bantuan' || t === 'menu') {
        return 'menu';
    }
    if (t.startsWith('!broadcastjadwal') || t.startsWith('/broadcastjadwal')) {
        return 'broadcastjadwal';
    }
    if (t.startsWith('!broadcast ') || t.startsWith('/broadcast ')) {
        return 'broadcast';
    }
    if (t.startsWith('!sesi') || t.startsWith('/sesi')) {
        return 'sesi';
    }
    if (t.startsWith('!stats') || t.startsWith('/stats')) {
        return 'stats';
    }
    if (t.startsWith('!sync') || t.startsWith('/sync') || t.startsWith('!reloadsessions') || t.startsWith('/reloadsessions')) {
        return 'sync';
    }
    return 'ai_chat';
}

// =========================================================================
// REST API & DIRECT CLOUD REDIS CLIENT LAYER (HYBRID DUAL-ENGINE)
// =========================================================================

// Mengambil data dari Upstash Cloud secara langsung, dengan fallback ke REST API lokal
async function callDbGet(key) {
    // 1. Coba koneksi langsung ke Upstash Redis Cloud (Tanpa Ketergantungan Localhost)
    const redisResult = await redisDirectGet(key);
    if (redisResult !== null && redisResult !== undefined) {
        return redisResult;
    }

    // 2. Fallback: Coba HTTP API Web Absensi jika sedang di lingkungan lokal
    if (WEB_ABSENSI_API_URL && !WEB_ABSENSI_API_URL.includes('localhost:3000')) {
        try {
            const res = await fetch(`${WEB_ABSENSI_API_URL}/db?key=${encodeURIComponent(key)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                cache: 'no-store'
            });
            if (res.ok) {
                const json = await res.json();
                if (json.success && json.data !== undefined) return json.data;
            }
        } catch (e) { }
    }

    return null;
}

// Menyimpan data langsung ke Upstash Cloud, dengan fallback ke REST API lokal
async function callDbSet(key, value) {
    // 1. Tulis langsung ke Upstash Redis Cloud
    const successDirect = await redisDirectSet(key, value);
    if (successDirect) return true;

    // 2. Fallback: Tulis via HTTP API
    try {
        const res = await fetch(`${WEB_ABSENSI_API_URL}/db`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ key, value })
        });
        if (res.ok) {
            const json = await res.json();
            return json.success === true;
        }
    } catch (e) { }

    return false;
}

// Menarik antrian pesan outbox (Mendukung Upstash Cloud key 'axaxyz_wa_queue')
async function callWaPull() {
    // 1. Coba baca antrian langsung dari Upstash Redis Cloud (Key: axaxyz_wa_queue)
    const cloudQueue = await redisDirectGet('axaxyz_wa_queue');
    if (Array.isArray(cloudQueue) && cloudQueue.length > 0) {
        return cloudQueue;
    }

    // 2. Fallback: Coba request ke endpoint /api/wa?action=pull
    try {
        const res = await fetch(`${WEB_ABSENSI_API_URL}/wa?action=pull`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
        });
        if (res.ok) {
            const json = await res.json();
            if (json.success && Array.isArray(json.queue)) {
                return json.queue;
            }
            if (json.success && Array.isArray(json.messages)) {
                return json.messages;
            }
        }
    } catch (e) { }

    return [];
}

// Menghapus pesan dari antrian setelah berhasil dikirim
async function callWaAcknowledge(processedIds = []) {
    if (!Array.isArray(processedIds) || processedIds.length === 0) return true;

    // 1. Hapus langsung dari Upstash Redis Cloud
    try {
        let currentQueue = await redisDirectGet('axaxyz_wa_queue');
        if (Array.isArray(currentQueue)) {
            const idSet = new Set(processedIds);
            const remaining = currentQueue.filter(msg => !idSet.has(msg.id));
            await redisDirectSet('axaxyz_wa_queue', remaining);
        }
    } catch (e) { }

    // 2. Kirim juga request DELETE ke REST API jika tersedia
    try {
        await fetch(`${WEB_ABSENSI_API_URL}/wa`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ message_ids: processedIds })
        });
    } catch (e) { }

    return true;
}

// =========================================================================
// BAILEYS USYNC & SIGNAL KEYSTORE REVERSE RESOLVER (LID <-> PHONE)
// =========================================================================
async function resolveLidFromWhatsAppServer(sock, rawPhone) {
    const cleanPhone = formatToInternational(rawPhone);
    if (!cleanPhone || cleanPhone.length < 8) return null;

    if (phoneToLidMap.has(cleanPhone)) {
        return phoneToLidMap.get(cleanPhone);
    }

    try {
        if (sock && typeof sock.onWhatsApp === 'function') {
            const waCheck = await sock.onWhatsApp(cleanPhone);
            if (waCheck && waCheck.length > 0 && waCheck[0].lid) {
                const lid = String(waCheck[0].lid).replace(/\D/g, '');
                registerIdentityMapping(lid, cleanPhone);
                return lid;
            }
        }
    } catch (e) { }

    try {
        if (sock && typeof sock.query === 'function') {
            const usyncIqNode = {
                tag: 'iq',
                attrs: {
                    to: 's.whatsapp.net',
                    type: 'get',
                    xmlns: 'usync',
                },
                content: [
                    {
                        tag: 'usync',
                        attrs: {
                            sid: `usync-lid-${Date.now()}`,
                            mode: 'query',
                            last: 'true',
                            index: '0',
                            context: 'interactive',
                        },
                        content: [
                            {
                                tag: 'query',
                                attrs: {},
                                content: [
                                    { tag: 'contact', attrs: {} },
                                    { tag: 'lid', attrs: {} }
                                ]
                            },
                            {
                                tag: 'list',
                                attrs: {},
                                content: [
                                    {
                                        tag: 'user',
                                        attrs: { jid: `${cleanPhone}@s.whatsapp.net` }
                                    }
                                ]
                            }
                        ]
                    }
                ]
            };

            const res = await sock.query(usyncIqNode);
            if (res && res.content) {
                const extractLid = (node) => {
                    if (!node) return null;
                    if (node.tag === 'lid' && node.attrs && (node.attrs.val || node.attrs.jid)) {
                        return String(node.attrs.val || node.attrs.jid).replace(/\D/g, '');
                    }
                    if (Array.isArray(node.content)) {
                        for (const c of node.content) {
                            const found = extractLid(c);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                const foundLid = extractLid(res);
                if (foundLid) {
                    registerIdentityMapping(foundLid, cleanPhone);
                    return foundLid;
                }
            }
        }
    } catch (e) { }

    return null;
}

async function resolvePhoneFromLid(sock, rawLid) {
    const cleanLid = String(rawLid).replace(/\D/g, '');
    if (!cleanLid) return null;

    // 1. Cek cache memori (0ms)
    if (lidToPhoneMap.has(cleanLid)) {
        return lidToPhoneMap.get(cleanLid);
    }

    // 2. Cek Signal Repository dari Baileys jika ada
    try {
        if (sock?.signalRepository?.lidToJid) {
            const jidResult = await sock.signalRepository.lidToJid(`${cleanLid}@lid`);
            if (jidResult) {
                const p = formatToInternational(jidResult);
                if (p && p.length >= 8) {
                    registerIdentityMapping(cleanLid, p);
                    return p;
                }
            }
        }
    } catch (e) { }

    // 3. Query USYNC ke server WhatsApp
    try {
        if (sock && typeof sock.query === 'function') {
            const usyncNode = {
                tag: 'iq',
                attrs: {
                    to: 's.whatsapp.net',
                    type: 'get',
                    xmlns: 'usync',
                },
                content: [
                    {
                        tag: 'usync',
                        attrs: {
                            sid: `usync-rev-${Date.now()}`,
                            mode: 'query',
                            last: 'true',
                            index: '0',
                            context: 'interactive',
                        },
                        content: [
                            {
                                tag: 'query',
                                attrs: {},
                                content: [
                                    { tag: 'contact', attrs: {} },
                                    { tag: 'phone', attrs: {} }
                                ]
                            },
                            {
                                tag: 'list',
                                attrs: {},
                                content: [
                                    {
                                        tag: 'user',
                                        attrs: { jid: `${cleanLid}@lid` }
                                    }
                                ]
                            }
                        ]
                    }
                ]
            };

            const res = await sock.query(usyncNode);
            if (res && res.content) {
                const extractPhone = (node) => {
                    if (!node) return null;
                    if (node.attrs && (node.attrs.phone || node.attrs.jid)) {
                        const raw = node.attrs.phone || node.attrs.jid;
                        const p = formatToInternational(raw);
                        if (p && p.length >= 8 && p.length <= 15) return p;
                    }
                    if (Array.isArray(node.content)) {
                        for (const c of node.content) {
                            const found = extractPhone(c);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                const foundPhone = extractPhone(res);
                if (foundPhone) {
                    registerIdentityMapping(cleanLid, foundPhone);
                    return foundPhone;
                }
            }
        }
    } catch (e) { }

    return null;
}

// Pre-warming LID admin dan staf pengajar secara background
async function prewarmAdminAndOwnerLids(sock) {
    if (!sock) return;
    try {
        const adminPhones = ADMIN_JID_LIST.map(j => j.replace(/@.*$/, ''));
        for (const p of adminPhones) {
            const clean = formatToInternational(p);
            if (clean && !phoneToLidMap.has(clean)) {
                await resolveLidFromWhatsAppServer(sock, clean).catch(() => null);
            }
        }
    } catch (e) { }
}

// =========================================================================
// SMART VERIFIKASI MAHASISWA (DATABASE DEPT. RKG)
// =========================================================================
async function smartVerifyStudent(sock, senderInfo, messageText = "") {
    // 1. Cek di cache memori dulu
    let candidate = getCachedStudentObject(senderInfo.id);
    if (candidate) return candidate;

    // 2. Jika pengirim berupa LID, coba dapatkan nomor telepon aslinya
    let realPhone = null;
    if (senderInfo.isLid) {
        realPhone = await resolvePhoneFromLid(sock, senderInfo.id);
        if (realPhone) {
            candidate = getCachedStudentObject(realPhone);
            if (candidate) return candidate;
        }
    } else {
        realPhone = formatToInternational(senderInfo.id);
    }

    // 3. Query database mahasiswa dari Redis
    const allStudents = await callDbGet('axaxyz_students') || [];
    if (!Array.isArray(allStudents) || allStudents.length === 0) return null;

    // A. Cocokkan berdasarkan nomor telepon
    if (realPhone) {
        const matched = allStudents.find(s => {
            const sp = formatToInternational(s.phone);
            return sp && sp === realPhone;
        });
        if (matched) {
            cacheStudentObject(senderInfo.id, matched);
            cacheStudentObject(realPhone, matched);
            return matched;
        }
    }

    // B. Cek apakah pesan berisi NIM mahasiswa
    const inputNim = extractNimFromText(messageText);
    if (inputNim) {
        const matchedByNim = allStudents.find(s => String(s.nim).trim() === inputNim);
        if (matchedByNim) {
            // Auto-link nomor WA / LID ke mahasiswa tersebut jika nomornya belum terdaftar
            if (!matchedByNim.phone && realPhone) {
                matchedByNim.phone = realPhone;
                const updatedList = allStudents.map(s => s.id === matchedByNim.id ? matchedByNim : s);
                await callDbSet('axaxyz_students', updatedList);
            }
            cacheStudentObject(senderInfo.id, matchedByNim);
            if (realPhone) cacheStudentObject(realPhone, matchedByNim);
            return matchedByNim;
        }
    }

    return null;
}

// =========================================================================
// MULTI-TIER AI ENGINE (DEPT. RADIOLOGI KEDOKTERAN GIGI FKG UMI)
// =========================================================================

// Tier 1: 9Router VPS OpenAI-compatible Gateway (Prioritas Model: axyz-combos / gemini-flash)
async function ask9RouterRkg(conversationHistory, systemPromptText, aiConfig = {}) {
    const rawUrl = aiConfig.nineRouterUrl || process.env.NINEROUTER_URL || "http://43.134.43.146:20128/v1/chat/completions";
    const endpoint = normalize9RouterUrl(rawUrl);
    const apiKey = (aiConfig.nineRouterApiKey || process.env.NINEROUTER_API_KEY || "9router").trim().replace(/^["']|["']$/g, '');

    const primaryModel = sanitize9RouterModel(aiConfig.nineRouterModel || process.env.NINEROUTER_MODEL || 'axyz-combos');
    const fallbackModel = sanitize9RouterModel(aiConfig.nineRouterFallbackModel || process.env.NINEROUTER_FALLBACK_MODEL || 'gemini-2.5-flash');

    const modelsPipeline = [primaryModel, fallbackModel, 'auto'].filter((v, i, a) => v && a.indexOf(v) === i);

    const openAiMessages = [
        { role: "system", content: systemPromptText }
    ];

    for (const turn of conversationHistory) {
        const role = turn.role === 'model' ? 'assistant' : 'user';
        const text = turn.parts?.[0]?.text || '';
        if (text.trim()) {
            openAiMessages.push({ role, content: text.trim() });
        }
    }

    let lastError = null;

    for (const targetModel of modelsPipeline) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000);

        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    model: targetModel,
                    messages: openAiMessages,
                    temperature: 0.2,
                    max_tokens: 2048
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`[${targetModel}] ${res.status}: ${errText}`);
            }

            const data = await res.json();
            const reply = data.choices?.[0]?.message?.content;
            if (!reply || !reply.trim()) throw new Error(`[${targetModel}] Respon kosong`);

            return { reply: reply.trim(), resolvedModel: targetModel };
        } catch (err) {
            clearTimeout(timeoutId);
            lastError = err;
            console.warn(`[9Router AI Failover] Model ${targetModel} gagal: ${err.message}. Lanjut model berikutnya...`);
        }
    }

    throw lastError || new Error("Semua rute model 9Router gagal.");
}

// Tier 2: Google Gemini AI Direct (Cadangan 1)
async function askGeminiRkg(conversationHistory, systemPromptText, aiConfig = {}) {
    const apiKey = (aiConfig.geminiApiKey || process.env.GEMINI_API_KEY || "").trim();
    const model = aiConfig.geminiModel || process.env.GEMINI_MODEL || "gemini-2.5-flash";

    if (!apiKey) throw new Error("Gemini API Key belum terkonfigurasi di environment.");

    const contents = [];
    for (const turn of conversationHistory) {
        if (!turn.parts || !turn.parts[0] || !turn.parts[0].text) continue;
        const role = turn.role === 'model' ? 'model' : 'user';
        const text = String(turn.parts[0].text).trim();
        if (text) {
            contents.push({ role, parts: [{ text }] });
        }
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
        system_instruction: {
            parts: [{ text: systemPromptText }]
        },
        contents: contents,
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048
        }
    };

    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini Direct (${model}) ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const reply = candidate?.content?.parts?.[0]?.text;
    if (!reply || !reply.trim()) throw new Error("Respon kosong dari Google Gemini.");
    return reply.trim();
}

// Tier 3: Groq Cloud AI (Cadangan 2)
async function askGroqRkg(conversationHistory, systemPromptText, aiConfig = {}) {
    const groqKey = (aiConfig.groqApiKey || process.env.GROQ_API_KEY || "").trim();
    if (!groqKey) throw new Error("Groq API Key belum terpasang.");

    const groqMessages = [
        { role: "system", content: systemPromptText }
    ];

    for (const turn of conversationHistory) {
        const role = turn.role === 'model' ? 'assistant' : 'user';
        const text = turn.parts?.[0]?.text || '';
        if (text.trim()) {
            groqMessages.push({ role, content: text.trim() });
        }
    }

    const modelsToTry = [
        aiConfig.groqModel || "openai/gpt-oss-120b",
        ...GROQ_ALLOWED_MODELS
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    let lastGroqError = null;

    for (const model of modelsToTry) {
        try {
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${groqKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: model,
                    messages: groqMessages,
                    temperature: 0.2,
                    max_tokens: 2048
                })
            });

            if (!res.ok) {
                const errBody = await res.text();
                lastGroqError = new Error(`Groq (${model}) ${res.status}: ${errBody}`);
                continue;
            }

            const data = await res.json();
            const reply = data.choices?.[0]?.message?.content;
            if (reply && reply.trim()) {
                return reply.trim();
            }
        } catch (err) {
            lastGroqError = err;
        }
    }

    throw lastGroqError || new Error("Seluruh model Groq AI gagal merespon.");
}

// Unified Cascading AI (9Router -> Gemini -> Groq)
async function askAIRkgUnified(conversationHistory, studentContext = null, senderPushName = "Mahasiswa", senderInfo = null) {
    const wita = getWitaTimeGreeting();

    let studentProfile = "Identitas Belum Terdata (Belum memasukkan NIM resmi).";
    if (studentContext) {
        studentProfile = `Nama: ${studentContext.name}\n` +
            `NIM: ${studentContext.nim}\n` +
            `Kelompok Stase: ${studentContext.clusterId || studentContext.cluster || 'Belum Ditentukan'}\n` +
            `Status Perangkat (DeviceId): ${studentContext.deviceId ? 'Terkunci pada perangkat aktif' : 'Belum Terikat / Bebas'}`;
    }

    const systemPromptText = `Anda adalah Asisten Virtual Cerdas dan Helpdesk Resmi Departemen Radiologi Kedokteran Gigi (Dept. RKG) Fakultas Kedokteran Gigi Universitas Muslim Indonesia (FKG UMI).

[INFORMASI LOKAL & WAKTU REAL-TIME]:
- Waktu Lokal Makassar (WITA, UTC+8): ${wita.fullWitaStr}
- Sapaan Waktu Resmi Saat Ini: "${wita.greeting}"
- Portal Resmi Presensi Web: ${WEB_PORTAL_URL}

[PROFIL MAHASISWA PENGIRIM PESAN]:
- Nama Panggilan WhatsApp: ${senderPushName}
- WhatsApp ID: ${senderInfo ? senderInfo.id : '-'}
${studentProfile}

[TUGAS & TANGGUNG JAWAB]:
1. Memberikan informasi akurat seputar tata cara presensi web absensi Dept. RKG (jadwal sesi, jam toleransi keterlambatan, titik koordinat GPS kampus, dan syarat selfie).
2. Membantu mahasiswa jika mengalami kendala login, ganti perangkat (perintah !logout), atau memeriksa rekap kehadiran (!rekap).
3. Menjawab pertanyaan akademis seputar keilmuan Radiologi Kedokteran Gigi:
   - Teknik Radiografi Gigi: Periapikal (Paralel & Biseksi), Bite-Wing, Oklusal, Panoramik (OPG), Sefalometri, CBCT 3D.
   - Interpretasi Radiografi: Gambaran radiopak, radiolusen, mixed, lesi periapikal (abses, granuloma, kista radikuler), impaksi kaninus/molar ketiga (Klasifikasi Winter & Pell-Gregory), karies dentin/email.
   - Proteksi Radiasi: Prinsip ALARA (As Low As Reasonably Achievable), apron timbal, collimator, dosimeter saku.
4. Gaya Bahasa: Ramah, profesional, santun, akademis, menggunakan bahasa Indonesia formal yang hangat, dan selalu mengawali sapaan dengan "${wita.greeting}". Gunakan format bold WhatsApp (*teks*) dan poin-poin rapi agar mudah dibaca di layar HP.`;

    // 1. Coba Tier 1: 9Router VPS
    try {
        const res9 = await ask9RouterRkg(conversationHistory, systemPromptText);
        return enforceCorrectGreeting(res9.reply, wita.greeting);
    } catch (e1) {
        console.warn(`[Cascading AI] Tier 1 (9Router) gagal: ${e1.message}. Mencoba Tier 2 (Gemini)...`);
    }

    // 2. Coba Tier 2: Gemini Direct
    try {
        const resGemini = await askGeminiRkg(conversationHistory, systemPromptText);
        return enforceCorrectGreeting(resGemini, wita.greeting);
    } catch (e2) {
        console.warn(`[Cascading AI] Tier 2 (Gemini) gagal: ${e2.message}. Mencoba Tier 3 (Groq)...`);
    }

    // 3. Coba Tier 3: Groq Cloud
    try {
        const resGroq = await askGroqRkg(conversationHistory, systemPromptText);
        return enforceCorrectGreeting(resGroq, wita.greeting);
    } catch (e3) {
        console.error(`[Cascading AI] Tier 3 (Groq) gagal: ${e3.message}.`);
    }

    // Fallback Darurat Statis jika seluruh koneksi internet AI bermasalah
    return `*${wita.greeting}, Rekan Mahasiswa.* 🦷\n\n` +
        `Sistem AI Dept. RKG sedang mengalami peningkatan jaringan sementara.\n` +
        `Berikut perintah cepat yang dapat Anda gunakan:\n` +
        `• *!absen* : Panduan & status presensi harian\n` +
        `• *!jadwal* : Jadwal sesi praktikum hari ini\n` +
        `• *!lokasi* : Titik koordinat GPS radius kampus\n` +
        `• *!rekap* : Cek rekapitulasi kehadiran Anda\n` +
        `• *!logout* : Pelepasan kunci perangkat jika ganti HP\n\n` +
        `Portal Resmi: ${WEB_PORTAL_URL}`;
}

// =========================================================================
// AUTONOMOUS WITA ATTENDANCE SCHEDULER & ZERO-SPAM IN-MEMORY CRON ENGINE
// (Murni Berjalan di Bot WA, Nol Spam ke Redis, Beban Server Web 0%)
// =========================================================================
let cachedSessions = [];
let cachedGeofence = null;
let cachedFormats = [];
let lastKnownSessionsHash = "";
let lastKnownGeofenceHash = "";
const sentEventsToday = new Set();
const recentBroadcastMap = new Map();
let isSchedulerRunning = false;

// =========================================================================
// PERSISTENT DAILY EVENT LOCK DI UPSTASH REDIS CLOUD (24H TTL)
// Mencegah siaran sesi ganda/lampau saat bot restart di jam yang sudah jauh
// =========================================================================
async function loadSentEventsFromCloud(todayDateStr) {
    if (!todayDateStr) return;
    try {
        const cloudData = await redisDirectGet(`axaxyz_sent_events:${todayDateStr}`);
        if (Array.isArray(cloudData)) {
            cloudData.forEach(ev => sentEventsToday.add(ev));
        }
    } catch (e) {}
}

async function markCloudEventSent(todayDateStr, eventKey) {
    if (!todayDateStr || !eventKey) return;
    sentEventsToday.add(eventKey);
    try {
        const list = Array.from(sentEventsToday);
        await redisDirectSet(`axaxyz_sent_events:${todayDateStr}`, list, 86400); // TTL 24 Jam
    } catch (e) {}
}

// Format Template Fallback Darurat jika Redis lambat merespons
const fallbackFormatsMap = {
    1: "🔔 *NOTIFIKASI ABSENSI DIBUKA* 🔔\n\nHalo *[Nama Lengkap]*, sesi absensi untuk *[Shift]* Dept. RKG hari ini telah resmi *DIBUKA*.\n\n📋 *Detail Sesi Absensi:*\n• Kelompok: *[Kelompok]*\n• Jam Tepat Waktu: *[Jam Sesi]* WITA\n• Batas Tutup Sesi: *[Jam Tutup]* WITA\n\nYuk, segera lakukan validasi kehadiran Anda sekarang melalui portal resmi kami:\n[Link]\n\nSelamat bertugas! 🏥",
    2: "⚠️ *PENGINGAT TERAKHIR ABSENSI* ⚠️\n\nPanggilan kepada *[Nama Lengkap]*! Sistem mendeteksi Anda *BELUM* melakukan absensi untuk *[Shift]* hari ini.\n\nWaktu absensi Anda hampir habis. Sesi ini akan ditutup secara permanen pada pukul *[Jam Tutup]* WITA.\n\nMohon segera menuju area batas kampus dan selesaikan absen Anda di sini:\n[Link]",
    4: "📊 *STATUS AKHIR KEHADIRAN* 📊\n\nHalo *[Nama Lengkap]*, batas waktu absensi untuk *[Shift]* telah resmi *DITUTUP* pada pukul *[Jam Tutup]* WITA.\n\nBerikut adalah rekapan status kehadiran Anda untuk sesi ini:\n*[Status Kehadiran]*\n\nTransparansi data Anda bisa diakses kembali melalui:\n[Link]",
    8: "🔄 *INFO PERUBAHAN JADWAL ABSENSI* 🔄\n\nPerhatian *[Nama Lengkap]*, terdapat penyesuaian jadwal pada sistem absensi Dept. RKG untuk *[Shift]*.\n\nJadwal absensi terbaru Anda:\n⏳ Mulai Buka: *[Jam Sesi]* WITA\n⏳ Jam Berakhir: *[Jam Selesai]* WITA\n⏳ Batas Akhir Toleransi: *[Jam Tutup]* WITA\n\nMohon sesuaikan jam kedatangan Anda dengan jadwal terbaru ini.\nPortal Presensi: [Link]\nTerima kasih atas perhatiannya!",
    13: "📍 *PEMBARUAN TITIK LOKASI ABSENSI* 📍\n\nHalo rekan-rekan mahasiswa Dept. RKG!\nTerdapat pembaruan pada titik pusat radar Lokasi Absensi (Geofence) yang berlaku mulai hari ini.\n\n• Titik Lokasi Baru: *[Nama Lokasi Geofence]*\n• Jangkauan Radar: *[Radius]* Meter\n\nPastikan Anda berada di area gedung tersebut dan selalu mengizinkan akses GPS pada browser Anda sebelum melakukan absensi di: [Link]",
    22: "⏳ *PERINGATAN SISA WAKTU TOLERANSI* ⏳\n\nPerhatian *[Nama Lengkap]*! Waktu toleransi untuk *[Shift]* tersisa *[Sisa Waktu]* lagi.\n\nGerbang absensi akan ditutup permanen tepat pada pukul *[Jam Tutup]* WITA. Jika Anda belum menyelesaikan selfie lokasi, segera lakukan validasi sekarang di: [Link]"
};

function compileScenarioTemplate(templateStr, dataObj = {}) {
    if (!templateStr) return "";
    let compiled = templateStr
        .replace(/\[Nama Lengkap\]/g, dataObj.namaLengkap || '')
        .replace(/\[NIM\]/g, dataObj.nim || '')
        .replace(/\[Kelompok\]/g, dataObj.kelompok || '')
        .replace(/\[Shift\]/g, String(dataObj.shift || ''))
        .replace(/\[Jam Sesi\]/g, String(dataObj.jamSesi || ''))
        .replace(/\[Jam Selesai\]/g, String(dataObj.jamSelesai || dataObj.jamTutup || ''))
        .replace(/\[Jam Tutup\]/g, String(dataObj.jamTutup || ''))
        .replace(/\[Jam Absen\]/g, String(dataObj.jamAbsen || ''))
        .replace(/\[Sisa Waktu\]/g, String(dataObj.sisaWaktu || '15 Menit'))
        .replace(/\[Tanggal Mulai\]/g, String(dataObj.tanggalMulai || ''))
        .replace(/\[Tanggal Akhir\]/g, String(dataObj.tanggalAkhir || ''))
        .replace(/\[Tanggal\]/g, String(dataObj.tanggal || ''))
        .replace(/\[Password\]/g, String(dataObj.password || ''))
        .replace(/\[Pesan Custom\]/g, String(dataObj.pesanCustom || ''))
        .replace(/\[Radius\]/g, String(dataObj.radius || '50'))
        .replace(/\[Nama Lokasi Geofence\]/g, String(dataObj.lokasiGeofence || 'Gedung FKG UMI'))
        .replace(/\[Status Kehadiran\]/g, String(dataObj.statusKehadiran || 'Sesi Ditutup'))
        .replace(/\[Link\]/g, String(dataObj.link || WEB_PORTAL_URL));

    // Jaminan URL Mutlak: Selalu arahkan ke domain resmi dan bersihkan referensi localhost:3000
    if (compiled.includes('localhost:3000')) {
        compiled = compiled.replace(/http:\/\/localhost:3000/g, WEB_PORTAL_URL)
                           .replace(/localhost:3000/g, WEB_PORTAL_URL.replace(/^https?:\/\//, ''));
    }
    return compiled;
}

function calculateCloseTimeStr(eH, eM, tolMins = 0) {
    const total = Number(eH) * 60 + Number(eM) + Number(tolMins);
    const cH = Math.floor((total / 60) % 24);
    const cM = total % 60;
    return `${String(cH).padStart(2, '0')}:${String(cM).padStart(2, '0')}`;
}

// Refresh lambat data sesi & geofence dari Redis (Setiap 3 Menit)
// Menjamin Nol Spam Request ke Upstash Redis
async function refreshMemoryCacheFromRedis(forceReload = false) {
    try {
        const [sessions, geofence, formats] = await Promise.all([
            callDbGet('axaxyz_sessions'),
            callDbGet('axaxyz_geofence'),
            callDbGet('axaxyz_formats')
        ]);

        if (Array.isArray(sessions) && sessions.length > 0) {
            const newHash = JSON.stringify(sessions);
            lastKnownSessionsHash = newHash;
            cachedSessions = sessions;
        }

        if (geofence && typeof geofence === 'object') {
            const newGfHash = JSON.stringify(geofence);
            // Nonaktifkan auto-broadcast implisit Skenario 13 di background cache refresh
            // untuk mencegah false-positive pengiriman Skenario 13 saat sinkronisasi jadwal.
            lastKnownGeofenceHash = newGfHash;
            cachedGeofence = geofence;
        }

        if (Array.isArray(formats) && formats.length > 0) {
            cachedFormats = formats;
        }
    } catch (e) {
        // Abaikan error jaringan sementara
    }
}

// Broadcast skenario umum ke seluruh mahasiswa dengan throttling aman (350ms antar pesan)
async function broadcastScenarioToStudents(sock, scenarioId, dataObj = {}) {
    if (!isSocketReadyToSend(sock)) {
        return 0;
    }

    const [students, clusters] = await Promise.all([
        callDbGet('axaxyz_students'),
        callDbGet('axaxyz_clusters')
    ]);
    if (!Array.isArray(students) || students.length === 0) return 0;

    const clusterMap = new Map();
    if (Array.isArray(clusters)) {
        clusters.forEach(c => {
            if (c.id) clusterMap.set(c.id, c.name);
        });
    }

    let templateStr = fallbackFormatsMap[scenarioId] || "";
    if (cachedFormats && cachedFormats.length > 0) {
        const found = cachedFormats.find(f => f.id === scenarioId);
        if (found && found.template) templateStr = found.template;
    }

    let sentCount = 0;
    let alreadySentCooldownCount = 0;
    let validStudentsCount = 0;

    for (const st of students) {
        const phone = st.noHp || st.phone;
        if (!phone) continue;
        const cleanDigits = sanitizeNumber(phone);
        if (!cleanDigits) continue;
        validStudentsCount++;

        // Layer Deduplikasi 60 Detik (Mencegah pesan dobel dalam rentang waktu berdekatan)
        const dedupKey = `${cleanDigits}_${scenarioId}_${dataObj.shift || ''}`;
        const lastSent = recentBroadcastMap.get(dedupKey);
        if (lastSent && (Date.now() - lastSent) < 60000) {
            alreadySentCooldownCount++;
            continue;
        }

        const clusterName = clusterMap.get(st.clusterId) || st.clusterId || st.cluster || 'Radiologi Kedokteran Gigi';

        const textMsg = compileScenarioTemplate(templateStr, {
            ...dataObj,
            namaLengkap: st.name || '',
            nim: st.nim || '',
            kelompok: clusterName,
            password: st.password || '',
            link: WEB_PORTAL_URL
        });

        if (isSocketReadyToSend(sock)) {
            try {
                await sock.sendMessage(`${cleanDigits}@s.whatsapp.net`, {
                    text: formatForWhatsApp(textMsg)
                });
                recentBroadcastMap.set(dedupKey, Date.now());
                sentCount++;
            } catch (e) {
                console.error(`[Auto-Scheduler] ❌ Gagal kirim Baileys ke ${cleanDigits}:`, e.message);
            }
        }

        // Jeda 350ms antar kirim pesan untuk memproteksi sesi Baileys
        await new Promise(r => setTimeout(r, 350));
    }

    // ZERO-SPAM LOGGING: Hanya log jika benar-benar ada mahasiswa yang berhasil dikirimi pesan
    if (sentCount > 0) {
        console.log(`📢 [Auto-Scheduler WITA] ✅ Sukses memproses siaran Skenario ${scenarioId} ke ${sentCount} mahasiswa.`);
        return sentCount;
    }

    // Jika seluruh mahasiswa valid sudah menerima siaran dalam cooldown 60 detik,
    // kembalikan nilai sukses simbolik agar scheduler mengunci event hari ini dan tidak mengulang pengiriman
    if (validStudentsCount > 0 && alreadySentCooldownCount === validStudentsCount) {
        return validStudentsCount;
    }

    return 0;
}

// Broadcast khusus sisa toleransi (Skenario 22/2) kepada mahasiswa yang belum absen
async function broadcastWarningToUnloggedStudents(sock, session, closeStr) {
    if (!isSocketReadyToSend(sock)) {
        return 0;
    }

    const [students, logs, clusters] = await Promise.all([
        callDbGet('axaxyz_students'),
        callDbGet('axaxyz_logs'),
        callDbGet('axaxyz_clusters')
    ]);

    if (!Array.isArray(students) || students.length === 0) return 0;

    const clusterMap = new Map();
    if (Array.isArray(clusters)) {
        clusters.forEach(c => {
            if (c.id) clusterMap.set(c.id, c.name);
        });
    }

    const wita = getWitaTimeGreeting();
    const todayDateStr = wita.dateIso;

    // Filter mahasiswa yang sudah absen hari ini pada sesi ini
    const loggedNims = new Set();
    if (Array.isArray(logs)) {
        logs.forEach(l => {
            if (l.date === todayDateStr || (l.timestamp && l.timestamp.includes(todayDateStr))) {
                if (l.session === session.name || !l.session) {
                    loggedNims.add(l.nim);
                    if (l.studentId) loggedNims.add(l.studentId);
                }
            }
        });
    }

    const unloggedStudents = students.filter(st => !loggedNims.has(st.nim) && !loggedNims.has(st.id));
    if (unloggedStudents.length === 0) return 0;

    const targets = unloggedStudents;

    let templateStr = fallbackFormatsMap[22] || fallbackFormatsMap[2] || "";
    if (cachedFormats && cachedFormats.length > 0) {
        const found = cachedFormats.find(f => f.id === 22 || f.id === 2);
        if (found && found.template) templateStr = found.template;
    }

    let sentCount = 0;
    let alreadySentCooldownCount = 0;
    let validTargetsCount = 0;

    for (const st of targets) {
        const phone = st.noHp || st.phone;
        if (!phone) continue;
        const cleanDigits = sanitizeNumber(phone);
        if (!cleanDigits) continue;
        validTargetsCount++;

        const dedupKey = `${cleanDigits}_warn_${session.name || ''}`;
        const lastSent = recentBroadcastMap.get(dedupKey);
        if (lastSent && (Date.now() - lastSent) < 60000) {
            alreadySentCooldownCount++;
            continue;
        }

        const clusterName = clusterMap.get(st.clusterId) || st.clusterId || st.cluster || 'Radiologi Kedokteran Gigi';

        const textMsg = compileScenarioTemplate(templateStr, {
            shift: session.name,
            jamSesi: session.startTime || session.start,
            jamTutup: closeStr,
            sisaWaktu: "15 Menit",
            namaLengkap: st.name || '',
            nim: st.nim || '',
            kelompok: clusterName,
            link: WEB_PORTAL_URL
        });

        if (isSocketReadyToSend(sock)) {
            try {
                await sock.sendMessage(`${cleanDigits}@s.whatsapp.net`, {
                    text: formatForWhatsApp(textMsg)
                });
                recentBroadcastMap.set(dedupKey, Date.now());
                sentCount++;
            } catch (e) {
                console.error(`[Auto-Scheduler] ❌ Gagal kirim peringatan Baileys ke ${cleanDigits}:`, e.message);
            }
        }

        await new Promise(r => setTimeout(r, 350));
    }

    if (sentCount > 0) {
        console.log(`⏳ [Auto-Scheduler WITA] ⚠️ Sukses mengirim pengingat sisa waktu sesi [${session.name}] ke ${sentCount} mahasiswa belum absen.`);
        return sentCount;
    }

    if (validTargetsCount > 0 && alreadySentCooldownCount === validTargetsCount) {
        return validTargetsCount;
    }

    return 0;
}

// Broadcast otomatis saat koordinat geofence kampus diubah di Admin
async function broadcastGeofenceChange(sock, geofence) {
    if (!sock || !geofence) return;
    await broadcastScenarioToStudents(sock, 13, {
        lokasiGeofence: geofence.name || 'Gedung FKG Kampus 2 UMI',
        radius: String(geofence.radius || '50')
    });
}

// Broadcast otomatis saat jam shift sesi diubah di Admin
async function broadcastScheduleChange(sock, sessions) {
    if (!sock || !Array.isArray(sessions) || sessions.length === 0) return;
    const active = sessions.find(s => s.active || s.isActive !== false) || sessions[0];
    const tolMins = typeof active.toleranceMinutes === 'number' ? active.toleranceMinutes : 15;
    const [eH, eM] = (active.endTime || active.end || "16:00").split(':').map(Number);
    const closeStr = calculateCloseTimeStr(eH, eM, tolMins);

    await broadcastScenarioToStudents(sock, 8, {
        shift: active.name || active.title || 'Sesi Praktikum',
        jamSesi: active.startTime || active.start || '08:00',
        jamSelesai: active.endTime || active.end || '16:00',
        jamTutup: closeStr
    });
}

// Tick lokal dalam memori RAM (Dieksekusi setiap 30 detik tanpa spam request ke Redis)
let isEvaluatingTick = false;

async function autonomousWitaSchedulerTick(sock) {
    if (isEvaluatingTick) return;
    if (!sock || !isSocketReadyToSend(sock)) return;
    if (!Array.isArray(cachedSessions) || cachedSessions.length === 0) return;

    isEvaluatingTick = true;
    try {
        const wita = getWitaTimeGreeting();
        const currentTotalMin = wita.hours * 60 + parseInt(wita.minutes, 10);
        const todayDateStr = wita.dateIso;

        // Muat riwayat siaran hari ini dari Upstash Redis Cloud ke RAM (Kebal Reboot Railway)
        await loadSentEventsFromCloud(todayDateStr);

        for (const session of cachedSessions) {
            const isSessionActive = session.isActive !== undefined ? Boolean(session.isActive) : (session.active !== undefined ? Boolean(session.active) : true);
            if (!isSessionActive) continue;

            const startStr = session.startTime || session.start || "08:00";
            const endStr = session.endTime || session.end || "16:00";
            const tolMins = typeof session.toleranceMinutes === 'number' ? session.toleranceMinutes : 15;

            const [sH, sM] = startStr.split(':').map(Number);
            const [eH, eM] = endStr.split(':').map(Number);

            if (isNaN(sH) || isNaN(eH)) continue;

            const startMin = sH * 60 + sM;
            const closeMin = eH * 60 + eM + tolMins;
            const remainingMinutes = closeMin - currentTotalMin;
            const closeStr = calculateCloseTimeStr(eH, eM, tolMins);
            const sessionId = session.id || session.name || "default";

            const isSessionRunningNow = (currentTotalMin >= startMin && currentTotalMin <= closeMin);

            // 1. EVENT: PEMBUKAAN SESI PRESENSI (Skenario 1)
            // Jendela pemicuan KETAT: Hanya dalam 5 menit pertama sejak jam buka (startMin s/d startMin + 5)
            // Mencegah siaran pembukaan jika bot baru online puluhan menit setelah jam buka
            const openEventKey = `open_${todayDateStr}_${sessionId}_${startStr}`;
            const isOpeningJustNow = (currentTotalMin >= startMin && currentTotalMin <= startMin + 5);
            if (isOpeningJustNow) {
                if (!sentEventsToday.has(openEventKey)) {
                    const sent = await broadcastScenarioToStudents(sock, 1, {
                        shift: session.name,
                        jamSesi: startStr,
                        jamSelesai: endStr,
                        jamTutup: closeStr
                    }).catch(e => {
                        console.error('[Auto-Scheduler Error Skenario 1]', e.message);
                        return 0;
                    });
                    if (sent > 0) {
                        await markCloudEventSent(todayDateStr, openEventKey);
                    }
                }
            }

            // 2. EVENT: PERINGATAN SISA WAKTU TOLERANSI 15 MENIT (Skenario 22 / Skenario 2)
            // Jendela pemicuan: Hanya saat sesi sedang berjalan dan sisa toleransi antara 1 s/d 15 menit
            const warnEventKey = `warn_${todayDateStr}_${sessionId}_${startStr}`;
            const isWarningWindow = (isSessionRunningNow && remainingMinutes <= 15 && remainingMinutes >= 1);
            if (isWarningWindow) {
                if (!sentEventsToday.has(warnEventKey)) {
                    const sent = await broadcastWarningToUnloggedStudents(sock, session, closeStr).catch(e => {
                        console.error('[Auto-Scheduler Error Skenario 22]', e.message);
                        return 0;
                    });
                    if (sent > 0) {
                        await markCloudEventSent(todayDateStr, warnEventKey);
                    }
                }
            }

            // 3. EVENT: PENUTUPAN SESI RESMI (Skenario 4)
            // Jendela pemicuan KETAT: HANYA dalam rentang 2 menit pasca batas penutupan (closeMin s/d closeMin + 2)
            // Sesi yang sudah tutup berjam-jam lalu (seperti Shift Pagi/Siang saat bot reboot jam 16:27) 100% DIABAIKAN!
            const closeEventKey = `close_${todayDateStr}_${sessionId}_${closeStr}`;
            const isClosingJustNow = (currentTotalMin >= closeMin && currentTotalMin <= closeMin + 2);
            if (isClosingJustNow) {
                if (!sentEventsToday.has(closeEventKey)) {
                    const sent = await broadcastScenarioToStudents(sock, 4, {
                        shift: session.name,
                        jamTutup: closeStr,
                        statusKehadiran: "Sesi telah resmi ditutup."
                    }).catch(e => {
                        console.error('[Auto-Scheduler Error Skenario 4]', e.message);
                        return 0;
                    });
                    if (sent > 0) {
                        await markCloudEventSent(todayDateStr, closeEventKey);
                    }
                }
            }
        }
    } finally {
        isEvaluatingTick = false;
    }
}

// Inisialisasi Mesin Scheduler Otonom (Hanya di Bot WA)
function startAutonomousAttendanceScheduler(sock) {
    currentSock = sock; // Pastikan currentSock selalu diperbarui ke instance aktif terbaru
    if (isSchedulerRunning) return;
    isSchedulerRunning = true;

    console.log("⏰ [Auto-Scheduler WITA] Mesin cron penjadwal presensi otonom AKTIF (Memory-First, Zero-Spam Redis, 30s Local Ticker).");

    // Inisialisasi cache memori pertama kali & jalankan evaluasi jika socket sudah siap
    refreshMemoryCacheFromRedis().then(() => {
        if (currentSock && isSocketReadyToSend(currentSock)) {
            autonomousWitaSchedulerTick(currentSock).catch(() => {});
        } else {
            console.log("⏰ [Auto-Scheduler WITA] Cache sesi termuat di RAM. Menunggu socket Baileys open sebelum evaluasi jadwal perdana.");
        }
    }).catch(() => {});

    // Refresh lambat data sesi & geofence dari Redis setiap 3 Menit (180.000 ms)
    setInterval(() => {
        refreshMemoryCacheFromRedis().catch(() => {});
    }, 180000);

    // Pengecekan jam WITA lokal murni di memori RAM setiap 30 detik (Nol request Redis)
    setInterval(() => {
        if (currentSock && isSocketReadyToSend(currentSock)) {
            autonomousWitaSchedulerTick(currentSock).catch(() => {});
        }
    }, 30000);
}

// =========================================================================
// BACKGROUND WORKER: DISPATCHER ANTRIAN OUTBOX CLOUD (axaxyz_wa_queue)
// =========================================================================
let isOutboxWorkerRunning = false;
let currentSock = null;

function startOutboxQueueWorker(sock) {
    currentSock = sock; // Pastikan currentSock selalu diperbarui ke instance aktif terbaru
    if (isOutboxWorkerRunning) return;
    isOutboxWorkerRunning = true;

    console.log("🚀 [Outbox Worker] Background dispatcher antrian pesan WhatsApp Web Absensi V7 AKTIF (Interval 5s, Direct Cloud Redis, Auto-Purge Stale >10m).");

    // Startup Sweep: Bersihkan antrean usang (>10 menit) saat worker pertama kali aktif
    (async () => {
        try {
            const rawQueue = await redisDirectGet('axaxyz_wa_queue');
            if (Array.isArray(rawQueue) && rawQueue.length > 0) {
                const now = Date.now();
                const staleIds = [];
                const freshQueue = [];
                for (const qItem of rawQueue) {
                    const qTime = qItem.created_at ? new Date(qItem.created_at).getTime() : (qItem.timestamp ? new Date(qItem.timestamp).getTime() : 0);
                    if (qTime > 0 && (now - qTime > 10 * 60 * 1000)) {
                        staleIds.push(qItem.id);
                    } else {
                        freshQueue.push(qItem);
                    }
                }
                if (staleIds.length > 0) {
                    console.log(`[Outbox Worker] 🧹 Startup Sweep: Menghapus ${staleIds.length} pesan usang/kadaluarsa (>10m) dari antrean Redis.`);
                    await redisDirectSet('axaxyz_wa_queue', freshQueue);
                }
            }
        } catch (e) {}
    })();

    setInterval(async () => {
        if (!currentSock || !isSocketReadyToSend(currentSock)) return;

        try {
            const pendingMessages = await callWaPull();
            if (!Array.isArray(pendingMessages) || pendingMessages.length === 0) return;

            const processedIds = [];

            for (const item of pendingMessages) {
                try {
                    // Cek sinyal kontrol instan (SYNC_SCHEDULE) dari Web Dashboard
                    if (item.type === 'SYNC_SCHEDULE' || item.action === 'reload_sessions') {
                        try {
                            await refreshMemoryCacheFromRedis(true);
                            if (currentSock && isSocketReadyToSend(currentSock)) {
                                await autonomousWitaSchedulerTick(currentSock);
                            }
                        } catch (syncErr) {
                            console.error("[Live-Trigger Error]", syncErr.message);
                        } finally {
                            // Selalu acknowledge item sinyal kontrol agar antrean bersih dan tidak memicu perulangan
                            processedIds.push(item.id);
                        }
                        continue;
                    }

                    // Ekstraksi nomor tujuan yang fleksibel (target_number / phone / targetJid / to)
                    const rawTarget = item.target_number || item.phone || item.targetJid || item.target || item.to || '';
                    // Ekstraksi pesan (formatted_message / message / text)
                    let rawMessage = item.formatted_message || item.message || item.text || '';

                    if (!rawTarget || !rawMessage) {
                        processedIds.push(item.id);
                        continue;
                    }

                    // 1. FILTER UMUR PESAN (STALENESS GUARD): Hapus pesan jika usianya sudah > 10 menit
                    const itemTime = item.created_at ? new Date(item.created_at).getTime() : (item.timestamp ? new Date(item.timestamp).getTime() : 0);
                    if (itemTime > 0 && (Date.now() - itemTime > 10 * 60 * 1000)) {
                        console.log(`[Outbox Worker] 🗑️ Menghapus antrean kadaluarsa (>10 menit) ID: ${item.id}, Target: ${rawTarget}, Waktu: ${item.created_at || item.timestamp}`);
                        processedIds.push(item.id);
                        continue;
                    }

                    let targetJid = String(rawTarget).trim();
                    if (!targetJid.includes('@')) {
                        const cleanDigits = formatToInternational(targetJid) || sanitizeNumber(targetJid);
                        if (!cleanDigits) {
                            processedIds.push(item.id);
                            continue;
                        }
                        targetJid = `${cleanDigits}@s.whatsapp.net`;
                    }

                    // 2. DYNAMIC URL SANITIZER: Otomatis ubah localhost:3000 menjadi domain resmi
                    if (rawMessage.includes('localhost:3000')) {
                        rawMessage = rawMessage.replace(/http:\/\/localhost:3000/g, WEB_PORTAL_URL)
                                               .replace(/localhost:3000/g, WEB_PORTAL_URL.replace(/^https?:\/\//, ''));
                    }

                    // 3. Filter deduplikasi outbox 60 detik
                    const outboxDedupKey = `${targetJid}_${rawMessage.slice(0, 50)}`;
                    const lastOutboxSent = recentBroadcastMap.get(outboxDedupKey);
                    if (lastOutboxSent && (Date.now() - lastOutboxSent) < 60000) {
                        console.log(`[Outbox Worker] ⏭️ Menghapus item duplikat antrian ke ${targetJid} (cooldown 60s aktif).`);
                        processedIds.push(item.id);
                        continue;
                    }
                    recentBroadcastMap.set(outboxDedupKey, Date.now());

                    // Pastikan socket masih siap sebelum sendMessage
                    if (!isSocketReadyToSend(currentSock)) {
                        console.warn(`[Outbox Worker] ⏳ Socket Baileys belum siap / disconnected saat memproses antrean outbox. Menunda pengiriman.`);
                        break;
                    }

                    // Kirim pesan WhatsApp melalui Baileys
                    await currentSock.sendMessage(targetJid, {
                        text: formatForWhatsApp(rawMessage)
                    });

                    processedIds.push(item.id);
                    console.log(`[Outbox Worker] ✅ Sukses mengirim notifikasi ke ${targetJid} (ID: ${item.id})`);
                } catch (sendErr) {
                    console.error(`[Outbox Worker] ❌ Gagal mengirim pesan ID ${item.id}:`, sendErr.message);
                }
            }

            // Hapus batch pesan yang telah berhasil diproses dari Upstash Redis Cloud
            if (processedIds.length > 0) {
                await callWaAcknowledge(processedIds);
                console.log(`[Outbox Worker] 🗑️ Berhasil menghapus ${processedIds.length} pesan terproses dari antrian cloud.`);
            }
        } catch (workerErr) {
            // Silently ignore temporary network glitch
        }
    }, 5000);
}

// =========================================================================
// UNIVERSAL MESSAGE HANDLER ENTRY POINT (COMPATIBLE DENGAN SEMUA RUNNER)
// =========================================================================
async function messageHandler(sock) {
    currentSock = sock;

    // Pasang pendengar siklus hidup koneksi Baileys (memastikan kesiapan otentikasi)
    if (sock?.ev && typeof sock.ev.on === 'function') {
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update || {};
            if (connection === 'open') {
                currentSock = sock;
                console.log("🌐 [Baileys Socket] Status KONEKSI: OPEN & TEROTENTIKASI (Siap kirim pesan WA) ✅");
                try {
                    await autonomousWitaSchedulerTick(sock);
                } catch (tickErr) {
                    console.error("[Baileys Post-Connect Tick Error]", tickErr.message);
                }
            }
        });
    }

    // 1. Inisialisasi background dispatcher antrian outbox Web Absensi V7
    startOutboxQueueWorker(sock);

    // 2. Inisialisasi mesin cron penjadwal presensi otonom berbasis WITA (Zero-Spam Redis)
    startAutonomousAttendanceScheduler(sock);

    // 3. Pre-warming LID admin di latar belakang
    setTimeout(() => {
        prewarmAdminAndOwnerLids(sock);
    }, 2000);

    // 3. Pasang pendengar event messages.upsert Baileys
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages?.[0];
            if (!msg || !msg.message) return;
            if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid) return;

            // Abaikan grup WhatsApp & pesan broadcast massal
            if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) {
                return;
            }

            const senderInfo = parseSenderInfo(remoteJid);
            const pushName = msg.pushName || "Rekan Mahasiswa";

            // Ekstraksi isi teks pesan (Conversation, Extended Text, atau Caption Gambar)
            const textContent = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                "";

            const trimmedText = textContent.trim();
            if (!trimmedText && !msg.message.imageMessage && !msg.message.stickerMessage) return;

            // Tangani pembuatan stiker jika diminta
            if (handleStickerCommand && (trimmedText.startsWith('#sticker') || trimmedText.startsWith('.s') || trimmedText.startsWith('!s') || trimmedText.startsWith('!sticker') || (msg.message.imageMessage && trimmedText.toLowerCase() === 'sticker'))) {
                try {
                    await handleStickerCommand(sock, msg, senderInfo.targetJid);
                    return;
                } catch (stkErr) {
                    console.error('[Sticker Handler Error]', stkErr);
                }
            }

            // Tampilkan indikator mengetik di WhatsApp
            try {
                await sock.sendPresenceUpdate('composing', senderInfo.targetJid);
            } catch (e) { }

            // Verifikasi identitas mahasiswa dari database Redis
            const studentObj = await smartVerifyStudent(sock, senderInfo, trimmedText);
            const intent = detectStudentIntent(trimmedText);
            const isAdmin = ADMIN_JID_LIST.some(adminJid => {
                const adminId = adminJid.replace(/@.*$/, '');
                return senderInfo.id.includes(adminId);
            });

            // =====================================================================
            // ROUTING PERINTAH INTERAKTIF
            // =====================================================================
            switch (intent) {
                case 'menu': {
                    const wita = getWitaTimeGreeting();
                    const greetingLine = studentObj
                        ? `Halo, *${studentObj.name}* (*${studentObj.nim}*) - Kelompok *${studentObj.clusterId || studentObj.cluster || '-'}*`
                        : `Halo, *${pushName}*!`;

                    const menuText = `🏛️ *PUSAT LAYANAN RESMI DEPT. RADIOLOGI KEDOKTERAN GIGI*\n` +
                        `*Fakultas Kedokteran Gigi - Universitas Muslim Indonesia*\n\n` +
                        `${wita.greeting}! ${greetingLine}\n\n` +
                        `Berikut adalah daftar perintah interaktif bot presensi:\n\n` +
                        `📋 *PERINTAH MAHASISWA:*\n` +
                        `• *!absen* : Cek status & countdown presensi hari ini\n` +
                        `• *!jadwal* : Jadwal live & jam operasional sesi praktikum\n` +
                        `• *!lokasi* : Koordinat GPS resmi kampus (Geofence)\n` +
                        `• *!rekap* : Ringkasan kehadiran stase Anda\n` +
                        `• *!kalender* : Jadwal kalender akademik & hari libur\n` +
                        `• *!logout* : Pelepasan ikatan perangkat (jika ganti HP)\n` +
                        `• *!sesi* : Detail teknis data sesi praktikum terkini\n` +
                        `• *!reset* : Reset percakapan dengan Asisten AI RKG\n\n` +
                        (isAdmin ? `👑 *PERINTAH ADMINISTRATOR:*\n• *!sync* : Muat ulang jadwal sesi seketika dari Redis Cloud\n• *!broadcast <teks>* : Kirim pengumuman ke semua mahasiswa\n• *!broadcastjadwal* : Broadcast jadwal sesi terbaru ke semua mahasiswa\n• *!stats* : Rekapitulasi kehadiran harian\n• *!ping* : Cek latensi dan status bot\n\n` : '') +
                        `💬 *Tanya Jawab AI:*\n` +
                        `Anda dapat langsung mengetikkan pertanyaan seputar radiografi gigi, interpretasi lesi, SOP stase, atau kendala portal.\n\n` +
                        `🌐 *Portal Web Absensi:* ${WEB_PORTAL_URL}`;

                    await sock.sendMessage(senderInfo.targetJid, { text: menuText });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'absen': {
                    const wita = getWitaTimeGreeting();
                    const rawSessions = await callDbGet('axaxyz_sessions') || [];
                    const enriched = Array.isArray(rawSessions)
                        ? rawSessions.map(s => enrichSessionWithWitaStatus(s, wita.hours, parseInt(wita.minutes, 10)))
                        : [];

                    const activeRunning = enriched.find(s => s.isRunningNow);
                    const upcoming = enriched.find(s => s.isUpcoming);

                    let sessionStatus = "";
                    if (activeRunning) {
                        sessionStatus = `🟢 *SESI PRESENSI SEDANG DIBUKA!*\n` +
                            `• *Nama Sesi:* ${activeRunning.name}\n` +
                            `• *Jam Operasional:* ${activeRunning.startStr} - ${activeRunning.endStr} WITA\n` +
                            `• *Batas Akhir Presensi (Toleransi):* ${activeRunning.closingTimeStr} WITA\n` +
                            `• *Sisa Waktu:* ⏳ *${activeRunning.remainingMinutes} Menit Tersisa!* Segera lakukan presensi sekarang!`;
                    } else if (upcoming) {
                        sessionStatus = `🟡 *SESI BELUM DIBUKA*\n` +
                            `Sesi berikutnya (*${upcoming.name}*) akan dibuka pada pukul *${upcoming.startStr} WITA* (kurang lebih ${upcoming.minutesToStart} menit lagi).\n` +
                            `_Silakan bersiap di area kampus FKG sebelum sesi dibuka._`;
                    } else {
                        sessionStatus = `🔴 *TIDAK ADA SESI AKTIF SAAT INI*\n` +
                            `Sesi praktikum saat ini belum dibuka atau telah berakhir pada jam ${wita.timeStr}.\n` +
                            `Ketik *!jadwal* untuk melihat seluruh agenda sesi praktikum hari ini.`;
                    }

                    const absenText = `📝 *PANDUAN & STATUS PRESENSI DEPT. RKG*\n` +
                        `*Fakultas Kedokteran Gigi - Universitas Muslim Indonesia*\n\n` +
                        `⏰ *Waktu Sekarang:* ${wita.fullWitaStr}\n\n` +
                        `${sessionStatus}\n\n` +
                        `📌 *Langkah Melakukan Presensi:*\n` +
                        `1. Pastikan GPS HP Anda aktif dengan akurasi tinggi.\n` +
                        `2. Buka portal resmi: ${WEB_PORTAL_URL}\n` +
                        `3. Masukkan NIM Anda dan ambil foto selfie verifikasi di lokasi kampus.\n` +
                        `4. Klik tombol *Kirim Absensi*.\n\n` +
                        `_Catatan: Presensi wajib dilakukan di dalam radius geofence resmi gedung kampus FKG UMI._`;

                    await sock.sendMessage(senderInfo.targetJid, { text: absenText });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'jadwal': {
                    const wita = getWitaTimeGreeting();
                    const rawSessions = await callDbGet('axaxyz_sessions') || [];
                    if (!Array.isArray(rawSessions) || rawSessions.length === 0) {
                        await sock.sendMessage(senderInfo.targetJid, {
                            text: "⚠️ *BELUM ADA JADWAL SESI*\n\nSaat ini belum ada data jadwal sesi praktikum yang terdaftar di portal web."
                        });
                        return;
                    }

                    const enriched = rawSessions.map(s => enrichSessionWithWitaStatus(s, wita.hours, parseInt(wita.minutes, 10)));
                    const activeRunning = enriched.find(s => s.isRunningNow);
                    const upcoming = enriched.find(s => s.isUpcoming);

                    let scheduleList = `📅 *JADWAL SESI & WAKTU PRESENSI DEPT. RKG*\n` +
                        `*Fakultas Kedokteran Gigi - Universitas Muslim Indonesia*\n\n` +
                        `⏰ *Waktu Saat Ini:* ${wita.timeStr}\n` +
                        `📆 *Hari & Tanggal:* ${wita.fullWitaStr.split(' Pukul ')[0]}\n\n`;

                    if (activeRunning) {
                        scheduleList += `🟢 *SESI SEDANG BERLANGSUNG:*\n` +
                            `• *${activeRunning.name}*\n` +
                            `• Jam Sesi: *${activeRunning.startStr} - ${activeRunning.endStr} WITA*\n` +
                            `• Batas Toleransi: *${activeRunning.closingTimeStr} WITA*\n` +
                            `• Sisa Waktu: *⏳ ${activeRunning.remainingMinutes} Menit Lagi!*\n\n`;
                    } else if (upcoming) {
                        scheduleList += `🟡 *SESI BERIKUTNYA SEGERA DIBUKA:*\n` +
                            `• *${upcoming.name}*\n` +
                            `• Jam Sesi: *${upcoming.startStr} - ${upcoming.endStr} WITA*\n` +
                            `• Mulai dalam: *${upcoming.minutesToStart} menit lagi*\n\n`;
                    } else {
                        scheduleList += `⚪ *STATUS:* Saat ini tidak ada sesi praktikum yang sedang berlangsung.\n\n`;
                    }

                    scheduleList += `📋 *DAFTAR SELURUH SESI PRAKTIKUM:*\n`;
                    enriched.forEach((s, idx) => {
                        let badge = s.isRunningNow ? "🟢 [SEDANG BUKA]" : (s.isUpcoming ? "🟡 [SEGERA BUKA]" : (s.active ? "🔴 [SELESAI]" : "⚪ [NON-AKTIF]"));
                        scheduleList += `${idx + 1}. *${s.name}* ${badge}\n` +
                            `   • Jam Sesi: ${s.startStr} - ${s.endStr} WITA\n` +
                            `   • Batas Toleransi: ${s.closingTimeStr} WITA\n`;
                    });
                    scheduleList += `\n🌐 *Portal Absensi:* ${WEB_PORTAL_URL}\n` +
                        `_Ketik *!absen* untuk panduan & status presensi langsung._`;

                    await sock.sendMessage(senderInfo.targetJid, { text: scheduleList });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'sesi': {
                    const rawSessions = await callDbGet('axaxyz_sessions') || [];
                    const wita = getWitaTimeGreeting();
                    const enriched = Array.isArray(rawSessions)
                        ? rawSessions.map(s => enrichSessionWithWitaStatus(s, wita.hours, parseInt(wita.minutes, 10)))
                        : [];

                    const jsonStr = JSON.stringify(enriched, null, 2);
                    const displayText = `📋 *DATA JSON SESI PRAKTIKUM (WITA: ${wita.timeStr})*\n\n` +
                        `\`\`\`json\n${jsonStr.length > 1500 ? jsonStr.substring(0, 1490) + '...\n}' : jsonStr}\`\`\``;

                    await sock.sendMessage(senderInfo.targetJid, { text: displayText });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'lokasi': {
                    const gf = await callDbGet('axaxyz_geofence');
                    if (!gf) {
                        await sock.sendMessage(senderInfo.targetJid, { text: "⚠️ Titik koordinat lokasi kampus belum dikonfigurasi di database." });
                        return;
                    }

                    const mapsUrl = `https://www.google.com/maps?q=${gf.lat},${gf.lng}`;
                    const locText = `📍 *TITIK KOORDINAT GEOFENCE RESMI KAMPUS*\n\n` +
                        `🏢 *Nama Lokasi:* ${gf.name || 'Gedung FKG Kampus Pusat'}\n` +
                        `🌐 *Koordinat GPS:* \`${gf.lat}, ${gf.lng}\`\n` +
                        `🎯 *Radius Maksimal:* *${gf.radius} Meter*\n` +
                        `🗺️ *Tautan Google Maps:* ${mapsUrl}\n\n` +
                        `_Pastikan GPS pada perangkat Anda aktif dan memiliki tingkat akurasi tinggi saat membuka portal web._`;

                    await sock.sendMessage(senderInfo.targetJid, { text: locText });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'rekap': {
                    if (!studentObj) {
                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `⚠️ Nomor WhatsApp Anda (*${senderInfo.id}*) belum terhubung dengan akun mahasiswa Dept. RKG.\n` +
                                `Silakan kirimkan pesan berupa *NIM Anda* (contoh: \`16120200021\`) untuk mengaitkan akun Anda terlebih dahulu.`
                        });
                        return;
                    }

                    const logs = await callDbGet('axaxyz_logs') || [];
                    const myLogs = logs.filter(l => l.nim === studentObj.nim || l.studentId === studentObj.id);

                    const hadirTepat = myLogs.filter(l => l.status === 'Hadir' || l.status === 'Tepat Waktu').length;
                    const terlambat = myLogs.filter(l => l.status === 'Terlambat').length;
                    const alfa = myLogs.filter(l => l.status === 'Alfa' || l.status === 'Tidak Hadir').length;

                    const rekapText = `📊 *REKAPITULASI KEHADIRAN MAHASISWA*\n\n` +
                        `👤 *Nama:* ${studentObj.name}\n` +
                        `🔢 *NIM:* ${studentObj.nim}\n` +
                        `🏷️ *Kelompok Stase:* ${studentObj.clusterId || studentObj.cluster || '-'}\n\n` +
                        `📈 *Statistik Kehadiran:*\n` +
                        `• Hadir Tepat Waktu: *${hadirTepat}* Sesi ✅\n` +
                        `• Terlambat: *${terlambat}* Sesi 🟡\n` +
                        `• Tidak Hadir (Alfa): *${alfa}* Sesi ❌\n` +
                        `• Total Log Terdata: *${myLogs.length}* Rekaman\n\n` +
                        `Lihat riwayat presensi detail di: ${WEB_PORTAL_URL}`;

                    await sock.sendMessage(senderInfo.targetJid, { text: rekapText });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'logout': {
                    if (!studentObj) {
                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `⚠️ Akun mahasiswa Anda belum terdata. Silakan ketik NIM Anda terlebih dahulu.`
                        });
                        return;
                    }

                    // Reset deviceId di database Redis
                    const allStudents = await callDbGet('axaxyz_students') || [];
                    const updated = allStudents.map(st => {
                        if (st.id === studentObj.id || st.nim === studentObj.nim) {
                            return { ...st, deviceId: null };
                        }
                        return st;
                    });

                    await callDbSet('axaxyz_students', updated);
                    cacheStudentObject(studentObj.nim, { ...studentObj, deviceId: null });

                    const logoutMsg = `🔓 *PELEPASAN PERANGKAT (LOGOUT) BERHASIL*\n\n` +
                        `Halo *${studentObj.name}* (*${studentObj.nim}*),\n` +
                        `Kunci perangkat (DeviceId) pada akun presensi Anda telah berhasil direset.\n\n` +
                        `Anda sekarang dapat melakukan login dan presensi kembali menggunakan perangkat/browser baru di: ${WEB_PORTAL_URL}`;

                    await sock.sendMessage(senderInfo.targetJid, { text: logoutMsg });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'kalender': {
                    const holidays = await callDbGet('axaxyz_holidays') || [];
                    if (holidays.length === 0) {
                        await sock.sendMessage(senderInfo.targetJid, { text: "📅 Belum ada agenda libur khusus atau jadwal penyesuaian di kalender akademik." });
                        return;
                    }

                    let holidayText = `📅 *AGENDA LIBUR & PENYESUAIAN STASE RKG*\n\n`;
                    holidays.slice(0, 10).forEach((h, idx) => {
                        holidayText += `${idx + 1}. *${h.date}* : ${h.description || h.name}\n`;
                    });
                    holidayText += `\nPortal Absensi: ${WEB_PORTAL_URL}`;

                    await sock.sendMessage(senderInfo.targetJid, { text: holidayText });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'reset': {
                    userSessions.delete(senderInfo.id);
                    await sock.sendMessage(senderInfo.targetJid, {
                        text: "🔄 *Memori sesi percakapan Anda telah direset bersih.* Silakan ajukan pertanyaan atau perintah baru!"
                    });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                case 'broadcast': {
                    if (!isAdmin) {
                        await sock.sendMessage(senderInfo.targetJid, { text: "⛔ Perintah ini hanya dapat diakses oleh Staf Pengajar / Administrator Dept. RKG." });
                        return;
                    }

                    const broadcastContent = trimmedText.replace(/^!broadcast\s+/i, '').trim();
                    if (!broadcastContent) {
                        await sock.sendMessage(senderInfo.targetJid, { text: "⚠️ Format salah. Gunakan: `!broadcast <isi pesan pengumuman>`" });
                        return;
                    }

                    const allStudents = await callDbGet('axaxyz_students') || [];
                    const targets = allStudents.filter(s => s.phone);

                    if (targets.length === 0) {
                        await sock.sendMessage(senderInfo.targetJid, { text: "⚠️ Tidak ditemukan mahasiswa yang memiliki nomor telepon terdaftar." });
                        return;
                    }

                    let sentCount = 0;
                    const wita = getWitaTimeGreeting();
                    const formattedAnnouncement = `📢 *PENGUMUMAN RESMI DEPT. RADIOLOGI KEDOKTERAN GIGI*\n` +
                        `*Fakultas Kedokteran Gigi - Universitas Muslim Indonesia*\n\n` +
                        `${broadcastContent}\n\n` +
                        `_Diumumkan pada: ${wita.fullWitaStr}_\n` +
                        `_Portal Presensi: ${WEB_PORTAL_URL}_`;

                    for (const st of targets) {
                        const cleanDigits = sanitizeNumber(st.phone);
                        if (cleanDigits) {
                            try {
                                await sock.sendMessage(`${cleanDigits}@s.whatsapp.net`, { text: formattedAnnouncement });
                                sentCount++;
                            } catch (e) { }
                        }
                    }

                    await sock.sendMessage(senderInfo.targetJid, {
                        text: `✅ *Broadcast Berhasil Dikirim!*\nTotal terkirim: *${sentCount}* mahasiswa dari total ${targets.length} data.`
                    });
                    return;
                }

                case 'broadcastjadwal': {
                    if (!isAdmin) {
                        await sock.sendMessage(senderInfo.targetJid, { text: "⛔ Perintah ini hanya dapat diakses oleh Staf Pengajar / Administrator Dept. RKG." });
                        return;
                    }

                    const wita = getWitaTimeGreeting();
                    const rawSessions = await callDbGet('axaxyz_sessions') || [];
                    const allStudents = await callDbGet('axaxyz_students') || [];
                    const targets = allStudents.filter(s => s.phone);

                    if (targets.length === 0) {
                        await sock.sendMessage(senderInfo.targetJid, { text: "⚠️ Tidak ditemukan mahasiswa yang memiliki nomor telepon terdaftar." });
                        return;
                    }

                    let sessionDetail = "";
                    if (rawSessions.length > 0) {
                        sessionDetail = rawSessions.map((s, idx) => {
                            const tol = s.calculatedClosingTime || s.lateLimit || s.endTime || s.end;
                            return `${idx + 1}. *${s.name || s.title}* (${s.active ? '🟢 Aktif' : '⚪ Non-Aktif'}):\n` +
                                `   • Jam Sesi: ${s.startTime || s.start} - ${s.endTime || s.end} WITA\n` +
                                `   • Batas Toleransi: ${tol} WITA`;
                        }).join('\n\n');
                    } else {
                        sessionDetail = "Belum ada sesi praktikum terdaftar di database portal.";
                    }

                    const formattedAnnouncement = `📢 *PENGUMUMAN JADWAL PRESENSI PRAKTIKUM DEPT. RKG*\n` +
                        `*Fakultas Kedokteran Gigi - Universitas Muslim Indonesia*\n\n` +
                        `Yth. Seluruh Rekan Mahasiswa Preklinik/Klinik RKG,\n` +
                        `Berikut adalah update susunan jam sesi praktikum terbaru yang berlaku:\n\n` +
                        `${sessionDetail}\n\n` +
                        `⏰ *Diperbarui pada:* ${wita.fullWitaStr}\n` +
                        `🌐 *Portal Web Absensi:* ${WEB_PORTAL_URL}\n\n` +
                        `_Mohon hadir tepat waktu dan melakukan presensi di dalam radius lokasi resmi kampus FKG UMI._`;

                    let sentCount = 0;
                    for (const st of targets) {
                        const cleanDigits = sanitizeNumber(st.phone);
                        if (cleanDigits) {
                            try {
                                await sock.sendMessage(`${cleanDigits}@s.whatsapp.net`, { text: formattedAnnouncement });
                                sentCount++;
                            } catch (e) { }
                        }
                    }

                    await sock.sendMessage(senderInfo.targetJid, {
                        text: `✅ *Broadcast Jadwal Berhasil Dikirim!*\nTotal terkirim: *${sentCount}* mahasiswa dari total ${targets.length} data.`
                    });
                    return;
                }

                case 'stats': {
                    if (!isAdmin) {
                        await sock.sendMessage(senderInfo.targetJid, { text: "⛔ Perintah ini hanya dapat diakses oleh Administrator Dept. RKG." });
                        return;
                    }

                    const students = await callDbGet('axaxyz_students') || [];
                    const logs = await callDbGet('axaxyz_logs') || [];

                    const totalHadir = logs.filter(l => l.status === 'Hadir' || l.status === 'Tepat Waktu').length;
                    const totalTerlambat = logs.filter(l => l.status === 'Terlambat').length;

                    const statsText = `📈 *STATISTIK KEHADIRAN HARIAN DEPT. RKG*\n\n` +
                        `👥 *Total Mahasiswa Terdata:* ${students.length} Orang\n` +
                        `✅ *Total Hadir Tepat Waktu:* ${totalHadir} Sesi\n` +
                        `🟡 *Total Terlambat:* ${totalTerlambat} Sesi\n` +
                        `📊 *Total Akumulasi Log:* ${logs.length} Data\n\n` +
                        `Dashboard Lengkap: ${WEB_PORTAL_URL}`;

                    await sock.sendMessage(senderInfo.targetJid, { text: statsText });
                    return;
                }

                case 'ping': {
                    const startTime = Date.now();
                    await callDbGet('axaxyz_geofence');
                    const latency = Date.now() - startTime;

                    const pingText = `⚡ *STATUS BOT ABSENSI DEPT. RKG*\n\n` +
                        `• *Status Koneksi:* Online & Terhubung 🟢\n` +
                        `• *Latensi Upstash Redis Cloud:* ${latency}ms\n` +
                        `• *Node.js Runtime:* ${process.version} (${os.platform()} ${os.arch()})\n` +
                        `• *Penggunaan RAM Heap:* ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\n` +
                        `• *Portal Absensi Web:* ${WEB_PORTAL_URL}`;

                    await sock.sendMessage(senderInfo.targetJid, { text: pingText });
                    return;
                }

                case 'sync': {
                    await refreshMemoryCacheFromRedis(true);
                    if (sock && isSocketReadyToSend(sock)) {
                        await autonomousWitaSchedulerTick(sock);
                    }
                    const count = Array.isArray(cachedSessions) ? cachedSessions.length : 0;
                    await sock.sendMessage(senderInfo.targetJid, {
                        text: `⚡ *SINKRONISASI JADWAL SUKSES* ⚡\n\nJadwal sesi praktikum berhasil dimuat ulang langsung dari Upstash Redis Cloud.\n• *Total Sesi Terkonfigurasi:* ${count}\n• *Scheduler WITA:* Telah dievaluasi ulang untuk sesi aktif saat ini.\n• *Beban Server:* 0% (In-Memory RAM Engine).`
                    });
                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }
            }

            // =====================================================================
            // ASISTEN AI VIRTUAL DEPT. RKG (PERCAKAPAN AKADEMIK & KENDALA MAHASISWA)
            // =====================================================================
            cleanExpiredSessions();

            let session = userSessions.get(senderInfo.id);
            if (!session) {
                session = { history: [], lastActivity: Date.now() };
                userSessions.set(senderInfo.id, session);
            }
            session.lastActivity = Date.now();

            session.history.push({
                role: 'user',
                parts: [{ text: trimmedText }]
            });

            // Batasi panjang histori percakapan (maksimal 10 putaran)
            if (session.history.length > 20) {
                session.history = session.history.slice(-20);
            }

            const aiReply = await askAIRkgUnified(session.history, studentObj, pushName, senderInfo);

            session.history.push({
                role: 'model',
                parts: [{ text: aiReply }]
            });

            const formattedReply = formatForWhatsApp(aiReply);
            await sock.sendMessage(senderInfo.targetJid, { text: formattedReply });
            await sock.sendPresenceUpdate('paused', senderInfo.targetJid);

        } catch (error) {
            console.error('[Error Pemrosesan Pesan WhatsApp]', error);
        }
    });
}

// =========================================================================
// UNIVERSAL EXPORTS & RUNTIME GLOBAL DECLARATIONS
// (Mencegah ReferenceError: messageHandler is not defined di Semua Lingkungan)
// =========================================================================
export default messageHandler;
export { messageHandler, messageHandler as setupMessageHandler };

if (typeof globalThis !== 'undefined') {
    globalThis.messageHandler = messageHandler;
    globalThis.setupMessageHandler = messageHandler;
}
if (typeof global !== 'undefined') {
    global.messageHandler = messageHandler;
    global.setupMessageHandler = messageHandler;
}
