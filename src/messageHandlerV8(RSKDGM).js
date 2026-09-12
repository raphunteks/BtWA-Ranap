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

// Kunci API Google AI Studio & Model Terkini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6KfVb-fIIdi_BsauXX69CEOoE037lYnsPJYvCy4Vhr6cw";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

// Kontak WhatsApp Dokter DPJP RSKDGM
const DOKTER_JID_LIST = [
  "6282291675363@s.whatsapp.net", // drg. Hj. Kurniawaty, Sp.KG
  "6285256739684@s.whatsapp.net"  // drg. M. Aksa Arsyad
];

// Manajemen Sesi Percakapan & Cache System Prompt
const conversationSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // Kadaluarsa sesi percakapan 30 menit
let cachedCustomPrompt = { prompt: '', timestamp: 0 };
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000; // Cache prompt 5 menit

const sessionPath = './session';
const settingsFile = `${sessionPath}/settings.json`; 

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

let botSettings = { 
  autoFollowupSimgos: true,
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

// =========================================================================
// CLIENT REST API SIMGOS RSKDGM (APPS SCRIPT)
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

// Mengambil Custom System Prompt dari Sheet CUSTOM_PROMPT
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
    console.warn("[Custom Prompt Warning] Gagal sinkronisasi prompt dari sheet, menggunakan fallback default.");
  }

  return `Kamu adalah Asisten Resepsionis Medis Resmi RSKD Gigi dan Mulut Provinsi Sulawesi Selatan (Poli Konservasi dan Endodonsi).
Dokter DPJP: drg. Hj. Kurniawaty, Sp.KG & drg. M. Aksa Arsyad.
Karakter: Sangat ramah, bersahabat, sopan, profesional layaknya manusia sungguhan.
PENTING: Jika pasien meminta reschedule tanggal kontrol dan menentukan tanggalnya, sisipkan tag [ACTION:RESCHEDULE:YYYY-MM-DD] di akhir pesanmu.`;
}

// =========================================================================
// REST API GOOGLE AI STUDIO ENGINE (GEMINI 3.5 FLASH)
// =========================================================================
async function askGeminiClinic(conversationHistory, patientContext = null) {
  const apiKey = GEMINI_API_KEY.trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let systemPromptText = await fetchActiveCustomPrompt();

  // Tambahkan konteks rekam medis pasien jika terdaftar di database
  if (patientContext) {
    systemPromptText += `\n\nKONTEKS PASIEN YANG SEDANG CHAT SAAT INI:
- Nama Pasien: ${patientContext.namaPasien}
- No. Rekam Medis: ${patientContext.noRm}
- Jadwal Kontrol Terdaftar: ${patientContext.tglKontrol}
- Dokter DPJP: drg. Hj. Kurniawaty, Sp.KG & drg. M. Aksa Arsyad
- Poli: Poli Konservasi dan Endodonsi
Gunakan informasi di atas jika relevan untuk menyapa atau mengonfirmasi jadwal mereka secara akrab.`;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey.startsWith('AQ')) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const requestBody = {
    contents: conversationHistory,
    systemInstruction: {
      parts: [{ text: systemPromptText }]
    },
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
      topP: 0.92
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google AI Studio Error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawReply) throw new Error('Respon teks Google AI Studio kosong');

  return rawReply;
}

