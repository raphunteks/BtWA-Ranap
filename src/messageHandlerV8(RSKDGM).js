import fs from 'fs';
import process from 'process';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// Handler perintah eksternal pendukung
import handleStickerCommand from './commands/sticker.js';

// =========================================================================
// KONFIGURASI SISTEM & REST API GOOGLE APPS SCRIPT (SIMGOS RSKDGM)
// =========================================================================
const ownerNumber = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

// URL REST API Google Apps Script (GAS) SIMGOS RSKDGM
const GAS_URL_SIMGOS = process.env.GAS_URL_SIMGOS || "https://script.google.com/macros/s/AKfycbzCOj9YFKEqXRfMEKBugnEhqzuC7MoJfIyc5PihST3bxmJaseaKKX9YifotK2qpT38/exec";

// Kontak WhatsApp Dokter Cadangan jika Setting Belum Terisi
const DOKTER_JID_LIST = [
  "6282291675363@s.whatsapp.net", // drg. Hj. Kurniawaty, Sp.KG (DPJP Utama)
  "6285256739684@s.whatsapp.net"  // drg. M. Aksa Arsyad
];

// Model fallback Groq AI yang diizinkan (Allowed Models Organisasi)
const GROQ_ALLOWED_MODELS = [
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.6-27b",
  "groq/compound",
  "groq/compound-mini"
];

// =========================================================================
// PARSER KHUSUS: MEMBEDAKAN ANTARA NOMOR LID DAN JID TELEPON SECARA PRESISI
// =========================================================================
function parseSenderInfo(rawJid) {
  if (!rawJid) return { rawJid: '', id: '', isLid: false, targetJid: '' };
  const jidStr = String(rawJid).trim();
  const isLid = jidStr.toLowerCase().endsWith('@lid');
  const isGroup = jidStr.toLowerCase().endsWith('@g.us');
  const isBroadcast = jidStr.toLowerCase().includes('broadcast');

  const cleanId = jidStr.replace(/@(lid|s\.whatsapp\.net|broadcast|g\.us)$/i, '').replace(/\D/g, '');

  let targetJid = jidStr;
  if (isLid) {
    targetJid = `${cleanId}@lid`;
  } else if (!isGroup && !isBroadcast) {
    let phone = cleanId;
    if (phone.startsWith('0')) phone = '62' + phone.substring(1);
    else if (phone.startsWith('8')) phone = '62' + phone;
    else if (!phone.startsWith('62') && phone.length >= 8) phone = '62' + phone;
    targetJid = `${phone}@s.whatsapp.net`;
  }

  return {
    rawJid: jidStr,
    id: cleanId,         // Nomor LID murni atau nomor telepon
    isLid: isLid,        // True jika pengirim berstatus LID
    targetJid: targetJid // JID pengiriman balik yang valid
  };
}

function sanitizeNumber(rawNumber) {
  if (!rawNumber) return '';
  const str = String(rawNumber).trim();
  if (str.toLowerCase().endsWith('@lid')) {
    return str.replace(/\D/g, '') + '@lid';
  }
  let cleaned = str.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.substring(1);
  else if (cleaned.startsWith('8')) cleaned = '62' + cleaned;
  else if (!cleaned.startsWith('62') && cleaned.length >= 8) cleaned = '62' + cleaned;
  return cleaned + '@s.whatsapp.net';
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

/**
 * Kompilasi Variabel Template dari Sheet CUSTOM_FORMAT
 */
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
    .replace(/{STATUS_RESCHEDULE}/g, patient?.statusReschedule || "-")
    .replace(/{STATUS_RUJUKAN}/g, patient?.statusRujukan || "Rujukan Habis")
    .replace(/{DPJP_UTAMA}/g, sysCfg.dpjpUtama || "drg. Hj. Kurniawaty, Sp.KG")
    .replace(/{DPJP_PENDAMPING}/g, sysCfg.dpjpPendamping || "drg. M. Aksa Arsyad")
    .replace(/{NAMA_INSTANSI}/g, sysCfg.instansi || "RSKD Gigi dan Mulut Prov. Sulsel")
    .replace(/{POLI_KLINIK}/g, sysCfg.poli || "Poli Konservasi dan Endodonsi");
}

// =========================================================================
// CACHE CERDAS: PROMPT, TEMPLATES & KREDENSIAL AI DARI GOOGLE SHEET
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
  doctors: [],
  timestamp: 0
};
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

const conversationSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

const sessionPath = './session';
const settingsFile = `${sessionPath}/settings.json`; 

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

let botSettings = { 
  autoFollowupSimgos: true,
  autoFollowupHour: "08",
  autoFollowupMinute: "30",
  lastAutoFollowupDate: ""
};

if (fs.existsSync(settingsFile)) {
  try { 
    botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) }; 
  } catch (e) { 
    console.error("Gagal membaca settings.json", e); 
  }
}

