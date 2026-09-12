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
// CACHE CERDAS: PROMPT, TEMPLATES & KREDENSIAL AI DARI GOOGLE SHEET
// =========================================================================
let cachedSystemConfig = {
  prompt: '',
  templates: {},
  instansi: 'RSKD Gigi dan Mulut Prov. Sulawesi Selatan',
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
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // Cache lokal 5 menit

// Manajemen Sesi Percakapan Multi-Turn & Cache Pasien Terkait
const conversationSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // Sesi percakapan 30 menit

const sessionPath = './session';
const settingsFile = `${sessionPath}/settings.json`; 

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

// DEFAULT: autoFollowupSimgos = TRUE/ON, default jam 08:30 WITA
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

function sanitizeNumber(rawNumber) {
  let cleaned = String(rawNumber || '').replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.substring(1);
  else if (cleaned.startsWith('8')) cleaned = '62' + cleaned;
  else if (!cleaned.startsWith('62') && cleaned.length >= 8) cleaned = '62' + cleaned;
  return cleaned + '@s.whatsapp.net';
}

function extractPureNumberE164(rawNumber) {
  let cleaned = String(rawNumber || '').replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.substring(1);
  else if (cleaned.startsWith('8')) cleaned = '62' + cleaned;
  else if (!cleaned.startsWith('62') && cleaned.length >= 8) cleaned = '62' + cleaned;
  return cleaned;
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
 * Kompilasi Variabel Template dari Sheet CUSTOM_FORMAT (Murni 100% Tanpa Teks Langsung di Kodingan)
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
    .replace(/{DPJP_UTAMA}/g, sysCfg.dpjpUtama || "drg. Hj. Kurniawaty, Sp.KG")
    .replace(/{DPJP_PENDAMPING}/g, sysCfg.dpjpPendamping || "drg. M. Aksa Arsyad")
    .replace(/{NAMA_INSTANSI}/g, sysCfg.instansi || "RSKD Gigi dan Mulut Prov. Sulawesi Selatan")
    .replace(/{POLI_KLINIK}/g, sysCfg.poli || "Poli Konservasi dan Endodonsi");
}

/**
 * Ekstraktor tanggal fleksibel dari pesan pasien
 */
function extractDateFromText(text) {
  if (!text) return null;
  const t = text.trim();

  // 1. Format ISO YYYY-MM-DD
  const isoMatch = t.match(/\b(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = String(isoMatch[2]).padStart(2, '0');
    const d = String(isoMatch[3]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 2. Format lokal DD-MM-YYYY atau DD/MM/YYYY
  const dmyMatch = t.match(/\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\b/);
  if (dmyMatch) {
    const d = String(dmyMatch[1]).padStart(2, '0');
    const m = String(dmyMatch[2]).padStart(2, '0');
    const y = dmyMatch[3];
    return `${y}-${m}-${d}`;
  }

  // 3. Format Nama Bulan Bahasa Indonesia
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

/**
 * Super Smart NLP: Deteksi Intent Pasien (HADIR vs RESCHEDULE vs GENERAL)
 * Mendukung variasi percakapan santun: "bisa dok", "bisa kak", "bisa min", "boleh min", dll.
 */
function detectPatientIntent(rawText) {
  const text = rawText.trim().toLowerCase();

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

// =========================================================================
// CLIENT REST API SIMGOS RSKDGM (GOOGLE APPS SCRIPT)
// =========================================================================
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

/**
 * Mengambil Seluruh Kredensial AI & Template dari Database Google Spreadsheet
 */
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
        instansi: res.config?.instansi || cachedSystemConfig.instansi,
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

// =========================================================================
// ENGINE 1: GOOGLE AI STUDIO (GEMINI 3.5 FLASH - KREDENSIAL DARI SHEET)
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
// ENGINE 2: GROQ AI FALLBACK ENGINE (ALLOWED MODELS DARI SHEET)
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

// =========================================================================
// HYBRID UNIFIED AI ROUTER: GEMINI 3.5 -> GROQ AI FALLBACK
// =========================================================================
async function askAIClinicUnified(conversationHistory, patientContext = null) {
  const aiConfig = await fetchSystemAIConfig();
  let systemPromptText = aiConfig.prompt;

  if (patientContext) {
    systemPromptText += `\n\nKONTEKS PASIEN YANG SEDANG CHAT SAAT INI:
- Nama Pasien: ${patientContext.namaPasien || "-"}
- No. Rekam Medis: ${patientContext.noRm || "-"}
- Jadwal Kontrol Terdaftar: ${patientContext.tglKontrol || "-"}
- Dokter DPJP: ${aiConfig.dpjpUtama} & ${aiConfig.dpjpPendamping}
- Poli: ${aiConfig.poli}
Gunakan informasi di atas jika relevan untuk menyapa atau mengonfirmasi jadwal mereka secara akrab.`;
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
// LOGIKA FOLLOW-UP DENGAN FITUR AUTO-CONVERT NOMOR SENDER (KOLOM 13)
// =========================================================================
async function executeFollowupBlast(sock, replyTargetJid = null, tglParam = "auto", overrideToSender = false) {
  const resultLog = {
    totalTarget: 0,
    pasienTerkirim: 0,
    pasienGagal: 0,
    laporanDokterTerkirim: 0,
    laporanDokterGagal: 0,
    targetDate: "",
    isSenderConverted: false,
    convertedToPhone: ""
  };

  const senderPure = replyTargetJid ? extractPureNumberE164(replyTargetJid) : "";
  const apiParams = { tgl: tglParam };

  if (overrideToSender && senderPure) {
    apiParams.override_wa = senderPure;
    resultLog.isSenderConverted = true;
    resultLog.convertedToPhone = senderPure;
  }

  const followupData = await callSimgosApi("get_followup", apiParams);
  if (!followupData || followupData.status !== "success" || !Array.isArray(followupData.data)) {
    throw new Error(followupData?.message || "Data kontrol tidak tersedia.");
  }

  const listPasien = followupData.data;
  resultLog.totalTarget = listPasien.length;
  resultLog.targetDate = followupData.target_control_date || tglParam;

  if (listPasien.length === 0) return resultLog;

  for (const px of listPasien) {
    const targetJid = (overrideToSender && replyTargetJid) ? sanitizeNumber(replyTargetJid) : sanitizeNumber(px.noHp);
    const activeSenderNumber = (overrideToSender && senderPure) ? senderPure : extractPureNumberE164(px.noHp);

    try {
      let pesanKirim = px.pesan_wa_pasien;
      if (overrideToSender) {
        pesanKirim = `🧪 *[TESTING BLAST: NOMOR DIKONVERSI KE SENDER]*\n` +
                     `_(Asli Pasien: ${px.namaPasien} | No. Asli: ${px.originalNoHp || px.noHp})_\n\n` + 
                     pesanKirim;
      }

      await sock.sendMessage(targetJid, { text: pesanKirim });
      resultLog.pasienTerkirim++;
      
      // Update status DAN simpan No Sender aktif ke Kolom 13 Spreadsheet
      await callSimgosApi("update_status", { 
        row: px.rowNumber, 
        type: "pasien", 
        status: "Terkirim",
        noSender: activeSenderNumber
      });

      // Simpan asosiasi sesi lokal agar instan dikenali
      conversationSessions.set(activeSenderNumber, {
        history: [],
        lastSeen: Date.now(),
        patientData: px
      });

      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[Gagal Kirim Pasien] ${px.namaPasien}:`, e);
      resultLog.pasienGagal++;
    }
  }

  const targetDoctors = followupData.doctors && followupData.doctors.length > 0
    ? followupData.doctors.map(d => sanitizeNumber(d.wa)).filter(Boolean)
    : DOKTER_JID_LIST;

  for (const docJid of targetDoctors) {
    try {
      let rekapDokter = `📋 *LAPORAN FOLLOW-UP KONTROL PASIEN*\n` +
                        `🏥 *RSKD Gigi dan Mulut Prov. Sulsel*\n` +
                        `📅 *Tgl Kontrol:* ${resultLog.targetDate}\n` +
                        `👥 *Total Pasien Dihubungi:* ${resultLog.pasienTerkirim} dari ${resultLog.totalTarget}\n\n` +
                        `*Rincian Pasien:*\n`;

      listPasien.forEach((p, idx) => {
        rekapDokter += `${idx + 1}. *${p.namaPasien}* (RM: ${p.noRm}) - WA: ${p.noHp}\n`;
      });

      if (overrideToSender) {
        rekapDokter += `\n_Mode Simulasi: Seluruh pesan pasien dialihkan ke pengirim (${senderPure})._ 🙏`;
      } else {
        rekapDokter += `\n_Pesan otomatis telah terkirim ke kontak WhatsApp pasien di atas._ 🙏`;
      }

      await sock.sendMessage(docJid, { text: rekapDokter });
      resultLog.laporanDokterTerkirim++;
      await new Promise(r => setTimeout(r, 1000));
    } catch (docErr) {
      console.error(`[Gagal Kirim Dokter] ${docJid}:`, docErr);
      resultLog.laporanDokterGagal++;
    }
  }

  for (const px of listPasien) {
    try {
      await callSimgosApi("update_status", { 
        row: px.rowNumber, 
        type: "dokter", 
        status: "Terkirim" 
      });
    } catch (err) {}
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
          console.log(`[Auto SIMGOS] Follow-up kontrol terjadwal jam ${targetJam}:${targetMenit} WITA (${tanggalHariIniWita})...`);
          const blastRes = await executeFollowupBlast(currentSock, ownerNumber, "auto", false);
          botSettings.lastAutoFollowupDate = tanggalHariIniWita;
          saveSettings();

          if (blastRes.totalTarget > 0) {
            await currentSock.sendMessage(ownerNumber, {
              text: `🤖 *AUTO FOLLOW-UP SIMGOS SELESAI (H- KONTROL)*\n\n` +
                    `📅 Tgl Kontrol: *${blastRes.targetDate}*\n` +
                    `✅ Pasien Terkirim: ${blastRes.pasienTerkirim} / ${blastRes.totalTarget}\n` +
                    `👨‍⚕️ Laporan Dokter: ${blastRes.laporanDokterTerkirim} DPJP\n` +
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

      const senderPhonePure = extractPureNumberE164(remoteJid);
      const pushName = msg.pushName || "Pasien";

      console.log(`[Chat 1-on-1] Dari: ${senderPhonePure} (${pushName}) | Pesan: "${text.trim()}"`);

      // =====================================================================
      // 1. COMMAND ADMIN (PREFIX '!')
      // =====================================================================
      if (text.startsWith('!')) {
        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch (command) {
          case 'menu':
          case 'help':
            const menuText = `*🤖 BOT KONTROL RSKDGM (AI DIRECT SPREADSHEET) 🤖*\n\n` +
                             `*🦷 SIMGOS FOLLOW-UP KONTROL:*\n` +
                             `* !followupnow* [tgl/auto] [me] - 🚀 Kirim sekarang instan ('me' = konversi ke WA Anda)\n` +
                             `* !followup* [tgl/auto] - Cek daftar antrean kontrol H-\n` +
                             `* !gassfollowup* [tgl/auto] [me] - Kirim WA massal Pasien & Dokter\n` +
                             `* !caripasien* <No.RM/Nama/WA> - Cari data pasien di Spreadsheet\n` +
                             `* !reschedule* <No.RM> <YYYY-MM-DD> - Ubah tanggal kontrol manual\n` +
                             `* !statskontrol* - Cek ringkasan statistik kontrol\n` +
                             `* !settingssimgos* - Cek konfigurasi H- & nomor dokter\n` +
                             `* !templatesimgos* - Cek template format pesan WhatsApp\n` +
                             `* !autofollowup on/off* - Pengaturan status blast harian otomatis\n` +
                             `* !setjamfollowup* <HH:mm> - Ubah jam blast harian\n\n` +

                             `*🧠 STATUS KREDENSIAL AI (DARI SHEET 'SETTING'):*\n` +
                             `* !getprompt* - Cek System Prompt AI aktif & status API Key\n` +
                             `* !clearpromptcache* - Refresh cache prompt, template & API Key terbaru\n\n` +

                             `*⚙️ UTILITAS:* \n` +
                             `* !ping* - Cek kecepatan respon bot\n` +
                             `* !runtime* - Cek waktu aktif bot & server\n` +
                             `* !sticker* / *!s* - Konversi gambar ke stiker\n\n` +
                             `_💬 Chat konfirmasi seperti "hadir", "bisa dok", "boleh min", maupun "reschedule" otomatis diproses sesuai template Spreadsheet._`;
            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            return;

          case 'followupnow':
          case 'follownow':
            let tglTarget = "auto";
            let toSender = false;

            for (const arg of args) {
              const lowerArg = arg.toLowerCase();
              if (lowerArg === 'me' || lowerArg === 'test' || lowerArg === 'myself') {
                toSender = true;
              } else if (lowerArg !== 'auto') {
                tglTarget = arg;
              }
            }

            const infoNotice = toSender 
              ? `⚡ *[FOLLOWUP NOW]* Memulai penarikan data... ⚠️ *Fitur Aktif:* Nomor penerima dialihkan ke WhatsApp Anda (*${senderPhonePure}*) dan dicatat ke Kolom 13 No Sender.`
              : `⚡ *[FOLLOWUP NOW]* Memulai penarikan data dan pengiriman instan ke nomor WhatsApp pasien...`;

            await sock.sendMessage(remoteJid, { text: infoNotice }, { quoted: msg });
            
            try {
              const blastResult = await executeFollowupBlast(sock, remoteJid, tglTarget, toSender);

              if (blastResult.totalTarget === 0) {
                await sock.sendMessage(remoteJid, { 
                  text: `ℹ️ Tidak ada antrean pasien kontrol berstatus *Pending* untuk tanggal ${blastResult.targetDate}.` 
                }, { quoted: msg });
                break;
              }

              let rekapSekarang = `🚀 *[FOLLOWUP NOW SELESAI]*\n\n` +
                                  `📅 *Target Kontrol:* ${blastResult.targetDate}\n` +
                                  `👥 *Total Pasien Disasar:* ${blastResult.totalTarget}\n` +
                                  `📲 *Pesan Terkirim:* ${blastResult.pasienTerkirim}\n` +
                                  `⚠️ *Pesan Gagal:* ${blastResult.pasienGagal}\n` +
                                  `👨‍⚕️ *Laporan Terkirim ke DPJP:* ${blastResult.laporanDokterTerkirim} Dokter\n`;

              if (blastResult.isSenderConverted) {
                rekapSekarang += `🎯 *Penerima Diarahkan ke:* ${blastResult.convertedToPhone} (Tersimpan di Kolom 13 No Sender)\n`;
              }

              rekapSekarang += `\n_Seluruh status di Google Spreadsheet berhasil diperbarui ke Terkirim._ 📊`;
              await sock.sendMessage(remoteJid, { text: rekapSekarang }, { quoted: msg });
            } catch (errNow) {
              await sock.sendMessage(remoteJid, { text: `❌ *Gagal eksekusi Followup Now:* ${errNow.message}` }, { quoted: msg });
            }
            return;

          case 'setjamfollowup':
            if (args.length === 0 || !args[0].includes(':')) {
              await sock.sendMessage(remoteJid, { 
                text: `⚠️ Format salah!\nGunakan format: *!setjamfollowup <HH:mm>*\nContoh: *!setjamfollowup 08:30*` 
              }, { quoted: msg });
              break;
            }
            const [inputJam, inputMenit] = args[0].split(':');
            const parsedJam = parseInt(inputJam, 10);
            const parsedMenit = parseInt(inputMenit, 10);

            if (isNaN(parsedJam) || isNaN(parsedMenit) || parsedJam < 0 || parsedJam > 23 || parsedMenit < 0 || parsedMenit > 59) {
              await sock.sendMessage(remoteJid, { text: "❌ Jam atau menit tidak valid! Rentang 00:00 - 23:59." }, { quoted: msg });
              break;
            }

            botSettings.autoFollowupHour = String(parsedJam).padStart(2, '0');
            botSettings.autoFollowupMinute = String(parsedMenit).padStart(2, '0');
            saveSettings();

            await sock.sendMessage(remoteJid, { 
              text: `⏰ *Jadwal Auto Follow-up Diubah!*\n\nJam: *${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA*\nStatus: *${botSettings.autoFollowupSimgos ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}*` 
            }, { quoted: msg });
            return;

          case 'followup':
          case 'cekfollowup':
            await sock.sendMessage(remoteJid, { text: "⏳ _Mengambil data pasien kontrol siap follow-up dari Google Spreadsheet..._" }, { quoted: msg });
            try {
              const tglArg = args[0] || "auto";
              const resFollowup = await callSimgosApi("get_followup", { tgl: tglArg });

              if (resFollowup.status !== "success" || !resFollowup.data || resFollowup.data.length === 0) {
                await sock.sendMessage(remoteJid, { 
                  text: `ℹ️ *Tidak ada antrean pasien kontrol berstatus Pending untuk tanggal:* ${resFollowup.target_control_date || tglArg}.` 
                }, { quoted: msg });
                break;
              }

              let textHasil = `📋 *DAFTAR PASIEN SIAP FOLLOW-UP (H-${resFollowup.h_days})*\n` +
                              `📅 *Target Kontrol:* ${resFollowup.target_control_date}\n` +
                              `👥 *Total Pasien:* ${resFollowup.total} orang\n\n`;

              resFollowup.data.forEach((px, idx) => {
                textHasil += `${idx + 1}. *${px.namaPasien}* (RM: ${px.noRm})\n` +
                             `   📱 WA Pasien: ${px.noHp}\n` +
                             `   📲 No Sender: ${px.noSender || '-'}\n` +
                             `   🏥 Status WA: ${px.statusWa} | Dokter: ${px.statusDokter}\n\n`;
              });

              textHasil += `👉 _Ketik *!followupnow me* untuk kirim ke nomor Anda, atau *!followupnow* untuk blast ke pasien._`;
              await sock.sendMessage(remoteJid, { text: textHasil }, { quoted: msg });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Gagal mengambil data:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'gassfollowup':
          case 'kirimfollowup':
            await sock.sendMessage(remoteJid, { text: "🚀 _Memulai pengiriman pesan WhatsApp massal... Mohon tunggu._" }, { quoted: msg });
            try {
              let tglKirim = "auto";
              let toSenderGass = false;

              for (const a of args) {
                if (a.toLowerCase() === 'me' || a.toLowerCase() === 'test') toSenderGass = true;
                else if (a.toLowerCase() !== 'auto') tglKirim = a;
              }

              const blastResult = await executeFollowupBlast(sock, remoteJid, tglKirim, toSenderGass);

              if (blastResult.totalTarget === 0) {
                await sock.sendMessage(remoteJid, { text: `ℹ️ Tidak ada antrean pasien Pending untuk tanggal ${blastResult.targetDate}.` }, { quoted: msg });
                break;
              }

              let rekapAkhir = `✅ *EKSEKUSI FOLLOW-UP SELESAI!*\n\n` +
                               `📅 *Tgl Kontrol:* ${blastResult.targetDate}\n` +
                               `👥 *Total Target Pasien:* ${blastResult.totalTarget}\n` +
                               `📲 *Pasien Berhasil Dikirimi:* ${blastResult.pasienTerkirim}\n` +
                               `⚠️ *Pasien Gagal:* ${blastResult.pasienGagal}\n` +
                               `👨‍⚕️ *Laporan DPJP Terkirim:* ${blastResult.laporanDokterTerkirim} Dokter\n`;

              if (blastResult.isSenderConverted) {
                rekapAkhir += `🎯 *Catatan:* Pesan dialihkan ke WhatsApp pengirim (${blastResult.convertedToPhone}) & Kolom 13 No Sender terupdate.\n`;
              }

              rekapAkhir += `\n_Seluruh status di Google Spreadsheet berhasil diperbarui ke Terkirim._ 📊`;
              await sock.sendMessage(remoteJid, { text: rekapAkhir }, { quoted: msg });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Terjadi Kesalahan saat eksekusi:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'caripasien':
            if (args.length === 0) {
              await sock.sendMessage(remoteJid, { text: "⚠️ Masukkan kata kunci pencarian!\nContoh: *!caripasien 00.06.32.89* atau *!caripasien ILDHAYANI*" }, { quoted: msg });
              break;
            }
            const queryCari = args.join(" ");
            await sock.sendMessage(remoteJid, { text: `🔍 _Mencari data pasien "${queryCari}"..._` }, { quoted: msg });
            try {
              const hasilCari = await callSimgosApi("search_patient", { query: queryCari });
              if (hasilCari.status !== "success" || !hasilCari.data || hasilCari.data.length === 0) {
                await sock.sendMessage(remoteJid, { text: `❌ Data pasien dengan kata kunci *"${queryCari}"* tidak ditemukan.` }, { quoted: msg });
                break;
              }

              let txtMatch = `🎯 *HASIL PENCARIAN PASIEN (${hasilCari.total}):*\n\n`;
              hasilCari.data.slice(0, 5).forEach((p, idx) => {
                txtMatch += `${idx + 1}. *${p.namaPasien}*\n` +
                            `   🔖 No. RM: ${p.noRm}\n` +
                            `   📅 Tgl Masuk: ${p.tglMasuk}\n` +
                            `   📅 Tgl Kontrol: ${p.tglKontrol}\n` +
                            `   📱 No. WA: ${p.noHp}\n` +
                            `   📲 No. Sender: ${p.noSender || '-'}\n` +
                            `   🎂 Umur / JK: ${p.umur} / ${p.jenisKelamin}\n` +
                            `   Status: Pasien [${p.statusWa}] | Dokter [${p.statusDokter}]\n\n`;
              });

              await sock.sendMessage(remoteJid, { text: txtMatch }, { quoted: msg });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Gagal mencari pasien:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'reschedule':
            if (args.length < 2) {
              await sock.sendMessage(remoteJid, { 
                text: "⚠️ Format salah!\nGunakan: *!reschedule <No.RM> <YYYY-MM-DD>*\nContoh: *!reschedule 00.06.32.89 2026-10-15*" 
              }, { quoted: msg });
              break;
            }
            const rmResched = args[0];
            const dateResched = args[1];

            await sock.sendMessage(remoteJid, { text: `⏳ _Memproses penjadwalan ulang No. RM ${rmResched} ke tanggal ${dateResched}..._` }, { quoted: msg });
            try {
              const reschedApi = await callSimgosApi("reschedule_patient", { noRm: rmResched, newDate: dateResched });
              if (reschedApi.status === "success") {
                await sock.sendMessage(remoteJid, { 
                  text: `✅ *Reschedule Berhasil!*\n\n` +
                        `🔖 No. RM: *${rmResched}*\n` +
                        `📅 Jadwal Kontrol Baru: *${dateResched}*\n` +
                        `Status pasien otomatis direset ke *Pending* agar siap difollow-up kembali.` 
                }, { quoted: msg });
              } else {
                throw new Error(reschedApi.message);
              }
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Gagal Reschedule:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'statskontrol':
          case 'statssimgos':
            await sock.sendMessage(remoteJid, { text: "⏳ _Menghitung statistik follow-up klinik..._" }, { quoted: msg });
            try {
              const statsRes = await callSimgosApi("get_summary_stats");
              if (statsRes.status === "success") {
                const s = statsRes.statistics;
                const repStats = `📊 *STATISTIK KONTROL POLI SIMGOS*\n` +
                                 `📅 Tanggal Server: ${statsRes.date}\n\n` +
                                 `📁 Total Pasien Terdata: *${s.total_pasien_terdata} Pasien*\n` +
                                 `📥 Di-scrape Hari Ini: *${s.scraped_hari_ini} Pasien*\n\n` +
                                 `*Status WA Pasien:*\n` +
                                 `⏳ Pending: ${s.wa_pasien_pending}\n` +
                                 `✅ Terkirim/Hadir: ${s.wa_pasien_terkirim}\n\n` +
                                 `*Status Konfirmasi Dokter:*\n` +
                                 `⏳ Pending: ${s.notif_dokter_pending}\n` +
                                 `✅ Terkirim: ${s.notif_dokter_terkirim}\n\n` +
                                 `🏥 *Faskes:* ${statsRes.config.instansi}\n` +
                                 `🦷 *Klinik:* ${statsRes.config.poli}\n` +
                                 `⏰ *Jadwal Auto Blast:* Jam ${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA`;
                await sock.sendMessage(remoteJid, { text: repStats }, { quoted: msg });
              } else throw new Error(statsRes.message);
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Gagal mengambil statistik:* ${e.message}` }, { quoted: msg });
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
                await sock.sendMessage(remoteJid, { text: txtCfg }, { quoted: msg });
              }
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Error:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'templatesimgos':
            try {
              const sysCfg = await fetchSystemAIConfig();
              let tplTxt = `📝 *TEMPLATE PESAN SPREADSHEET (CUSTOM_FORMAT):*\n\n`;
              for (const [kode, isi] of Object.entries(sysCfg.templates)) {
                tplTxt += `🔖 *Kode:* \`${kode}\`\n${isi}\n\n-------------------------\n\n`;
              }
              await sock.sendMessage(remoteJid, { text: tplTxt }, { quoted: msg });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Error:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'autofollowup':
            if (args[0] === 'on' || args[0] === 'off') {
              botSettings.autoFollowupSimgos = args[0] === 'on';
              saveSettings();
              await sock.sendMessage(remoteJid, { 
                text: `⚙️ Fitur *Auto Follow-up Kontrol (${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA)* disetel ke: *${args[0].toUpperCase()}*` 
              }, { quoted: msg });
            } else {
              await sock.sendMessage(remoteJid, { 
                text: `Status Auto Follow-up: *${botSettings.autoFollowupSimgos ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}*\nJam Blast: *${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA*\nGunakan: *!autofollowup on*, *!autofollowup off*, atau *!setjamfollowup <HH:mm>*` 
              }, { quoted: msg });
            }
            return;

          case 'getprompt':
            const activeCfg = await fetchSystemAIConfig();
            const geminiMasked = activeCfg.geminiApiKey ? `${activeCfg.geminiApiKey.substring(0, 8)}...${activeCfg.geminiApiKey.slice(-4)}` : "TIDAK TERPASANG";
            const groqMasked = activeCfg.groqApiKey ? `${activeCfg.groqApiKey.substring(0, 8)}...${activeCfg.groqApiKey.slice(-4)}` : "TIDAK TERPASANG";

            await sock.sendMessage(remoteJid, { 
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
              instansi: 'RSKD Gigi dan Mulut Prov. Sulawesi Selatan',
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
            await sock.sendMessage(remoteJid, { text: "🔄 Cache Custom Prompt, Template & Kredensial AI berhasil dibersihkan. Konfigurasi baru langsung ditarik dari Spreadsheet saat chat berikutnya." }, { quoted: msg });
            return;

          case 'ping':
            const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
            await sock.sendMessage(remoteJid, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingProcess} ms` }, { quoted: msg }); 
            return;

          case 'runtime':
            const uptime = process.uptime();
            await sock.sendMessage(remoteJid, { 
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
      await sock.sendPresenceUpdate('composing', remoteJid);

      // A. Ambil Konfigurasi AI & Template Dinamis Langsung dari Sheet
      const sysConfig = await fetchSystemAIConfig();

      // Tentukan nomor WhatsApp DPJP Utama (Dokter 1)
      const targetDpjpUtamaWa = sysConfig.doctors?.[0]?.wa || sysConfig.dpjpUtamaWa || "6282291675363";
      const targetDpjpUtamaJid = sanitizeNumber(targetDpjpUtamaWa);

      // B. Identifikasi Data Pasien dari Spreadsheet Berdasarkan No WA / No Sender (Kolom 13)
      let patientData = null;
      try {
        const searchPx = await callSimgosApi("search_patient", { query: senderPhonePure });
        if (searchPx.status === "success" && Array.isArray(searchPx.data) && searchPx.data.length > 0) {
          patientData = searchPx.data[0];
          console.log(`[Pasien Ditemukan dari Database] Nama: ${patientData.namaPasien} | RM: ${patientData.noRm} | Tgl: ${patientData.tglKontrol}`);
        } else {
          // Cek fallback sesi lokal jika baru saja di-blast
          const sessionSaved = conversationSessions.get(senderPhonePure);
          if (sessionSaved && sessionSaved.patientData) {
            patientData = sessionSaved.patientData;
            console.log(`[Pasien Dikenali dari Sesi Lokal] Nama: ${patientData.namaPasien}`);
          } else {
            console.warn(`[Pasien Tidak Dikenali di Kolom WA maupun Kolom No Sender] Sender: ${senderPhonePure}`);
          }
        }
      } catch (errSearch) {
        console.warn("[Search Patient Warning]", errSearch.message);
      }

      // Objek Pasien Definitif (Prioritas Database Pasien Asli)
      const pObj = patientData || {
        namaPasien: pushName,
        noRm: "-",
        tglKontrol: "Terjadwal",
        tglMasuk: "-",
        umur: "-",
        agama: "-",
        jenisKelamin: "-",
        noHp: senderPhonePure,
        noSender: senderPhonePure
      };

      // C. Klasifikasi Niat Pasien (Super Smart NLP: hadir, bisa dok, siap min, reschedule, dll)
      const intent = detectPatientIntent(text);

      // =====================================================================
      // JALUR 1: PASIEN KONFIRMASI "HADIR" (BISA DOK / SIAP KAK / BOLEH MIN DLL)
      // =====================================================================
      if (intent.type === 'HADIR') {
        // 1. Update status dan tautkan No Sender aktif ke Kolom 13 di Spreadsheet
        if (patientData && patientData.noRm) {
          try {
            await callSimgosApi("update_status", { 
              noRm: patientData.noRm, 
              type: "pasien", 
              status: "Hadir (Terkonfirmasi)",
              noSender: senderPhonePure
            });
          } catch (e) {
            console.error("[Update Status Hadir Error]", e.message);
          }
        }

        // 2. KIRIM NOTIFIKASI KE DOKTER DPJP UTAMA (100% Template Database WA_LAPORAN_HADIR_DOKTER)
        const templateLaporanHadir = sysConfig.templates["WA_LAPORAN_HADIR_DOKTER"];
        if (templateLaporanHadir) {
          const notifDokterHadir = compileTemplateText(templateLaporanHadir, pObj, sysConfig);
          try {
            await sock.sendMessage(targetDpjpUtamaJid, { text: notifDokterHadir });
            console.log(`[Notif Hadir Terkirim ke DPJP Utama] ${sysConfig.dpjpUtama} (${targetDpjpUtamaJid})`);
          } catch (docErr) {
            console.error(`[Gagal Kirim ke DPJP Utama: ${targetDpjpUtamaJid}]`, docErr.message);
          }
        } else {
          console.warn("[Peringatan] Template 'WA_LAPORAN_HADIR_DOKTER' belum ditemukan di CUSTOM_FORMAT.");
        }

        // 3. KIRIM BALASAN KE PASIEN (100% Template Database WA_PX_HADIR_CONFIRM)
        const templateBalasHadir = sysConfig.templates["WA_PX_HADIR_CONFIRM"];
        if (templateBalasHadir) {
          const replyHadir = compileTemplateText(templateBalasHadir, pObj, sysConfig);
          await sock.sendMessage(remoteJid, { text: replyHadir });
        }
        
        await sock.sendPresenceUpdate('paused', remoteJid);
        return;
      }

      // =====================================================================
      // JALUR 2: PASIEN INGIN "RESCHEDULE" / MENGIRIM TANGGAL BARU
      // =====================================================================
      if (intent.type === 'RESCHEDULE') {
        // Kasus 2A: Pasien langsung menyertakan tanggal baru (misal: "2026-09-28" atau "undur ke 25 september")
        if (intent.date) {
          const newDate = intent.date;
          if (patientData && patientData.noRm) {
            try {
              await callSimgosApi("reschedule_patient", {
                noRm: patientData.noRm,
                newDate: newDate,
                noSender: senderPhonePure
              });
            } catch (e) {
              console.error("[Reschedule API Error]", e.message);
            }
          }

          const updatedPatientObj = {
            ...pObj,
            tglKontrol: newDate,
            noSender: senderPhonePure
          };

          // 1. KIRIM NOTIFIKASI KE DOKTER DPJP UTAMA (100% Template Database WA_LAPORAN_RESCHEDULE_DOKTER)
          const templateLaporanResched = sysConfig.templates["WA_LAPORAN_RESCHEDULE_DOKTER"];
          if (templateLaporanResched) {
            const notifResched = compileTemplateText(templateLaporanResched, updatedPatientObj, sysConfig);
            try {
              await sock.sendMessage(targetDpjpUtamaJid, { text: notifResched });
              console.log(`[Notif Reschedule Terkirim ke DPJP Utama] ${sysConfig.dpjpUtama} (${targetDpjpUtamaJid})`);
            } catch (docErr) {
              console.error(`[Gagal Kirim ke DPJP Utama: ${targetDpjpUtamaJid}]`, docErr.message);
            }
          } else {
            console.warn("[Peringatan] Template 'WA_LAPORAN_RESCHEDULE_DOKTER' belum ditemukan di CUSTOM_FORMAT.");
          }

          // 2. KIRIM BALASAN KE PASIEN (100% Template Database WA_PX_RESCHEDULE)
          const templateBalasResched = sysConfig.templates["WA_PX_RESCHEDULE"];
          if (templateBalasResched) {
            const replyResched = compileTemplateText(templateBalasResched, updatedPatientObj, sysConfig);
            await sock.sendMessage(remoteJid, { text: replyResched });
          }

          await sock.sendPresenceUpdate('paused', remoteJid);
          return;
        }

        // Kasus 2B: Pasien meminta reschedule tanpa menyebutkan tanggal
        if (patientData && patientData.noRm) {
          try {
            await callSimgosApi("update_status", { 
              noRm: patientData.noRm, 
              type: "pasien", 
              status: "Reschedule Diajukan",
              noSender: senderPhonePure
            });
          } catch (e) {}
        }

        // Tanyakan tanggal dengan 100% Template Database WA_PX_RESCHEDULE_ASK
        const templateTanyaTanggal = sysConfig.templates["WA_PX_RESCHEDULE_ASK"];
        if (templateTanyaTanggal) {
          const replyAskDate = compileTemplateText(templateTanyaTanggal, pObj, sysConfig);
          await sock.sendMessage(remoteJid, { text: replyAskDate });
        }

        await sock.sendPresenceUpdate('paused', remoteJid);
        return;
      }

      // =====================================================================
      // JALUR 3: PERCAKAPAN UMUM, KONSULTASI GIGI & AI PARSER (GEMINI / GROQ)
      // =====================================================================
      let userSession = conversationSessions.get(senderPhonePure);
      if (!userSession) {
        userSession = { history: [], lastSeen: Date.now(), patientData: patientData };
        conversationSessions.set(senderPhonePure, userSession);
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
        try { await sock.sendPresenceUpdate('composing', remoteJid); } catch (e) {}
      }, 4000);

      let rawAiResponse = "";
      try {
        rawAiResponse = await askAIClinicUnified(userSession.history, patientData);
      } catch (aiErr) {
        console.error("[Dual AI Fatal Error]", aiErr.message);
        rawAiResponse = `Halo Bapak/Ibu ${pObj.namaPasien}, terima kasih telah menghubungi Poli Konservasi RSKD Gigi dan Mulut Prov. Sulsel. Pesan Anda telah kami terima, staf poli kami siap membantu jadwal kontrol dan perawatan gigi Anda. Ada yang bisa kami bantu? 🙏`;
      } finally {
        clearInterval(typingTimer);
      }

      // Deteksi Tag Aksi [ACTION:HADIR] dari Percakapan AI
      if (rawAiResponse.includes('[ACTION:HADIR]')) {
        rawAiResponse = rawAiResponse.replace(/\[ACTION:HADIR\]/gi, '').trim();

        if (patientData && patientData.noRm) {
          await callSimgosApi("update_status", { 
            noRm: patientData.noRm, 
            type: "pasien", 
            status: "Hadir (Terkonfirmasi)",
            noSender: senderPhonePure
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

      // Deteksi Tag Aksi [ACTION:RESCHEDULE:YYYY-MM-DD] dari Percakapan AI
      const rescheduleMatch = rawAiResponse.match(/\[ACTION:RESCHEDULE:(\d{4}-\d{2}-\d{2})\]/i);
      let finalClientReply = rawAiResponse.replace(/\[ACTION:RESCHEDULE:\d{4}-\d{2}-\d{2}\]/gi, '').trim();

      if (rescheduleMatch) {
        const newRescheduleDate = rescheduleMatch[1];
        if (patientData && patientData.noRm) {
          try {
            await callSimgosApi("reschedule_patient", {
              noRm: patientData.noRm,
              newDate: newRescheduleDate,
              noSender: senderPhonePure
            });
          } catch (reschedErr) {
            console.error("[Auto-Reschedule Error]", reschedErr.message);
          }
        }

        const updatedPx = { ...pObj, tglKontrol: newRescheduleDate, noSender: senderPhonePure };
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
      await sock.sendMessage(remoteJid, { text: formattedReply });
      await sock.sendPresenceUpdate('paused', remoteJid);

    } catch (error) { 
      console.error('Error proses pesan:', error); 
    }
  });
}
