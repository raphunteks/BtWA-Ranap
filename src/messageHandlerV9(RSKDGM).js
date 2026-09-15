import fs from 'fs';
import process from 'process';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// Handler perintah eksternal pendukun
import handleStickerCommand from './commands/sticker.js';

// =========================================================================
// KONFIGURASI SISTEM & REST API GOOGLE APPS SCRIPT (SIMGOS RSKDGM)
// =========================================================================
const ownerNumber = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

// URL REST API SIMGOS RSKDGM (Utama: Vercel Ultra-Fast Engine, Fallback: Google Apps Script)
const SIMGOS_API_URL = process.env.SIMGOS_API_URL || process.env.GAS_URL_SIMGOS || "https://rskdgmsimgosdb.vercel.app/api";
const GAS_URL_SIMGOS = SIMGOS_API_URL;

// Kontak WhatsApp Dokter Cadangan jika Setting Belum Terisi
const DOKTER_JID_LIST = [
    "6282291675363@s.whatsapp.net", // drg. Hj. Kurniawaty, Sp.KG (DPJP Utama)
    "6285256739684@s.whatsapp.net"  // drg. M. Aksa Arsyad
];

// Model fallback Groq AI yang diizinkan
const GROQ_ALLOWED_MODELS = [
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
    "groq/compound",
    "groq/compound-mini"
];

// Normalisasi URL Endpoint 9Router VPS
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

// Sanitizer Cerdas Nama Model (Membersihkan string kurung yang merusak URL Google)
function sanitize9RouterModel(rawModel) {
    let model = String(rawModel || 'auto').trim();
    // Hilangkan tanda kurung beserta isinya seperti (high), (low), (preview)
    model = model.replace(/\s*\([^)]*\)/g, '').trim();
    // Hilangkan awalan berulang jika ada
    if (model.startsWith('gemini/gemini/')) {
        model = model.replace('gemini/gemini/', 'gemini/');
    }
    return model || 'auto';
}

// =========================================================================
// SMART BIDIRECTIONAL RESOLVER & PERSISTENT CACHE (TTL 24 JAM)
// =========================================================================
const sessionPath = './session';
const lidCacheFile = `${sessionPath}/lid_mappings.json`;
const patientCacheFile = `${sessionPath}/patient_cache.json`;

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

const lidToPhoneMap = new Map();     // Kunci: LID Digits -> Nilai: Phone Digits (628xxx)
const phoneToLidMap = new Map();     // Kunci: Phone Digits (628xxx) -> Nilai: LID Digits
const patientCacheMap = new Map();   // Kunci: Phone Digits / LID Digits / No. RM -> { data, cachedAt }

const PATIENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 Jam penuh untuk siklus kontrol pasien

function formatToInternational(raw) {
    if (!raw && raw !== 0) return '';
    let p = String(raw).trim().replace(/\D/g, '');
    if (p.startsWith('0')) p = '62' + p.substring(1);
    else if (p.startsWith('8')) p = '62' + p;
    else if (!p.startsWith('62') && p.length >= 8) p = '62' + p;
    return p;
}

if (fs.existsSync(lidCacheFile)) {
    try {
        const savedMappings = JSON.parse(fs.readFileSync(lidCacheFile, 'utf-8'));
        for (const [lid, phone] of Object.entries(savedMappings.lidToPhone || {})) {
            lidToPhoneMap.set(lid, phone);
        }
        for (const [phone, lid] of Object.entries(savedMappings.phoneToLid || {})) {
            phoneToLidMap.set(phone, lid);
        }
    } catch (e) { }
}

if (fs.existsSync(patientCacheFile)) {
    try {
        const savedPatients = JSON.parse(fs.readFileSync(patientCacheFile, 'utf-8'));
        const now = Date.now();
        for (const [k, v] of Object.entries(savedPatients)) {
            if (v && v.cachedAt && (now - v.cachedAt < PATIENT_CACHE_TTL_MS)) {
                patientCacheMap.set(k, v);
            }
        }
    } catch (e) { }
}

function persistLidMappings() {
    try {
        const data = {
            lidToPhone: Object.fromEntries(lidToPhoneMap),
            phoneToLid: Object.fromEntries(phoneToLidMap)
        };
        fs.writeFileSync(lidCacheFile, JSON.stringify(data, null, 2));
    } catch (e) { }
}

let persistPatientTimer = null;
function persistPatientCache() {
    if (persistPatientTimer) clearTimeout(persistPatientTimer);
    persistPatientTimer = setTimeout(() => {
        try {
            const obj = Object.fromEntries(patientCacheMap);
            fs.writeFileSync(patientCacheFile, JSON.stringify(obj, null, 2));
        } catch (e) { }
    }, 1000);
}

function registerIdentityMapping(lidDigits, phoneDigits) {
    if (!lidDigits || !phoneDigits) return;
    const cleanLid = String(lidDigits).replace(/\D/g, '');
    const cleanPhone = formatToInternational(phoneDigits);

    if (cleanLid && cleanPhone && cleanLid !== cleanPhone) {
        lidToPhoneMap.set(cleanLid, cleanPhone);
        phoneToLidMap.set(cleanPhone, cleanLid);
        persistLidMappings();
    }
}

function cachePatientObject(key, patientObj) {
    if (!key || !patientObj) return;
    const cleanKey = String(key).replace(/\D/g, '') || String(key).trim();
    patientCacheMap.set(cleanKey, {
        data: patientObj,
        cachedAt: Date.now()
    });
    persistPatientCache();
}

function getCachedPatientObject(key) {
    if (!key) return null;
    const cleanKey = String(key).replace(/\D/g, '') || String(key).trim();
    if (!patientCacheMap.has(cleanKey)) return null;
    const item = patientCacheMap.get(cleanKey);
    if (Date.now() - item.cachedAt > PATIENT_CACHE_TTL_MS) {
        patientCacheMap.delete(cleanKey);
        persistPatientCache();
        return null;
    }
    return item.data;
}

function parseSenderInfo(rawJid) {
    if (!rawJid) return { rawJid: '', id: '', isLid: false, targetJid: '', resolvedPhone: '', resolvedLid: '' };
    const jidStr = String(rawJid).trim();
    const isLid = jidStr.toLowerCase().endsWith('@lid');
    const isGroup = jidStr.toLowerCase().endsWith('@g.us');
    const isBroadcast = jidStr.toLowerCase().includes('broadcast');

    const cleanId = jidStr.replace(/@(lid|s\.whatsapp\.net|broadcast|g\.us)$/i, '').replace(/\D/g, '');

    let targetJid = jidStr;
    let resolvedPhone = '';
    let resolvedLid = '';

    if (isLid) {
        targetJid = `${cleanId}@lid`;
        resolvedLid = cleanId;
        if (lidToPhoneMap.has(cleanId)) {
            resolvedPhone = lidToPhoneMap.get(cleanId);
        }
    } else if (!isGroup && !isBroadcast) {
        let phone = formatToInternational(cleanId);
        targetJid = `${phone}@s.whatsapp.net`;
        resolvedPhone = phone;
        if (phoneToLidMap.has(phone)) {
            resolvedLid = phoneToLidMap.get(phone);
        }
    }

    return {
        rawJid: jidStr,
        id: cleanId,
        isLid: isLid,
        targetJid: targetJid,
        resolvedPhone: resolvedPhone,
        resolvedLid: resolvedLid
    };
}

function sanitizeNumber(rawNumber) {
    if (!rawNumber) return '';
    const str = String(rawNumber).trim();
    if (str.toLowerCase().endsWith('@lid')) {
        return str.replace(/\D/g, '') + '@lid';
    }
    let cleaned = str.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
    return formatToInternational(cleaned) + '@s.whatsapp.net';
}

function formatForWhatsApp(text) {
    if (!text) return '';
    let formatted = String(text);
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');
    formatted = formatted.replace(/^###\s*(.*)$/gm, '\n*$1*');
    formatted = formatted.replace(/^##\s*(.*)$/gm, '\n*$1*');
    formatted = formatted.replace(/^#\s*(.*)$/gm, '\n*$1*');
    formatted = formatted.replace(/^[\*\-]\s+(.*)$/gm, '• $1');
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    return formatted.trim();
}

function getWitaTimeGreeting() {
    const now = new Date();
    const hourStr = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Makassar',
        hour: 'numeric',
        hour12: false
    }).format(now);
    const hour = parseInt(hourStr, 10);

    let greeting = "Selamat malam";
    if (hour >= 4 && hour < 11) {
        greeting = "Selamat pagi";
    } else if (hour >= 11 && hour < 15) {
        greeting = "Selamat siang";
    } else if (hour >= 15 && hour < 18) {
        greeting = "Selamat sore";
    } else {
        greeting = "Selamat malam";
    }

    const fullWitaStr = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Makassar',
        dateStyle: 'full',
        timeStyle: 'medium'
    }).format(now) + " WITA";

    return { hour, greeting, fullWitaStr };
}

function enforceCorrectGreeting(text, correctGreeting) {
    if (!text) return text;
    return text.replace(/\b(selamat\s+(pagi|siang|sore|malam))\b/gi, correctGreeting);
}

function compileTemplateText(templateStr, patient, sysCfg) {
    if (!templateStr) return "";
    return templateStr
        .replace(/{NAMA_PASIEN}/g, patient?.namaPasien || "-")
        .replace(/{NO_RM}/g, patient?.noRm || "-")
        .replace(/{TGL_KONTROL}/g, patient?.tglKontrol || "-")
        .replace(/{TGL_MASUK}/g, patient?.tglMasuk || "-")
        .replace(/{UMUR}/g, patient?.umur || "-")
        .replace(/{AGAMA}/g, patient?.agama || "-")
        .replace(/{JENIS_KELAMIN}/g, patient?.jenisKelamin || "-")
        .replace(/{NO_WA}/g, patient?.noHp || "-")
        .replace(/{NO_SENDER}/g, patient?.noSender || "-")
        .replace(/{NO_LID}/g, patient?.noLid || "-")
        .replace(/{TGL_RESCHEDULE}/g, patient?.tglReschedule || "-")
        .replace(/{STATUS_RESCHEDULE}/g, patient?.statusReschedule || "-")
        .replace(/{STATUS_RUJUKAN}/g, patient?.statusRujukan || "Rujukan Habis")
        .replace(/{DPJP_UTAMA}/g, sysCfg.dpjpUtama || "drg. Hj. Kurniawaty, Sp.KG")
        .replace(/{DPJP_PENDAMPING}/g, sysCfg.dpjpPendamping || "drg. M. Aksa Arsyad")
        .replace(/{NAMA_INSTANSI}/g, sysCfg.instansi || "RSKD Gigi dan Mulut Prov. Sulsel")
        .replace(/{POLI_KLINIK}/g, sysCfg.poli || "Poli Konservasi dan Endodonsi");
}

// =========================================================================
// CACHE CERDAS: PROMPT, TEMPLATES & KREDENSIAL AI
// =========================================================================
let cachedSystemConfig = {
    prompt: '',
    templates: {},
    instansi: 'RSKD Gigi dan Mulut Prov. Sulsel',
    poli: 'Poli Konservasi dan Endodonsi',
    dpjpUtama: 'drg. Hj. Kurniawaty, Sp.KG',
    dpjpUtamaWa: '6282291675363',
    dpjpPendamping: 'drg. M. Aksa Arsyad',
    geminiApiKey: '',
    geminiModel: 'gemini-3.5-flash',
    groqApiKey: '',
    groqModel: 'openai/gpt-oss-120b',
    nineRouterUrl: normalize9RouterUrl(process.env.NINEROUTER_URL),
    nineRouterApiKey: (process.env.NINEROUTER_API_KEY || '9router').trim().replace(/^["']|["']$/g, ''),
    nineRouterModel: sanitize9RouterModel(process.env.NINEROUTER_MODEL || 'gemini-3.8-flash'),
    nineRouterFallbackModel: sanitize9RouterModel(process.env.NINEROUTER_FALLBACK_MODEL || 'ag/gemini-3.8-flash-high'),
    doctors: [],
    delayChat: 60,
    timestamp: 0
};
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

const conversationSessions = new Map();
const SESSION_TTL_MS = 45 * 60 * 1000;

const settingsFile = `${sessionPath}/settings.json`;

let botSettings = {
    autoFollowupSimgos: false,
    autoFollowupHour: "08",
    autoFollowupMinute: "30",
    lastAutoFollowupDate: ""
};

if (fs.existsSync(settingsFile)) {
    try {
        botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) };
    } catch (e) { }
}

function saveSettings() {
    fs.writeFileSync(settingsFile, JSON.stringify(botSettings, null, 2));
}

