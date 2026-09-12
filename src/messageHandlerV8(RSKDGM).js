import fs from 'fs';
import process from 'process';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// Handler perintah eksternal pendukung
import handleStickerCommand from './commands/sticker.js';

// =========================================================================
// KONFIGURASI SISTEM, GOOGLE AI STUDIO & DATABASE RSKDGM
// =========================================================================
const ownerNumber = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

// URL REST API Google Apps Script (GAS) SIMGOS RSKDGM
const GAS_URL_SIMGOS = process.env.GAS_URL_SIMGOS || "https://script.google.com/macros/s/AKfycbzCOj9YFKEqXRfMEKBugnEhqzuC7MoJfIyc5PihST3bxmJaseaKKX9YifotK2qpT38/exec";

// Kunci API Google AI Studio & Model Gemini Terpercaya
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6KfVb-fIIdi_BsauXX69CEOoE037lYnsPJYvCy4Vhr6cw";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Kontak WhatsApp Dokter DPJP RSKDGM
const DOKTER_JID_LIST = [
  "6282291675363@s.whatsapp.net", // drg. Hj. Kurniawaty, Sp.KG
  "6285256739684@s.whatsapp.net"  // drg. M. Aksa Arsyad
];

// Manajemen Sesi Percakapan & Cache System Prompt
const conversationSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // Kadaluarsa sesi percakapan 30 menit
let cachedCustomPrompt = { prompt: '', timestamp: 0 };
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000; // Cache prompt lokal 5 menit

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
 * Ekstraktor tanggal fleksibel dari pesan pasien (Bahasa Indonesia & format angka)
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

  // 3. Format Nama Bulan Bahasa Indonesia: contoh "28 September 2026" atau "28 September"
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
 * Deteksi Intent Pasien (HADIR vs RESCHEDULE vs GENERAL)
 */