function saveSettings() { 
  fs.writeFileSync(settingsFile, JSON.stringify(botSettings, null, 2)); 
}

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

function formatWITA(dateObj) {
  return new Intl.DateTimeFormat('en-US', { 
    timeZone: 'Asia/Makassar', 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    hour: 'numeric', 
    minute: 'numeric', 
    hour12: true 
  }).format(dateObj);
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

  // 1. Deteksi Khusus: Pasien Menyatakan Salah Orang / Salah Sambung
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

async function callSimgosApi(action, params = {}) {
  try {
    const query = new URLSearchParams({ action, ...params }).toString();
    const url = `${GAS_URL_SIMGOS}?${query}`;
    const res = await fetch(url, { method: "GET" });
    return await res.json();
  } catch (err) {
    console.error(`[SIMGOS API Error: ${action}]`, err);
    throw new Error(`Gagal komunikasi dengan API SIMGOS: ${err.message}`);
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
        doctors: res.config?.doctors || [],
        timestamp: now
      };
      return cachedSystemConfig;
    }
  } catch (e) {
    console.warn("[Config AI Warning] Menggunakan cache konfigurasi lokal:", e.message);
  }

  return cachedSystemConfig;
}

async function fetchPatientsByRujukanStatus(statusType) {
  try {
    let res = await callSimgosApi("search_patient", { query: "." });
    if (!res || !res.data || res.data.length === 0) {
      res = await callSimgosApi("search_patient", { query: "0" });
    }

    if (res && res.status === "success" && Array.isArray(res.data)) {
      return res.data.filter(p => {
        const r = String(p.statusRujukan || "").toLowerCase();
        if (statusType === "aktif") {
          return r.includes("aktif");
        } else if (statusType === "habis") {
          return r.includes("habis") || !r || r === "-";
        }
        return false;
      });
    }
  } catch (e) {
    console.error("[Get Patients By Rujukan Error]", e);
  }
  return [];
}

// =========================================================================
// ENGINE 1: GOOGLE AI STUDIO (GEMINI 3.5 FLASH)
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
      temperature: 0.4,
      maxOutputTokens: 2048,
      topP: 0.92
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

  console.log(`[AI Response] Dijawab sukses oleh Google AI Studio (${model}) 🚀`);
  return rawReply.trim();
}

// =========================================================================
// ENGINE 2: GROQ AI FALLBACK ENGINE
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
          temperature: 0.4,
          max_tokens: 2048
        })
      });

      if (!res.ok) {
        const errBody = await res.text();
        console.warn(`[Groq Failover: ${model} ${res.status}]`, errBody);
        lastGroqError = new Error(`Groq (${model}) ${res.status}: ${errBody}`);
        continue;
      }

      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content;
      if (reply && reply.trim()) {
        console.log(`[AI Fallback Active] Dijawab sukses oleh Groq AI (${model}) ⚡`);
        return reply.trim();
      }
    } catch (err) {
      console.warn(`[Groq Error ${model}]`, err.message);
      lastGroqError = err;
    }
  }

  throw lastGroqError || new Error("Seluruh model Groq AI gagal.");
}

async function askAIClinicUnified(conversationHistory, patientContext = null, senderPushName = "Pasien") {
  const aiConfig = await fetchSystemAIConfig();
  let systemPromptText = aiConfig.prompt;

  // Pastikan nama instansi selalu tepat tanpa sebutan lain
  systemPromptText = systemPromptText.replace(/RSKDGM Care|RSKD Care/gi, "RSKD Gigi dan Mulut Prov. Sulsel");

  // Injeksi Konteks Pasien yang Sangat Ketat dan Akurat
  if (patientContext && patientContext.namaPasien && patientContext.namaPasien !== "-") {
    systemPromptText += `\n\n[DATA IDENTITAS RESMI PASIEN SESUAI DATABASE]:
- Nama Lengkap Resmi: ${patientContext.namaPasien}
- Nomor Rekam Medis: ${patientContext.noRm}
- Jadwal Kontrol: ${patientContext.tglKontrol}
- Status Reschedule: ${patientContext.statusReschedule || "-"}
- Status Rujukan: ${patientContext.statusRujukan || "Rujukan Aktif"}
- Rumah Sakit: RSKD Gigi dan Mulut Prov. Sulsel
- Unit Poli: Poli Konservasi dan Endodonsi

ATURAN WAJIB PENYEBUTAN NAMA PASIEN:
1. Pasien yang sedang chat ini adalah "${patientContext.namaPasien}".
2. Kamu WAJIB menyapa dan memanggil pasien ini dengan nama resminya "${patientContext.namaPasien}".
3. DILARANG KERAS memanggil dengan nama lain (seperti Rusdianto, dsb).
4. Gunakan sapaan identitas "RSKD Gigi dan Mulut Prov. Sulsel", jangan gunakan nama lain.`;
  } else {
    systemPromptText += `\n\n[DATA PENGIRIM CHAT]:
- Nama Profil WhatsApp: ${senderPushName}
- Status Database: Nomor pengirim ini BELUM TERDAFTAR dalam database kontrol Poli Konservasi.

ATURAN RESPONS PENGIRIM TIDAK TERDAFTAR:
1. Sapa pengirim dengan nama profil WhatsApp-nya: "${senderPushName}".
2. JANGAN PERNAH mengarang nama pasien lain atau mengarang tanggal kontrol jika tidak ada di database!
3. Jika pengirim menyatakan "salah orang", "bukan saya", atau merasa salah kirim, jelaskan dengan sangat ramah dan santun bahwa nomornya mungkin salah tercatat di pendaftaran RSKD Gigi dan Mulut Prov. Sulsel, dan persilakan mengabaikan pesan tersebut.`;
  }

  try {
    return await askGeminiClinic(conversationHistory, systemPromptText, aiConfig);
  } catch (geminiErr) {
    console.warn(`[Gemini Error -> Beralih ke Groq AI Fallback]`, geminiErr.message);
  }

  try {
    return await askGroqClinic(conversationHistory, systemPromptText, aiConfig);
  } catch (groqErr) {
    console.error(`[Groq Fallback Error]`, groqErr.message);
    throw new Error(`Kedua Engine AI (Gemini & Groq) gagal merespons.`);
  }
}