// DAFTAR PERINTAH RESMI BOT RSKDGM (GUARDED SET AGAR TIDAK DIJAWAB OLEH AI)
const BOT_COMMAND_SET = new Set([
    'menu', 'help',
    'test9router', 'ping9router', 'cek9router',
    'converstalltolid', 'convertalltolid', 'syncalllid', 'syncalldb', 'synclids', 'syncpasien',
    'reschedulepx', 'rescheduleterbatalkan',
    'cekrujukanaktif', 'rujukanaktif',
    'cekrujukanhabis', 'rujukanhabis',
    'bindpasien', 'linkpasien',
    'followupnow', 'follownow',
    'setjamfollowup',
    'followup', 'cekfollowup',
    'gassfollowup', 'kirimfollowup', 'gass',
    'caripasien',
    'reschedule',
    'statskontrol', 'statssimgos',
    'settingssimgos',
    'templatesimgos',
    'autofollowup',
    'setdelaychat', 'setdelay', 'delaychat',
    'fixsender', 'syncsender',
    'getprompt',
    'clearpromptcache',
    'ping',
    'runtime',
    'sticker', 's'
]);

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [phone, session] of conversationSessions.entries()) {
        if (now - session.lastSeen > SESSION_TTL_MS) {
            conversationSessions.delete(phone);
        }
    }
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000);

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60);
    const h = Math.floor(seconds / 3600);
    const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} hari lalu`;
    if (h > 0) return `${h} jam lalu`;
    if (m > 0) return `${m} menit lalu`;
    return `${Math.floor(seconds)} detik lalu`;
}

function extractDateFromText(text) {
    if (!text) return null;
    const t = text.trim();

    const isoMatch = t.match(/\b(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
    if (isoMatch) {
        const y = isoMatch[1];
        const m = String(isoMatch[2]).padStart(2, '0');
        const d = String(isoMatch[3]).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    const dmyMatch = t.match(/\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\b/);
    if (dmyMatch) {
        const d = String(dmyMatch[1]).padStart(2, '0');
        const m = String(dmyMatch[2]).padStart(2, '0');
        const y = dmyMatch[3];
        return `${y}-${m}-${d}`;
    }

    const monthMap = {
        'januari': '01', 'jan': '01',
        'februari': '02', 'feb': '02',
        'maret': '03', 'mar': '03',
        'april': '04', 'apr': '04',
        'mei': '05',
        'juni': '06', 'jun': '06',
        'juli': '07', 'jul': '07',
        'agustus': '08', 'ags': '08', 'agt': '08',
        'september': '09', 'sep': '09',
        'oktober': '10', 'okt': '10',
        'november': '11', 'nov': '11',
        'desember': '12', 'des': '12'
    };

    const idMatch = t.match(/\b(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?\b/);
    if (idMatch) {
        const d = String(idMatch[1]).padStart(2, '0');
        const mName = idMatch[2].toLowerCase();
        const y = idMatch[3] || '2026';
        if (monthMap[mName]) {
            return `${y}-${monthMap[mName]}-${d}`;
        }
    }

    return null;
}

function detectPatientIntent(rawText) {
    const text = rawText.trim().toLowerCase();

    const jknCancelPattern1 = /\b(terbatalkan|batal|dibatalkan)\b.*\b(mobile\s*jkn|jkn|aplikasi|bpjs|sistem)\b/i;
    const jknCancelPattern2 = /\b(mobile\s*jkn|jkn)\b.*\b(terbatalkan|batal|dibatalkan)\b/i;
    const jknExactPhrase = /saya\s*terbatalkan\s*(di\s*aplikasi)?\s*mobile\s*jkn/i;

    if (jknExactPhrase.test(text) || jknCancelPattern1.test(text) || jknCancelPattern2.test(text)) {
        return { type: 'TERBATALKAN_JKN' };
    }

    const wrongPersonPattern = /\b(salah\s*orang|bukan\s*saya|salah\s*nomor|salah\s*ki|salah\s*kirim|salah\s*target|tidak\s*pernah\s*(ke|periksa|daftar))\b/i;
    if (wrongPersonPattern.test(text)) {
        return { type: 'SALAH_ORANG' };
    }

    const isNegative = /\b(tidak|nggak|engga|gak|gk|belum|batal)\s*(bisa|hadir|datang|ikut|boleh)?\b/i.test(text);

    const hadirPattern = /\b(hadir|bisa\s*(dok|kak|min|hadir|datang|ikut|ia|ya)?|boleh\s*(dok|kak|min)?|siap\s*(dok|kak|min|hadir|datang)?|oke\s*(dok|kak|min)?|ok\s*(dok|kak|min)?|baik\s*(dok|kak|min)?|insya\s*allah\s*(bisa|hadir|datang)?|datang|dateng|ikut)\b/i;

    if (!isNegative && hadirPattern.test(text) && !text.includes('reschedule') && !text.includes('ganti') && !text.includes('undur')) {
        return { type: 'HADIR' };
    }

    const reschedPattern = /\b(reschedule|reschedole|rescedule|riscedul|rescedul|jadwal ulang|ganti jadwal|ubah jadwal|undur|mundur|tunda|ganti hari|pindah hari|ganti tanggal|pindah tanggal)\b/i;
    const extractedDate = extractDateFromText(text);

    if (isNegative || reschedPattern.test(text)) {
        return {
            type: 'RESCHEDULE',
            date: extractedDate
        };
    }

    if (extractedDate && text.length <= 30) {
        return {
            type: 'RESCHEDULE',
            date: extractedDate
        };
    }

    return { type: 'GENERAL' };
}

// CLIENT REST API GAS SIMGOS
async function callSimgosApi(action, params = {}) {
    const query = new URLSearchParams({ action, ...params }).toString();
    const url = `${GAS_URL_SIMGOS}?${query}`;

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await fetch(url, {
                method: "GET",
                redirect: "follow",
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
            });

            const rawText = await res.text();

            if (!rawText || rawText.trim().startsWith("<")) {
                throw new Error(`Google Apps Script mengembalikan halaman HTML. Pastikan Web App di-deploy dengan akses 'Anyone'.`);
            }

            const jsonData = JSON.parse(rawText);
            if (jsonData.status === "error") {
                throw new Error(jsonData.message || "GAS Server Error");
            }

            return jsonData;
        } catch (err) {
            lastError = err;
            if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
        }
    }

    throw new Error(`Gagal komunikasi dengan API SIMGOS: ${lastError.message}`);
}

async function callSimgosPost(payload = {}) {
    try {
        const res = await fetch(GAS_URL_SIMGOS, {
            method: "POST",
            redirect: "follow",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (err) {
        return { status: "error", message: err.message };
    }
}

async function fetchSystemAIConfig() {
    const now = Date.now();
    if (cachedSystemConfig.prompt && cachedSystemConfig.geminiApiKey && (now - cachedSystemConfig.timestamp < CONFIG_CACHE_TTL_MS)) {
        return cachedSystemConfig;
    }

    try {
        const res = await callSimgosApi("get_active_prompt");
        if (res && res.status === "success") {
            cachedSystemConfig = {
                prompt: res.activePrompt || cachedSystemConfig.prompt,
                templates: res.templates || cachedSystemConfig.templates,
                instansi: res.config?.instansi || "RSKD Gigi dan Mulut Prov. Sulsel",
                poli: res.config?.poli || cachedSystemConfig.poli,
                dpjpUtama: res.config?.doctors?.[0]?.name || "drg. Hj. Kurniawaty, Sp.KG",
                dpjpUtamaWa: res.config?.doctors?.[0]?.wa || "6282291675363",
                dpjpPendamping: res.config?.doctors?.[1]?.name || "drg. M. Aksa Arsyad",
                geminiApiKey: res.aiConfig?.geminiApiKey || cachedSystemConfig.geminiApiKey,
                geminiModel: res.aiConfig?.geminiModel || "gemini-3.5-flash",
                groqApiKey: res.aiConfig?.groqApiKey || cachedSystemConfig.groqApiKey,
                groqModel: res.aiConfig?.groqModel || "openai/gpt-oss-120b",
                nineRouterUrl: normalize9RouterUrl(process.env.NINEROUTER_URL || res.aiConfig?.nineRouterUrl || cachedSystemConfig.nineRouterUrl),
                nineRouterApiKey: (process.env.NINEROUTER_API_KEY || res.aiConfig?.nineRouterApiKey || cachedSystemConfig.nineRouterApiKey || '9router').trim().replace(/^["']|["']$/g, ''),
                nineRouterModel: sanitize9RouterModel(process.env.NINEROUTER_MODEL || res.aiConfig?.nineRouterModel || cachedSystemConfig.nineRouterModel || 'gemini-3.8-flash'),
                nineRouterFallbackModel: sanitize9RouterModel(process.env.NINEROUTER_FALLBACK_MODEL || res.aiConfig?.nineRouterFallbackModel || cachedSystemConfig.nineRouterFallbackModel || 'ag/gemini-3.8-flash-high'),
                doctors: res.config?.doctors || [],
                delayChat: parseInt(res.config?.delayChat || res.delay_chat || cachedSystemConfig.delayChat || 60, 10),
                timestamp: now
            };
            return cachedSystemConfig;
        }
    } catch (e) { }

    return cachedSystemConfig;
}

// USYNC LID RESOLVER
async function resolveLidFromWhatsAppServer(sock, rawPhone) {
    const cleanPhone = formatToInternational(rawPhone);
    if (!cleanPhone || cleanPhone.length < 8) return null;

    try {
        const waCheck = await sock.onWhatsApp(cleanPhone);
        if (waCheck && waCheck.length > 0 && waCheck[0].lid) {
            return String(waCheck[0].lid).replace(/\D/g, '');
        }
    } catch (e) { }

    try {
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
            if (foundLid) return foundLid;
        }
    } catch (errUsync) { }

    return null;
}

// REVERSE RESOLVER (LID -> PHONE NUMBER)
async function resolvePhoneFromLid(sock, rawLid) {
    const cleanLid = String(rawLid).replace(/\D/g, '');
    if (!cleanLid) return null;

    // 1. Cek memory map terlebih dahulu (0ms)
    if (lidToPhoneMap.has(cleanLid)) {
        return lidToPhoneMap.get(cleanLid);
    }

    // 2. Cek Signal Repository dari Baileys jika tersedia
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
    } catch (e) { }

    return null;
}

// PRE-WARMING DOKTER & OWNER
async function prewarmDoctorAndOwnerLids(sock) {
    try {
        const sysCfg = await fetchSystemAIConfig();
        const phoneCandidates = [
            ownerNumber,
            ...(sysCfg.doctors || []).map(d => d.wa),
            "6282291675363",
            "6285256739684"
        ].map(p => formatToInternational(p)).filter(Boolean);

        for (const phone of phoneCandidates) {
            if (!phoneToLidMap.has(phone)) {
                try {
                    const lid = await resolveLidFromWhatsAppServer(sock, phone);
                    if (lid) {
                        registerIdentityMapping(lid, phone);
                        console.log(`[Identity Pre-warm] ${phone} <-> ${lid}@lid`);
                    }
                } catch (e) { }
            }
        }
    } catch (e) { }
}

// CONVERT ALL PATIENTS TO LID & SAVE TO COLUMN 18 (NO LID)
async function convertAllPatientsToLid(sock, forceAll = false) {
    console.log(`[Auto-Converter] Memulai konversi satu-satu No WA ke Kolom 18 (No LID)...`);
    try {
        const actionToCall = forceAll ? "get_all_patient_phones" : "get_unlinked_patients";
        const res = await callSimgosApi(actionToCall);

        if (res.status !== "success" || !Array.isArray(res.data) || res.data.length === 0) {
            console.log(`[Auto-Converter] Semua pasien di spreadsheet telah memiliki No LID resmi.`);
            return { total: 0, matched: 0 };
        }

        const patientList = res.data;
        console.log(`[Auto-Converter] Memproses ${patientList.length} pasien untuk konversi LID resmi...`);

        const batchUpdates = [];
        let matchedCount = 0;

        for (const p of patientList) {
            const phoneFull = formatToInternational(p.cleanPhone || p.noHp);
            if (!phoneFull || phoneFull.length < 8) continue;

            try {
                const resolvedLid = await resolveLidFromWhatsAppServer(sock, phoneFull);
                if (resolvedLid) {
                    registerIdentityMapping(resolvedLid, phoneFull);
                    p.noLid = resolvedLid;
                    p.noSender = phoneFull;
                    cachePatientObject(resolvedLid, p);
                    cachePatientObject(phoneFull, p);
                    cachePatientObject(p.noRm, p);

                    batchUpdates.push({
                        noRm: p.noRm,
                        phone: phoneFull,
                        lid: resolvedLid,
                        rowNumber: p.rowNumber
                    });

                    matchedCount++;
                    console.log(`[LID Match SUKSES] ${p.namaPasien} (RM: ${p.noRm}): No WA ${phoneFull} -> LID: ${resolvedLid}`);
                }
                await new Promise(r => setTimeout(r, 250));
            } catch (errCheck) {
                console.warn(`[Resolve Error: ${phoneFull}]`, errCheck.message);
            }
        }

        if (batchUpdates.length > 0) {
            await callSimgosPost({
                action: "batch_update_lids",
                updates: batchUpdates
            });
            console.log(`[Auto-Converter] Sukses menyimpan ${batchUpdates.length} data ke Kolom 18 (No LID) Spreadsheet!`);
        }

        return { total: patientList.length, matched: matchedCount };
    } catch (errSync) {
        console.error("[Auto-Converter Error]", errSync.message);
        return { total: 0, matched: 0, error: errSync.message };
    }
}

// Helper: Mengekstrak Nomor RM dari teks pesan pasien (Contoh: 'RM 123456', 'No. RM 12-34-56', atau 5-8 digit angka)
function extractRmFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const rmMatch = text.match(/(?:no\.?\s*rm|nomor\s*rm|rekam\s*medis|rm)\s*[:#.-]?\s*(\d{2}[-.]?\d{2}[-.]?\d{2}|\d{5,8})/i);
    if (rmMatch) {
        return rmMatch[1].replace(/[-.]/g, '');
    }
    const standAloneDigitMatch = text.trim().match(/^(\d{2}[-.]?\d{2}[-.]?\d{2}|\d{5,8})$/);
    if (standAloneDigitMatch) {
        return standAloneDigitMatch[1].replace(/[-.]/g, '');
    }
    return null;
}

// Helper: Memilih kandidat pasien terbaik jika query menghasilkan lebih dari 1 data kontrol
function selectBestPatientCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 1. Prioritaskan yang status kontrolnya masih 'Pending'
    const pending = candidates.find(c => {
        const sH2 = String(c.statusWaH2 || c.statusWa || "").toLowerCase();
        const sH1 = String(c.statusWaH1 || "").toLowerCase();
        return sH2 === "pending" || sH2 === "" || sH1 === "pending" || sH1 === "";
    });
    if (pending) return pending;

    // 2. Ambil kandidat paling baru (indeks terakhir)
    return candidates[candidates.length - 1];
}

// SMART VERIFIED RESOLVER: Verifikasi Instan Identitas Pasien (LID, Phone, RM di Chat, Nama Lengkap & Auto-Bind LID)
async function smartVerifyPatient(sock, senderInfo, pushName, messageText = "") {
    let matchedPatient = null;

    // 1. Cek Cache Memori (Instant 0ms)
    if (senderInfo.id) {
        matchedPatient = getCachedPatientObject(senderInfo.id);
    }
    if (!matchedPatient && senderInfo.resolvedPhone) {
        matchedPatient = getCachedPatientObject(senderInfo.resolvedPhone);
    }
    if (!matchedPatient && senderInfo.targetJid) {
        matchedPatient = getCachedPatientObject(senderInfo.targetJid);
    }

    if (matchedPatient && matchedPatient.namaPasien && matchedPatient.noRm && matchedPatient.noRm !== "-") {
        if ((!matchedPatient.tglReschedule || matchedPatient.tglReschedule === "-") && matchedPatient.statusReschedule) {
            const match = matchedPatient.statusReschedule.match(/\b(\d{4}-\d{2}-\d{2})\b/);
            if (match) matchedPatient.tglReschedule = match[1];
        }
        return matchedPatient;
    }

    // 2. Cek apakah ada Nomor RM yang diketikkan di dalam teks pesan pasien
    const extractedRm = extractRmFromText(messageText);
    if (extractedRm) {
        try {
            const rmRes = await callSimgosApi("search_patient", {
                query: extractedRm,
                lid: senderInfo.id
            });
            if (rmRes.status === "success" && Array.isArray(rmRes.data) && rmRes.data.length > 0) {
                matchedPatient = selectBestPatientCandidate(rmRes.data);
            }
        } catch (e) { }
    }

    // 3. Pencarian via Phone atau LID pengirim di Google Sheets
    if (!matchedPatient) {
        let lookupPhone = senderInfo.resolvedPhone;
        if (!lookupPhone && senderInfo.isLid && lidToPhoneMap.has(senderInfo.id)) {
            lookupPhone = lidToPhoneMap.get(senderInfo.id);
        } else if (!lookupPhone && !senderInfo.isLid) {
            lookupPhone = senderInfo.id;
        }

        const cleanLookupPhone = (lookupPhone && lookupPhone.length >= 8 && lookupPhone.length <= 15)
            ? formatToInternational(lookupPhone)
            : "";
        const lookupLid = senderInfo.isLid ? senderInfo.id : (phoneToLidMap.get(senderInfo.id) || "");

        try {
            const searchRes = await callSimgosApi("search_patient", {
                phone: cleanLookupPhone,
                lid: lookupLid || senderInfo.id,
                query: cleanLookupPhone || lookupLid || senderInfo.id
            });

            if (searchRes.status === "success" && Array.isArray(searchRes.data) && searchRes.data.length > 0) {
                matchedPatient = selectBestPatientCandidate(searchRes.data);
            }
        } catch (e) { }
    }

    // 4. Reverse Resolve Phone dari WhatsApp Server jika pengirim adalah LID
    if (senderInfo.isLid && !matchedPatient) {
        try {
            const resolvedPhone = await resolvePhoneFromLid(sock, senderInfo.id);
            if (resolvedPhone) {
                registerIdentityMapping(senderInfo.id, resolvedPhone);
                const searchRev = await callSimgosApi("search_patient", {
                    phone: resolvedPhone,
                    lid: senderInfo.id,
                    query: resolvedPhone
                });
                if (searchRev.status === "success" && Array.isArray(searchRev.data) && searchRev.data.length > 0) {
                    matchedPatient = selectBestPatientCandidate(searchRev.data);
                }
            }
        } catch (e) { }
    }

    // 4b. Dynamic Fallback: Jika pengirim adalah LID belum terpetakan, cek antrean kontrol aktif hari ini & H-1
    if (senderInfo.isLid && !matchedPatient) {
        try {
            const [h1Res, h2Res] = await Promise.all([
                callSimgosApi("get_followup", { mode: "h1", tgl: "auto" }).catch(() => null),
                callSimgosApi("get_followup", { mode: "h2", tgl: "auto" }).catch(() => null)
            ]);
            const candidatePatients = [];
            if (h1Res?.status === "success" && Array.isArray(h1Res.data)) candidatePatients.push(...h1Res.data);
            if (h2Res?.status === "success" && Array.isArray(h2Res.data)) candidatePatients.push(...h2Res.data);

            for (const cp of candidatePatients) {
                const phoneCandidate = formatToInternational(cp.noHp);
                if (!phoneCandidate || phoneCandidate.length < 8) continue;

                let cLid = phoneToLidMap.get(phoneCandidate) || (cp.noLid && cp.noLid !== "-" && cp.noLid.length > 10 ? cp.noLid : null);
                if (!cLid) {
                    cLid = await resolveLidFromWhatsAppServer(sock, phoneCandidate);
                }
                if (cLid && String(cLid).replace(/\D/g, '') === String(senderInfo.id).replace(/\D/g, '')) {
                    console.log(`[Dynamic LID Match] Pengirim ${senderInfo.id} teridentifikasi sebagai ${cp.namaPasien} (RM: ${cp.noRm}, No: ${phoneCandidate})`);
                    matchedPatient = cp;
                    registerIdentityMapping(senderInfo.id, phoneCandidate);
                    break;
                }
            }
        } catch (e) { }
    }

    // 5. Pencarian Cerdas via Nama Lengkap (PushName atau Teks Pesan)
    if (!matchedPatient && pushName && pushName.length >= 3 && pushName !== "Pasien") {
        try {
            const cleanName = pushName.replace(/[^a-zA-Z0-9\s.,]/g, '').trim();
            const nameCheck = await callSimgosApi("search_patient", { query: cleanName, lid: senderInfo.id });
            if (nameCheck.status === "success" && Array.isArray(nameCheck.data) && nameCheck.data.length > 0) {
                matchedPatient = selectBestPatientCandidate(nameCheck.data);
            }
        } catch (e) { }
    }

    // 6. Post-Process: Normalisasi & Auto-Binding LID ke Database Spreadsheet
    if (matchedPatient) {
        if ((!matchedPatient.tglReschedule || matchedPatient.tglReschedule === "-") && matchedPatient.statusReschedule) {
            const match = matchedPatient.statusReschedule.match(/\b(\d{4}-\d{2}-\d{2})\b/);
            if (match) matchedPatient.tglReschedule = match[1];
        }

        if (senderInfo.id) {
            registerIdentityMapping(senderInfo.id, matchedPatient.noHp || senderInfo.id);
            cachePatientObject(senderInfo.id, matchedPatient);
        }
        if (matchedPatient.noHp) {
            cachePatientObject(formatToInternational(matchedPatient.noHp), matchedPatient);
        }
        if (matchedPatient.noRm) {
            cachePatientObject(matchedPatient.noRm, matchedPatient);
        }

        // Auto-bind LID pengirim ke spreadsheet kolom 18 secara background agar permanen
        if (senderInfo.isLid && matchedPatient.rowNumber) {
            callSimgosApi("update_status", {
                row: matchedPatient.rowNumber,
                type: "lid_only",
                no_lid: senderInfo.id
            }).catch(() => {});
        }
    }

    return matchedPatient;
}

// Saring Pasien Berdasarkan Status Rujukan
async function fetchPatientsByRujukanStatus(statusType) {
    const collected = new Map();
    try {
        const [h2Res, h1Res] = await Promise.all([
            callSimgosApi("get_followup", { mode: "h2", tgl: "auto" }).catch(() => null),
            callSimgosApi("get_followup", { mode: "h1", tgl: "auto" }).catch(() => null)
        ]);

        const candidateLists = [];
        if (h2Res?.status === "success" && Array.isArray(h2Res.data)) candidateLists.push(...h2Res.data);
        if (h1Res?.status === "success" && Array.isArray(h1Res.data)) candidateLists.push(...h1Res.data);

        for (const p of candidateLists) {
            if (!p || !p.noRm) continue;
            const r = String(p.statusRujukan || "").toLowerCase();
            const isAktif = r.includes("aktif");
            const isHabis = r.includes("habis") || !r || r === "-";

            if ((statusType === "aktif" && isAktif) || (statusType === "habis" && isHabis)) {
                if (!collected.has(p.noRm)) {
                    collected.set(p.noRm, p);
                }
            }
        }
    } catch (e) { }
    return Array.from(collected.values());
}

// =========================================================================
// ENGINE 1 (UTAMA): 9ROUTER MULTI-TIER GATEWAY (GEMINI DIRECT -> ANTIGRAVITY -> AUTO)
// =========================================================================
async function ask9RouterClinic(conversationHistory, systemPromptText, aiConfig, customModelOverride = null) {
    const rawUrl = aiConfig.nineRouterUrl || process.env.NINEROUTER_URL || "http://43.134.43.146:20128/v1/chat/completions";
    const endpoint = normalize9RouterUrl(rawUrl);
    const apiKey = (aiConfig.nineRouterApiKey || process.env.NINEROUTER_API_KEY || "9router").trim().replace(/^["']|["']$/g, '');

    // Model Cascading Pipeline
    const primaryModel = sanitize9RouterModel(customModelOverride || aiConfig.nineRouterModel || process.env.NINEROUTER_MODEL || 'gemini-3.8-flash');
    const antigravityFallback = sanitize9RouterModel(aiConfig.nineRouterFallbackModel || process.env.NINEROUTER_FALLBACK_MODEL || 'ag/gemini-3.8-flash-high');

    const modelsPipeline = [primaryModel, antigravityFallback, 'auto'].filter((v, i, a) => v && a.indexOf(v) === i);

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

    let last9RouterErr = null;

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
                const errBody = await res.text();
                throw new Error(`[${targetModel}] ${res.status}: ${errBody}`);
            }

            const data = await res.json();
            const reply = data.choices?.[0]?.message?.content;
            if (!reply || !reply.trim()) throw new Error(`[${targetModel}] Respon kosong`);

            return { reply: reply.trim(), resolvedModel: targetModel };
        } catch (err) {
            clearTimeout(timeoutId);
            last9RouterErr = err;
            console.warn(`[9Router Multi-Cascade Failover] Model ${targetModel} gagal: ${err.message}. Mencoba model berikutnya...`);
        }
    }

    throw last9RouterErr || new Error("Semua rute model 9Router (Gemini & Antigravity) gagal.");
}

// =========================================================================
// ENGINE 2 (CADANGAN 1): GOOGLE AI STUDIO (GEMINI DIRECT)
// =========================================================================
async function askGeminiClinic(conversationHistory, systemPromptText, aiConfig) {
    const apiKey = aiConfig.geminiApiKey ? aiConfig.geminiApiKey.trim() : "";
    const model = aiConfig.geminiModel || "gemini-3.5-flash";

    if (!apiKey) throw new Error("Gemini API Key belum terpasang di Sheet 'SETTING'.");

    const sanitizedHistory = [];
    for (const turn of conversationHistory) {
        if (!turn.parts || !turn.parts[0] || !turn.parts[0].text) continue;
        const role = turn.role === 'model' ? 'model' : 'user';
        const text = String(turn.parts[0].text).trim();
        if (!text) continue;

        if (sanitizedHistory.length > 0 && sanitizedHistory[sanitizedHistory.length - 1].role === role) {
            sanitizedHistory[sanitizedHistory.length - 1].parts[0].text += `\n${text}`;
        } else {
            sanitizedHistory.push({ role, parts: [{ text }] });
        }
    }

    while (sanitizedHistory.length > 0 && sanitizedHistory[0].role !== 'user') {
        sanitizedHistory.shift();
    }

    if (sanitizedHistory.length === 0) throw new Error('History pesan Gemini kosong.');

    const requestBody = {
        contents: sanitizedHistory,
        systemInstruction: {
            parts: [{ text: systemPromptText }]
        },
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
            topP: 0.85
        }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const headers = { 'Content-Type': 'application/json' };

    const res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Google AI Studio (${model}) ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawReply || !rawReply.trim()) throw new Error('Respon Gemini kosong');

    return rawReply.trim();
}

// =========================================================================
// ENGINE 3 (CADANGAN 2): GROQ AI FALLBACK ENGINE
// =========================================================================
async function askGroqClinic(conversationHistory, systemPromptText, aiConfig) {
    const groqKey = aiConfig.groqApiKey ? aiConfig.groqApiKey.trim() : "";
    if (!groqKey) throw new Error("Groq API Key belum terpasang di Sheet 'SETTING'.");

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

    throw lastGroqError || new Error("Seluruh model Groq AI gagal.");
}

// =========================================================================
// UNIFIED INTELLIGENT AI (9ROUTER CASCADE -> GEMINI DIRECT -> GROQ AI)
// =========================================================================
async function askAIClinicUnified(conversationHistory, patientContext = null, senderPushName = "Pasien", senderInfo = null) {
    const aiConfig = await fetchSystemAIConfig();
    const sysConfig = aiConfig;
    let systemPromptText = aiConfig.prompt;

    systemPromptText = systemPromptText.replace(/RSKDGM Care|RSKD Care/gi, "RSKD Gigi dan Mulut Prov. Sulsel");

    // Injeksi Waktu Lokal Real-Time Makassar (WITA / UTC+8)
    const witaTime = getWitaTimeGreeting();
    const timeInjection = `\n\n[PANDUAN WAKTU & SALAM LOKAL REAL-TIME MAKASSAR (WITA)]:
