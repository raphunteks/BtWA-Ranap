import fs from 'fs';
import process from 'process';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// Handler perintah eksternal pendukung
import handleStickerCommand from './commands/sticker.js';

// =========================================================================
// KONFIGURASI SISTEM & DATABASE SIMGOS RSKDGM
// =========================================================================
const ownerNumber = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

// URL REST API Google Apps Script (GAS) SIMGOS RSKDGM
const GAS_URL_SIMGOS = process.env.GAS_URL_SIMGOS || "https://script.google.com/macros/s/AKfycbzCOj9YFKEqXRfMEKBugnEhqzuC7MoJfIyc5PihST3bxmJaseaKKX9YifotK2qpT38/exec";

// Kunci API Google AI Studio & Default Model
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6Kv0O5noBbl4INzrZXC_zngVYJY04j38XLHpRmn371VzA";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Kontak WhatsApp Dokter DPJP RSKDGM
const DOKTER_JID_LIST = [
  "6282291675363@s.whatsapp.net", // drg. Hj. Kurniawaty, Sp.KG
  "6285256739684@s.whatsapp.net"  // drg. M. Aksa Arsyad
];

const botStartTime = new Date(); 

const sessionPath = './session';
const settingsFile = `${sessionPath}/settings.json`; 

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

let botSettings = { 
  autoFollowupSimgos: true,
  lastAutoFollowupDate: "",
  aiSystemPrompt: "Kamu adalah asisten AI medis pintar untuk RSKD Gigi dan Mulut Provinsi Sulawesi Selatan. Berikan jawaban yang ramah, profesional, ringkas, dan berbasis medis kedokteran gigi yang tepat."
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

// Normalisasi nomor telepon ke format JID WhatsApp
function formatToJid(phone) {
  if (!phone) return null;
  let clean = String(phone).replace(/\D/g, "");
  if (clean.startsWith("08")) clean = "628" + clean.slice(2);
  else if (clean.startsWith("8")) clean = "62" + clean;
  if (clean.length < 10) return null;
  return `${clean}@s.whatsapp.net`;
}

// =========================================================================
// ENGINE REST API GOOGLE AI STUDIO (GEMINI DIRECT FETCH)
// =========================================================================
async function callGeminiAIStudio(promptText, mediaBuffer = null, mimeType = null, customInstruction = "") {
  try {
    const trimmedKey = GEMINI_API_KEY.trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${trimmedKey}`;

    const parts = [];

    // Jika ada lampiran media gambar / audio
    if (mediaBuffer && mimeType) {
      parts.push({
        inlineData: {
          mimeType: mimeType,
          data: mediaBuffer.toString("base64")
        }
      });
    }

    if (promptText) {
      parts.push({ text: promptText });
    }

    const payload = {
      contents: [
        {
          role: "user",
          parts: parts
        }
      ],
      systemInstruction: {
        parts: [
          { text: customInstruction || botSettings.aiSystemPrompt }
        ]
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1000
      }
    };

    const headers = { 'Content-Type': 'application/json' };
    if (trimmedKey.startsWith('AQ')) {
      headers['Authorization'] = `Bearer ${trimmedKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(`[Google AI Studio] ${data.error.message || JSON.stringify(data.error)}`);
    }

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!replyText) {
      throw new Error("Respons teks kosong dari Google AI Studio.");
    }

    return replyText.trim();
  } catch (error) {
    console.error("[AI Studio Error]", error);
    throw new Error(`Gagal memproses AI Studio: ${error.message}`);
  }
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

  if (listPasien.length === 0) {
    return resultLog;
  }

  // 1. Pengiriman pesan WhatsApp personal ke masing-masing pasien
  for (const px of listPasien) {
    const targetJid = formatToJid(px.noHp);
    if (!targetJid) {
      console.warn(`[Skip] Nomor WA tidak valid untuk: ${px.namaPasien}`);
      resultLog.pasienGagal++;
      continue;
    }

    try {
      await sock.sendMessage(targetJid, { text: px.pesan_wa_pasien });
      resultLog.pasienTerkirim++;
      
      // Update status WA pasien ke "Terkirim" di Spreadsheet
      await callSimgosApi("update_status", { 
        row: px.rowNumber, 
        type: "pasien", 
        status: "Terkirim" 
      });

      // Jeda 2 detik antar nomor untuk keamanan dari filter anti-spam
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[Gagal Kirim Pasien] ${px.namaPasien}:`, e);
      resultLog.pasienGagal++;
    }
  }

  // 2. Pengiriman rekapitulasi laporan ke kedua dokter DPJP
  const targetDoctors = followupData.doctors && followupData.doctors.length > 0
    ? followupData.doctors.map(d => formatToJid(d.wa)).filter(Boolean)
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

  // Update status notifikasi dokter pada sheet
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
// MAIN MESSAGE HANDLER
// =========================================================================
export default function setupMessageHandler(sock) {
  currentSock = sock; 

  if (!isIntervalStarted) {
    // DAILY AUTO FOLLOW-UP SIMGOS (Setiap Hari Pukul 08:30 WITA)
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
          console.log(`[Auto SIMGOS] Menjalankan follow-up kontrol otomatis H-2 untuk tanggal ${tanggalHariIniWita}...`);
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

      const text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   msg.message.imageMessage?.caption || 
                   msg.message.videoMessage?.caption || '';
      const sender = msg.key.remoteJid;
      const pushName = msg.pushName || "Pengguna";

      // =====================================================================
      // PENANGANAN RESPON BALASAN DARI PASIEN (HADIR / RESCHEDULE)
      // =====================================================================
      const cleanUpper = text.trim().toUpperCase();
      if (!text.startsWith('!') && (cleanUpper.includes("HADIR") || cleanUpper.includes("RESCHEDULE") || cleanUpper.includes("KONTROL"))) {
        try {
          const senderPhone = sender.replace(/\D/g, "");
          const searchRes = await callSimgosApi("search_patient", { query: senderPhone });
          
          if (searchRes.status === "success" && searchRes.data && searchRes.data.length > 0) {
            const pxData = searchRes.data[0];
            const notifKeDokter = `📩 *RESPON BALASAN PASIEN KONTROL*\n\n` +
                                  `👤 *Pasien:* ${pxData.namaPasien}\n` +
                                  `🔖 *No. RM:* ${pxData.noRm}\n` +
                                  `📅 *Tgl Kontrol:* ${pxData.tglKontrol}\n` +
                                  `💬 *Isi Pesan:* "${text.trim()}"\n` +
                                  `📱 *Kontak:* ${pxData.noHp}\n\n` +
                                  `_Telah diteruskan ke dokter DPJP._`;

            for (const docJid of DOKTER_JID_LIST) {
              await sock.sendMessage(docJid, { text: notifKeDokter });
            }

            if (cleanUpper.includes("HADIR")) {
              await sock.sendMessage(sender, { 
                text: `Terima kasih atas konfirmasinya, Bapak/Ibu *${pxData.namaPasien}*. Kehadiran Anda telah kami catat untuk jadwal kontrol tanggal *${pxData.tglKontrol}*. Sampai jumpa di RSKD Gigi dan Mulut Sulsel. 🙏` 
              }, { quoted: msg });
            } else if (cleanUpper.includes("RESCHEDULE")) {
              await sock.sendMessage(sender, { 
                text: `Baik Bapak/Ibu *${pxData.namaPasien}*, permohonan penjadwalan ulang telah diteruskan ke dokter DPJP. Silakan balas dengan menyertakan *tanggal pengganti* yang Anda inginkan. Terima kasih. 🙏` 
              }, { quoted: msg });
            }
            return;
          }
        } catch (e) {
          console.error("[Auto-Reply Pasien Error]", e);
        }
      }

      // =====================================================================
      // PENANGANAN COMMAND BOT (!)
      // =====================================================================
      const prefix = '!'; 
      if (!text.startsWith(prefix)) return;

      const args = text.slice(prefix.length).trim().split(/ +/);
      const command = args.shift().toLowerCase();

      console.log(`[COMMAND] ${command} dari ${sender} (${pushName})`);

      switch (command) {
        // -------------------------------------------------------------------
        // MENU BANTUAN
        // -------------------------------------------------------------------
        case 'menu':
        case 'help':
          const menuText = `*🤖 BOT KONTROL RSKDGM & ASISTEN AI 🤖*\n\n` +
                           `*🦷 SIMGOS FOLLOW-UP KONTROL:*\n` +
                           `* !followup* [tgl/auto] - Cek pasien jadwal kontrol H-2\n` +
                           `* !gassfollowup* [tgl/auto] - Kirim WA ke Pasien & Laporan ke 2 Dokter\n` +
                           `* !caripasien* <No.RM/Nama> - Cari data pasien di Spreadsheet\n` +
                           `* !reschedule* <No.RM> <YYYY-MM-DD> - Ubah tanggal kontrol\n` +
                           `* !statskontrol* - Cek ringkasan statistik kontrol\n` +
                           `* !settingssimgos* - Cek konfigurasi H-2 & kontak dokter\n` +
                           `* !templatesimgos* - Cek template format pesan WhatsApp\n` +
                           `* !autofollowup on/off* - Pengaturan blast otomatis jam 08:30 WITA\n\n` +

                           `*🧠 GOOGLE AI STUDIO (REST API):*\n` +
                           `* !ai* <pertanyaan> - Chat dengan Gemini via AI Studio\n` +
                           `* !setprompt* <instruksi> - Set custom system instruction AI\n` +
                           `* !getprompt* - Cek system prompt AI saat ini\n\n` +

                           `*⚙️ UTILITAS:* \n` +
                           `* !ping* - Cek kecepatan respon bot\n` +
                           `* !runtime* - Cek status server & waktu aktif bot\n` +
                           `* !sticker* / *!s* - Konversi gambar ke stiker\n`;
          await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
          break;

        // -------------------------------------------------------------------
        // SIMGOS KONTROL & REST API GAS COMMANDS
        // -------------------------------------------------------------------
        case 'followup':
        case 'cekfollowup':
          await sock.sendMessage(sender, { text: "⏳ _Mengambil data pasien kontrol siap follow-up dari Google Spreadsheet..._" }, { quoted: msg });
          try {
            const tglArg = args[0] || "auto";
            const resFollowup = await callSimgosApi("get_followup", { tgl: tglArg });

            if (resFollowup.status !== "success" || !resFollowup.data || resFollowup.data.length === 0) {
              await sock.sendMessage(sender, { 
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
            await sock.sendMessage(sender, { text: textHasil }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(sender, { text: `❌ *Gagal mengambil data:* ${e.message}` }, { quoted: msg });
          }
          break;

        case 'gassfollowup':
        case 'kirimfollowup':
          await sock.sendMessage(sender, { text: "🚀 _Memulai pengiriman pesan WhatsApp ke Pasien & Dokter DPJP... Mohon tunggu._" }, { quoted: msg });
          try {
            const tglParam = args[0] || "auto";
            const blastResult = await executeFollowupBlast(sock, sender, tglParam);

            if (blastResult.totalTarget === 0) {
              await sock.sendMessage(sender, { text: `ℹ️ Tidak ada antrean pasien Pending untuk tanggal ${blastResult.targetDate}.` }, { quoted: msg });
              break;
            }

            const rekapAkhir = `✅ *EKSEKUSI FOLLOW-UP SELESAI!*\n\n` +
                               `📅 *Tgl Kontrol:* ${blastResult.targetDate}\n` +
                               `👥 *Total Target Pasien:* ${blastResult.totalTarget}\n` +
                               `📲 *Pasien Berhasil Dikirimi:* ${blastResult.pasienTerkirim}\n` +
                               `⚠️ *Pasien Gagal:* ${blastResult.pasienGagal}\n` +
                               `👨‍⚕️ *Laporan DPJP Terkirim:* ${blastResult.laporanDokterTerkirim} Dokter\n\n` +
                               `_Seluruh status di Google Spreadsheet berhasil diperbarui ke Terkirim._ 📊`;
            await sock.sendMessage(sender, { text: rekapAkhir }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(sender, { text: `❌ *Terjadi Kesalahan saat eksekusi:* ${e.message}` }, { quoted: msg });
          }
          break;

        case 'caripasien':
          if (args.length === 0) {
            await sock.sendMessage(sender, { text: "⚠️ Masukkan kata kunci pencarian!\nContoh: *!caripasien 00.06.32.89* atau *!caripasien Ildhayani*" }, { quoted: msg });
            break;
          }
          const queryCari = args.join(" ");
          await sock.sendMessage(sender, { text: `🔍 _Mencari data pasien "${queryCari}"..._` }, { quoted: msg });
          try {
            const hasilCari = await callSimgosApi("search_patient", { query: queryCari });
            if (hasilCari.status !== "success" || !hasilCari.data || hasilCari.data.length === 0) {
              await sock.sendMessage(sender, { text: `❌ Data pasien dengan kata kunci *"${queryCari}"* tidak ditemukan.` }, { quoted: msg });
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

            await sock.sendMessage(sender, { text: txtMatch }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(sender, { text: `❌ *Gagal mencari pasien:* ${e.message}` }, { quoted: msg });
          }
          break;

        case 'reschedule':
          if (args.length < 2) {
            await sock.sendMessage(sender, { 
              text: "⚠️ Format salah!\nGunakan: *!reschedule <No.RM> <YYYY-MM-DD>*\nContoh: *!reschedule 00.06.32.89 2026-10-15*" 
            }, { quoted: msg });
            break;
          }
          const rmResched = args[0];
          const dateResched = args[1];

          await sock.sendMessage(sender, { text: `⏳ _Memproses penjadwalan ulang No. RM ${rmResched} ke tanggal ${dateResched}..._` }, { quoted: msg });
          try {
            const reschedApi = await callSimgosApi("reschedule_patient", { noRm: rmResched, newDate: dateResched });
            if (reschedApi.status === "success") {
              await sock.sendMessage(sender, { 
                text: `✅ *Reschedule Berhasil!*\n\n` +
                      `🔖 No. RM: *${rmResched}*\n` +
                      `📅 Jadwal Kontrol Baru: *${dateResched}*\n` +
                      `Status pasien otomatis direset ke *Pending* agar siap difollow-up kembali pada jadwal baru.` 
              }, { quoted: msg });
            } else {
              throw new Error(reschedApi.message);
            }
          } catch (e) {
            await sock.sendMessage(sender, { text: `❌ *Gagal Reschedule:* ${e.message}` }, { quoted: msg });
          }
          break;

        case 'statskontrol':
        case 'statssimgos':
          await sock.sendMessage(sender, { text: "⏳ _Menghitung statistik follow-up klinik..._" }, { quoted: msg });
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
              await sock.sendMessage(sender, { text: repStats }, { quoted: msg });
            } else throw new Error(statsRes.message);
          } catch (e) {
            await sock.sendMessage(sender, { text: `❌ *Gagal mengambil statistik:* ${e.message}` }, { quoted: msg });
          }
          break;

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
              await sock.sendMessage(sender, { text: txtCfg }, { quoted: msg });
            }
          } catch (e) {
            await sock.sendMessage(sender, { text: `❌ *Error:* ${e.message}` }, { quoted: msg });
          }
          break;

        case 'templatesimgos':
          try {
            const tplRes = await callSimgosApi("get_templates");
            if (tplRes.status === "success") {
              let tplTxt = `📝 *TEMPLATE PESAN WHATSAPP TERSIMPAN:*\n\n`;
              for (const [kode, isi] of Object.entries(tplRes.templates)) {
                tplTxt += `🔖 *Kode:* \`${kode}\`\n${isi}\n\n-------------------------\n\n`;
              }
              await sock.sendMessage(sender, { text: tplTxt }, { quoted: msg });
            }
          } catch (e) {
            await sock.sendMessage(sender, { text: `❌ *Error:* ${e.message}` }, { quoted: msg });
          }
          break;

        case 'autofollowup':
          if (args[0] === 'on' || args[0] === 'off') {
            botSettings.autoFollowupSimgos = args[0] === 'on';
            saveSettings();
            await sock.sendMessage(sender, { 
              text: `⚙️ Fitur *Auto Follow-up Kontrol (08:30 WITA)* disetel ke: *${args[0].toUpperCase()}*` 
            }, { quoted: msg });
          } else {
            await sock.sendMessage(sender, { 
              text: `Status Auto Follow-up: *${botSettings.autoFollowupSimgos ? 'AKTIF' : 'NONAKTIF'}*\nGunakan: *!autofollowup on* atau *!autofollowup off*` 
            }, { quoted: msg });
          }
          break;

        // -------------------------------------------------------------------
        // GOOGLE AI STUDIO (GEMINI REST API)
        // -------------------------------------------------------------------
        case 'ai':
          try {
            const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isImage = msg.message.imageMessage || quotedMsg?.imageMessage;
            const promptText = args.join(" ");

            if (!promptText && !isImage) {
              await sock.sendMessage(sender, { text: "⚠️ Masukkan pertanyaan atau kirim gambar dengan caption *!ai <pertanyaan>*" }, { quoted: msg });
              break;
            }

            await sock.sendMessage(sender, { text: "🧠 _AI Studio sedang memproses respon..._" }, { quoted: msg });

            let mediaBuffer = null;
            let mimeType = null;

            if (isImage) {
              const targetMsg = msg.message.imageMessage ? msg : msg.message.extendedTextMessage.contextInfo.quotedMessage;
              mediaBuffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
              mimeType = "image/jpeg";
            }

            const aiReply = await callGeminiAIStudio(promptText, mediaBuffer, mimeType);
            await sock.sendMessage(sender, { text: aiReply }, { quoted: msg });
          } catch (aiErr) {
            await sock.sendMessage(sender, { text: `❌ *Error AI Studio:* ${aiErr.message}` }, { quoted: msg });
          }
          break;

        case 'setprompt':
          if (args.length === 0) {
            await sock.sendMessage(sender, { text: "⚠️ Masukkan instruksi sistem baru!\nContoh: *!setprompt Kamu adalah asisten dokter gigi spesialis konservasi yang ramah.*" }, { quoted: msg });
            break;
          }
          botSettings.aiSystemPrompt = args.join(" ");
          saveSettings();
          await sock.sendMessage(sender, { text: `✅ *System Instruction AI Studio Berhasil Diperbarui:*\n\n"${botSettings.aiSystemPrompt}"` }, { quoted: msg });
          break;

        case 'getprompt':
          await sock.sendMessage(sender, { text: `📋 *System Instruction AI Studio Saat Ini:*\n\n"${botSettings.aiSystemPrompt}"\n\nModel: *${GEMINI_MODEL}*` }, { quoted: msg });
          break;

        // -------------------------------------------------------------------
        // UTILITAS UMUM
        // -------------------------------------------------------------------
        case 'ping':
          const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
          await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${pingProcess} ms` }, { quoted: msg }); 
          break;

        case 'runtime':
          const uptime = process.uptime();
          await sock.sendMessage(sender, { 
            text: `⏳ *Bot Uptime:* ${getRelativeTime(uptime)}\n🖥️ *OS Memory:* ${Math.round(os.freemem()/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB\n⚡ Server Time: ${formatWITA(new Date())}` 
          }, { quoted: msg });
          break;

        case 'sticker': 
        case 's': 
          if (typeof handleStickerCommand === 'function') {
            await handleStickerCommand(sock, msg); 
          }
          break;
      }
    } catch (error) { 
      console.error('Error proses pesan:', error); 
    }
  });
}