// Logika Pengiriman Blast Kontrol Pasien H-2 & Rekapitulasi ke Dokter
async function executeFollowupBlast(sock, replyTargetJid = null, tglParam = "auto") {
  const resultLog = {
    totalTarget: 0,
    pasienTerkirim: 0,
    pasienGagal: 0,
    laporanDokterTerkirim: 0,
    laporanDokterGagal: 0,
    targetDate: ""
  };

  const followupData = await callSimgosApi("get_followup", { tgl: tglParam });
  if (!followupData || followupData.status !== "success" || !Array.isArray(followupData.data)) {
    throw new Error(followupData?.message || "Data kontrol tidak tersedia.");
  }

  const listPasien = followupData.data;
  resultLog.totalTarget = listPasien.length;
  resultLog.targetDate = followupData.target_control_date || tglParam;

  if (listPasien.length === 0) return resultLog;

  // 1. Kirim pesan WA ke masing-masing pasien
  for (const px of listPasien) {
    const targetJid = sanitizeNumber(px.noHp);
    try {
      await sock.sendMessage(targetJid, { text: px.pesan_wa_pasien });
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

      rekapDokter += `\n_Pesan otomatis telah terkirim ke kontak WhatsApp pasien di atas._ 🙏`;

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
    // Blast Otomatis Setiap Pukul 08:30 WITA
    setInterval(async () => {
      if (!currentSock) return;

      const d = new Date();
      const jam = d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Makassar' });
      const menit = d.getMinutes();
      const tanggalHariIniWita = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(d);

      if (
        botSettings.autoFollowupSimgos &&
        jam === '08' &&
        menit === 30 &&
        botSettings.lastAutoFollowupDate !== tanggalHariIniWita
      ) {
        try {
          console.log(`[Auto SIMGOS] Menjalankan follow-up kontrol H-2 (${tanggalHariIniWita})...`);
          const blastRes = await executeFollowupBlast(currentSock, ownerNumber, "auto");
          botSettings.lastAutoFollowupDate = tanggalHariIniWita;
          saveSettings();

          if (blastRes.totalTarget > 0) {
            await currentSock.sendMessage(ownerNumber, {
              text: `🤖 *AUTO FOLLOW-UP SIMGOS SELESAI (H-2)*\n\n` +
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

      // 1. FILTER MUTLAK: TOLAK PESAN GRUP (@g.us) DAN BROADCAST
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
      // 2. JIKA DIAWALI PREFIX (!): JALANKAN COMMAND KHUSUS ADMIN
      // =====================================================================
      if (text.startsWith('!')) {
        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch (command) {
          case 'menu':
          case 'help':
            const menuText = `*🤖 BOT KONTROL RSKDGM & ASISTEN AI (GEMINI 3.5) 🤖*\n\n` +
                             `*🦷 SIMGOS FOLLOW-UP KONTROL:*\n` +
                             `* !followup* [tgl/auto] - Cek pasien jadwal kontrol H-2\n` +
                             `* !gassfollowup* [tgl/auto] - Kirim WA ke Pasien & Laporan ke 2 Dokter\n` +
                             `* !caripasien* <No.RM/Nama> - Cari data pasien di Spreadsheet\n` +
                             `* !reschedule* <No.RM> <YYYY-MM-DD> - Ubah tanggal kontrol manual\n` +
                             `* !statskontrol* - Cek ringkasan statistik kontrol\n` +
                             `* !settingssimgos* - Cek konfigurasi H-2 & nomor dokter\n` +
                             `* !templatesimgos* - Cek template format pesan WhatsApp\n` +
                             `* !autofollowup on/off* - Pengaturan blast otomatis jam 08:30 WITA\n\n` +

                             `*🧠 GOOGLE AI STUDIO (CUSTOM PROMPT):*\n` +
                             `* !getprompt* - Cek System Instruction AI aktif dari Sheet\n` +
                             `* !clearpromptcache* - Refresh cache prompt terbaru dari Sheet\n\n` +

                             `*⚙️ UTILITAS:* \n` +
                             `* !ping* - Cek kecepatan respon bot\n` +
                             `* !runtime* - Cek status server & waktu aktif bot\n` +
                             `* !sticker* / *!s* - Konversi gambar ke stiker\n\n` +
                             `_💬 Percakapan biasa tanpa tanda (!) akan otomatis dijawab ramah & cerdas layaknya manusia oleh AI Gemini 3.5 Flash._`;
            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
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

              textHasil += `👉 _Ketik *!gassfollowup* untuk mengirim WhatsApp ke seluruh pasien di atas sekaligus laporan ke kedua dokter DPJP._`;
              await sock.sendMessage(remoteJid, { text: textHasil }, { quoted: msg });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Gagal mengambil data:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'gassfollowup':
          case 'kirimfollowup':
            await sock.sendMessage(remoteJid, { text: "🚀 _Memulai pengiriman pesan WhatsApp ke Pasien & Dokter DPJP... Mohon tunggu._" }, { quoted: msg });
            try {
              const tglParam = args[0] || "auto";
              const blastResult = await executeFollowupBlast(sock, remoteJid, tglParam);

              if (blastResult.totalTarget === 0) {
                await sock.sendMessage(remoteJid, { text: `ℹ️ Tidak ada antrean pasien Pending untuk tanggal ${blastResult.targetDate}.` }, { quoted: msg });
                break;
              }

              const rekapAkhir = `✅ *EKSEKUSI FOLLOW-UP SELESAI!*\n\n` +
                                 `📅 *Tgl Kontrol:* ${blastResult.targetDate}\n` +
                                 `👥 *Total Target Pasien:* ${blastResult.totalTarget}\n` +
                                 `📲 *Pasien Berhasil Dikirimi:* ${blastResult.pasienTerkirim}\n` +
                                 `⚠️ *Pasien Gagal:* ${blastResult.pasienGagal}\n` +
                                 `👨‍⚕️ *Laporan DPJP Terkirim:* ${blastResult.laporanDokterTerkirim} Dokter\n\n` +
                                 `_Seluruh status di Google Spreadsheet berhasil diperbarui ke Terkirim._ 📊`;
              await sock.sendMessage(remoteJid, { text: rekapAkhir }, { quoted: msg });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Terjadi Kesalahan saat eksekusi:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'caripasien':
            if (args.length === 0) {
              await sock.sendMessage(remoteJid, { text: "⚠️ Masukkan kata kunci pencarian!\nContoh: *!caripasien 00.06.32.89* atau *!caripasien Ildhayani*" }, { quoted: msg });
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
                        `Status pasien otomatis di-reset ke *Pending* agar siap difollow-up kembali saat mendekati jadwal baru.` 
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
                                 `✅ Terkirim: ${s.wa_pasien_terkirim}\n\n` +
                                 `*Status Konfirmasi Dokter:*\n` +
                                 `⏳ Pending: ${s.notif_dokter_pending}\n` +
                                 `✅ Terkirim: ${s.notif_dokter_terkirim}\n\n` +
                                 `🏥 *Faskes:* ${statsRes.config.instansi}\n` +
                                 `🦷 *Klinik:* ${statsRes.config.poli}`;
                await sock.sendMessage(remoteJid, { text: repStats }, { quoted: msg });
              } else throw new Error(statsRes.message);
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ *Gagal mengambil statistik:* ${e.message}` }, { quoted: msg });
            }
            return;

          case 'settingssimgos':
            try {
              const cfg = await callSimgosApi("get_settings");
              if (cfg.status === "success") {
                const c = cfg.config;
                let txtCfg = `⚙️ *KONFIGURASI SISTEM SIMGOS KONTROL*\n\n` +
                             `⏰ Jarak Follow-Up: *H-${c.hDays}* Hari Sebelum Kontrol\n` +
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
              const tplRes = await callSimgosApi("get_templates");
              if (tplRes.status === "success") {
                let tplTxt = `📝 *TEMPLATE PESAN WHATSAPP TERSIMPAN:*\n\n`;
                for (const [kode, isi] of Object.entries(tplRes.templates)) {
                  tplTxt += `🔖 *Kode:* \`${kode}\`\n${isi}\n\n-------------------------\n\n`;
                }
                await sock.sendMessage(remoteJid, { text: tplTxt }, { quoted: msg });
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
                text: `⚙️ Fitur *Auto Follow-up Kontrol (08:30 WITA)* disetel ke: *${args[0].toUpperCase()}*` 
              }, { quoted: msg });
            } else {
              await sock.sendMessage(remoteJid, { 
                text: `Status Auto Follow-up: *${botSettings.autoFollowupSimgos ? 'AKTIF' : 'NONAKTIF'}*\nGunakan: *!autofollowup on* atau *!autofollowup off*` 
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
      // 3. CHAT NATURAL HUMANOID (GEMINI 3.5 FLASH + RESCHEDULE DETECTOR)
      // =====================================================================
      await sock.sendPresenceUpdate('composing', remoteJid);

      // A. Cek apakah pengirim adalah pasien yang terdaftar di database Spreadsheet
      let patientData = null;
      try {
        const searchPx = await callSimgosApi("search_patient", { query: senderPhonePure });
        if (searchPx.status === "success" && searchPx.data && searchPx.data.length > 0) {
          patientData = searchPx.data[0];
        }
      } catch (errSearch) {
        console.warn("[Search Patient Warning]", errSearch.message);
      }

      // B. Setup Sesi Percakapan Multi-Turn
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

      // Batasi 8 riwayat percakapan terakhir agar fokus dan hemat token
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
        console.error("[Gemini AI Error]", aiErr);
        rawAiResponse = "Halo Bapak/Ibu, terima kasih telah menghubungi RSKD Gigi dan Mulut Prov. Sulsel. Pesan Anda telah kami terima, tim staf poli gigi kami akan segera membalas pesan ini ya. 🙏";
      } finally {
        clearInterval(typingTimer);
      }

      // C. Deteksi Otomatis Tag [ACTION:RESCHEDULE:YYYY-MM-DD] dari AI
      const rescheduleMatch = rawAiResponse.match(/\[ACTION:RESCHEDULE:(\d{4}-\d{2}-\d{2})\]/i);
      let finalClientReply = rawAiResponse.replace(/\[ACTION:RESCHEDULE:\d{4}-\d{2}-\d{2}\]/gi, '').trim();

      if (rescheduleMatch && patientData) {
        const newRescheduleDate = rescheduleMatch[1];
        console.log(`[Auto-Reschedule Detected] Pasien ${patientData.namaPasien} (RM: ${patientData.noRm}) -> Tanggal Baru: ${newRescheduleDate}`);

        try {
          // Eksekusi update jadwal langsung ke Google Spreadsheet
          await callSimgosApi("reschedule_patient", {
            noRm: patientData.noRm,
            newDate: newRescheduleDate
          });

          // Kirimkan notifikasi konfirmasi ke kedua dokter DPJP
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

      // D. Simpan jawaban model ke riwayat sesi dan kirim pesan
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