- Waktu Lokal Makassar Saat Ini: ${witaTime.fullWitaStr}
- Sapaan Waktu Resmi: "${witaTime.greeting}"
- ATURAN SALAM: Wajib mengawali percakapan secara formal dengan "${witaTime.greeting}". Hindari sapaan yang bertentangan dengan zona waktu saat ini!`;

    systemPromptText += timeInjection;

    if (patientContext && patientContext.namaPasien && patientContext.namaPasien !== "-") {
        let finalReschedDate = (patientContext.tglReschedule && patientContext.tglReschedule !== "-") ? patientContext.tglReschedule : "";
        if (!finalReschedDate && patientContext.statusReschedule) {
            const match = patientContext.statusReschedule.match(/\b(\d{4}-\d{2}-\d{2})\b/);
            if (match) finalReschedDate = match[1];
        }

        const hasResched = !!finalReschedDate;
        const isJknCanceled = String(patientContext.statusReschedule || "").toLowerCase().includes("terbatalkan");
        const statusRaw = `${patientContext.statusWa || ''} ${patientContext.statusWaH2 || ''} ${patientContext.statusWaH1 || ''} ${patientContext.statusReschedule || ''}`.toLowerCase();
        const isConfirmedHadir = statusRaw.includes("hadir") || statusRaw.includes("terkonfirmasi");

        systemPromptText += `\n\n[DATA RESMI REKAM MEDIS PASIEN (SIMGOS RSKDGM)]:
- Nama Lengkap Resmi Pasien: ${patientContext.namaPasien}
- Nomor Rekam Medis (No. RM): ${patientContext.noRm}
- Jadwal Kontrol Semula (Awal): ${patientContext.tglKontrol}
- Jadwal Reschedule Baru (Kolom 19): ${hasResched ? finalReschedDate : "-"}
- Status Konfirmasi Kehadiran: ${isConfirmedHadir ? "HADIR (TERKONFIRMASI)" : (patientContext.statusReschedule || patientContext.statusWa || "-")}
- Status Rujukan BPJS: ${patientContext.statusRujukan || "Rujukan Aktif"}
- Dokter DPJP Utama: ${sysConfig.dpjpUtama}
- Unit Kerja Pelayanan: Poli Konservasi dan Endodonsi RSKD Gigi dan Mulut Prov. Sulsel

PEDOMAN TATA BAHASA & ATURAN MEDIS BIROKRATIS (MUTLAK):
1. PENYEBUTAN NAMA LENGKAP:
   Wajib menyapa dan menyebut identitas pasien dengan sebutan kehormatan "Bapak/Ibu/Sdr(i) ${patientContext.namaPasien}" sesuai data resmi database rekam medis. Dilarang mengubah, memotong, atau menggunakan nama samaran lain.
2. JAWABAN JADWAL KONTROL & STATUS KONFIRMASI:
${hasResched ? `
   • STATUS: PASIEN TELAH MEMILIKI TANGGAL RESCHEDULE RESMI YAITU: *${finalReschedDate}*!
   • PERNYATAAN BIROKRATIS WAJIB:
     Jelaskan secara formal dan tegas bahwa jadwal kontrol semula pada tanggal ${patientContext.tglKontrol} telah resmi dialihkan/dijadwalkan ulang ke tanggal *${finalReschedDate}* bersama DPJP Utama (${sysConfig.dpjpUtama}). Nomor Rekam Medis (RM) pasien adalah ${patientContext.noRm}.
   • LARANGAN KERAS: DILARANG KERAS mengatakan "jadwal kontrol tetap dan tidak ada perubahan pada tanggal ${patientContext.tglKontrol}" karena jadwal tersebut telah resmi diperbarui di sistem SIMGOS!` :
isJknCanceled ? `
   • STATUS: PASIEN TERBATALKAN OTOMATIS OLEH SISTEM APLIKASI MOBILE JKN!
   • PERNYATAAN BIROKRATIS WAJIB:
     Sampaikan bahwa jadwal kontrol semula pada tanggal ${patientContext.tglKontrol} telah tercatat terbatalkan oleh sistem aplikasi Mobile JKN. Laporan tersebut telah diteruskan secara kedinasan kepada DPJP Utama (${sysConfig.dpjpUtama}) untuk penerbitan jadwal kontrol pengganti. Pasien dimohon menunggu konfirmasi jadwal baru melalui saluran komunikasi ini.` :
isConfirmedHadir ? `
   • STATUS KONFIRMASI: PASIEN TELAH RESMI MENGONFIRMASI *HADIR (TERKONFIRMASI)* DI SISTEM RSKDGM!
   • LARANGAN MUTLAK (SANGAT PENTING): DILARANG KERAS menyuruh, meminta, atau mengulang perintah "Balas hadir konfirmasi kedatangan" kepada pasien ini! Pasien SUDAH mengonfirmasi hadir!
   • PANDUAN RESPON: Akui dengan hangat bahwa jadwal kehadiran kontrol pada tanggal *${patientContext.tglKontrol}* bersama ${sysConfig.dpjpUtama} (No. RM: ${patientContext.noRm}) telah tercatat rapi di Poli Konservasi. Jawab langsung, fokus, cerdas, dan tuntas apa yang ditanyakan atau dikonsultasikan oleh pasien.` : `
   • STATUS: JADWAL KONTROL AKTIF TERJADWAL PADA TANGGAL *${patientContext.tglKontrol}* BERSAMA ${sysConfig.dpjpUtama} (No. RM: ${patientContext.noRm}).
     Jika pasien bertanya persiapan kontrol, ingatkan membawa KTP/BPJS dan kartu kontrol. Jika pasien menanyakan masalah klinis gigi, prioritaskan menjawab keluhan klinisnya terlebih dahulu secara tuntas.`}
3. KOMPETENSI KLINIS KEDOKTERAN GIGI (SOUL OF RSKDGM DENTAL SPECIALIST):
   Berperanlah sebagai Asisten AI Klinis Rumah Sakit Khusus Daerah Gigi dan Mulut yang cerdas, berwawasan medis spesialisasi tinggi, empatik, dan menenangkan.
   - Pahami dengan cermat patofisiologi kedokteran gigi: Pulpitis ireversibel/reversibel, nekrosis pulpa, abses periapikal, periodontitis, gingivitis, impaksi gigi bungsu, karies profunda, tahapan Perawatan Saluran Akar (PSA / Endodonsi: ekstirpasi pulpa, preparasi biomekanis, medikamen intrakanal, obturasi gutta-percha), tambal resin komposit estetik, mahkota jaket/crown, dan perawatan gigi tiruan.
   - Respon dengan empati mendalam bagi pasien yang merasakan nyeri gigi berdenyut, berikan saran pertolongan pertama sementara yang aman, dan tegaskan bahwa perawatan medis kuratif definitif dilakukan oleh DPJP di Dental Chair.
4. INTEGRITAS KONTEKS & RELEVANSI INTERAKSI:
   Jawablah secara spesifik dan terfokus pada pesan terakhir yang ditanyakan pasien. Jangan mengulang-ulang informasi yang tidak relevan dengan pertanyaan pasien.
5. REGISTER BAHASA:
   Gunakan bahasa Indonesia birokratis rumah sakit formal, santun, lugas, mengayomi, dan tertata rapi.`;
    } else {
        systemPromptText += `\n\n[DATA PENGIRIM CHAT]:
