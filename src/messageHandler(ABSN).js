import fs from 'fs';
import process from 'process';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// =========================================================================
// KONFIGURASI SISTEM & REST API WEB ABSENSI V7 (DEPT. RKG)
// =========================================================================
const WEB_ABSENSI_API_URL = process.env.WEB_ABSENSI_API_URL || "http://localhost:3000/api";
const WEB_PORTAL_URL = process.env.WEB_PORTAL_URL || "http://localhost:3000";
const OWNER_NUMBER = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

const ADMIN_JID_LIST = [
    OWNER_NUMBER,
    "6285256739684@s.whatsapp.net",
    "6282291675363@s.whatsapp.net"
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

// Sanitizer Cerdas Nama Model
function sanitize9RouterModel(rawModel) {
    let model = String(rawModel || 'auto').trim();
    model = model.replace(/\s*\([^)]*\)/g, '').trim();
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
const studentCacheFile = `${sessionPath}/student_cache.json`;

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

const lidToPhoneMap = new Map();     // Kunci: LID Digits -> Nilai: Phone Digits (628xxx)
const phoneToLidMap = new Map();     // Kunci: Phone Digits (628xxx) -> Nilai: LID Digits
const studentCacheMap = new Map();   // Kunci: Phone Digits / LID Digits / NIM -> { data, cachedAt }

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

if (fs.existsSync(studentCacheFile)) {
    try {
        const savedStudents = JSON.parse(fs.readFileSync(studentCacheFile, 'utf-8'));
        const now = Date.now();
        for (const [k, v] of Object.entries(savedStudents)) {
            if (v && v.cachedAt && (now - v.cachedAt < CACHE_TTL_MS)) {
                studentCacheMap.set(k, v);
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

let persistStudentTimer = null;
function persistStudentCache() {
    if (persistStudentTimer) clearTimeout(persistStudentTimer);
    persistStudentTimer = setTimeout(() => {
        try {
            const obj = Object.fromEntries(studentCacheMap);
            fs.writeFileSync(studentCacheFile, JSON.stringify(obj, null, 2));
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

function cacheStudentObject(key, studentObj) {
    if (!key || !studentObj) return;
    const cleanKey = String(key).replace(/\D/g, '') || String(key).trim();
    studentCacheMap.set(cleanKey, {
        data: studentObj,
        cachedAt: Date.now()
    });
    persistStudentCache();
}

function getCachedStudentObject(key) {
    if (!key) return null;
    const cleanKey = String(key).replace(/\D/g, '') || String(key).trim();
    if (!studentCacheMap.has(cleanKey)) return null;
    const item = studentCacheMap.get(cleanKey);
    if (Date.now() - item.cachedAt > CACHE_TTL_MS) {
        studentCacheMap.delete(cleanKey);
        persistStudentCache();
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

// =========================================================================
// CLIENT REST API WEB ABSENSI V7 (/api/db & /api/wa)
// =========================================================================
async function callDbGet(key = '') {
    const url = key ? `${WEB_ABSENSI_API_URL}/db?key=${encodeURIComponent(key)}` : `${WEB_ABSENSI_API_URL}/db`;
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return json.success ? json.data : null;
    } catch (e) {
        console.error(`[REST API DB GET Error (${key || 'all'})]`, e.message);
        return null;
    }
}

async function callDbSet(key, data) {
    try {
        const res = await fetch(`${WEB_ABSENSI_API_URL}/db`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, data })
        });
        return await res.json();
    } catch (e) {
        console.error(`[REST API DB SET Error (${key})]`, e.message);
        return { success: false, error: e.message };
    }
}

async function callDbSetBatch(batchData) {
    try {
        const res = await fetch(`${WEB_ABSENSI_API_URL}/db`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch: batchData })
        });
        return await res.json();
    } catch (e) {
        console.error(`[REST API DB SET Batch Error]`, e.message);
        return { success: false, error: e.message };
    }
}

async function fetchWaQueue() {
    try {
        const res = await fetch(`${WEB_ABSENSI_API_URL}/wa?action=pull`, { cache: 'no-store' });
        if (!res.ok) return [];
        const json = await res.json();
        return json.success && Array.isArray(json.queue) ? json.queue : [];
    } catch (e) {
        return [];
    }
}

async function deleteWaQueueBatch(messageIds) {
    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) return;
    try {
        await fetch(`${WEB_ABSENSI_API_URL}/wa`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message_ids: messageIds })
        });
    } catch (e) {
        console.error("[REST API WA DELETE Error]", e.message);
    }
}