// =========================================================================
// LOGIKA FOLLOW-UP (SKIP OTOMATIS JIKA STATUS RUJUKAN HABIS)
// =========================================================================
async function executeFollowupBlast(sock, replyTargetJid = null, tglParam = "auto", overrideToSender = false, modeH = "h2") {
  const resultLog = {
    mode: modeH,
    totalTarget: 0,
    pasienTerkirim: 0,
    pasienGagal: 0,
    pasienSkipRujukanHabis: 0,
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

  for (const px of listPasien) {
    const statusRujukan = String(px.statusRujukan || "").trim().toLowerCase();
    if (statusRujukan.includes("habis") || !statusRujukan || statusRujukan === "-") {
      console.log(`[SKIP FOLLOWUP] Pasien ${px.namaPasien} (RM: ${px.noRm}) dilewati karena Status Rujukan Habis.`);
      resultLog.pasienSkipRujukanHabis++;
      continue;
    }

    const cleanPhone = String(px.noHp || '').replace(/\D/g, '');
    let resolvedLid = "";

    if (overrideToSender && senderInfo.id) {
      resolvedLid = senderInfo.id;
    } else {
      try {
        const waCheck = await sock.onWhatsApp(cleanPhone);
        if (waCheck && waCheck.length > 0 && waCheck[0].lid) {
          resolvedLid = String(waCheck[0].lid).replace(/\D/g, '');
        }
      } catch (errCheck) {}

      if (!resolvedLid) resolvedLid = cleanPhone;
    }

    const targetJid = (overrideToSender && replyTargetJid) ? senderInfo.targetJid : sanitizeNumber(px.noHp);

    try {
      let pesanKirim = px.pesan_wa_pasien;
      if (overrideToSender) {
        pesanKirim = `🧪 *[TESTING BLAST ${modeH.toUpperCase()}: NOMOR DIKONVERSI KE SENDER]*\n` +
                     `_(Pasien: ${px.namaPasien} | RM: ${px.noRm} | Rujukan: ${px.statusRujukan} | No. Asli: ${px.originalNoHp || px.noHp})_\n\n` + 
                     pesanKirim;
      }

      await sock.sendMessage(targetJid, { text: pesanKirim });
      resultLog.pasienTerkirim++;
      
      await callSimgosApi("update_status", { 
        row: px.rowNumber, 
        type: "pasien", 
        status: "Terkirim",
        mode: modeH,
        no_lid: resolvedLid
      });

      console.log(`[Blast ${modeH.toUpperCase()} Terkirim] ${px.namaPasien} (${px.statusRujukan}) -> JID: ${targetJid}`);

      // HANYA simpan ke sesi lokal jika BUKAN mode override pengirim (mencegah tumpang tindih nama)
      if (!overrideToSender) {
        conversationSessions.set(resolvedLid, {
          history: [],
          lastSeen: Date.now(),
          patientData: px
        });
        conversationSessions.set(cleanPhone, {
          history: [],
          lastSeen: Date.now(),
          patientData: px
        });
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[Gagal Kirim Pasien ${modeH.toUpperCase()}] ${px.namaPasien}:`, e);
      resultLog.pasienGagal++;
    }
  }

  const targetDoctors = followupData.doctors && followupData.doctors.length > 0
    ? followupData.doctors.map(d => sanitizeNumber(d.wa)).filter(Boolean)
    : DOKTER_JID_LIST;

  for (const docJid of targetDoctors) {
    try {
      let rekapDokter = `📋 *LAPORAN FOLLOW-UP KONTROL PASIEN (${modeH.toUpperCase()})*\n` +
                        `🏥 *${sysConfig.instansi}*\n` +
                        `📅 *Tgl Kontrol:* ${resultLog.targetDate}\n` +
                        `👨‍⚕️ *DPJP Utama:* ${sysConfig.dpjpUtama}\n` +
                        `👥 *Total Pasien Terjadwal:* ${resultLog.totalTarget}\n` +
                        `📲 *Berhasil Dihubungi (Rujukan Aktif):* ${resultLog.pasienTerkirim}\n` +
                        `🚫 *Dilewati (Rujukan Habis):* ${resultLog.pasienSkipRujukanHabis}\n\n` +
                        `*Rincian Pasien:*\n`;

      listPasien.forEach((p, idx) => {
        const isHabis = String(p.statusRujukan || "").toLowerCase().includes("habis");
        const statusKirim = isHabis ? "🚫 _(Rujukan Habis - Dilewati)_" : "✅ _(Terkirim)_";
        rekapDokter += `${idx + 1}. *${p.namaPasien}* (RM: ${p.noRm}) - WA: ${p.noHp}\n   ${statusKirim}\n`;
      });

      if (overrideToSender) {
        rekapDokter += `\n_Mode Simulasi: Seluruh pesan dialihkan ke WhatsApp Anda (${senderInfo.id})._ 🙏`;
      } else {
        rekapDokter += `\n_Pesan otomatis telah terkirim hanya kepada pasien dengan status Rujukan Aktif._ 🙏`;
      }

      await sock.sendMessage(docJid, { text: rekapDokter });
      resultLog.laporanDokterTerkirim++;
      await new Promise(r => setTimeout(r, 1000));
    } catch (docErr) {
      console.error(`[Gagal Kirim Dokter ${modeH.toUpperCase()}] ${docJid}:`, docErr);
      resultLog.laporanDokterGagal++;
    }
  }

  for (const px of listPasien) {
    const isHabis = String(px.statusRujukan || "").toLowerCase().includes("habis");
    if (!isHabis) {
      try {
        await callSimgosApi("update_status", { 
          row: px.rowNumber, 
          type: "dokter", 
          status: "Terkirim",
          mode: modeH
        });
      } catch (err) {}
    }
  }

  return resultLog;
}

let isIntervalStarted = false;
let currentSock = null;

// =========================================================================
// MAIN MESSAGE HANDLER ENGINE
// =========================================================================
export default function setupMessageHandler(sock) {
  currentSock = sock; 

  if (!isIntervalStarted) {
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
                    `⏱️ Waktu: ${formatWITA(new Date())}`
            });
          }
        } catch (autoErr) {
          console.error("[Auto SIMGOS Error]", autoErr);
        }
      }
    }, 30000); 

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
      
      if (!text.trim()) return;

      const senderInfo = parseSenderInfo(remoteJid);
      const pushName = msg.pushName || "Pasien";

      console.log(`[Chat 1-on-1] Dari: ${senderInfo.id} (${senderInfo.isLid ? 'LID' : 'Phone'}) (PushName: ${pushName}) | Pesan: "${text.trim()}"`);

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
                             `* !followupnow* [h1/h2] [tgl/auto] [me] - 🚀 Kirim instan ('me' = kirim ke Anda)\n` +
                             `* !followup* [h1/h2] [tgl/auto] - Cek daftar antrean kontrol H-2 atau H-1\n` +
                             `* !gassfollowup* [h1/h2] [me] - Kirim WA massal ke Pasien & DPJP Utama\n` +
                             `* !cekrujukanaktif* - 📋 Lihat seluruh pasien dengan Rujukan Aktif\n` +
                             `* !cekrujukanhabis* - ⚠️ Lihat seluruh pasien dengan Rujukan Habis\n` +
                             `* !bindpasien* <No.RM> - 🔗 Tautkan identitas WhatsApp Anda ke No RM Pasien\n` +
                             `* !caripasien* <No.RM/Nama/WA/LID> - Cari data pasien di Spreadsheet\n` +
                             `* !reschedule* <No.RM> <YYYY-MM-DD> - Ubah tanggal kontrol manual\n` +
                             `* !statskontrol* - Cek statistik kontrol & status rujukan\n` +
                             `* !settingssimgos* - Cek konfigurasi sistem & dokter\n` +
                             `* !templatesimgos* - Cek template format pesan WhatsApp\n` +
                             `* !autofollowup on/off* - Pengaturan status blast harian otomatis\n` +
                             `* !setjamfollowup* <HH:mm> - Ubah jam blast harian\n\n` +

                             `*🧠 KREDENSIAL AI (DARI SHEET 'SETTING'):*\n` +
                             `* !getprompt* - Cek System Prompt AI aktif & status API Key\n` +
                             `* !clearpromptcache* - Refresh cache prompt, template & API Key terbaru\n\n` +

                             `*⚙️ UTILITAS:* \n` +
                             `* !ping* - Cek kecepatan respon bot\n` +
                             `* !runtime* - Cek waktu aktif bot & server\n` +
                             `* !sticker* / *!s* - Konversi gambar ke stiker\n\n` +
                             `_💬 Rumah Sakit Resmi: *RSKD Gigi dan Mulut Prov. Sulsel*._`;
            await sock.sendMessage(senderInfo.targetJid, { text: menuText }, { quoted: msg });
            return;

          case 'cekrujukanaktif':
          case 'rujukanaktif':
            await sock.sendMessage(senderInfo.targetJid, { text: "⏳ _Mengambil data pasien dengan Status Rujukan Aktif dari Google Spreadsheet..._" }, { quoted: msg });
            try {
              const pasienAktif = await fetchPatientsByRujukanStatus("aktif");
              if (pasienAktif.length === 0) {
                await sock.sendMessage(senderInfo.targetJid, { text: "ℹ️ Tidak ditemukan pasien dengan status *Rujukan Aktif* di database." }, { quoted: msg });
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
                await sock.sendMessage(senderInfo.targetJid, { text: "ℹ️ Tidak ditemukan pasien dengan status *Rujukan Habis* di database." }, { quoted: msg });
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

              const searchCheck = await callSimgosApi("search_patient", { query: targetRmBind });
              const pxName = (searchCheck.status === "success" && searchCheck.data?.[0]?.namaPasien) ? searchCheck.data[0].namaPasien : targetRmBind;

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

            for (const arg of args) {
              const lowerArg = arg.toLowerCase();
              if (lowerArg === 'me' || lowerArg === 'test' || lowerArg === 'myself') {
                toSender = true;
              } else if (lowerArg === 'h1') {
                modeHNow = "h1";
              } else if (lowerArg === 'h2') {
                modeHNow = "h2";
              } else if (lowerArg !== 'auto') {
                tglTarget = arg;
              }
            }

            const infoNotice = toSender 
              ? `⚡ *[FOLLOWUP NOW ${modeHNow.toUpperCase()}]* Memulai penarikan data... ⚠️ *Fitur Aktif:* Nomor penerima dialihkan ke WhatsApp Anda (*${senderInfo.id}*) & disimpan ke Kolom 15.`
              : `⚡ *[FOLLOWUP NOW ${modeHNow.toUpperCase()}]* Memulai pengiriman instan ke nomor WhatsApp pasien (Rujukan Habis otomatis diskip)...`;

            await sock.sendMessage(senderInfo.targetJid, { text: infoNotice }, { quoted: msg });
            
            try {
              const blastResult = await executeFollowupBlast(sock, remoteJid, tglTarget, toSender, modeHNow);

              if (blastResult.totalTarget === 0) {
                await sock.sendMessage(senderInfo.targetJid, { 
                  text: `ℹ️ Tidak ada antrean pasien kontrol berstatus *Pending* untuk target ${modeHNow.toUpperCase()} tanggal ${blastResult.targetDate}.` 
                }, { quoted: msg });
                break;
              }

              let rekapSekarang = `🚀 *[FOLLOWUP NOW ${modeHNow.toUpperCase()} SELESAI]*\n\n` +
                                  `📅 *Target Kontrol:* ${blastResult.targetDate}\n` +
                                  `👥 *Total Pasien Terjadwal:* ${blastResult.totalTarget}\n` +
                                  `📲 *Pesan Terkirim (Aktif):* ${blastResult.pasienTerkirim}\n` +
                                  `🚫 *Dilewati (Rujukan Habis):* ${blastResult.pasienSkipRujukanHabis}\n` +
                                  `⚠️ *Pesan Gagal:* ${blastResult.pasienGagal}\n` +
                                  `👨‍⚕️ *Laporan Terkirim ke DPJP Utama:* ${blastResult.laporanDokterTerkirim} Dokter\n`;

              if (blastResult.isSenderConverted) {
                rekapSekarang += `🎯 *Penerima Diarahkan ke:* ${blastResult.convertedToPhone} (Tersimpan di Kolom 15 No Sender)\n`;
              }

              rekapSekarang += `\n_Seluruh status di Google Spreadsheet berhasil diperbarui ke Terkirim._ 📊`;
              await sock.sendMessage(senderInfo.targetJid, { text: rekapSekarang }, { quoted: msg });
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
              if (lowerA === 'h1') modeHFU = "h1";
              else if (lowerA === 'h2') modeHFU = "h2";
              else if (lowerA !== 'auto') tglArg = a;
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

              let textHasil = `📋 *DAFTAR PASIEN SIAP FOLLOW-UP (${modeHFU.toUpperCase()})*\n` +
                              `📅 *Target Kontrol:* ${resFollowup.target_control_date}\n` +
                              `👥 *Total Pasien:* ${resFollowup.total} orang\n\n`;

              resFollowup.data.forEach((px, idx) => {
                const iconRujuk = String(px.statusRujukan || "").toLowerCase().includes("habis") ? "🚫 Habis" : "✅ Aktif";
                textHasil += `${idx + 1}. *${px.namaPasien}* (RM: ${px.noRm})\n` +
                             `   📱 WA Pasien: ${px.noHp}\n` +
                             `   📋 Rujukan: *${iconRujuk}*\n` +
                             `   🏥 Status WA: ${px.statusWa} | Dokter: ${px.statusDokter}\n\n`;
              });

              textHasil += `👉 _Ketik *!followupnow ${modeHFU} me* untuk test ke Anda, atau *!followupnow ${modeHFU}* untuk blast._`;
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

            await sock.sendMessage(senderInfo.targetJid, { text: `🚀 _Memulai pengiriman pesan WhatsApp massal (${modeHGass.toUpperCase()})... Mohon tunggu._` }, { quoted: msg });
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
                               `⚠️ *Pasien Gagal:* ${blastResult.pasienGagal}\n` +
                               `👨‍⚕️ *Laporan DPJP Terkirim:* ${blastResult.laporanDokterTerkirim} Dokter\n`;

              if (blastResult.isSenderConverted) {
                rekapAkhir += `🎯 *Catatan:* Pesan dialihkan ke WhatsApp pengirim (${blastResult.convertedToPhone}).\n`;
              }

              rekapAkhir += `\n_Seluruh status di Google Spreadsheet berhasil diperbarui ke Terkirim._ 📊`;
              await sock.sendMessage(senderInfo.targetJid, { text: rekapAkhir }, { quoted: msg });
            } catch (e) {
              await sock.sendMessage(senderInfo.targetJid, { text: `❌ *Terjadi Kesalahan saat eksekusi:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'caripasien':
            if (args.length === 0) {
              await sock.sendMessage(senderInfo.targetJid, { text: "⚠️ Masukkan kata kunci pencarian!\nContoh: *!caripasien 00.06.32.89* atau *!caripasien ILDHAYANI*" }, { quoted: msg });
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
                            `   📅 Tgl Kontrol: ${p.tglKontrol}\n` +
                            `   📱 No. WA: ${p.noHp}\n` +
                            `   📋 Status Rujukan: *${iconRujuk}*\n` +
                            `   🔄 Status Reschedule: *${p.statusReschedule || '-'}*\n` +
                            `   🎂 Umur / JK: ${p.umur} / ${p.jenisKelamin}\n` +
                            `   Status H-2: [${p.statusWaH2}] | Status H-1: [${p.statusWaH1}]\n\n`;
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
                await sock.sendMessage(senderInfo.targetJid, { 
                  text: `✅ *Reschedule Berhasil!*\n\n` +
                        `🔖 No. RM: *${rmResched}*\n` +
                        `📅 Jadwal Kontrol Baru: *${dateResched}*\n` +
                        `📋 Status Database: *Reschedule (${dateResched})*\n` +
                        `Status pasien otomatis direset ke *Pending* untuk jadwal kontrol baru.` 
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

          case 'getprompt':
            const activeCfg = await fetchSystemAIConfig();
            const geminiMasked = activeCfg.geminiApiKey ? `${activeCfg.geminiApiKey.substring(0, 8)}...${activeCfg.geminiApiKey.slice(-4)}` : "TIDAK TERPASANG";
            const groqMasked = activeCfg.groqApiKey ? `${activeCfg.groqApiKey.substring(0, 8)}...${activeCfg.groqApiKey.slice(-4)}` : "TIDAK TERPASANG";

            await sock.sendMessage(senderInfo.targetJid, { 
              text: `📋 *SYSTEM PROMPT AKTIF DARI SHEET 'CUSTOM_PROMPT':*\n\n"${activeCfg.prompt}"\n\n` +
                    `🤖 *KREDENSIAL AI AKTIF (DARI SHEET 'SETTING'):*\n` +
                    `• Model Gemini Utama: *${activeCfg.geminiModel}* (${geminiMasked})\n` +
                    `• Model Fallback Groq: *${activeCfg.groqModel}* (${groqMasked})\n` +
                    `• Total Template Tersinkron: *${Object.keys(activeCfg.templates).length} Template*\n\n` +
                    `_Ketik *!clearpromptcache* jika Anda baru saja mengubah setting di Spreadsheet._`
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
              doctors: [],
              timestamp: 0
            };
            await sock.sendMessage(senderInfo.targetJid, { text: "🔄 Cache Custom Prompt, Template & Kredensial AI berhasil dibersihkan. Konfigurasi baru langsung ditarik dari Spreadsheet saat chat berikutnya." }, { quoted: msg });
            return;

          case 'ping':
            const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
            await sock.sendMessage(senderInfo.targetJid, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingProcess} ms` }, { quoted: msg }); 
            return;

          case 'runtime':
            const uptime = process.uptime();
            await sock.sendMessage(senderInfo.targetJid, { 
              text: `⏳ *Bot Uptime:* ${getRelativeTime(uptime)}\n🖥️ *OS Memory:* ${Math.round(os.freemem()/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB\n⚡ Server Time: ${formatWITA(new Date())}` 
            }, { quoted: msg });
            return;

          case 'sticker': 
          case 's': 
            if (typeof handleStickerCommand === 'function') {
              await handleStickerCommand(sock, msg); 
            }
            return;
        }
      }

      // =====================================================================
      // 2. HYBRID INTELLIGENT CHAT ENGINE (NLP + TEMPLATE CUSTOM_FORMAT MURNI)
      // =====================================================================
      await sock.sendPresenceUpdate('composing', senderInfo.targetJid);

      const sysConfig = await fetchSystemAIConfig();
      const targetDpjpUtamaWa = sysConfig.doctors?.[0]?.wa || sysConfig.dpjpUtamaWa || "6282291675363";
      const targetDpjpUtamaJid = sanitizeNumber(targetDpjpUtamaWa);

      // COCOKKAN IDENTITAS SENDER SECARA PRESISI DENGAN DATABASE
      let patientData = null;
      try {
        const searchPx = await callSimgosApi("search_patient", { query: senderInfo.id });
        if (searchPx.status === "success" && Array.isArray(searchPx.data) && searchPx.data.length > 0) {
          patientData = searchPx.data[0];
          console.log(`[Pasien Dikenali dari Database] Nama: ${patientData.namaPasien} | RM: ${patientData.noRm} | Tgl: ${patientData.tglKontrol}`);
        }
      } catch (errSearch) {
        console.warn("[Search Patient Warning]", errSearch.message);
      }

      // Tentukan Nama Sapaan yang Benar: Ambil Nama Database JIKA Terdaftar, JIKA Tidak Pakai pushName WhatsApp
      const officialPatientName = (patientData && patientData.namaPasien && patientData.namaPasien !== "-") 
        ? patientData.namaPasien 
        : pushName;

      const pObj = patientData || {
        namaPasien: officialPatientName,
        noRm: "-",
        tglKontrol: "Terjadwal",
        tglMasuk: "-",
        umur: "-",
        agama: "-",
        jenisKelamin: "-",
        noHp: senderInfo.id,
        noSender: senderInfo.id,
        statusReschedule: "-",
        statusRujukan: "Rujukan Aktif"
      };

      const intent = detectPatientIntent(text);

      // =====================================================================
      // JALUR KHUSUS: PENGIRIM MENYATAKAN "SALAH ORANG / SALAH NOMOR"
      // =====================================================================
      if (intent.type === 'SALAH_ORANG') {
        const wrongPersonReply = `Mohon maaf yang sebesar-besarnya atas ketidaknyamanan pesan sebelumnya, Bapak/Ibu *${officialPatientName}*. 🙏\n\n` +
                                 `Kemungkinan nomor telepon ini salah tercatat pada antrean pendaftaran pasien kami di *RSKD Gigi dan Mulut Prov. Sulsel*.\n\n` +
                                 `Silakan abaikan pesan pengingat tersebut jika Anda tidak memiliki jadwal perawatan di Poli Konservasi. Terima kasih banyak atas konfirmasinya. Salam sehat selalu! 🙏✨`;
        
        await sock.sendMessage(senderInfo.targetJid, { text: wrongPersonReply }, { quoted: msg });
        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
        return;
      }

      // =====================================================================
      // JALUR 1: PASIEN KONFIRMASI "HADIR"
      // =====================================================================
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
          } catch (e) {
            console.error("[Update Status Hadir Error]", e.message);
          }
        }

        const templateLaporanHadir = sysConfig.templates["WA_LAPORAN_HADIR_DOKTER"];
        if (templateLaporanHadir) {
          const notifDokterHadir = compileTemplateText(templateLaporanHadir, pObj, sysConfig);
          try {
            await sock.sendMessage(targetDpjpUtamaJid, { text: notifDokterHadir });
            console.log(`[Notif Hadir Terkirim ke DPJP Utama] ${sysConfig.dpjpUtama} (${targetDpjpUtamaJid})`);
          } catch (docErr) {
            console.error(`[Gagal Kirim ke DPJP Utama: ${targetDpjpUtamaJid}]`, docErr.message);
          }
        }

        const templateBalasHadir = sysConfig.templates["WA_PX_HADIR_CONFIRM"];
        if (templateBalasHadir) {
          const replyHadir = compileTemplateText(templateBalasHadir, pObj, sysConfig);
          await sock.sendMessage(senderInfo.targetJid, { text: replyHadir });
        }
        
        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
        return;
      }

      // =====================================================================
      // JALUR 2: PASIEN INGIN "RESCHEDULE" / MENGIRIM TANGGAL BARU
      // =====================================================================
      if (intent.type === 'RESCHEDULE') {
        if (intent.date) {
          const newDate = intent.date;
          if (patientData && patientData.noRm) {
            try {
              // Update database dan catat ke Kolom 16 'Status Reschedule'
              await callSimgosApi("reschedule_patient", {
                noRm: patientData.noRm,
                newDate: newDate,
                no_lid: senderInfo.id
              });
            } catch (e) {
              console.error("[Reschedule API Error]", e.message);
            }
          }

          const updatedPatientObj = {
            ...pObj,
            tglKontrol: newDate,
            statusReschedule: `Reschedule (${newDate})`,
            noSender: senderInfo.id
          };

          const templateLaporanResched = sysConfig.templates["WA_LAPORAN_RESCHEDULE_DOKTER"];
          if (templateLaporanResched) {
            const notifResched = compileTemplateText(templateLaporanResched, updatedPatientObj, sysConfig);
            try {
              await sock.sendMessage(targetDpjpUtamaJid, { text: notifResched });
              console.log(`[Notif Reschedule Terkirim ke DPJP Utama] ${sysConfig.dpjpUtama} (${targetDpjpUtamaJid})`);
            } catch (docErr) {
              console.error(`[Gagal Kirim ke DPJP Utama: ${targetDpjpUtamaJid}]`, docErr.message);
            }
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
          } catch (e) {}
        }

        const templateTanyaTanggal = sysConfig.templates["WA_PX_RESCHEDULE_ASK"];
        if (templateTanyaTanggal) {
          const replyAskDate = compileTemplateText(templateTanyaTanggal, pObj, sysConfig);
          await sock.sendMessage(senderInfo.targetJid, { text: replyAskDate });
        }

        await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
        return;
      }

      // =====================================================================
      // JALUR 3: PERCAKAPAN UMUM, KONSULTASI GIGI & AI PARSER (GEMINI / GROQ)
      // =====================================================================
      let userSession = conversationSessions.get(senderInfo.id);
      if (!userSession) {
        userSession = { history: [], lastSeen: Date.now(), patientData: patientData };
        conversationSessions.set(senderInfo.id, userSession);
      }
      userSession.lastSeen = Date.now();
      if (patientData) userSession.patientData = patientData;

      userSession.history.push({
        role: 'user',
        parts: [{ text: text.trim() }]
      });

      if (userSession.history.length > 8) {
        userSession.history = userSession.history.slice(-8);
      }

      const typingTimer = setInterval(async () => {
        try { await sock.sendPresenceUpdate('composing', senderInfo.targetJid); } catch (e) {}
      }, 4000);

      let rawAiResponse = "";
      try {
        rawAiResponse = await askAIClinicUnified(userSession.history, patientData, pushName);
      } catch (aiErr) {
        console.error("[Dual AI Fatal Error]", aiErr.message);
        rawAiResponse = `Halo Bapak/Ibu ${officialPatientName}, terima kasih telah menghubungi Poli Konservasi RSKD Gigi dan Mulut Prov. Sulsel. Pesan Anda telah kami terima, staf poli kami siap membantu jadwal kontrol dan perawatan gigi Anda. Ada yang bisa kami bantu? 🙏`;
      } finally {
        clearInterval(typingTimer);
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
          }).catch(() => {});
        }

        const templateLaporanHadir = sysConfig.templates["WA_LAPORAN_HADIR_DOKTER"];
        if (templateLaporanHadir) {
          const notifDokter = compileTemplateText(templateLaporanHadir, pObj, sysConfig);
          try {
            await sock.sendMessage(targetDpjpUtamaJid, { text: notifDokter });
            console.log(`[AI Auto-Action Hadir Terkirim ke DPJP Utama] ${targetDpjpUtamaJid}`);
          } catch (e) {
            console.error("[Gagal Kirim ke DPJP Utama]", e.message);
          }
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
          } catch (reschedErr) {
            console.error("[Auto-Reschedule Error]", reschedErr.message);
          }
        }

        const updatedPx = { 
          ...pObj, 
          tglKontrol: newRescheduleDate, 
          statusReschedule: `Reschedule (${newRescheduleDate})`,
          noSender: senderInfo.id 
        };

        const templateLaporanResched = sysConfig.templates["WA_LAPORAN_RESCHEDULE_DOKTER"];
        if (templateLaporanResched) {
          const notifResched = compileTemplateText(templateLaporanResched, updatedPx, sysConfig);
          try {
            await sock.sendMessage(targetDpjpUtamaJid, { text: notifResched });
            console.log(`[AI Auto-Action Reschedule Terkirim ke DPJP Utama] ${targetDpjpUtamaJid}`);
          } catch (e) {
            console.error("[Gagal Kirim ke DPJP Utama]", e.message);
          }
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