- Nama Profil: ${senderPushName}
- Status: Nomor WhatsApp belum terhubung dengan antrean kontrol aktif.
PETUNJUK: Berikan salam formal birokratis dan persilakan pengirim menginformasikan Nama Lengkap serta Tanggal Lahir guna verifikasi data rekam medis di sistem SIMGOS.`;
    }

    let finalReply = "";

    // 1. Prioritas Utama: 9Router Gateway (Gemini Direct -> Antigravity OAuth -> Auto)
    try {
        const result = await ask9RouterClinic(conversationHistory, systemPromptText, aiConfig);
        finalReply = result.reply;
    } catch (nineRouterErr) {
        console.warn(`[9Router Failover -> Beralih ke Gemini Direct Google AI Studio]`, nineRouterErr.message);
        // 2. Cadangan 1: Google AI Studio Gemini Direct
        try {
            finalReply = await askGeminiClinic(conversationHistory, systemPromptText, aiConfig);
        } catch (geminiErr) {
            console.warn(`[Gemini Direct Failover -> Beralih ke Groq AI]`, geminiErr.message);
            // 3. Cadangan 2: Groq AI Multi-model
            finalReply = await askGroqClinic(conversationHistory, systemPromptText, aiConfig);
        }
    }

    finalReply = enforceCorrectGreeting(finalReply, witaTime.greeting);
    return finalReply.replace(/RSKDGM Care|RSKD Care/gi, "RSKD Gigi dan Mulut Prov. Sulsel");
}

// =========================================================================
// CIRCUIT BREAKER, CONNECTION AUTO-RECOVERY & LOGIKA BLAST FOLLOW-UP
// =========================================================================
let currentSock = null;
let isIntervalStarted = false;

async function executeFollowupBlast(sock, replyTargetJid = null, tglParam = "auto", overrideToSender = false, modeH = "h2") {
    const resultLog = {
        mode: modeH,
        totalTarget: 0,
        pasienTerkirim: 0,
        pasienGagal: 0,
        pasienSkipRujukanHabis: 0,
        pasienWaTidakTerdaftar: 0,
        laporanDokterTerkirim: 0,
        laporanDokterGagal: 0,
        targetDate: "",
        isSenderConverted: false,
        convertedToPhone: ""
    };

    const senderInfo = parseSenderInfo(replyTargetJid);
    const apiParams = { tgl: tglParam, mode: modeH };

    if (overrideToSender && senderInfo.id) {
        apiParams.override_wa = senderInfo.id;
        apiParams.no_lid = senderInfo.id;
        resultLog.isSenderConverted = true;
        resultLog.convertedToPhone = `${senderInfo.id} (${senderInfo.isLid ? 'LID' : 'Phone'})`;
    }

    const followupData = await callSimgosApi("get_followup", apiParams);
    if (!followupData || followupData.status !== "success" || !Array.isArray(followupData.data)) {
        throw new Error(followupData?.message || "Data kontrol tidak tersedia.");
    }

    const listPasien = followupData.data;
    resultLog.totalTarget = listPasien.length;
    resultLog.targetDate = followupData.target_control_date || tglParam;

    if (listPasien.length === 0) return resultLog;

    const sysConfig = await fetchSystemAIConfig();
    const delaySeconds = parseInt(followupData?.delay_chat || sysConfig?.delayChat, 10) || 60;
    const effectiveDelayMs = overrideToSender ? 3000 : (delaySeconds * 1000);

    const targetDoctors = followupData.doctors && followupData.doctors.length > 0
        ? followupData.doctors.map(d => sanitizeNumber(d.wa)).filter(Boolean)
        : DOKTER_JID_LIST;

    const currentDocTargets = (overrideToSender && replyTargetJid) ? [senderInfo.targetJid] : targetDoctors;

    console.log(`[FOLLOWUP BLAST] Memulai pengiriman (${modeH.toUpperCase()}) satu-satu untuk ${listPasien.length} target. Mode: ${overrideToSender ? 'SIMULASI SENDER' : 'REAL BLAST'}, Delay: ${effectiveDelayMs / 1000}s`);

    for (let pxIndex = 0; pxIndex < listPasien.length; pxIndex++) {
        const px = listPasien[pxIndex];
        const statusRujukan = String(px.statusRujukan || "").trim().toLowerCase();
        if (statusRujukan.includes("habis") || !statusRujukan || statusRujukan === "-") {
            console.log(`[SKIP FOLLOWUP] Pasien #${pxIndex + 1} ${px.namaPasien} (RM: ${px.noRm}) dilewati karena Status Rujukan Habis.`);
            resultLog.pasienSkipRujukanHabis++;
            continue;
        }

        // 1. SOCKET AKTIF: Gunakan socket WhatsApp aktif
        const activeSock = currentSock || sock;

        const cleanPhone = formatToInternational(px.noHp);
        let resolvedLid = "";
        let targetPatientJid = "";
        let isWaRegistered = true;

        if (overrideToSender && senderInfo.id) {
            resolvedLid = senderInfo.id;
            targetPatientJid = senderInfo.targetJid;
        } else {
            // 1. Cek apakah LID sudah tersimpan di memory map atau di px.noLid dari sheet
            if (phoneToLidMap.has(cleanPhone)) {
                resolvedLid = phoneToLidMap.get(cleanPhone);
            } else if (px.noLid && px.noLid !== "-" && px.noLid !== cleanPhone && px.noLid.length > 10) {
                resolvedLid = String(px.noLid).replace(/\D/g, '');
                registerIdentityMapping(resolvedLid, cleanPhone);
            }

            try {
                const waCheck = await activeSock.onWhatsApp(cleanPhone);
                if (waCheck && waCheck.length > 0 && waCheck[0]?.exists) {
                    targetPatientJid = waCheck[0].jid || sanitizeNumber(cleanPhone);
                    if (waCheck[0].lid) {
                        resolvedLid = String(waCheck[0].lid).replace(/\D/g, '');
                    }
                } else {
                    isWaRegistered = false;
                }
            } catch (errCheck) {
                targetPatientJid = sanitizeNumber(cleanPhone);
            }

            // 2. JIKA BELUM ADA LID RIIL, RESOLVE LANGSUNG DENGAN USYNC QUERY DARI SERVER WHATSAPP!
            if (isWaRegistered && (!resolvedLid || resolvedLid === cleanPhone)) {
                try {
                    const serverLid = await resolveLidFromWhatsAppServer(activeSock, cleanPhone);
                    if (serverLid) {
                        resolvedLid = serverLid;
                    }
                } catch (e) { }
            }

            if (resolvedLid && resolvedLid !== cleanPhone) {
                registerIdentityMapping(resolvedLid, cleanPhone);
                px.noLid = resolvedLid;
            }

            // 3. CACHE DATA PASIEN SECARA PERSISTEN (24 JAM) DI SEMUA KUNCI (LID, PHONE, NO. RM)
            if (resolvedLid && resolvedLid !== cleanPhone) cachePatientObject(resolvedLid, px);
            cachePatientObject(cleanPhone, px);
            if (px.noRm && px.noRm !== "-") cachePatientObject(px.noRm, px);
        }

        // 2. JIKA NOMOR PASIEN TIDAK TERDAFTAR DI WHATSAPP
        if (!isWaRegistered) {
            console.warn(`[WA TIDAK TERDAFTAR] Pasien #${pxIndex + 1} ${px.namaPasien} (${cleanPhone}) tidak memiliki akun WhatsApp aktif.`);
            resultLog.pasienWaTidakTerdaftar++;
            resultLog.pasienGagal++;

            try {
                await callSimgosApi("update_status", {
                    row: px.rowNumber,
                    type: "both",
                    status: "Bukan Nomor WA",
                    doctor_status: "Bukan Nomor WA",
                    mode: modeH,
                    noSender: cleanPhone,
                    no_lid: (resolvedLid && resolvedLid !== cleanPhone) ? resolvedLid : "-"
                });
            } catch (uErr) { }

            // Notifikasi transparan ke Dokter (SATU-SATU) agar dokter mengetahui nomor tidak ada WA
            for (const docJid of currentDocTargets) {
                try {
                    await activeSock.sendMessage(docJid, {
                        text: `⚠️ *[PERINGATAN DPJP: NO. WA TIDAK AKTIF]*\n\n` +
                            `👤 *Nama Pasien:* ${px.namaPasien}\n` +
                            `🔖 *No. RM:* ${px.noRm}\n` +
                            `📱 *No. Telepon:* ${px.noHp}\n` +
                            `📅 *Jadwal Kontrol:* ${px.tglKontrol}\n` +
                            `📋 *Status Rujukan:* ${px.statusRujukan}\n\n` +
                            `_Nomor di atas tidak terdaftar di WhatsApp. Status di Google Spreadsheet telah ditandai sebagai 'Bukan Nomor WA'. Mohon hubungi pasien melalui panggilan telepon seluler biasa._ 🙏`
                    });
                } catch (wErr) { }
            }

            if (pxIndex < listPasien.length - 1) {
                await new Promise(r => setTimeout(r, 2000));
            }
            continue;
        }

        // 3. KIRIM PESAN KE PASIEN (SATU-SATU)
        let patientSentSuccess = false;
        let pesanKirimPasien = px.pesan_wa_pasien;
        if (overrideToSender) {
            pesanKirimPasien = `🧪 *[SIMULASI BLAST ${modeH.toUpperCase()}: DIARAHKAN KE SENDER]*\n` +
                `_(Target Pasien: ${px.namaPasien} | RM: ${px.noRm} | Rujukan: ${px.statusRujukan} | No. Asli: ${px.originalNoHp || px.noHp})_\n\n` +
                pesanKirimPasien;
        }

        try {
            try {
                await activeSock.sendPresenceUpdate('composing', targetPatientJid);
                await new Promise(r => setTimeout(r, 1200));
            } catch (pErr) { }

            await activeSock.sendMessage(targetPatientJid, { text: pesanKirimPasien });

            try {
                await activeSock.sendPresenceUpdate('paused', targetPatientJid);
            } catch (pErr) { }

            patientSentSuccess = true;
            resultLog.pasienTerkirim++;
            console.log(`[Blast ${modeH.toUpperCase()} Pasien (${resultLog.pasienTerkirim}/${listPasien.length})] ${px.namaPasien} (${px.statusRujukan}) -> JID: ${targetPatientJid}`);

            if (!overrideToSender) {
                if (resolvedLid && resolvedLid !== cleanPhone) {
                    conversationSessions.set(resolvedLid, {
                        history: [],
                        lastSeen: Date.now(),
                        patientData: px
                    });
                }
                conversationSessions.set(cleanPhone, {
                    history: [],
                    lastSeen: Date.now(),
                    patientData: px
                });
            }
        } catch (pxErr) {
            console.error(`[Gagal Kirim Pasien ${modeH.toUpperCase()}] ${px.namaPasien}:`, pxErr?.message || pxErr);
            resultLog.pasienGagal++;
            patientSentSuccess = false;
        }

        // 4. KIRIM LAPORAN DOKTER UNTUK PASIEN INI (SATU-SATU / REAL-TIME)
        let docSentSuccess = false;
        if (patientSentSuccess) {
            // JEDA PACING 60 DETIK ANTARA PESAN PASIEN DAN LAPORAN DOKTER DPJP
            const interMessageDelaySec = overrideToSender ? 3 : (delaySeconds || 60);
            console.log(`[Pacing Delay ${interMessageDelaySec}s] Menunggu jeda ${interMessageDelaySec} detik sebelum mengirimkan laporan dokter (${px.namaPasien})...`);
            await new Promise(r => setTimeout(r, interMessageDelaySec * 1000));

            let pesanLaporanDokter = px.pesan_wa_laporan_dokter;
            if (!pesanLaporanDokter) {
                const docTplKey = modeH === "h1" 
                    ? (sysConfig.templates?.["WA_LAPORAN_DOKTER_H1"] ? "WA_LAPORAN_DOKTER_H1" : "WA_LAPORAN_DOKTER")
                    : (sysConfig.templates?.["WA_LAPORAN_DOKTER_H2"] ? "WA_LAPORAN_DOKTER_H2" : "WA_LAPORAN_DOKTER");
                const docTpl = sysConfig.templates?.[docTplKey] || sysConfig.templates?.["WA_LAPORAN_DOKTER"] || "";
                pesanLaporanDokter = compileTemplateText(docTpl, px, sysConfig);
            }

            if (overrideToSender) {
                pesanLaporanDokter = `🧪 *[SIMULASI LAPORAN DPJP: DIARAHKAN KE SENDER]*\n` +
                    `_(Laporan untuk Pasien: ${px.namaPasien} | RM: ${px.noRm} | Status: Rujukan Aktif)_\n\n` +
                    pesanLaporanDokter;
            }

            for (let dIdx = 0; dIdx < currentDocTargets.length; dIdx++) {
                const docJid = currentDocTargets[dIdx];
                try {
                    try {
                        await activeSock.sendPresenceUpdate('composing', docJid);
                        await new Promise(r => setTimeout(r, 800));
                    } catch (pErr) { }

                    await activeSock.sendMessage(docJid, { text: pesanLaporanDokter });

                    try {
                        await activeSock.sendPresenceUpdate('paused', docJid);
                    } catch (pErr) { }

                    docSentSuccess = true;
                    console.log(`[Laporan DPJP Terkirim (Satu-Satu)] Pasien #${pxIndex + 1} (${px.namaPasien}) -> Dokter: ${docJid}`);
                } catch (dErr) {
                    console.error(`[Gagal Kirim Laporan Dokter] Pasien #${pxIndex + 1} (${px.namaPasien}) ke ${docJid}:`, dErr.message);
                }
            }

            if (docSentSuccess) {
                resultLog.laporanDokterTerkirim++;
            } else {
                resultLog.laporanDokterGagal++;
            }
        }

        // 5. ATOMIC STATUS UPDATE KE GOOGLE SPREADSHEET (Pasien & Dokter Serentak)
        try {
            await callSimgosApi("update_status", {
                row: px.rowNumber,
                type: "both",
                status: patientSentSuccess ? "Terkirim" : "Gagal",
                doctor_status: docSentSuccess ? "Terkirim" : (patientSentSuccess ? "Gagal" : "Pending"),
                mode: modeH,
                noSender: cleanPhone,
                no_lid: (resolvedLid && resolvedLid !== cleanPhone) ? resolvedLid : (px.noLid && px.noLid !== cleanPhone ? px.noLid : "-")
            });
        } catch (dbErr) {
            console.error(`[Update Status Gagal] Baris ${px.rowNumber}:`, dbErr.message);
        }

        // 6. JEDA ANTI-SPAM (Default 60 Detik dari Sheet 'SETTING') antar pasien jika masih ada pasien berikutnya
        if (pxIndex < listPasien.length - 1) {
            const countdownSec = overrideToSender ? 3 : delaySeconds;
            console.log(`[Anti-Spam Delay] Menunggu jeda ${countdownSec} detik sebelum pengiriman pasien & dokter berikutnya...`);
            await new Promise(r => setTimeout(r, effectiveDelayMs));
        }
    }

    // 7. SELESAI BLAST FOLLOW-UP
    // Rekapitulasi summary TIDAK lagi dikirim ke dokter DPJP (dokter hanya menerima laporan pasien dari CUSTOM_FORMAT).
    // Rekapitulasi dikembalikan lewat resultLog untuk dilaporkan kepada pengirim perintah (petugas/admin).
    console.log(`[Blast ${modeH.toUpperCase()} Selesai] Total: ${resultLog.totalTarget} | Pasien Terkirim: ${resultLog.pasienTerkirim} | Laporan DPJP: ${resultLog.laporanDokterTerkirim} | Skip Rujukan Habis: ${resultLog.pasienSkipRujukanHabis}`);

    return resultLog;
}