function detectPatientIntent(rawText) {
  const text = rawText.trim().toLowerCase();

  // Pola Konfirmasi Hadir
  const hadirPattern = /\b(hadir|hadirr|hadirrr|bisa hadir|siap hadir|pasti hadir|datang|bisa datang|siap datang|konfirmasi hadir|insya allah hadir|hadir dok|hadir kak)\b/i;
  if (hadirPattern.test(text) && !text.includes('tidak') && !text.includes('batal') && !text.includes('reschedule') && !text.includes('ganti')) {
    return { type: 'HADIR' };
  }

  // Pola Reschedule (mendukung typo: reschedole, rescedule, riscedul, jadwal ulang, undur, ganti jadwal)
  const reschedPattern = /\b(reschedule|reschedole|rescedule|riscedul|rescedul|jadwal ulang|ganti jadwal|ubah jadwal|undur|mundur|tunda)\b/i;
  if (reschedPattern.test(text)) {
    const extractedDate = extractDateFromText(text);
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

async function fetchActiveCustomPrompt() {
  const now = Date.now();
  if (cachedCustomPrompt.prompt && (now - cachedCustomPrompt.timestamp < PROMPT_CACHE_TTL_MS)) {
    return cachedCustomPrompt.prompt;
  }

  try {
    const res = await callSimgosApi("get_active_prompt");
    if (res && res.status === "success" && res.activePrompt) {
      cachedCustomPrompt = { prompt: res.activePrompt, timestamp: now };
      return res.activePrompt;
    }
  } catch (e) {
    console.warn("[Custom Prompt Warning] Menggunakan prompt default cadangan.");
  }

  return `Kamu adalah Asisten Resepsionis Medis Resmi RSKD Gigi dan Mulut Provinsi Sulawesi Selatan (Poli Konservasi dan Endodonsi).
Dokter DPJP: drg. Hj. Kurniawaty, Sp.KG & drg. M. Aksa Arsyad.
Karakter: Sangat ramah, bersahabat, sopan, profesional layaknya manusia sungguhan.
PENTING: Jika pasien meminta reschedule tanggal kontrol dan menentukan tanggalnya, sisipkan tag [ACTION:RESCHEDULE:YYYY-MM-DD] di akhir pesanmu.`;
}

// =========================================================================
// REST API GOOGLE AI STUDIO ENGINE (SUPER UPGRADE: FIXED AUTH & FAILOVER)
// =========================================================================
async function askGeminiClinic(conversationHistory, patientContext = null) {
  const apiKey = GEMINI_API_KEY.trim();

  // 1. Sanitasi History: Pastikan giliran berselang-seling dan diawali 'user'
  const sanitizedHistory = [];
  for (const turn of conversationHistory) {
    if (!turn.parts || !turn.parts[0] || !turn.parts[0].text) continue;
    const role = turn.role === 'model' ? 'model' : 'user';
    const text = String(turn.parts[0].text).trim();
    if (!text) continue;

    if (sanitizedHistory.length > 0 && sanitizedHistory[sanitizedHistory.length - 1].role === role) {
      // Gabungkan turn berturut-turut yang memiliki role sama
      sanitizedHistory[sanitizedHistory.length - 1].parts[0].text += `\n${text}`;
    } else {
      sanitizedHistory.push({ role, parts: [{ text }] });
    }
  }

  // Wajib diawali oleh user
  while (sanitizedHistory.length > 0 && sanitizedHistory[0].role !== 'user') {
    sanitizedHistory.shift();
  }

  if (sanitizedHistory.length === 0) {
    throw new Error('History pesan tidak valid.');
  }

  let systemPromptText = await fetchActiveCustomPrompt();

  if (patientContext) {
    systemPromptText += `\n\nKONTEKS PASIEN YANG SEDANG CHAT SAAT INI:
- Nama Pasien: ${patientContext.namaPasien || "-"}
- No. Rekam Medis: ${patientContext.noRm || "-"}
- Jadwal Kontrol Terdaftar: ${patientContext.tglKontrol || "-"}
- Dokter DPJP: drg. Hj. Kurniawaty, Sp.KG & drg. M. Aksa Arsyad
- Poli: Poli Konservasi dan Endodonsi
Gunakan informasi di atas jika relevan untuk menyapa atau mengonfirmasi jadwal mereka secara akrab.`;
  }

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

  // Daftar model failover bertingkat
  const modelList = [
    GEMINI_MODEL,
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastError = null;

  for (const model of modelList) {
    try {
      // PERBAIKAN FATAL: Gunakan x-goog-api-key dan URL ?key, HAPUS Authorization: Bearer
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const headers = { 
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody)
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[Gemini Try ${model} ${res.status}]`, errText);
        lastError = new Error(`Google AI Studio (${model}) ${res.status}: ${errText}`);
        if (res.status === 404 || res.status === 400) continue;
        break;
      }

      const data = await res.json();
      const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawReply && rawReply.trim()) {
        return rawReply.trim();
      }
    } catch (modelErr) {
      console.warn(`[Gemini Error on ${model}]`, modelErr.message);
      lastError = modelErr;
    }
  }

  throw lastError || new Error('Gagal memproses respon dari seluruh model Gemini.');
}

// =========================================================================
// LOGIKA FOLLOW-UP DENGAN FITUR AUTO-CONVERT NOMOR SENDER
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

  // 1. Kirim pesan pengingat ke pasien
  for (const px of listPasien) {
    const targetJid = (overrideToSender && replyTargetJid) ? sanitizeNumber(replyTargetJid) : sanitizeNumber(px.noHp);

    try {
      let pesanKirim = px.pesan_wa_pasien;
      if (overrideToSender) {
        pesanKirim = `🧪 *[TESTING BLAST: NOMOR DIKONVERSI KE SENDER]*\n` +
                     `_(Asli Pasien: ${px.namaPasien} | No. Asli: ${px.originalNoHp || px.noHp})_\n\n` + 
                     pesanKirim;
      }

      await sock.sendMessage(targetJid, { text: pesanKirim });
      resultLog.pasienTerkirim++;
      
      await callSimgosApi("update_status", { 
        row: px.rowNumber, 
        type: "pasien", 
        status: "Terkirim" 
      });

      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[Gagal Kirim Pasien] ${px.namaPasien}:`, e);
      resultLog.pasienGagal++;
    }
  }

  // 2. Kirim laporan ke kedua dokter DPJP
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

      // 1. FILTER MUTLAK: TOLAK PESAN GRUP & BROADCAST
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
      // 2. COMMAND ADMIN (PREFIX '!')
      // =====================================================================
      if (text.startsWith('!')) {
        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch (command) {
          case 'menu':
          case 'help':
            const menuText = `*🤖 BOT KONTROL RSKDGM & ASISTEN AI (GEMINI) 🤖*\n\n` +
                             `*🦷 SIMGOS FOLLOW-UP KONTROL:*\n` +
                             `* !followupnow* [tgl/auto] [me] - 🚀 *Kirim sekarang* (Ketik 'me' untuk otomatis konversi nomor pasien ke nomor WhatsApp Anda)\n` +
                             `* !followup* [tgl/auto] - Cek daftar antrean pasien kontrol\n` +
                             `* !gassfollowup* [tgl/auto] [me] - Kirim WA massal ke Pasien & 2 Dokter\n` +
                             `* !caripasien* <No.RM/Nama/WA> - Cari data pasien di Spreadsheet\n` +
                             `* !reschedule* <No.RM> <YYYY-MM-DD> - Ubah tanggal kontrol manual\n` +
                             `* !statskontrol* - Cek ringkasan statistik kontrol\n` +
                             `* !settingssimgos* - Cek konfigurasi H- & nomor dokter\n` +
                             `* !templatesimgos* - Cek template format pesan WhatsApp\n` +
                             `* !autofollowup on/off* - Pengaturan status blast otomatis harian\n` +
                             `* !setjamfollowup* <HH:mm> - Ubah jam blast otomatis\n\n` +

                             `*🧠 GOOGLE AI STUDIO:*\n` +
                             `* !getprompt* - Cek System Instruction AI aktif dari Sheet\n` +
                             `* !clearpromptcache* - Refresh cache prompt terbaru dari Sheet\n\n` +

                             `*⚙️ UTILITAS:* \n` +
                             `* !ping* - Cek kecepatan respon bot\n` +
                             `* !runtime* - Cek status server & waktu aktif bot\n` +
                             `* !sticker* / *!s* - Konversi gambar ke stiker\n\n` +
                             `_💬 Chat biasa tanpa tanda (!) akan otomatis ditangani secara cerdas & ramah._`;
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
              ? `⚡ *[FOLLOWUP NOW]* Memulai penarikan data... ⚠️ *Fitur Aktif:* Nomor penerima otomatis dialihkan ke nomor WhatsApp Anda (*${senderPhonePure}*).`
              : `⚡ *[FOLLOWUP NOW]* Memulai penarikan data dan pengiriman instan ke nomor WhatsApp pasien terdaftar...`;

            await sock.sendMessage(remoteJid, { text: infoNotice }, { quoted: msg });
            
            try {
              const blastResult = await executeFollowupBlast(sock, remoteJid, tglTarget, toSender);

              if (blastResult.totalTarget === 0) {
                await sock.sendMessage(remoteJid, { 
                  text: `ℹ️ Tidak ada antrean pasien kontrol berstatus *Pending* untuk target tanggal ${blastResult.targetDate}. Semua sudah terkirim atau belum ada jadwal.` 
                }, { quoted: msg });
                break;
              }

              let rekapSekarang = `🚀 *[FOLLOWUP NOW SELESAI DILAKUKAN]*\n\n` +
                                  `📅 *Target Kontrol:* ${blastResult.targetDate}\n` +
                                  `👥 *Total Pasien Disasar:* ${blastResult.totalTarget}\n` +
                                  `📲 *Pesan Terkirim:* ${blastResult.pasienTerkirim}\n` +
                                  `⚠️ *Pesan Gagal:* ${blastResult.pasienGagal}\n` +
                                  `👨‍⚕️ *Laporan Terkirim ke DPJP:* ${blastResult.laporanDokterTerkirim} Dokter\n`;

              if (blastResult.isSenderConverted) {
                rekapSekarang += `🎯 *Penerima Diarahkan ke:* ${blastResult.convertedToPhone} (Nomor Sender Anda)\n`;
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
              await sock.sendMessage(remoteJid, { text: "❌ Jam atau menit tidak valid! Gunakan rentang 00:00 - 23:59." }, { quoted: msg });
              break;
            }

            botSettings.autoFollowupHour = String(parsedJam).padStart(2, '0');
            botSettings.autoFollowupMinute = String(parsedMenit).padStart(2, '0');
            saveSettings();

            await sock.sendMessage(remoteJid, { 
              text: `⏰ *Jadwal Jam Auto Follow-up Berhasil Diubah!*\n\nJam Eksekusi Harian: *${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA*\nStatus Auto Follow-up: *${botSettings.autoFollowupSimgos ? 'AKTIF (ON)' : 'NONAKTIF (OFF)'}*` 
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
                             `   📱 WA: ${px.noHp}\n` +
                             `   🏥 Status WA: ${px.statusWa} | Dokter: ${px.statusDokter}\n\n`;
              });

              textHasil += `👉 _Ketik *!followupnow me* untuk kirim ke nomor Anda, atau *!followupnow* untuk kirim ke pasien._`;
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
                rekapAkhir += `🎯 *Catatan:* Pesan pasien dialihkan ke nomor WhatsApp pengirim (${blastResult.convertedToPhone}).\n`;
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
                        `Status pasien otomatis direset ke *Pending* agar siap difollow-up kembali saat mendekati jadwal baru.` 
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
                             `🕒 Jam Auto Blast Harian: *${botSettings.autoFollowupHour}:${botSettings.autoFollowupMinute} WITA*\n` +
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
            const activeP = await fetchActiveCustomPrompt();
            await sock.sendMessage(remoteJid, { 
              text: `📋 *SYSTEM PROMPT AKTIF DARI SHEET 'CUSTOM_PROMPT':*\n\n"${activeP}"\n\n⚡ Model: *${GEMINI_MODEL}*` 
            }, { quoted: msg });
            return;

          case 'clearpromptcache':
            cachedCustomPrompt = { prompt: '', timestamp: 0 };
            await sock.sendMessage(remoteJid, { text: "🔄 Cache Custom Prompt berhasil dibersihkan. Prompt baru akan langsung diambil dari Sheet saat chat berikutnya." }, { quoted: msg });
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
      // 3. HYBRID INTELLIGENT CHAT ENGINE (FAST-PATH INTENT + GEMINI AI)
      // =====================================================================
      await sock.sendPresenceUpdate('composing', remoteJid);

      // A. Identifikasi Pasien dari Spreadsheet Berdasarkan Nomor WA Pengirim
      let patientData = null;
      try {
        const searchPx = await callSimgosApi("search_patient", { query: senderPhonePure });
        if (searchPx.status === "success" && Array.isArray(searchPx.data) && searchPx.data.length > 0) {
          patientData = searchPx.data[0];
        }
      } catch (errSearch) {
        console.warn("[Search Patient Warning]", errSearch.message);
      }

      // B. Klasifikasi Niat Pasien (Intent Detection)
      const intent = detectPatientIntent(text);

      // --- JALUR CEPAT 1: PASIEN KONFIRMASI "HADIR" ---
      if (intent.type === 'HADIR') {
        const namaPx = patientData ? patientData.namaPasien : pushName;
        const noRmPx = patientData ? patientData.noRm : "-";
        const tglKontrolPx = patientData ? patientData.tglKontrol : "jadwal Anda";

        if (patientData) {
          // Update status di database spreadsheet menjadi Hadir
          await callSimgosApi("update_status", { 
            noRm: patientData.noRm, 
            type: "pasien", 
            status: "Hadir (Terkonfirmasi)" 
          }).catch(() => {});

          // Notifikasi langsung ke kedua Dokter DPJP
          const notifDokterHadir = `✅ *KONFIRMASI KEHADIRAN PASIEN (HADIR)*\n\n` +
                                   `Pasien berikut telah mengonfirmasi *HADIR* untuk kontrol gigi:\n` +
                                   `👤 *Nama Pasien:* ${patientData.namaPasien}\n` +
                                   `🔖 *No. RM:* ${patientData.noRm}\n` +
                                   `📅 *Tgl Kontrol:* ${patientData.tglKontrol}\n` +
                                   `📱 *WhatsApp:* ${patientData.noHp}\n` +
                                   `🏥 *Unit:* Poli Konservasi dan Endodonsi\n\n` +
                                   `_Status database SIMGOS telah diperbarui ke Terkonfirmasi Hadir._ 📊`;

          for (const docJid of DOKTER_JID_LIST) {
            await sock.sendMessage(docJid, { text: notifDokterHadir }).catch(() => {});
          }
        }

        const replyHadir = `Halo, terima kasih banyak atas konfirmasinya Bapak/Ibu *${namaPx}* (No. RM: ${noRmPx}). 🙏\n\n` +
                           `Kehadiran Anda untuk jadwal kontrol perawatan gigi pada tanggal *${tglKontrolPx}* bersama tim dokter penanggung jawab kami (*drg. Hj. Kurniawaty, Sp.KG* & *drg. M. Aksa Arsyad*) telah berhasil kami catat di sistem.\n\n` +
                           `📌 *Pengingat Kontrol:*\n` +
                           `• Harap hadir 15 menit sebelum poli dibuka.\n` +
                           `• Mohon membawa Kartu BPJS / KTP serta kartu kontrol sebelumnya.\n` +
                           `• Lakukan konfirmasi di loket pendaftaran Poli Konservasi.\n\n` +
                           `Sampai jumpa di poli ya. Semoga proses perawatan giginya berjalan lancar dan lekas sehat selalu! 🦷✨`;

        await sock.sendMessage(remoteJid, { text: replyHadir });
        await sock.sendPresenceUpdate('paused', remoteJid);
        return;
      }

      // --- JALUR CEPAT 2: PASIEN INGIN "RESCHEDULE" ---
      if (intent.type === 'RESCHEDULE') {
        const namaPx = patientData ? patientData.namaPasien : pushName;
        const noRmPx = patientData ? patientData.noRm : "-";

        // Kasus 2A: Pasien langsung menyertakan tanggal baru
        if (intent.date && patientData) {
          const newDate = intent.date;
          await callSimgosApi("reschedule_patient", {
            noRm: patientData.noRm,
            newDate: newDate
          }).catch(() => {});

          const notifResched = `🔄 *NOTIFIKASI RESCHEDULE PASIEN (MANDIRI WA)*\n\n` +
                               `Pasien telah mengajukan jadwal kontrol ulang:\n` +
                               `👤 *Nama:* ${patientData.namaPasien}\n` +
                               `🔖 *No. RM:* ${patientData.noRm}\n` +
                               `📅 *Jadwal Lama:* ${patientData.tglKontrol}\n` +
                               `✨ *Jadwal Baru:* ${newDate}\n` +
                               `📱 *WhatsApp:* ${patientData.noHp}\n` +
                               `💬 *Pesan Pasien:* "${text.trim()}"\n\n` +
                               `_Status database telah direset ke Pending untuk tanggal baru._ 📊`;

          for (const docJid of DOKTER_JID_LIST) {
            await sock.sendMessage(docJid, { text: notifResched }).catch(() => {});
          }

          const replyResched = `Baik Bapak/Ibu *${namaPx}* (No. RM: ${noRmPx}), terima kasih atas konfirmasinya.\n\n` +
                               `Jadwal kontrol perawatan gigi Anda telah berhasil kami perbarui ke tanggal: *${newDate}*.\n\n` +
                               `Informasi perubahan ini sudah diteruskan ke dokter penanggung jawab (*drg. Hj. Kurniawaty, Sp.KG* & *drg. M. Aksa Arsyad*). Sistem kami akan mengingatkan Anda kembali saat mendekati jadwal tersebut.\n\n` +
                               `Salam sehat selalu dari Poli Konservasi RSKD Gigi dan Mulut Prov. Sulsel. 🙏`;

          await sock.sendMessage(remoteJid, { text: replyResched });
          await sock.sendPresenceUpdate('paused', remoteJid);
          return;
        }

        // Kasus 2B: Pasien mengetik kata "RESCHEDULE" / "RESCHEDOLE" tanpa tanggal
        if (patientData) {
          await callSimgosApi("update_status", { 
            noRm: patientData.noRm, 
            type: "pasien", 
            status: "Reschedule Diajukan" 
          }).catch(() => {});
        }

        const replyAskDate = `Baik Bapak/Ibu *${namaPx}*, kami siap membantu proses penjadwalan ulang (*reschedule*) kontrol perawatan gigi Anda.\n\n` +
                             `Kira-kira Anda ingin mengajukan kontrol di hari apa atau tanggal berapa? (Contoh format: *2026-09-28* atau *25 September*).\n\n` +
                             `Silakan balas pesan ini dengan tanggal yang Anda inginkan agar langsung kami sesuaikan di sistem SIMGOS ya. 🙏`;

        await sock.sendMessage(remoteJid, { text: replyAskDate });
        await sock.sendPresenceUpdate('paused', remoteJid);
        return;
      }

      // --- JALUR 3: PERCAKAPAN NATURAL & KONSULTASI GIGI DENGAN GEMINI AI ---
      let userSession = conversationSessions.get(senderPhonePure);
      if (!userSession) {
        userSession = { history: [], lastSeen: Date.now() };
        conversationSessions.set(senderPhonePure, userSession);
      }
      userSession.lastSeen = Date.now();

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
        rawAiResponse = await askGeminiClinic(userSession.history, patientData);
      } catch (aiErr) {
        console.error("[Gemini AI Error]", aiErr.message);
        rawAiResponse = `Halo Bapak/Ibu ${patientData ? patientData.namaPasien : ""}, terima kasih telah menghubungi Poli Konservasi RSKD Gigi dan Mulut Prov. Sulsel. Pesan Anda telah kami terima, staf poli kami siap membantu informasi jadwal dan perawatan gigi Anda. Ada hal yang bisa kami bantu? 🙏`;
      } finally {
        clearInterval(typingTimer);
      }

      // Deteksi Tag Reschedule dari AI
      const rescheduleMatch = rawAiResponse.match(/\[ACTION:RESCHEDULE:(\d{4}-\d{2}-\d{2})\]/i);
      let finalClientReply = rawAiResponse.replace(/\[ACTION:RESCHEDULE:\d{4}-\d{2}-\d{2}\]/gi, '').trim();

      if (rescheduleMatch && patientData) {
        const newRescheduleDate = rescheduleMatch[1];
        try {
          await callSimgosApi("reschedule_patient", {
            noRm: patientData.noRm,
            newDate: newRescheduleDate
          });

          const notifRescheduleDokter = `🔄 *NOTIFIKASI RESCHEDULE PASIEN (SISTEM AI)*\n\n` +
                                        `Pasien kontrol berikut telah mengajukan jadwal ulang:\n` +
                                        `👤 *Nama:* ${patientData.namaPasien}\n` +
                                        `🔖 *No. RM:* ${patientData.noRm}\n` +
                                        `📅 *Jadwal Lama:* ${patientData.tglKontrol}\n` +
                                        `✨ *Jadwal Baru:* ${newRescheduleDate}\n` +
                                        `📱 *WhatsApp:* ${patientData.noHp}\n` +
                                        `💬 *Pesan Pasien:* "${text.trim()}"\n\n` +
                                        `_Status database telah direset ke Pending untuk kontrol tanggal baru._ 📊`;

          for (const docJid of DOKTER_JID_LIST) {
            await sock.sendMessage(docJid, { text: notifRescheduleDokter }).catch(() => {});
          }
        } catch (reschedErr) {
          console.error("[Auto-Reschedule Error]", reschedErr);
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