async function enqueueWaNotification(noHp, scenarioId, payloadData) {
    try {
        const res = await fetch(`${WEB_ABSENSI_API_URL}/wa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ no_hp: noHp, scenario: scenarioId, data: payloadData })
        });
        return await res.json();
    } catch (e) {
        console.error("[REST API WA POST Error]", e.message);
        return { success: false, error: e.message };
    }
}

// =========================================================================
// USYNC & REVERSE RESOLVER (BAILEYS WHATSAPP PROTOCOL)
// =========================================================================
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
                        { tag: 'query', attrs: {}, content: [{ tag: 'contact', attrs: {} }, { tag: 'lid', attrs: {} }] },
                        { tag: 'list', attrs: {}, content: [{ tag: 'user', attrs: { jid: `${cleanPhone}@s.whatsapp.net` } }] }
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
    } catch (err) { }

    return null;
}

async function resolvePhoneFromLid(sock, rawLid) {
    const cleanLid = String(rawLid).replace(/\D/g, '');
    if (!cleanLid) return null;

    if (lidToPhoneMap.has(cleanLid)) {
        return lidToPhoneMap.get(cleanLid);
    }

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

    return null;
}

// SMART VERIFIER: Cocokkan Pengirim dengan Data Mahasiswa di Database Cloud Redis
async function smartVerifyStudent(sock, senderInfo, messageText = "") {
    let matchedStudent = null;

    if (senderInfo.id) matchedStudent = getCachedStudentObject(senderInfo.id);
    if (!matchedStudent && senderInfo.resolvedPhone) matchedStudent = getCachedStudentObject(senderInfo.resolvedPhone);
    if (!matchedStudent && senderInfo.targetJid) matchedStudent = getCachedStudentObject(senderInfo.targetJid);

    if (matchedStudent) return matchedStudent;

    const allStudents = await callDbGet('axaxyz_students');
    if (!Array.isArray(allStudents) || allStudents.length === 0) return null;

    const textNIMMatch = messageText.match(/\b([A-Za-z0-9]{6,12})\b/);
    const candidateNim = textNIMMatch ? textNIMMatch[1].toUpperCase() : null;

    let lookupPhone = senderInfo.resolvedPhone;
    if (!lookupPhone && senderInfo.isLid && lidToPhoneMap.has(senderInfo.id)) {
        lookupPhone = lidToPhoneMap.get(senderInfo.id);
    } else if (!lookupPhone && !senderInfo.isLid) {
        lookupPhone = senderInfo.id;
    }

    const cleanLookupPhone = formatToInternational(lookupPhone);

    for (const st of allStudents) {
        const stPhone = formatToInternational(st.noHp);
        if (cleanLookupPhone && stPhone && stPhone === cleanLookupPhone) {
            matchedStudent = st;
            break;
        }
        if (candidateNim && st.nim && st.nim.toUpperCase() === candidateNim) {
            matchedStudent = st;
            break;
        }
    }

    if (!matchedStudent && senderInfo.isLid) {
        const resolvedPhone = await resolvePhoneFromLid(sock, senderInfo.id);
        if (resolvedPhone) {
            registerIdentityMapping(senderInfo.id, resolvedPhone);
            matchedStudent = allStudents.find(st => formatToInternational(st.noHp) === resolvedPhone);
        }
    }

    if (matchedStudent) {
        if (senderInfo.id) {
            registerIdentityMapping(senderInfo.id, matchedStudent.noHp || senderInfo.id);
            cacheStudentObject(senderInfo.id, matchedStudent);
        }
        if (matchedStudent.noHp) cacheStudentObject(formatToInternational(matchedStudent.noHp), matchedStudent);
        if (matchedStudent.nim) cacheStudentObject(matchedStudent.nim, matchedStudent);
    }

    return matchedStudent;
}

// =========================================================================
// AI ASSISTANT DEPT. RKG (9ROUTER -> GEMINI -> GROQ MULTI-TIER ENGINE)
// =========================================================================
const conversationSessions = new Map();
const SESSION_TTL_MS = 45 * 60 * 1000;

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [k, session] of conversationSessions.entries()) {
        if (now - session.lastSeen > SESSION_TTL_MS) conversationSessions.delete(k);
    }
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000);

async function ask9Router(conversationHistory, systemPromptText) {
    const rawUrl = process.env.NINEROUTER_URL || "http://43.134.43.146:20128/v1/chat/completions";
    const endpoint = normalize9RouterUrl(rawUrl);
    const apiKey = (process.env.NINEROUTER_API_KEY || "9router").trim().replace(/^["']|["']$/g, '');
    const modelsPipeline = [
        sanitize9RouterModel(process.env.NINEROUTER_MODEL || 'axyz-combos'),
        sanitize9RouterModel(process.env.NINEROUTER_FALLBACK_MODEL || 'ag/gemini-3.8-flash-high'),
        'auto'
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    const openAiMessages = [{ role: "system", content: systemPromptText }];
    for (const turn of conversationHistory) {
        const role = turn.role === 'model' ? 'assistant' : 'user';
        const text = turn.parts?.[0]?.text || '';
        if (text.trim()) openAiMessages.push({ role, content: text.trim() });
    }

    let lastErr = null;
    for (const targetModel of modelsPipeline) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000);
        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ model: targetModel, messages: openAiMessages, temperature: 0.2, max_tokens: 2048 }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
            const data = await res.json();
            const reply = data.choices?.[0]?.message?.content;
            if (reply && reply.trim()) return { reply: reply.trim(), model: targetModel };
        } catch (err) {
            clearTimeout(timeoutId);
            lastErr = err;
        }
    }
    throw lastErr || new Error("9Router Gateway gagal");
}

async function askGemini(conversationHistory, systemPromptText) {
    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) throw new Error("GEMINI_API_KEY belum terpasang di .env");
    const model = process.env.GEMINI_MODEL || "axyz-combos";

    const sanitizedHistory = [];
    for (const turn of conversationHistory) {
        if (!turn.parts || !turn.parts[0]?.text) continue;
        const role = turn.role === 'model' ? 'model' : 'user';
        const text = String(turn.parts[0].text).trim();
        if (!text) continue;
        if (sanitizedHistory.length > 0 && sanitizedHistory[sanitizedHistory.length - 1].role === role) {
            sanitizedHistory[sanitizedHistory.length - 1].parts[0].text += `\n${text}`;
        } else {
            sanitizedHistory.push({ role, parts: [{ text }] });
        }
    }

    while (sanitizedHistory.length > 0 && sanitizedHistory[0].role !== 'user') sanitizedHistory.shift();
    if (sanitizedHistory.length === 0) throw new Error('History pesan Gemini kosong');

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: sanitizedHistory,
            systemInstruction: { parts: [{ text: systemPromptText }] },
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
        })
    });

    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
}

async function askGroq(conversationHistory, systemPromptText) {
    const groqKey = (process.env.GROQ_API_KEY || "").trim();
    if (!groqKey) throw new Error("GROQ_API_KEY belum terpasang di .env");

    const groqMessages = [{ role: "system", content: systemPromptText }];
    for (const turn of conversationHistory) {
        const role = turn.role === 'model' ? 'assistant' : 'user';
        const text = turn.parts?.[0]?.text || '';
        if (text.trim()) groqMessages.push({ role, content: text.trim() });
    }

    const modelsToTry = [process.env.GROQ_MODEL || "openai/gpt-oss-120b", ...GROQ_ALLOWED_MODELS];
    for (const model of modelsToTry) {
        try {
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model, messages: groqMessages, temperature: 0.2, max_tokens: 2048 })
            });
            if (res.ok) {
                const data = await res.json();
                const reply = data.choices?.[0]?.message?.content;
                if (reply && reply.trim()) return reply.trim();
            }
        } catch (e) { }
    }
    throw new Error("Seluruh model Groq AI gagal");
}

async function generateRkgAiResponse(senderInfo, pushName, userMessage, studentObj) {
    const { greeting, fullWitaStr } = getWitaTimeGreeting();

    const systemPrompt = `Anda adalah Asisten Virtual Resmi Departemen Radiologi Kedokteran Gigi (Dept. RKG) Rumah Sakit Gigi dan Mulut (RSGM).
Waktu saat ini di Makassar: ${fullWitaStr} (Gunakan sapaan "${greeting}" secara alami).

INFORMASI SISTEM ABSENSI DIGITAL DEPT. RKG:
1. Portal Absensi Web Resmi: ${WEB_PORTAL_URL}
2. Alur 4 Langkah Absensi Mahasiswa:
   - Langkah 1: Pilih Kelompok Stase (Angkatan/Kelompok).
   - Langkah 2: Pilih Shift (Shift Pagi: 07:00 - 09:00 WITA toleransi 15 menit, Shift Siang: 12:00 - 13:30 WITA).
   - Langkah 3: Validasi Liveness Selfie Kamera Real-time & Geofence GPS (Harus dalam radius gedung kampus).
   - Langkah 4: Klik 'Selesai' & Notifikasi WhatsApp otomatis terkirim.
3. Fitur Keamanan:
   - Device Fingerprint: 1 akun mahasiswa terikat permanen dengan 1 perangkat HP fisik (Anti-titip absen).
   - Jika mahasiswa ganti HP, ketik perintah "!logout" di bot WA ini untuk pelepasan perangkat.
   - Jika mahasiswa lupa sandi, ketik "!reset" di bot WA ini untuk reset password baru.
4. Data Mahasiswa Teridentifikasi:
   - Nama: ${studentObj ? studentObj.name : pushName}
   - NIM: ${studentObj ? studentObj.nim : 'Belum Terdaftar'}
   - No HP: ${studentObj ? studentObj.noHp : senderInfo.id}

PANDUAN MENJAWAB:
- Jawablah dengan ramah, profesional, ringkas, dan jelas dalam Bahasa Indonesia.
- Jangan pernah memberikan instruksi di luar prosedur absensi Dept. RKG.
- Gunakan formatting WhatsApp (*bold*, bullet points) agar mudah dibaca di ponsel.`;

    const userKey = senderInfo.id || senderInfo.targetJid;
    if (!conversationSessions.has(userKey)) {
        conversationSessions.set(userKey, { history: [], lastSeen: Date.now() });
    }
    const session = conversationSessions.get(userKey);
    session.lastSeen = Date.now();
    session.history.push({ role: 'user', parts: [{ text: userMessage }] });

    if (session.history.length > 10) session.history = session.history.slice(-10);

    let replyText = "";
    try {
        const r = await ask9Router(session.history, systemPrompt);
        replyText = r.reply;
    } catch (e9) {
        try {
            replyText = await askGemini(session.history, systemPrompt);
        } catch (eGem) {
            try {
                replyText = await askGroq(session.history, systemPrompt);
            } catch (eGrq) {
                replyText = `${greeting} rekan mahasiswa! Maaf, sistem AI kami sedang dalam pemeliharaan berkala. Silakan gunakan perintah langsung seperti *!absen*, *!jadwal*, *!lokasi*, atau *!logout*.`;
            }
        }
    }

    session.history.push({ role: 'model', parts: [{ text: replyText }] });
    return formatForWhatsApp(replyText);
}

// =========================================================================
// BACKGROUND WORKER: AUTOMATED OUTBOX QUEUE DISPATCHER
// =========================================================================
let isQueueWorkerRunning = false;

function startOutboxQueueWorker(sock) {
    if (isQueueWorkerRunning) return;
    isQueueWorkerRunning = true;

    console.log("🚀 [WA Bot Outbox Worker] Background Queue Dispatcher aktif (Interval: 5s)...");

    setInterval(async () => {
        try {
            const queue = await fetchWaQueue();
            if (!queue || queue.length === 0) return;

            console.log(`[WA Bot Outbox] Mendeteksi ${queue.length} pesan antrian dari Web Absensi V7. Mengirim...`);

            const sentMessageIds = [];

            for (const item of queue) {
                if (!item.target_number || !item.formatted_message) continue;

                const targetJid = sanitizeNumber(item.target_number);
                const messageText = formatForWhatsApp(item.formatted_message);

                try {
                    await sock.sendMessage(targetJid, { text: messageText });
                    sentMessageIds.push(item.id);
                    console.log(`[WA Bot Outbox] ✅ Terkirim ke ${targetJid} (ID: ${item.id})`);
                } catch (sendErr) {
                    console.error(`[WA Bot Outbox] ❌ Gagal kirim ke ${targetJid}:`, sendErr.message);
                }

                // Jeda halus anti-ban 800ms per pesan
                await new Promise(r => setTimeout(r, 800));
            }

            if (sentMessageIds.length > 0) {
                await deleteWaQueueBatch(sentMessageIds);
                console.log(`[WA Bot Outbox] 🗑️ Berhasil membersihkan ${sentMessageIds.length} pesan terkirim dari antrian Redis.`);
            }
        } catch (workerErr) {
            console.error("[WA Bot Outbox Worker Error]", workerErr.message);
        }
    }, 5000);
}

// =========================================================================
// HANDLER UTAMA PESAN MASUK (WHATSAPP INBOUND CONTROLLER)
// =========================================================================
export default function setupMessageHandler(sock) {
    // 1. Jalankan Background Queue Dispatcher untuk Outbox Web Absensi
    startOutboxQueueWorker(sock);

    // 2. Dengarkan Pesan Masuk (Upsert)
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) return;

            const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption || '';

            if (!text.trim()) return;

            const rawParticipant = msg.key.participant || msg.key.participantPn || msg.participantPn || '';
            if (rawParticipant && remoteJid.endsWith('@lid')) {
                registerIdentityMapping(remoteJid, rawParticipant);
            }

            const senderInfo = parseSenderInfo(remoteJid);
            const pushName = msg.pushName || "Mahasiswa";
            const trimmedText = text.trim();
            const { greeting } = getWitaTimeGreeting();

            console.log(`[Pesan Masuk] Dari: ${senderInfo.id} (${senderInfo.isLid ? 'LID' : 'Phone'}) | Nama: ${pushName} | Isi: "${trimmedText}"`);

            // Verifikasi Mahasiswa di Database Redis
            const studentObj = await smartVerifyStudent(sock, senderInfo, trimmedText);

            // Tampilkan indikator mengetik (typing presence)
            await sock.sendPresenceUpdate('composing', senderInfo.targetJid);

            // =====================================================================
            // 1. COMMAND SYSTEM (PREFIX '!' ATAU KATA KUNCI LANGSUNG)
            // =====================================================================
            const lowerText = trimmedText.toLowerCase();

            if (trimmedText.startsWith('!') || ['absen', 'jadwal', 'lokasi', 'logout', 'reset', 'rekap', 'menu', 'help'].includes(lowerText)) {
                const cleanCmd = trimmedText.startsWith('!') ? trimmedText.slice(1).trim() : trimmedText;
                const args = cleanCmd.split(/ +/);
                const command = args.shift().toLowerCase();

                switch (command) {
                    case 'menu':
                    case 'help': {
                        const menuText = `*🏥 SISTEM ABSENSI DIGITAL DEPT. RKG 🏥*\n` +
                            `Halo *${studentObj ? studentObj.name : pushName}*, selamat datang di bot asisten resmi Dept. Radiologi Kedokteran Gigi.\n\n` +
                            `*📋 MENU MAHASISWA:*\n` +
                            `• *!absen* - 📲 Dapatkan link portal & panduan absensi\n` +
                            `• *!jadwal* - ⏰ Cek jadwal shift aktif & batas toleransi\n` +
                            `• *!lokasi* - 📍 Cek titik koordinat & radius kampus\n` +
                            `• *!rekap* - 📊 Cek rapor kehadiran (Hadir/Telat/Alpha)\n` +
                            `• *!logout* - 🔓 Lepas ikatan HP (Ganti perangkat absensi)\n` +
                            `• *!reset* - 🔑 Reset kata sandi akun absensi Anda\n` +
                            `• *!kalender* - 🗓️ Cek jadwal hari libur akademik 2026\n\n` +
                            `*🛡️ MENU ADMINISTRATOR:*\n` +
                            `• *!stats* - 📈 Laporan ringkasan kehadiran harian\n` +
                            `• *!broadcast <pesan>* - 📢 Kirim pengumuman massal\n` +
                            `• *!ping* - ⚡ Cek latensi dan status koneksi bot\n\n` +
                            `_Anda juga dapat langsung berkonsultasi/bertanya apa saja seputar absensi dan stase RKG._`;

                        await sock.sendMessage(senderInfo.targetJid, { text: menuText });
                        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                        return;
                    }

                    case 'absen':
                    case 'portal':
                    case 'link': {
                        const replyText = `📲 *PORTAL RESMI ABSENSI DEPT. RKG*\n\n` +
                            `Silakan akses portal absensi melalui tautan berikut:\n` +
                            `🔗 *${WEB_PORTAL_URL}*\n\n` +
                            `*📌 Panduan Wajib 4 Langkah:* \n` +
                            `1️⃣ Buka link di browser HP Anda (Chrome/Safari).\n` +
                            `2️⃣ Pilih Kelompok Stase & Shift Kehadiran Anda.\n` +
                            `3️⃣ Izinkan Kamera & GPS (Pastikan Anda berada di area kampus).\n` +
                            `4️⃣ Masukkan NIM & Sandi, ambil foto selfie liveness, lalu klik *Kirim Absensi*.\n\n` +
                            `_Catatan: HP pertama yang Anda gunakan akan otomatis terkunci permanen untuk akun Anda._`;

                        await sock.sendMessage(senderInfo.targetJid, { text: replyText });
                        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                        return;
                    }

                    case 'jadwal':
                    case 'shift': {
                        const sessions = await callDbGet('axaxyz_sessions');
                        if (!Array.isArray(sessions) || sessions.length === 0) {
                            await sock.sendMessage(senderInfo.targetJid, { text: "⚠️ Saat ini belum ada jadwal shift absensi yang aktif." });
                            return;
                        }

                        let listJadwal = `⏰ *JADWAL SHIFT ABSENSI DEPT. RKG*\n\n`;
                        sessions.forEach((s, idx) => {
                            listJadwal += `*${idx + 1}. ${s.name}* ${s.isActive ? '🟢 (Aktif)' : '⚪ (Nonaktif)'}\n`;
                            listJadwal += `   ⏳ Jam Buka: *${s.startTime}* WITA\n`;
                            listJadwal += `   ⏳ Batas Tutup: *${s.endTime}* WITA\n`;
                            listJadwal += `   ⏳ Toleransi: *${s.toleranceMinutes}* Menit\n\n`;
                        });
                        listJadwal += `_Lakukan absensi tepat waktu untuk menghindari status Terlambat atau Alpha._`;

                        await sock.sendMessage(senderInfo.targetJid, { text: listJadwal });
                        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                        return;
                    }

                    case 'lokasi':
                    case 'gps':
                    case 'geofence': {
                        const gf = await callDbGet('axaxyz_geofence');
                        if (!gf) {
                            await sock.sendMessage(senderInfo.targetJid, { text: "⚠️ Titik koordinat lokasi kampus belum dikonfigurasi." });
                            return;
                        }

                        const mapsUrl = `https://www.google.com/maps?q=${gf.lat},${gf.lng}`;
                        const locText = `📍 *TITIK LOKASI ABSENSI RESMI (GEOFENCE)*\n\n` +
                            `🏢 *Lokasi:* ${gf.name || 'Gedung Kampus Pusat'}\n` +
                            `🌐 *Koordinat:* \`${gf.lat}, ${gf.lng}\`\n` +
                            `🎯 *Batas Radius:* *${gf.radius} Meter*\n` +
                            `🗺️ *Peta Google Maps:* ${mapsUrl}\n\n` +
                            `_Pastikan GPS pada browser Anda aktif dan berada di dalam batas radius maksimal saat menekan tombol Kirim Absensi._`;

                        await sock.sendMessage(senderInfo.targetJid, { text: locText });
                        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                        return;
                    }

                    case 'logout': {
                        // SKENARIO 16: PELEPASAN PERANGKAT (LOGOUT HP)
                        if (!studentObj) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ Nomor WhatsApp Anda (*${senderInfo.id}*) belum terdata sebagai mahasiswa Dept. RKG.\n` +
                                    `Jika Anda ingin melepas perangkat, silakan hubungi Administrator atau ketik NIM Anda terlebih dahulu.`
                            });
                            return;
                        }

                        // Update deviceId: null di database
                        const allStudents = await callDbGet('axaxyz_students') || [];
                        const updatedStudents = allStudents.map(st => {
                            if (st.id === studentObj.id || st.nim === studentObj.nim) {
                                return { ...st, deviceId: null };
                            }
                            return st;
                        });

                        await callDbSet('axaxyz_students', updatedStudents);
                        cacheStudentObject(studentObj.nim, { ...studentObj, deviceId: null });

                        const replyMsg = `🔓 *LOGOUT PERANGKAT BERHASIL* 🔓\n\n` +
                            `Halo *${studentObj.name}* (*${studentObj.nim}*),\n` +
                            `Permintaan pelepasan akses (Logout) perangkat Anda telah berhasil diproses oleh sistem database kami.\n\n` +
                            `Sistem tidak lagi mengunci perangkat lama Anda. Saat Anda melakukan absensi berikutnya di ${WEB_PORTAL_URL}, perangkat baru yang Anda gunakan akan otomatis menjadi perangkat utama yang terikat dengan akun Anda.\n\n` +
                            `Jaga selalu keamanan akun Anda! 🛡️`;

                        await sock.sendMessage(senderInfo.targetJid, { text: replyMsg });
                        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                        return;
                    }

                    case 'reset': {
                        // SKENARIO 19: RESET PASSWORD MAHASISWA
                        if (!studentObj) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ Nomor WhatsApp Anda (*${senderInfo.id}*) belum terdaftar di sistem absensi.\n` +
                                    `Silakan hubungi Administrator Dept. RKG untuk verifikasi data diri Anda.`
                            });
                            return;
                        }

                        // Generate 4-digit PIN baru
                        const newPassword = Math.floor(1000 + Math.random() * 9000).toString();
                        const allStudents = await callDbGet('axaxyz_students') || [];
                        const updatedStudents = allStudents.map(st => {
                            if (st.id === studentObj.id || st.nim === studentObj.nim) {
                                return { ...st, password: newPassword };
                            }
                            return st;
                        });

                        await callDbSet('axaxyz_students', updatedStudents);
                        cacheStudentObject(studentObj.nim, { ...studentObj, password: newPassword });

                        const replyMsg = `♻️ *RESET KATA SANDI BERHASIL* ♻️\n\n` +
                            `Halo *${studentObj.name}*,\n` +
                            `Permintaan reset kata sandi (password) Anda telah berhasil diproses secara real-time oleh sistem.\n\n` +
                            `Berikut adalah kredensial terbaru Anda:\n` +
                            `👤 NIM: *${studentObj.nim}*\n` +
                            `🔑 Sandi Baru: *${newPassword}*\n\n` +
                            `Silakan gunakan sandi baru ini untuk login kembali ke portal absensi:\n` +
                            `${WEB_PORTAL_URL}\n\n` +
                            `_Segera simpan dan jangan bagikan sandi ini kepada siapa pun!_ 🔒`;

                        await sock.sendMessage(senderInfo.targetJid, { text: replyMsg });
                        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                        return;
                    }

                    case 'rekap':
                    case 'status': {
                        if (!studentObj && args.length === 0) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ Nomor Anda belum terdaftar otomatis. Silakan ketik: *!rekap <NIM>* (Contoh: *!rekap 1312024001*).`
                            });
                            return;
                        }

                        const targetNim = args[0] || studentObj.nim;
                        const allLogs = await callDbGet('axaxyz_logs') || [];
                        const studentLogs = allLogs.filter(l => l.nim === targetNim);

                        const totalHadir = studentLogs.filter(l => l.status === 'Hadir').length;
                        const totalTerlambat = studentLogs.filter(l => l.status === 'Terlambat').length;

                        const rekapText = `📊 *RAPOR KEHADIRAN DEPT. RKG* 📊\n\n` +
                            `👤 *Nama:* ${studentObj ? studentObj.name : 'Mahasiswa'}\n` +
                            `🆔 *NIM:* ${targetNim}\n\n` +
                            `✅ *Tepat Waktu (Hadir):* ${totalHadir} Sesi\n` +
                            `🟡 *Terlambat:* ${totalTerlambat} Sesi\n` +
                            `📋 *Total Sesi Tervalidasi:* ${studentLogs.length} Sesi\n\n` +
                            `Untuk rincian lengkap foto bukti dan lokasi GPS kehadiran, silakan cek langsung di Dashboard: ${WEB_PORTAL_URL}`;

                        await sock.sendMessage(senderInfo.targetJid, { text: rekapText });
                        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                        return;
                    }

                    case 'kalender':
                    case 'libur': {
                        const holidays = await callDbGet('axaxyz_holidays') || [];
                        if (!Array.isArray(holidays) || holidays.length === 0) {
                            await sock.sendMessage(senderInfo.targetJid, { text: "📅 Tidak ada jadwal libur khusus yang tercatat di sistem." });
                            return;
                        }

                        let kalText = `🗓️ *JADWAL HARI LIBUR AKADEMIK 2026*\n\n`;
                        holidays.slice(0, 10).forEach(h => {
                            kalText += `• *${h.date}*: ${h.name}\n`;
                        });
                        kalText += `\n_Pada tanggal merah/libur di atas, sesi absensi reguler tidak dihitung sebagai alpha._`;

                        await sock.sendMessage(senderInfo.targetJid, { text: kalText });
                        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
                        return;
                    }

                    case 'broadcast': {
                        const broadcastMsg = args.join(' ');
                        if (!broadcastMsg) {
                            await sock.sendMessage(senderInfo.targetJid, { text: "Format: *!broadcast <pesan pengumuman>*" });
                            return;
                        }

                        const allStudents = await callDbGet('axaxyz_students') || [];
                        let enqueuedCount = 0;

                        for (const st of allStudents) {
                            if (st.noHp) {
                                await enqueueWaNotification(st.noHp, 18, {
                                    namaLengkap: st.name,
                                    pesanCustom: broadcastMsg,
                                    kelompok: "Semua Kelompok"
                                });
                                enqueuedCount++;
                            }
                        }

                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `📢 Pesan broadcast berhasil dimasukkan ke antrian untuk *${enqueuedCount} mahasiswa*!`
                        });
                        return;
                    }

                    case 'stats':
                    case 'rekapadmin': {
                        const [students, logs] = await Promise.all([
                            callDbGet('axaxyz_students') || [],
                            callDbGet('axaxyz_logs') || []
                        ]);

                        const totalHadir = logs.filter(l => l.status === 'Hadir').length;
                        const totalTerlambat = logs.filter(l => l.status === 'Terlambat').length;

                        const statsText = `📈 *REKAPITULASI ABSENSI HARIAN DEPT. RKG*\n\n` +
                            `👥 *Total Mahasiswa Terdaftar:* ${students.length} Orang\n` +
                            `✅ *Total Hadir Tepat Waktu:* ${totalHadir} Sesi\n` +
                            `🟡 *Total Terlambat:* ${totalTerlambat} Sesi\n` +
                            `📊 *Total Log Kehadiran:* ${logs.length} Data\n\n` +
                            `Dashboard Lengkap: ${WEB_PORTAL_URL}`;

                        await sock.sendMessage(senderInfo.targetJid, { text: statsText });
                        return;
                    }

                    case 'ping':
                    case 'runtime': {
                        const startTime = Date.now();
                        const checkDb = await callDbGet('axaxyz_geofence');
                        const latency = Date.now() - startTime;

                        const pingText = `⚡ *STATUS BOT ABSENSI DEPT. RKG*\n\n` +
                            `• *Status:* Online & Terhubung 🟢\n` +
                            `• *Latensi Database:* ${latency}ms\n` +
                            `• *Platform:* Node.js ${process.version} (${os.platform()})\n` +
                            `• *RAM Usage:* ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\n` +
                            `• *Portal Web:* ${WEB_PORTAL_URL}`;

                        await sock.sendMessage(senderInfo.targetJid, { text: pingText });
                        return;
                    }
                }
            }

            // =====================================================================
            // 2. CHATBOT ASISTEN VIRTUAL DEPT. RKG (AI ENGINE)
            // =====================================================================
            const aiReply = await generateRkgAiResponse(senderInfo, pushName, trimmedText, studentObj);
            await sock.sendMessage(senderInfo.targetJid, { text: aiReply });
            await sock.sendPresenceUpdate('paused', senderInfo.targetJid);

        } catch (error) {
            console.error('[Error Pesan Masuk WhatsApp]', error);
        }
    });
}messageHandler(ABSN).js