// =========================================================================
// MAIN MESSAGE HANDLER ENGINE
// =========================================================================
export default function setupMessageHandler(sock) {
    currentSock = sock;

    prewarmDoctorAndOwnerLids(sock);

    setTimeout(() => {
        convertAllPatientsToLid(sock, false);
    }, 3000);

    setTimeout(async () => {
        try {
            const fixRes = await callSimgosApi("fix_sender_columns");
            if (fixRes && fixRes.fixedCount > 0) {
                console.log(`[Auto-Sync Kolom O] Sukses menstandarisasi ${fixRes.fixedCount} baris Kolom O menjadi No WA Asli (628xxx)!`);
            }
        } catch (e) { }
    }, 5000);

    if (!isIntervalStarted) {
        // 1. Scheduler Auto Blast Jam 08:30 WITA
        setInterval(async () => {
            if (!currentSock) return;

            const d = new Date();
            const jam = d.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Makassar' });
            const menit = d.toLocaleString('en-US', { minute: '2-digit', timeZone: 'Asia/Makassar' });
            const tanggalHariIniWita = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(d);

            const targetJam = String(botSettings.autoFollowupHour || "08").padStart(2, "0");
            const targetMenit = String(botSettings.autoFollowupMinute || "30").padStart(2, "0");

            if (
                botSettings.autoFollowupSimgos &&
                jam === targetJam &&
                menit === targetMenit &&
                botSettings.lastAutoFollowupDate !== tanggalHariIniWita
            ) {
                try {
                    console.log(`[Auto SIMGOS] Menjalankan follow-up otomatis H-2 & H-1 jam ${targetJam}:${targetMenit} WITA (${tanggalHariIniWita})...`);

                    const blastH2 = await executeFollowupBlast(currentSock, ownerNumber, "auto", false, "h2");
                    const blastH1 = await executeFollowupBlast(currentSock, ownerNumber, "auto", false, "h1");

                    botSettings.lastAutoFollowupDate = tanggalHariIniWita;
                    saveSettings();

                    if (blastH2.totalTarget > 0 || blastH1.totalTarget > 0) {
                        await currentSock.sendMessage(ownerNumber, {
                            text: `🤖 *AUTO FOLLOW-UP SIMGOS SELESAI (H-2 & H-1)*\n\n` +
                                `📅 *Follow-up H-2 (${blastH2.targetDate}):*\n` +
                                `• Terkirim (Aktif): ${blastH2.pasienTerkirim}\n` +
                                `• Dilewati (Habis): ${blastH2.pasienSkipRujukanHabis}\n\n` +
                                `📅 *Follow-up H-1 (${blastH1.targetDate}):*\n` +
                                `• Terkirim (Aktif): ${blastH1.pasienTerkirim}\n` +
                                `• Dilewati (Habis): ${blastH1.pasienSkipRujukanHabis}\n\n` +
                                `👨‍⚕️ Laporan Dokter DPJP Utama Terkirim\n` +
                                `⏱️ Waktu: ${getWitaTimeGreeting().fullWitaStr}`
                        });
                    }
                } catch (autoErr) {
                    console.error("[Auto SIMGOS Error]", autoErr);
                }
            }
        }, 30000);

        // 2. Scheduler Rutin Sinkronisasi Pasien Setiap 30 Menit
        setInterval(() => {
            if (currentSock) {
                convertAllPatientsToLid(currentSock, false);
            }
        }, 30 * 60 * 1000);

        isIntervalStarted = true;
    }

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid) return;

            if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast') || remoteJid === 'status@broadcast') {
                return;
            }

            const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption || '';

            const isImage = !!(msg.message.imageMessage);

            if (!text.trim() && !isImage) return;

            const rawParticipant = msg.key.participant || msg.key.participantPn || msg.participantPn || '';
            if (rawParticipant && remoteJid.endsWith('@lid')) {
                registerIdentityMapping(remoteJid, rawParticipant);
            }

            const senderInfo = parseSenderInfo(remoteJid);
            const pushName = msg.pushName || "Pasien";

            console.log(`[Chat 1-on-1] Dari: ${senderInfo.id} (${senderInfo.isLid ? 'LID' : 'Phone'}) | PushName: ${pushName} | Pesan: "${text.trim()}"`);

            // =====================================================================
            // 1. COMMAND ADMIN (PREFIX '!')
            // =====================================================================
            if (text.startsWith('!')) {
                const args = text.slice(1).trim().split(/ +/);
                const command = args.shift().toLowerCase();

                switch (command) {
                    case 'menu':
                    case 'help':
                        const menuText = `*🤖 BOT KONTROL RSKDGM (H-2 & H-1 SIMGOS) 🤖*\n\n` +
                            `*🦷 SIMGOS FOLLOW-UP KONTROL:*\n` +
                            `* !converstalltolid* - 🔄 Konversi satu-satu No WA ke Kolom 18 (No LID)\n` +
                            `* !reschedulepx terbatalkan <No.RM/Nama> <YYYY-MM-DD>* - 🔁 Jadwal ulang tgl baru & simpan Kolom 19\n` +
                            `* !followupnow* [h1/h2/all] [tgl/auto] [me] - 🚀 Kirim instan ('all' = H-2 & H-1, 'me' = kirim ke Anda)\n` +
                            `* !followup* [h1/h2/h3/dst] [tgl/auto] - 📋 Cek antrean pasien kontrol (mendukung H-1, H-2, H-3, dst.)\n` +
                            `* !gassfollowup* [h1/h2] [me] - Kirim WA massal ke Pasien & DPJP Utama\n` +
                            `* !cekrujukanaktif* - 📋 Lihat pasien dengan Rujukan Aktif\n` +
                            `* !cekrujukanhabis* - ⚠️ Lihat pasien dengan Rujukan Habis\n` +
                            `* !bindpasien* <No.RM> - 🔗 Tautkan WhatsApp Anda ke No RM Pasien\n` +
                            `* !caripasien* <No.RM/Nama/WA/LID> - Cari data pasien di Spreadsheet\n` +
                            `* !reschedule* <No.RM> <YYYY-MM-DD> - Ubah tanggal kontrol manual\n` +
                            `* !statskontrol* - Cek statistik kontrol & status rujukan\n` +
                            `* !settingssimgos* - Cek konfigurasi sistem & dokter\n` +
                            `* !templatesimgos* - Cek template format pesan WhatsApp\n` +
                            `* !autofollowup on/off* - Pengaturan status blast harian otomatis\n` +
                            `* !setjamfollowup* <HH:mm> - Ubah jam blast harian\n` +
                            `* !setdelaychat* <detik> - ⏳ Ubah jeda anti-spam blast (default 60 detik / pasien & dokter)\n` +
                            `* !fixsender* - 🛠️ Standarisasi Kolom O (No Sender) ke No WA Asli (628xxx)\n\n` +

                            `*🧠 KREDENSIAL AI & 9ROUTER MULTI-GATEWAY:*\n` +
                            `* !test9router* [model/ag] - 🧪 Uji respon AI (ketik '!test9router ag' untuk tes Antigravity)\n` +
                            `* !getprompt* - Cek status 9Router VPS, Antigravity, Prompt & API Key\n` +
                            `* !clearpromptcache* - Refresh cache prompt, template & API Key terbaru\n\n` +

                            `*⚙️ UTILITAS:* \n` +
                            `* !ping* - Cek kecepatan respon bot\n` +
                            `* !runtime* - Cek waktu aktif bot & server\n` +
                            `* !sticker* / *!s* - Konversi gambar ke stiker\n\n` +

                            `_💬 Rumah Sakit Resmi: *RSKD Gigi dan Mulut Prov. Sulsel*._`;
                        await sock.sendMessage(senderInfo.targetJid, { text: menuText }, { quoted: msg });
                        return;

                    case 'test9router':
                    case 'ping9router':
                    case 'cek9router':
                        let overrideModelTest = null;
                        if (args[0]) {
                            const argModel = args[0].toLowerCase();
                            if (argModel === 'ag' || argModel === 'antigravity') {
                                overrideModelTest = 'ag/gemini-3.8-flash-high';
                            } else if (argModel === 'gemini') {
                                overrideModelTest = 'gemini-3.8-flash';
                            } else if (argModel === 'auto') {
                                overrideModelTest = 'auto';
                            } else {
                                overrideModelTest = args[0];
                            }
                        }

                        await sock.sendMessage(senderInfo.targetJid, { text: `⏳ _Menghubungkan ke 9Router VPS (Model: ${overrideModelTest || 'Auto Cascade'})..._` }, { quoted: msg });
                        try {
                            const cfgNow = await fetchSystemAIConfig();
                            const startT = Date.now();
                            const testResult = await ask9RouterClinic(
                                [{ role: 'user', parts: [{ text: 'Tes koneksi 9router vps rskdgm. Jawab singkat padat 1 kalimat.' }] }],
                                'Anda adalah asisten AI RSKD Gigi dan Mulut Prov. Sulsel.',
                                cfgNow,
                                overrideModelTest
                            );
                            const latensi = Date.now() - startT;
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `✅ *KONEKSI 9ROUTER VPS SUKSES!*\n\n` +
                                    `🌐 *Endpoint:* \`${cfgNow.nineRouterUrl}\`\n` +
                                    `🤖 *Model Terjawab:* \`${testResult.resolvedModel}\`\n` +
                                    `⚡ *Latensi Respon:* ${latensi} ms\n\n` +
                                    `💬 *Balasan Model:*\n"${testResult.reply}"`
                            }, { quoted: msg });
                        } catch (err9Test) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `❌ *Koneksi 9Router Gagal:*\n${err9Test.message}\n\n💡 *Tips:* Ketik *!test9router ag* untuk menguji jalur Antigravity OAuth secara langsung.`
                            }, { quoted: msg });
                        }
                        return;

                    case 'converstalltolid':
                    case 'convertalltolid':
                    case 'syncalllid':
                    case 'syncalldb':
                    case 'synclids':
                    case 'syncpasien':
                        await sock.sendMessage(senderInfo.targetJid, { text: "⏳ _Memulai konversi satu-satu No WA database ke Kolom 18 (No LID) via USync Server WhatsApp... Mohon tunggu sebentar._" }, { quoted: msg });
                        const syncResult = await convertAllPatientsToLid(sock, true);
                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `✅ *SINKRONISASI KOLOM 18 (NO LID) SELESAI!*\n\n` +
                                `📁 Total Nomor WA Diperiksa: *${syncResult.total} Pasien*\n` +
                                `🎯 Berhasil Dikonversi ke LID: *${syncResult.matched} Pasien*\n` +
                                `💾 Status: Tersimpan permanen ke Kolom 18 (No LID) & Kolom 15 di Spreadsheet.\n\n` +
                                `_Sekarang pasien yang chat melalui LID langsung dikenali nama & No RM aslinya secara akurat!_ 🚀`
                        }, { quoted: msg });
                        return;

                    case 'reschedulepx':
                    case 'rescheduleterbatalkan':
                        let inputArgs = [...args];
                        if (inputArgs[0] && inputArgs[0].toLowerCase() === 'terbatalkan') {
                            inputArgs.shift();
                        }

                        if (inputArgs.length < 2) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ Format salah!\nGunakan format:\n*!reschedulepx terbatalkan <No. RM / Nama Lengkap> <YYYY-MM-DD>*\n\nContoh:\n*!reschedulepx terbatalkan 00.06.32.89 2026-09-17*\natau\n*!reschedulepx terbatalkan M. AXA 2026-09-17*`
                            }, { quoted: msg });
                            break;
                        }

                        const newDateParam = inputArgs.pop();
                        const extractedTargetDate = extractDateFromText(newDateParam) || newDateParam;
                        const targetIdentifier = inputArgs.join(" ").replace(/\//g, "").trim();

                        if (!/^\d{4}-\d{2}-\d{2}$/.test(extractedTargetDate)) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `❌ Tanggal tidak valid! Gunakan format *YYYY-MM-DD* (contoh: *2026-09-17*).`
                            }, { quoted: msg });
                            break;
                        }

                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `⏳ _Mencari data pasien "${targetIdentifier}" untuk dijadwalkan ulang ke ${extractedTargetDate}..._`
                        }, { quoted: msg });

                        try {
                            const searchTarget = await callSimgosApi("search_patient", { query: targetIdentifier });
                            if (searchTarget.status !== "success" || !Array.isArray(searchTarget.data) || searchTarget.data.length === 0) {
                                await sock.sendMessage(senderInfo.targetJid, {
                                    text: `❌ Data pasien dengan kata kunci *"${targetIdentifier}"* tidak ditemukan di spreadsheet.`
                                }, { quoted: msg });
                                break;
                            }

                            const targetPx = searchTarget.data[0];
                            const sysCfg = await fetchSystemAIConfig();

                            await callSimgosApi("reschedule_patient", {
                                noRm: targetPx.noRm,
                                newDate: extractedTargetDate,
                                customStatus: `Reschedule DPJP (${extractedTargetDate})`
                            });

                            const updatedPxObj = {
                                ...targetPx,
                                tglReschedule: extractedTargetDate,
                                statusReschedule: `Reschedule DPJP (${extractedTargetDate})`
                            };

                            cachePatientObject(targetPx.noRm, updatedPxObj);
                            if (targetPx.noLid) cachePatientObject(targetPx.noLid, updatedPxObj);
                            if (targetPx.noHp) cachePatientObject(formatToInternational(targetPx.noHp), updatedPxObj);

                            const templateJknConfirm = sysCfg.templates["WA_PX_RESCHEDULE_JKN_CONFIRM"];
                            const msgToPatient = compileTemplateText(templateJknConfirm, updatedPxObj, sysCfg);
                            const targetPatientJid = sanitizeNumber(targetPx.noHp);

                            await sock.sendMessage(targetPatientJid, { text: msgToPatient });

                            const successReport = `✅ *RESCHEDULE PASIEN TERBATALKAN BERHASIL!*\n\n` +
                                `👤 *Nama Pasien:* ${targetPx.namaPasien}\n` +
                                `🔖 *No. RM:* ${targetPx.noRm}\n` +
                                `📅 *Jadwal Semula (Awal):* ${targetPx.tglKontrol}\n` +
                                `📅 *Tanggal Reschedule Baru:* ${extractedTargetDate}\n` +
                                `📱 *WhatsApp Pasien:* ${targetPx.noHp}\n` +
                                `📋 *Status Kolom 16:* Reschedule DPJP (${extractedTargetDate})\n` +
                                `💾 *Status Kolom 19 (Tanggal Reschedule):* ${extractedTargetDate}\n\n` +
                                `_Pesan konfirmasi jadwal baru telah otomatis dikirimkan ke WhatsApp pasien._ 🙏✨`;

                            await sock.sendMessage(senderInfo.targetJid, { text: successReport }, { quoted: msg });

                        } catch (errReschedPx) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal eksekusi reschedule pasien:* ${errReschedPx.message}` }, { quoted: msg });
                        }
                        return;

                    case 'cekrujukanaktif':
                    case 'rujukanaktif':
                        await sock.sendMessage(senderInfo.targetJid, { text: "⏳ _Mengambil data pasien dengan Status Rujukan Aktif dari Google Spreadsheet..._" }, { quoted: msg });
                        try {
                            const pasienAktif = await fetchPatientsByRujukanStatus("aktif");
                            if (pasienAktif.length === 0) {
                                await sock.sendMessage(senderInfo.targetJid, { text: "ℹ️ Tidak ditemukan pasien dengan status *Rujukan Aktif* di antrean kontrol." }, { quoted: msg });
                                break;
                            }

                            let textAktif = `📋 *DAFTAR PASIEN RUJUKAN AKTIF (${pasienAktif.length} Pasien)*\n` +
                                `🏥 RSKD Gigi dan Mulut Prov. Sulsel\n` +
                                `🦷 Poli Konservasi dan Endodonsi\n\n`;

                            pasienAktif.forEach((p, idx) => {
                                textAktif += `${idx + 1}. *${p.namaPasien}*\n` +
                                    `   🔖 No. RM: ${p.noRm}\n` +
                                    `   📅 Tgl Kontrol: ${p.tglKontrol}\n` +
                                    `   📱 WA Pasien: ${p.noHp}\n` +
                                    `   📋 Status: ✅ *Rujukan Aktif*\n\n`;
                            });

                            await sock.sendMessage(senderInfo.targetJid, { text: textAktif }, { quoted: msg });
                        } catch (errAktif) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal mengambil data rujukan aktif:* ${errAktif.message}` }, { quoted: msg });
                        }
                        return;

                    case 'cekrujukanhabis':
                    case 'rujukanhabis':
                        await sock.sendMessage(senderInfo.targetJid, { text: "⏳ _Mengambil data pasien dengan Status Rujukan Habis dari Google Spreadsheet..._" }, { quoted: msg });
                        try {
                            const pasienHabis = await fetchPatientsByRujukanStatus("habis");
                            if (pasienHabis.length === 0) {
                                await sock.sendMessage(senderInfo.targetJid, { text: "ℹ️ Tidak ditemukan pasien dengan status *Rujukan Habis* di antrean kontrol." }, { quoted: msg });
                                break;
                            }

                            let textHabis = `⚠️ *DAFTAR PASIEN RUJUKAN HABIS (${pasienHabis.length} Pasien)*\n` +
                                `🏥 RSKD Gigi dan Mulut Prov. Sulsel\n` +
                                `🦷 Poli Konservasi dan Endodonsi\n` +
                                `_(Pasien-pasien ini otomatis di-skip dari blast follow-up)_\n\n`;

                            pasienHabis.forEach((p, idx) => {
                                textHabis += `${idx + 1}. *${p.namaPasien}*\n` +
                                    `   🔖 No. RM: ${p.noRm}\n` +
                                    `   📅 Tgl Kontrol: ${p.tglKontrol}\n` +
                                    `   📱 WA Pasien: ${p.noHp}\n` +
                                    `   📋 Status: 🚫 *Rujukan Habis*\n\n`;
                            });

                            await sock.sendMessage(senderInfo.targetJid, { text: textHabis }, { quoted: msg });
                        } catch (errHabis) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal mengambil data rujukan habis:* ${errHabis.message}` }, { quoted: msg });
                        }
                        return;

                    case 'bindpasien':
                    case 'linkpasien':
                        if (args.length === 0) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ Format salah!\nGunakan: *!bindpasien <No.RM>*\nContoh: *!bindpasien 00.06.32.89*`
                            }, { quoted: msg });
                            break;
                        }
                        const targetRmBind = args[0].trim();
                        await sock.sendMessage(senderInfo.targetJid, { text: `⏳ _Menautkan identitas ${senderInfo.isLid ? 'LID' : 'WA'} (${senderInfo.id}) ke No. RM ${targetRmBind}..._` }, { quoted: msg });
                        try {
                            await callSimgosApi("update_status", {
                                noRm: targetRmBind,
                                type: "pasien",
                                status: "Pending",
                                no_lid: senderInfo.id
                            });

                            const searchCheck = await callSimgosApi("search_patient", { query: targetRmBind, lid: senderInfo.id });
                            const pxName = (searchCheck.status === "success" && searchCheck.data?.[0]?.namaPasien) ? searchCheck.data[0].namaPasien : targetRmBind;

                            if (searchCheck.data?.[0]?.noHp) {
                                registerIdentityMapping(senderInfo.id, searchCheck.data[0].noHp);
                                cachePatientObject(senderInfo.id, searchCheck.data[0]);
                            }

                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `✅ *Tautan Berhasil!*\n\nIdentitas ${senderInfo.isLid ? 'LID' : 'WA'} Anda (*${senderInfo.id}*) kini resmi terdaftar pada pasien:\n👤 *Nama:* ${pxName}\n🔖 *No. RM:* ${targetRmBind}\n\nKetik *"HADIR"* atau *"RESCHEDULE"* dan nama lengkap pasien akan otomatis tercantum!`
                            }, { quoted: msg });
                        } catch (errBind) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal menautkan pasien:* ${errBind.message}` }, { quoted: msg });
                        }
                        return;

                    case 'followupnow':
                    case 'follownow':
                        let tglTarget = "auto";
                        let toSender = false;
                        let modeHNow = "h2";
                        let isAllModes = false;

                        for (const arg of args) {
                            const lowerArg = arg.toLowerCase();
                            if (lowerArg === 'me' || lowerArg === 'test' || lowerArg === 'myself') {
                                toSender = true;
                            } else if (lowerArg === 'h1') {
                                modeHNow = "h1";
                            } else if (lowerArg === 'h2') {
                                modeHNow = "h2";
                            } else if (lowerArg === 'all') {
                                isAllModes = true;
                            } else if (lowerArg !== 'auto') {
                                tglTarget = arg;
                            }
                        }

                        const modesToRun = isAllModes ? ["h2", "h1"] : [modeHNow];
                        const sysCfgNow = await fetchSystemAIConfig();
                        const delaySecInfo = sysCfgNow.delayChat || 60;
                        const infoNotice = toSender
                            ? `⚡ *[FOLLOWUP NOW]* Memulai penarikan data (${modesToRun.map(m => m.toUpperCase()).join(" & ")})... ⚠️ *Mode Simulasi:* Pesan pasien & laporan DPJP dialihkan *satu per satu* ke WhatsApp Anda (*${senderInfo.id}*).`
                            : `⚡ *[FOLLOWUP NOW]* Memulai pengiriman (${modesToRun.map(m => m.toUpperCase()).join(" & ")}) secara *Satu-Satu* (Pesan Pasien ➔ Laporan DPJP)...\n⏳ *Jeda Anti-Spam:* ${delaySecInfo} detik / pasien (Rujukan Habis otomatis diskip).`;

                        await sock.sendMessage(senderInfo.targetJid, { text: infoNotice }, { quoted: msg });

                        try {
                            for (const currentMode of modesToRun) {
                                const blastResult = await executeFollowupBlast(sock, remoteJid, tglTarget, toSender, currentMode);

                                if (blastResult.totalTarget === 0) {
                                    await sock.sendMessage(senderInfo.targetJid, {
                                        text: `ℹ️ Tidak ada antrean pasien kontrol berstatus *Pending* untuk target ${currentMode.toUpperCase()} tanggal ${blastResult.targetDate}.`
                                    }, { quoted: msg });
                                    continue;
                                }

                                let rekapSekarang = `🚀 *[FOLLOWUP NOW ${currentMode.toUpperCase()} SELESAI]*\n\n` +
                                    `📅 *Target Kontrol:* ${blastResult.targetDate}\n` +
                                    `👥 *Total Pasien Terjadwal:* ${blastResult.totalTarget}\n` +
                                    `📲 *Pesan Pasien Terkirim (Aktif):* ${blastResult.pasienTerkirim}\n` +
                                    `🚫 *Dilewati (Rujukan Habis):* ${blastResult.pasienSkipRujukanHabis}\n` +
                                    `⚠️ *Nomor WA Tidak Terdaftar:* ${blastResult.pasienWaTidakTerdaftar}\n` +
                                    `⚠️ *Pesan Pasien Gagal:* ${blastResult.pasienGagal}\n` +
                                    `👨‍⚕️ *Laporan DPJP Terkirim:* ${blastResult.laporanDokterTerkirim} Laporan (Satu-Satu)\n`;

                                if (blastResult.isSenderConverted) {
                                    rekapSekarang += `🎯 *Penerima Diarahkan ke:* ${blastResult.convertedToPhone} (Tersimpan di Kolom 15 & 18)\n`;
                                }

                                rekapSekarang += `\n_Status Pasien dan Dokter di Google Spreadsheet telah diperbarui ke Terkirim._ 📊`;
                                await sock.sendMessage(senderInfo.targetJid, { text: rekapSekarang }, { quoted: msg });
                            }
                        } catch (errNow) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal eksekusi Followup Now:* ${errNow.message}` }, { quoted: msg });
                        }
                        return;

                    case 'setjamfollowup':
                        if (args.length === 0 || !args[0].includes(':')) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ Format salah!\nGunakan format: *!setjamfollowup <HH:mm>*\nContoh: *!setjamfollowup 08:30*`
                            }, { quoted: msg });
                            break;
                        }
                        const [inputJam, inputMenit] = args[0].split(':');
                        const parsedJam = parseInt(inputJam, 10);
                        const parsedMenit = parseInt(inputMenit, 10);

                        if (isNaN(parsedJam) || isNaN(parsedMenit) || parsedJam < 0 || parsedJam > 23 || parsedMenit < 0 || parsedMenit > 59) {
                            await sock.sendMessage(senderInfo.targetJid, { text: "❌ Jam atau menit tidak valid! Rentang 00:00 - 23:59." }, { quoted: msg });
                            break;
                        }

                        botSettings.autoFollowupHour = String(parsedJam).padStart(2, '0');
                        botSettings.autoFollowupMinute = String(parsedMenit).padStart(2, '0');
                        saveSettings();

                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `⏰ *Jadwal Auto Follow-up Diubah!*\n\nJam: *${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA*\nStatus: *${botSettings.autoFollowupSimgos ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}*`
                        }, { quoted: msg });
                        return;

                    case 'followup':
                    case 'cekfollowup':
                        let modeHFU = "h2";
                        let tglArg = "auto";

                        for (const a of args) {
                            const lowerA = a.toLowerCase();
                            const hMatch = lowerA.match(/^h(\d+)$/);
                            if (hMatch) {
                                modeHFU = lowerA;
                            } else if (lowerA !== 'auto') {
                                tglArg = a;
                            }
                        }

                        await sock.sendMessage(senderInfo.targetJid, { text: `⏳ _Mengambil data pasien kontrol siap follow-up (${modeHFU.toUpperCase()}) dari Google Spreadsheet..._` }, { quoted: msg });
                        try {
                            const resFollowup = await callSimgosApi("get_followup", { tgl: tglArg, mode: modeHFU });

                            if (resFollowup.status !== "success" || !resFollowup.data || resFollowup.data.length === 0) {
                                await sock.sendMessage(senderInfo.targetJid, {
                                    text: `ℹ️ *Tidak ada antrean pasien kontrol berstatus Pending untuk target ${modeHFU.toUpperCase()} tanggal:* ${resFollowup.target_control_date || tglArg}.`
                                }, { quoted: msg });
                                break;
                            }

                            let textHasil = `📋 *DAFTAR PASIEN KONTROL (${modeHFU.toUpperCase()})*\n` +
                                `📅 *Target Kontrol:* ${resFollowup.target_control_date}\n` +
                                `👥 *Total Pasien:* ${resFollowup.total} orang\n\n`;

                            resFollowup.data.forEach((px, idx) => {
                                const iconRujuk = String(px.statusRujukan || "").toLowerCase().includes("habis") ? "🚫 Habis" : "✅ Aktif";
                                textHasil += `${idx + 1}. *${px.namaPasien}* (RM: ${px.noRm})\n` +
                                    `   📱 WA Pasien: ${px.noHp}\n` +
                                    `   📋 Rujukan: *${iconRujuk}*\n` +
                                    `   🏥 Status WA: ${px.statusWa} | Dokter: ${px.statusDokter}\n\n`;
                            });

                            if (modeHFU === "h1" || modeHFU === "h2") {
                                textHasil += `👉 _Ketik *!followupnow ${modeHFU} me* untuk test ke Anda, atau *!followupnow ${modeHFU}* untuk blast._`;
                            } else {
                                textHasil += `👉 _Catatan: Pengecekan antrean kontrol ${modeHFU.toUpperCase()}. Blast WhatsApp otomatis dikhususkan untuk H-2 dan H-1 (!followupnow h2 / !followupnow h1)._`;
                            }
                            await sock.sendMessage(senderInfo.targetJid, { text: textHasil }, { quoted: msg });
                        } catch (e) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal mengambil data:* ${e.message}` }, { quoted: msg });
                        }
                        return;

                    case 'gassfollowup':
                    case 'kirimfollowup':
                        let modeHGass = "h2";
                        let tglKirim = "auto";
                        let toSenderGass = false;

                        for (const a of args) {
                            const lowerG = a.toLowerCase();
                            if (lowerG === 'me' || lowerG === 'test') toSenderGass = true;
                            else if (lowerG === 'h1') modeHGass = "h1";
                            else if (lowerG === 'h2') modeHGass = "h2";
                            else if (lowerG !== 'auto') tglKirim = a;
                        }

                        const sysCfgGass = await fetchSystemAIConfig();
                        const delaySecGass = sysCfgGass.delayChat || 60;
                        await sock.sendMessage(senderInfo.targetJid, { 
                            text: `🚀 _Memulai pengiriman pesan WhatsApp massal (${modeHGass.toUpperCase()}) secara *Satu-Satu* (Pesan Pasien ➔ Laporan DPJP)..._\n⏳ *Jeda Anti-Spam:* ${delaySecGass} detik / pasien agar aman dari pemblokiran WA.` 
                        }, { quoted: msg });
                        try {
                            const blastResult = await executeFollowupBlast(sock, remoteJid, tglKirim, toSenderGass, modeHGass);

                            if (blastResult.totalTarget === 0) {
                                await sock.sendMessage(senderInfo.targetJid, { text: `ℹ️ Tidak ada antrean pasien Pending untuk target ${modeHGass.toUpperCase()} tanggal ${blastResult.targetDate}.` }, { quoted: msg });
                                break;
                            }

                            let rekapAkhir = `✅ *EKSEKUSI FOLLOW-UP (${modeHGass.toUpperCase()}) SELESAI!*\n\n` +
                                `📅 *Tgl Kontrol:* ${blastResult.targetDate}\n` +
                                `👥 *Total Target Pasien:* ${blastResult.totalTarget}\n` +
                                `📲 *Pasien Berhasil Dikirimi (Aktif):* ${blastResult.pasienTerkirim}\n` +
                                `🚫 *Dilewati (Rujukan Habis):* ${blastResult.pasienSkipRujukanHabis}\n` +
                                `⚠️ *Nomor WA Tidak Terdaftar:* ${blastResult.pasienWaTidakTerdaftar}\n` +
                                `⚠️ *Pasien Gagal:* ${blastResult.pasienGagal}\n` +
                                `👨‍⚕️ *Laporan DPJP Terkirim:* ${blastResult.laporanDokterTerkirim} Laporan (Satu-Satu)\n`;

                            if (blastResult.isSenderConverted) {
                                rekapAkhir += `🎯 *Catatan:* Pesan dialihkan ke WhatsApp pengirim (${blastResult.convertedToPhone}).\n`;
                            }

                            rekapAkhir += `\n_Seluruh status Pasien dan Dokter di Google Spreadsheet berhasil diperbarui ke Terkirim._ 📊`;
                            await sock.sendMessage(senderInfo.targetJid, { text: rekapAkhir }, { quoted: msg });
                        } catch (e) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Terjadi Kesalahan saat eksekusi:* ${e.message}` }, { quoted: msg });
                        }
                        return;

                    case 'caripasien':
                        if (args.length === 0) {
                            await sock.sendMessage(senderInfo.targetJid, { text: "⚠️ Masukkan kata kunci pencarian!\nContoh: *!caripasien 00.06.32.89* atau *!caripasien M. AXA*" }, { quoted: msg });
                            break;
                        }
                        const queryCari = args.join(" ");
                        await sock.sendMessage(senderInfo.targetJid, { text: `🔍 _Mencari data pasien "${queryCari}"..._` }, { quoted: msg });
                        try {
                            const hasilCari = await callSimgosApi("search_patient", { query: queryCari });
                            if (hasilCari.status !== "success" || !hasilCari.data || hasilCari.data.length === 0) {
                                await sock.sendMessage(senderInfo.targetJid, { text: `❌ Data pasien dengan kata kunci *"${queryCari}"* tidak ditemukan.` }, { quoted: msg });
                                break;
                            }

                            let txtMatch = `🎯 *HASIL PENCARIAN PASIEN (${hasilCari.total}):*\n\n`;
                            hasilCari.data.slice(0, 5).forEach((p, idx) => {
                                const iconRujuk = String(p.statusRujukan || "").toLowerCase().includes("habis") ? "🚫 Rujukan Habis" : "✅ Rujukan Aktif";
                                txtMatch += `${idx + 1}. *${p.namaPasien}*\n` +
                                    `   🔖 No. RM: ${p.noRm}\n` +
                                    `   📅 Tgl Masuk: ${p.tglMasuk}\n` +
                                    `   📅 Tgl Kontrol Semula: ${p.tglKontrol}\n` +
                                    `   📅 Tgl Reschedule Baru: *${p.tglReschedule || '-'}*\n` +
                                    `   📱 No. WA: ${p.noHp}\n` +
                                    `   📋 Status Rujukan: *${iconRujuk}*\n` +
                                    `   🔄 Status Reschedule: *${p.statusReschedule || '-'}*\n` +
                                    `   🆔 No. LID: *${p.noLid || '-'}*\n` +
                                    `   🎂 Umur / JK: ${p.umur} / ${p.jenisKelamin}\n\n`;
                            });

                            await sock.sendMessage(senderInfo.targetJid, { text: txtMatch }, { quoted: msg });
                        } catch (e) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal mencari pasien:* ${e.message}` }, { quoted: msg });
                        }
                        return;

                    case 'reschedule':
                        if (args.length < 2) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: "⚠️ Format salah!\nGunakan: *!reschedule <No.RM> <YYYY-MM-DD>*\nContoh: *!reschedule 00.06.32.89 2026-10-15*"
                            }, { quoted: msg });
                            break;
                        }
                        const rmResched = args[0];
                        const dateResched = args[1];

                        await sock.sendMessage(senderInfo.targetJid, { text: `⏳ _Memproses penjadwalan ulang No. RM ${rmResched} ke tanggal ${dateResched}..._` }, { quoted: msg });
                        try {
                            const reschedApi = await callSimgosApi("reschedule_patient", { noRm: rmResched, newDate: dateResched, no_lid: senderInfo.id });
                            if (reschedApi.status === "success") {
                                patientCacheMap.clear();
                                await sock.sendMessage(senderInfo.targetJid, {
                                    text: `✅ *Reschedule Berhasil!*\n\n` +
                                        `🔖 No. RM: *${rmResched}*\n` +
                                        `📅 Tanggal Reschedule Baru: *${dateResched}*\n` +
                                        `📋 Status Database: *Reschedule (${dateResched})*\n` +
                                        `💾 Kolom 19 (Tanggal Reschedule) berhasil diperbarui ke ${dateResched}.`
                                }, { quoted: msg });
                            } else {
                                throw new Error(reschedApi.message);
                            }
                        } catch (e) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal Reschedule:* ${e.message}` }, { quoted: msg });
                        }
                        return;

                    case 'statskontrol':
                    case 'statssimgos':
                        await sock.sendMessage(senderInfo.targetJid, { text: "⏳ _Menghitung statistik follow-up klinik..._" }, { quoted: msg });
                        try {
                            const statsRes = await callSimgosApi("get_summary_stats");
                            if (statsRes.status === "success") {
                                const s = statsRes.statistics;
                                const repStats = `📊 *STATISTIK KONTROL POLI SIMGOS*\n` +
                                    `📅 Tanggal Server: ${statsRes.date}\n\n` +
                                    `📁 Total Pasien Terdata: *${s.total_pasien_terdata} Pasien*\n` +
                                    `📥 Di-scrape Hari Ini: *${s.scraped_hari_ini} Pasien*\n\n` +
                                    `*Status Rujukan:* \n` +
                                    `✅ Rujukan Aktif: ${s.rujukan_aktif || 0} Pasien\n` +
                                    `🚫 Rujukan Habis: ${s.rujukan_habis || 0} Pasien\n` +
                                    `🔄 Total Reschedule: ${s.total_reschedule || 0} Pasien\n\n` +
                                    `*Status Follow-up H-2:*\n` +
                                    `⏳ Pending: ${s.h2_wa_pending} | ✅ Terkirim/Hadir: ${s.h2_wa_terkirim}\n\n` +
                                    `*Status Follow-up H-1 (Pengingat Besok):*\n` +
                                    `⏳ Pending: ${s.h1_wa_pending} | ✅ Terkirim/Hadir: ${s.h1_wa_terkirim}\n\n` +
                                    `🏥 *Faskes:* ${statsRes.config.instansi}\n` +
                                    `🦷 *Klinik:* ${statsRes.config.poli}\n` +
                                    `⏰ *Jadwal Auto Blast:* Jam ${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA`;
                                await sock.sendMessage(senderInfo.targetJid, { text: repStats }, { quoted: msg });
                            } else throw new Error(statsRes.message);
                        } catch (e) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal mengambil statistik:* ${e.message}` }, { quoted: msg });
                        }
                        return;

                    case 'settingssimgos':
                        try {
                            const cfg = await callSimgosApi("get_active_prompt");
                            if (cfg.status === "success") {
                                const c = cfg.config;
                                let txtCfg = `⚙️ *KONFIGURASI SISTEM SIMGOS KONTROL*\n\n` +
                                    `🕒 Jam Auto Blast: *${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA*\n` +
                                    `🔄 Status Auto Follow-up: *${botSettings.autoFollowupSimgos ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}*\n` +
                                    `⏳ Jeda Anti-Spam Blast: *${c.delayChat || 60} Detik / Pasien & Dokter*\n` +
                                    `🏥 Instansi: ${c.instansi}\n` +
                                    `🦷 Poli: ${c.poli}\n\n` +
                                    `*Dokter DPJP Terdaftar:*\n`;
                                c.doctors.forEach((doc, i) => {
                                    txtCfg += `${i + 1}. ${doc.name} (${doc.wa})\n`;
                                });
                                await sock.sendMessage(senderInfo.targetJid, { text: txtCfg }, { quoted: msg });
                            }
                        } catch (e) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Error:* ${e.message}` }, { quoted: msg });
                        }
                        return;

                    case 'templatesimgos':
                        try {
                            const sysCfg = await fetchSystemAIConfig();
                            let tplTxt = `📝 *TEMPLATE PESAN SPREADSHEET (CUSTOM_FORMAT):*\n\n`;
                            for (const [kode, isi] of Object.entries(sysCfg.templates)) {
                                tplTxt += `🔖 *Kode:* \`${kode}\`\n${isi}\n\n-------------------------\n\n`;
                            }
                            await sock.sendMessage(senderInfo.targetJid, { text: tplTxt }, { quoted: msg });
                        } catch (e) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Error:* ${e.message}` }, { quoted: msg });
                        }
                        return;

                    case 'autofollowup':
                        if (args[0] === 'on' || args[0] === 'off') {
                            botSettings.autoFollowupSimgos = args[0] === 'on';
                            saveSettings();
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚙️ Fitur *Auto Follow-up Kontrol (${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA)* disetel ke: *${args[0].toUpperCase()}*`
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `Status Auto Follow-up: *${botSettings.autoFollowupSimgos ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}*\nJam Blast: *${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA*\nGunakan: *!autofollowup on*, *!autofollowup off*, atau *!setjamfollowup <HH:mm>*`
                            }, { quoted: msg });
                        }
                        return;

                    case 'setdelaychat':
                    case 'setdelay':
                    case 'delaychat':
                        if (args.length === 0 || isNaN(parseInt(args[0], 10))) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ Format salah!\nGunakan format: *!setdelaychat <detik>*\nContoh: *!setdelaychat 60* (Disarankan 45-60 detik agar aman dari spam WA).`
                            }, { quoted: msg });
                            break;
                        }
                        const newDelaySec = Math.max(5, parseInt(args[0], 10));
                        try {
                            await callSimgosApi("update_setting", { param: "DELAY_CHAT", value: String(newDelaySec) });
                            cachedSystemConfig.delayChat = newDelaySec;
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `✅ *JEDA ANTI-SPAM CHAT BLAST BERHASIL DIUPDATE!*\n\n⏳ *Delay Baru:* *${newDelaySec} detik* / pasien & dokter.\n💾 *Penyimpanan:* Tersimpan di Sheet 'SETTING' (Parameter: DELAY_CHAT).`
                            }, { quoted: msg });
                        } catch (errDelay) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal memperbarui delay di Sheet:* ${errDelay.message}` }, { quoted: msg });
                        }
                    case 'fixsender':
                    case 'syncsender':
                        await sock.sendMessage(senderInfo.targetJid, { text: "⏳ _Menyinkronkan Kolom O (No Sender) di Google Spreadsheet ke format No WA Asli (628xxx)..._" }, { quoted: msg });
                        try {
                            const fixRes = await callSimgosApi("fix_sender_columns");
                            if (fixRes && fixRes.status === "success") {
                                await sock.sendMessage(senderInfo.targetJid, {
                                    text: `✅ *STANDARISASI KOLOM O (NO SENDER) BERHASIL!*\n\n` +
                                        `📊 *Total Baris Pasien Dirapikan:* ${fixRes.fixedCount} baris\n` +
                                        `📱 *Kolom O (15):* Resmi menyimpan No WA Asli (*628xxxxxxxxxx*)\n` +
                                        `🆔 *Kolom R (18):* Tetap aman menyimpan No LID WhatsApp (*1106...*) 📊`
                                }, { quoted: msg });
                            } else throw new Error(fixRes?.message || "Gagal sinkronisasi");
                        } catch (e) {
                            await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Gagal menyinkronkan Kolom O:* ${e.message}` }, { quoted: msg });
                        }
                        return;

                    case 'getprompt':
                        const activeCfg = await fetchSystemAIConfig();
                        const geminiMasked = activeCfg.geminiApiKey ? `${activeCfg.geminiApiKey.substring(0, 8)}...${activeCfg.geminiApiKey.slice(-4)}` : "TIDAK TERPASANG";
                        const groqMasked = activeCfg.groqApiKey ? `${activeCfg.groqApiKey.substring(0, 8)}...${activeCfg.groqApiKey.slice(-4)}` : "TIDAK TERPASANG";

                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `📋 *SYSTEM PROMPT AKTIF (RSKD GIGI DAN MULUT PROV. SULSEL):*\n\n"${activeCfg.prompt}"\n\n` +
                                `🤖 *KREDENSIAL AI & MULTI-CASCADE PIPELINE:*\n` +
                                `• Engine Utama (VPS 9Router): *${activeCfg.nineRouterUrl}*\n` +
                                `• Model Utama: *${activeCfg.nineRouterModel}*\n` +
                                `• Model Fallback Antigravity: *${activeCfg.nineRouterFallbackModel}*\n` +
                                `• Cadangan 1 (Gemini Direct): *${activeCfg.geminiModel}* (${geminiMasked})\n` +
                                `• Cadangan 2 (Groq AI): *${activeCfg.groqModel}* (${groqMasked})\n` +
                                `• Total Template: *${Object.keys(activeCfg.templates).length} Template*\n\n` +
                                `_Ketik *!test9router* untuk memeriksa koneksi atau *!test9router ag* untuk menguji Antigravity._`
                        }, { quoted: msg });
                        return;

                    case 'clearpromptcache':
                        cachedSystemConfig = {
                            prompt: '',
                            templates: {},
                            instansi: 'RSKD Gigi dan Mulut Prov. Sulsel',
                            poli: 'Poli Konservasi dan Endodonsi',
                            dpjpUtama: 'drg. Hj. Kurniawaty, Sp.KG',
                            dpjpUtamaWa: '6282291675363',
                            dpjpPendamping: 'drg. M. Aksa Arsyad',
                            geminiApiKey: '',
                            geminiModel: 'gemini-3.5-flash',
                            groqApiKey: '',
                            groqModel: 'openai/gpt-oss-120b',
                            nineRouterUrl: normalize9RouterUrl(process.env.NINEROUTER_URL),
                            nineRouterApiKey: (process.env.NINEROUTER_API_KEY || '9router').trim().replace(/^["']|["']$/g, ''),
                            nineRouterModel: sanitize9RouterModel(process.env.NINEROUTER_MODEL || 'gemini-3.8-flash'),
                            nineRouterFallbackModel: sanitize9RouterModel(process.env.NINEROUTER_FALLBACK_MODEL || 'ag/gemini-3.8-flash-high'),
                            doctors: [],
                            delayChat: 60,
                            timestamp: 0
                        };
                        lidToPhoneMap.clear();
                        phoneToLidMap.clear();
                        patientCacheMap.clear();
                        conversationSessions.clear();
                        if (fs.existsSync(lidCacheFile)) {
                            try { fs.unlinkSync(lidCacheFile); } catch (e) { }
                        }
                        await prewarmDoctorAndOwnerLids(sock);
                        await convertAllPatientsToLid(sock, true);
                        await sock.sendMessage(senderInfo.targetJid, { text: "🔄 Seluruh Cache Prompt, Template, Data Pasien & Konfigurasi 9Router VPS (Gemini & Antigravity) berhasil disegarkan!" }, { quoted: msg });
                        return;

                    case 'ping':
                        const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
                        await sock.sendMessage(senderInfo.targetJid, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingProcess} ms` }, { quoted: msg });
                        return;

                    case 'runtime':
                        const uptime = process.uptime();
                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `⏳ *Bot Uptime:* ${getRelativeTime(uptime)}\n🖥️ *OS Memory:* ${Math.round(os.freemem() / 1024 / 1024)}MB / ${Math.round(os.totalmem() / 1024 / 1024)}MB\n⚡ Server Time: ${getWitaTimeGreeting().fullWitaStr}`
                        }, { quoted: msg });
                        return;

                    case 'sticker':
                    case 's':
                        if (typeof handleStickerCommand === 'function') {
                            await handleStickerCommand(sock, msg);
                        }
                        return;

                    default:
                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `❓ *Perintah Tidak Dikenali: \`!${command}\`*\n\nKetik *!menu* atau *!help* untuk melihat daftar seluruh perintah resmi bot RSKDGM.`
                        }, { quoted: msg });
                        return;
                }
            }

            // Command Guarding: Jika pesan tidak diawali '!', periksa apakah kata pertamanya adalah command di menu !help
            // Mencegah perintah bot dijawab oleh AI secara keliru!
            const cleanRawText = text.trim();
            const firstWord = cleanRawText.split(/[\s\n]+/)[0]?.toLowerCase().replace(/^[!./]/, '');
            if (firstWord && BOT_COMMAND_SET.has(firstWord)) {
                if (firstWord === 'menu' || firstWord === 'help') {
                    const helpHint = `*🤖 BOT KONTROL RSKDGM (H-2 & H-1 SIMGOS) 🤖*\n\n` +
                        `*Gunakan tanda seru (!)* di awal perintah untuk menjalankan command sistem, contoh:\n` +
                        `* !menu / !help* - Menampilkan daftar perintah\n` +
                        `* !followup h1 / h2 / h3* - Cek antrean pasien kontrol\n` +
                        `* !followupnow h1 / h2* - Eksekusi blast kontrol H-1 / H-2\n` +
                        `* !statskontrol* - Cek ringkasan statistik kontrol\n` +
                        `* !settingssimgos* - Cek status konfigurasi & DPJP\n` +
                        `* !caripasien <Nama/RM>* - Pencarian data pasien\n\n` +
                        `Ketik *!menu* untuk melihat panduan perintah lengkap.`;
                    await sock.sendMessage(senderInfo.targetJid, { text: helpHint }, { quoted: msg });
                    return;
                } else {
                    await sock.sendMessage(senderInfo.targetJid, {
                        text: `⚠️ *Format Perintah Terdeteksi*\n\nAnda mengetik perintah *${firstWord}*. Untuk mengeksekusi perintah bot sistem, mohon awali dengan tanda seru (*!*):\n👉 Contoh: *!${cleanRawText}*\n\nKetik *!menu* untuk melihat daftar perintah resmi.`
                    }, { quoted: msg });
                    return;
                }
            }

            // =====================================================================
            // 2. HYBRID INTELLIGENT CHAT ENGINE DENGAN AUTO-VERIFIED IDENTITY
            // =====================================================================
            await sock.sendPresenceUpdate('composing', senderInfo.targetJid);

            const sysConfig = await fetchSystemAIConfig();
            const targetDpjpUtamaWa = sysConfig.doctors?.[0]?.wa || sysConfig.dpjpUtamaWa || "6282291675363";
            const targetDpjpUtamaJid = sanitizeNumber(targetDpjpUtamaWa);

            // VERIFIKASI IDENTITAS PASIEN SECARA CERDAS LINTAS LID <-> HP <-> NAMA <-> RM (REAL-TIME)
            const patientData = await smartVerifyPatient(sock, senderInfo, pushName, text);
            if (patientData && patientData.noRm && patientData.noRm !== "-") {
                console.log(`[Pasien Terverifikasi] Nama Resmi: ${patientData.namaPasien} | RM: ${patientData.noRm} | Tgl Kontrol: ${patientData.tglKontrol} | Reschedule Baru: ${patientData.tglReschedule || '-'}`);
            } else {
                console.log(`[Pengirim Belum Terdaftar] Sender ID: ${senderInfo.id} | PushName: ${pushName}`);
            }

            const officialPatientName = (patientData && patientData.namaPasien && patientData.namaPasien !== "-")
                ? patientData.namaPasien
                : pushName;

            const isPatientVerified = !!(patientData && patientData.noRm && patientData.noRm !== "-" && patientData.tglKontrol && patientData.tglKontrol !== "Terjadwal");

            const pObj = isPatientVerified ? patientData : {
                namaPasien: officialPatientName,
                noRm: "-",
                tglKontrol: "Terjadwal",
                tglMasuk: "-",
                umur: "-",
                agama: "-",
                jenisKelamin: "-",
                noHp: senderInfo.resolvedPhone || senderInfo.id,
                noSender: senderInfo.id,
                statusReschedule: "-",
                statusRujukan: "Rujukan Aktif",
                noLid: senderInfo.id,
                tglReschedule: "-"
            };

            let intent = detectPatientIntent(text);

            // Cek apakah ada konfirmasi yang tertunda dari chat sebelumnya
            const sessionKey = senderInfo.id || senderInfo.targetJid;
            let userSession = conversationSessions.get(sessionKey);
            if (isPatientVerified && userSession && userSession.pendingIntent && intent.type === 'OTHER') {
                intent = userSession.pendingIntent;
                delete userSession.pendingIntent;
                console.log(`[Auto-Resume Intent] Melanjutkan konfirmasi tertunda: ${intent.type} untuk pasien ${patientData.namaPasien} (RM: ${patientData.noRm})`);
            }

            // PROTEKSI MUTLAK: JIKA PASIEN MENCOBA KONFIRMASI (HADIR, RESCHEDULE, JKN) NAMUN BELUM TERVERIFIKASI
            if ((intent.type === 'HADIR' || intent.type === 'RESCHEDULE' || intent.type === 'TERBATALKAN_JKN') && !isPatientVerified) {
                if (!userSession) {
                    userSession = { history: [], lastSeen: Date.now() };
                    conversationSessions.set(sessionKey, userSession);
                }
                userSession.pendingIntent = intent;
                userSession.lastSeen = Date.now();

                const wita = getWitaTimeGreeting();
                const intentLabel = intent.type === 'HADIR' ? 'KEHADIRAN' : (intent.type === 'RESCHEDULE' ? 'JADWAL ULANG (RESCHEDULE)' : 'MOBILE JKN');
                const askVerificationMsg = `${wita.greeting}, Bapak/Ibu *${pushName || 'Pasien'}*. 🙏\n\n` +
                    `Terima kasih atas konfirmasi Anda. Mohon maaf, nomor WhatsApp Anda belum terhubung otomatis dengan data jadwal kontrol di *RSKD Gigi dan Mulut Prov. Sulsel*.\n\n` +
                    `Agar konfirmasi *${intentLabel}* Anda dapat kami catat dengan benar di sistem, mohon balas pesan ini dengan mengetikkan:\n` +
                    `📌 *Nomor Rekam Medis (No. RM)* Anda (Contoh: *123456*)\n` +
                    `atau\n` +
                    `📌 *Nama Lengkap Pasien* sesuai kartu berobat/pendaftaran.\n\n` +
                    `Tim poli kami akan segera mencocokkan jadwal kontrol Anda bersama Dokter Penanggung Jawab (*${sysConfig.dpjpUtama}*). Terima kasih banyak. 🙏🦷`;

                await sock.sendMessage(senderInfo.targetJid, { text: askVerificationMsg });
                await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                return;
            }

            // JALUR KHUSUS: PASIEN MENYATAKAN "TERBATALKAN DI APLIKASI MOBILE JKN"
            if (intent.type === 'TERBATALKAN_JKN') {
                if (patientData && patientData.noRm) {
                    try {
                        await callSimgosApi("update_status", {
                            noRm: patientData.noRm,
                            type: "reschedule",
                            status: "Terbatalkan Mobile JKN",
                            no_lid: senderInfo.id
                        });
                        patientData.statusReschedule = "Terbatalkan Mobile JKN";
                        if (patientData.noRm) cachePatientObject(patientData.noRm, patientData);
                        if (senderInfo.id) cachePatientObject(senderInfo.id, patientData);
                        if (patientData.noHp) cachePatientObject(formatToInternational(patientData.noHp), patientData);
                    } catch (e) { }
                }

                const templateLaporanJkn = sysConfig.templates["WA_LAPORAN_TERBATALKAN_JKN"];
                if (templateLaporanJkn) {
                    const notifDokterJkn = compileTemplateText(templateLaporanJkn, pObj, sysConfig);
                    try {
                        await sock.sendMessage(targetDpjpUtamaJid, { text: notifDokterJkn });
                        console.log(`[Laporan Terbatalkan JKN Terkirim ke DPJP Utama] ${targetDpjpUtamaJid}`);
                    } catch (docErr) { }
                }

                const templateBalasJkn = sysConfig.templates["WA_PX_TERBATALKAN_JKN_CONFIRM"];
                let replyJknPasien = "";
                if (templateBalasJkn) {
                    replyJknPasien = compileTemplateText(templateBalasJkn, pObj, sysConfig);
                } else {
                    replyJknPasien = `Baik Bapak/Ibu *${officialPatientName}* (No. RM: ${pObj.noRm}), terima kasih banyak atas konfirmasinya. 🙏\n\n` +
                        `Laporan bahwa jadwal kontrol Anda terbatalkan oleh sistem di aplikasi *Mobile JKN* telah kami teruskan langsung ke Dokter Penanggung Jawab (*${sysConfig.dpjpUtama}*).\n\n` +
                        `Tim poli kami akan segera mengoordinasikan jadwal kontrol pengganti dan kami akan mengabarkan tanggal pastinya kepada Anda di nomor WhatsApp ini ya.\n\n` +
                        `Mohon ditunggu ya, Bapak/Ibu. Salam sehat selalu dari *${sysConfig.poli} - ${sysConfig.instansi}*. 🦷✨`;
                }

                await sock.sendMessage(senderInfo.targetJid, { text: replyJknPasien });
                await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                return;
            }

            // JALUR KHUSUS: PENGIRIM MENYATAKAN "SALAH ORANG / SALAH NOMOR"
            if (intent.type === 'SALAH_ORANG') {
                const witaTime = getWitaTimeGreeting();
                const wrongPersonReply = `${witaTime.greeting}, Bapak/Ibu *${officialPatientName}*. Mohon maaf yang sebesar-besarnya atas ketidaknyamanan pesan sebelumnya. 🙏\n\n` +
                    `Kemungkinan nomor telepon ini salah tercatat pada antrean pendaftaran pasien kami di *RSKD Gigi dan Mulut Prov. Sulsel*.\n\n` +
                    `Silakan abaikan pesan pengingat tersebut jika Anda tidak memiliki jadwal perawatan di Poli Konservasi. Terima kasih banyak atas konfirmasinya. Salam sehat selalu! 🙏✨`;

                await sock.sendMessage(senderInfo.targetJid, { text: wrongPersonReply }, { quoted: msg });
                await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                return;
            }

            // JALUR 1: PASIEN KONFIRMASI "HADIR"
            if (intent.type === 'HADIR') {
                if (patientData && patientData.noRm) {
                    try {
                        await callSimgosApi("update_status", {
                            noRm: patientData.noRm,
                            type: "pasien",
                            status: "Hadir (Terkonfirmasi)",
                            mode: "h2",
                            no_lid: senderInfo.id
                        });
                        await callSimgosApi("update_status", {
                            noRm: patientData.noRm,
                            type: "pasien",
                            status: "Hadir (Terkonfirmasi)",
                            mode: "h1",
                            no_lid: senderInfo.id
                        });
                        patientData.statusWaH2 = "Hadir (Terkonfirmasi)";
                        patientData.statusWaH1 = "Hadir (Terkonfirmasi)";
                        patientData.statusWa = "Hadir (Terkonfirmasi)";
                        if (patientData.noRm) cachePatientObject(patientData.noRm, patientData);
                        if (senderInfo.id) cachePatientObject(senderInfo.id, patientData);
                        if (patientData.noHp) cachePatientObject(formatToInternational(patientData.noHp), patientData);
                    } catch (e) { }
                }

                const templateLaporanHadir = sysConfig.templates["WA_LAPORAN_HADIR_DOKTER"];
                if (templateLaporanHadir) {
                    const notifDokterHadir = compileTemplateText(templateLaporanHadir, pObj, sysConfig);
                    try {
                        await sock.sendMessage(targetDpjpUtamaJid, { text: notifDokterHadir });
                    } catch (docErr) { }
                }

                const templateBalasHadir = sysConfig.templates["WA_PX_HADIR_CONFIRM"];
                if (templateBalasHadir) {
                    const replyHadir = compileTemplateText(templateBalasHadir, pObj, sysConfig);
                    await sock.sendMessage(senderInfo.targetJid, { text: replyHadir });
                }

                await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                return;
            }

            // JALUR 2: PASIEN INGIN "RESCHEDULE"
            if (intent.type === 'RESCHEDULE') {
                if (intent.date) {
                    const newDate = intent.date;
                    if (patientData && patientData.noRm) {
                        try {
                            await callSimgosApi("reschedule_patient", {
                                noRm: patientData.noRm,
                                newDate: newDate,
                                no_lid: senderInfo.id
                            });
                            patientData.tglReschedule = newDate;
                            patientData.statusReschedule = `Reschedule (${newDate})`;
                            if (patientData.noRm) cachePatientObject(patientData.noRm, patientData);
                            if (senderInfo.id) cachePatientObject(senderInfo.id, patientData);
                            if (patientData.noHp) cachePatientObject(formatToInternational(patientData.noHp), patientData);
                        } catch (e) { }
                    }

                    const updatedPatientObj = {
                        ...pObj,
                        tglReschedule: newDate,
                        statusReschedule: `Reschedule (${newDate})`,
                        noSender: senderInfo.id,
                        noLid: senderInfo.id
                    };

                    const templateLaporanResched = sysConfig.templates["WA_LAPORAN_RESCHEDULE_DOKTER"];
                    if (templateLaporanResched) {
                        const notifResched = compileTemplateText(templateLaporanResched, updatedPatientObj, sysConfig);
                        try {
                            await sock.sendMessage(targetDpjpUtamaJid, { text: notifResched });
                        } catch (docErr) { }
                    }

                    const templateBalasResched = sysConfig.templates["WA_PX_RESCHEDULE"];
                    if (templateBalasResched) {
                        const replyResched = compileTemplateText(templateBalasResched, updatedPatientObj, sysConfig);
                        await sock.sendMessage(senderInfo.targetJid, { text: replyResched });
                    }

                    await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                    return;
                }

                if (patientData && patientData.noRm) {
                    try {
                        await callSimgosApi("update_status", {
                            noRm: patientData.noRm,
                            type: "reschedule",
                            status: "Reschedule Diajukan",
                            no_lid: senderInfo.id
                        });
                        patientData.statusReschedule = "Reschedule Diajukan";
                        if (patientData.noRm) cachePatientObject(patientData.noRm, patientData);
                        if (senderInfo.id) cachePatientObject(senderInfo.id, patientData);
                        if (patientData.noHp) cachePatientObject(formatToInternational(patientData.noHp), patientData);
                    } catch (e) { }
                }

                const templateTanyaTanggal = sysConfig.templates["WA_PX_RESCHEDULE_ASK"];
                if (templateTanyaTanggal) {
                    const replyAskDate = compileTemplateText(templateTanyaTanggal, pObj, sysConfig);
                    await sock.sendMessage(senderInfo.targetJid, { text: replyAskDate });
                }

                await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                return;
            }

            // JALUR 3: PERCAKAPAN UMUM, TANYA NOMOR RM & KONSULTASI GIGI DENGAN AI
            if (!userSession) {
                userSession = conversationSessions.get(sessionKey) || { history: [], lastSeen: Date.now() };
                conversationSessions.set(sessionKey, userSession);
            }
            userSession.lastSeen = Date.now();

            userSession.history.push({
                role: 'user',
                parts: [{ text: text.trim() || "(Mengirimkan lampiran dokumen/gambar)" }]
            });

            if (userSession.history.length > 10) {
                userSession.history = userSession.history.slice(-10);
            }

            const typingTimer = setInterval(async () => {
                try { await sock.sendPresenceUpdate('composing', senderInfo.targetJid); } catch (e) { }
            }, 4000);

            let rawAiResponse = "";
            try {
                rawAiResponse = await askAIClinicUnified(userSession.history, patientData, pushName, senderInfo);
            } catch (aiErr) {
                console.error("[Multi-Gateway AI Fatal Error]", aiErr.message);
                const witaTime = getWitaTimeGreeting();
                if (patientData && patientData.noRm) {
                    let hasResched = (patientData.tglReschedule && patientData.tglReschedule !== "-");
                    let finalReschedDate = hasResched ? patientData.tglReschedule : "";
                    if (!finalReschedDate && patientData.statusReschedule) {
                        const mMatch = patientData.statusReschedule.match(/\b(\d{4}-\d{2}-\d{2})\b/);
                        if (mMatch) { finalReschedDate = mMatch[1]; hasResched = true; }
                    }

                    if (hasResched) {
                        rawAiResponse = `${witaTime.greeting}, Bapak/Ibu ${officialPatientName}. Berdasarkan catatan sistem rekam medis RSKD Gigi dan Mulut Prov. Sulsel, jadwal kontrol perawatan gigi Anda yang semula pada tanggal ${patientData.tglKontrol} telah resmi dialihkan/dijadwalkan ulang ke tanggal *${finalReschedDate}* bersama DPJP Utama kami, ${sysConfig.dpjpUtama}. Nomor Rekam Medis (RM) Anda adalah *${patientData.noRm}*. Mohon untuk hadir tepat waktu ya, Pak/Bu. Terima kasih. 🙏`;
                    } else {
                        rawAiResponse = `${witaTime.greeting}, Bapak/Ibu ${officialPatientName}. Nomor Rekam Medis (RM) Anda yang terdaftar di Poli Konservasi RSKD Gigi dan Mulut Prov. Sulsel adalah *${patientData.noRm}* dengan jadwal kontrol pada tanggal *${patientData.tglKontrol}*. Ada yang dapat kami bantu terkait administrasi perawatan gigi Anda? 🙏`;
                    }
                } else {
                    rawAiResponse = `${witaTime.greeting}, Bapak/Ibu ${officialPatientName}. Terima kasih telah menghubungi Layanan Informasi Medis Poli Konservasi RSKD Gigi dan Mulut Prov. Sulsel. Pesan Anda telah kami terima, ada hal yang dapat kami bantu terkait jadwal kontrol atau perawatan gigi Anda? 🙏`;
                }
            } finally {
                clearInterval(typingTimer);
            }

            // Deteksi Tag Aksi [ACTION:TERBATALKAN_JKN] dari AI
            if (rawAiResponse.includes('[ACTION:TERBATALKAN_JKN]')) {
                rawAiResponse = rawAiResponse.replace(/\[ACTION:TERBATALKAN_JKN\]/gi, '').trim();

                if (patientData && patientData.noRm) {
                    await callSimgosApi("update_status", {
                        noRm: patientData.noRm,
                        type: "reschedule",
                        status: "Terbatalkan Mobile JKN",
                        no_lid: senderInfo.id
                    }).catch(() => { });
                    patientCacheMap.delete(patientData.noRm);
                    patientCacheMap.delete(senderInfo.id);
                }

                const templateLaporanJkn = sysConfig.templates["WA_LAPORAN_TERBATALKAN_JKN"];
                if (templateLaporanJkn) {
                    const notifDokterJkn = compileTemplateText(templateLaporanJkn, pObj, sysConfig);
                    try {
                        await sock.sendMessage(targetDpjpUtamaJid, { text: notifDokterJkn });
                    } catch (e) { }
                }
            }

            // Deteksi Tag Aksi [ACTION:HADIR] dari AI
            if (rawAiResponse.includes('[ACTION:HADIR]')) {
                rawAiResponse = rawAiResponse.replace(/\[ACTION:HADIR\]/gi, '').trim();

                if (patientData && patientData.noRm) {
                    await callSimgosApi("update_status", {
                        noRm: patientData.noRm,
                        type: "pasien",
                        status: "Hadir (Terkonfirmasi)",
                        no_lid: senderInfo.id
                    }).catch(() => { });
                    patientCacheMap.delete(patientData.noRm);
                    patientCacheMap.delete(senderInfo.id);
                }

                const templateLaporanHadir = sysConfig.templates["WA_LAPORAN_HADIR_DOKTER"];
                if (templateLaporanHadir) {
                    const notifDokter = compileTemplateText(templateLaporanHadir, pObj, sysConfig);
                    try {
                        await sock.sendMessage(targetDpjpUtamaJid, { text: notifDokter });
                    } catch (e) { }
                }
            }

            // Deteksi Tag Aksi [ACTION:RESCHEDULE:YYYY-MM-DD] dari AI
            const rescheduleMatch = rawAiResponse.match(/\[ACTION:RESCHEDULE:(\d{4}-\d{2}-\d{2})\]/i);
            let finalClientReply = rawAiResponse.replace(/\[ACTION:RESCHEDULE:\d{4}-\d{2}-\d{2}\]/gi, '').trim();

            if (rescheduleMatch) {
                const newRescheduleDate = rescheduleMatch[1];
                if (patientData && patientData.noRm) {
                    try {
                        await callSimgosApi("reschedule_patient", {
                            noRm: patientData.noRm,
                            newDate: newRescheduleDate,
                            no_lid: senderInfo.id
                        });
                        patientCacheMap.delete(patientData.noRm);
                        patientCacheMap.delete(senderInfo.id);
                    } catch (reschedErr) { }
                }

                const updatedPx = {
                    ...pObj,
                    tglReschedule: newRescheduleDate,
                    statusReschedule: `Reschedule (${newRescheduleDate})`,
                    noSender: senderInfo.id,
                    noLid: senderInfo.id
                };

                const templateLaporanResched = sysConfig.templates["WA_LAPORAN_RESCHEDULE_DOKTER"];
                if (templateLaporanResched) {
                    const notifResched = compileTemplateText(templateLaporanResched, updatedPx, sysConfig);
                    try {
                        await sock.sendMessage(targetDpjpUtamaJid, { text: notifResched });
                    } catch (e) { }
                }
            }

            userSession.history.push({
                role: 'model',
                parts: [{ text: finalClientReply }]
            });

            const formattedReply = formatForWhatsApp(finalClientReply);
            await sock.sendMessage(senderInfo.targetJid, { text: formattedReply });
            await sock.sendPresenceUpdate('paused', senderInfo.targetJid);

        } catch (error) {
            console.error('Error proses pesan:', error);
        }
    });
}
