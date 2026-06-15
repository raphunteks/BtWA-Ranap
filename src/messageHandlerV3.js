import fs from 'fs';
import process from 'process';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Jika Anda menggunakan command handler terpisah
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ==========================================
// KONFIGURASI GLOBAL & API
// ==========================================
const ownerNumber = "6285256739684@s.whatsapp.net";

// URL RSUD / KLINIK
const GAS_URL_RSUD = "https://script.google.com/macros/s/AKfycbzhDou1e-e4QXDILWfM_mkyagViYOvcpLLv7xL-kJ6cVhpR_R5_bVICdnUYxp0AA90/exec";

// URL MONEY TRACKER & GEMINI AI
const MONEY_GAS_URL = "https://script.google.com/macros/s/AKfycbw38Tsw-C6-SMTWjyh-y2b2rzT7_rHH6K4JHHpy7vikCHWdyj20lxAdu-9cS4hPNIEJ/exec";
const genAI = new GoogleGenerativeAI("AQ.Ab8RN6Kv0O5noBbl4INzrZXC_zngVYJY04j38XLHpRmn371VzA");

const botStartTime = new Date(); 

const sessionPath = './session';
const schedulesFile = `${sessionPath}/schedules.json`; 
const settingsFile = `${sessionPath}/settings.json`; 

if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

let botSchedules = [];
let botSettings = { autoRanap: [], autoRajal: [] };

if (fs.existsSync(schedulesFile)) {
    try { botSchedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8')); } catch (e) { }
}
if (fs.existsSync(settingsFile)) {
    try { botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) }; } catch (e) { }
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
// FUNGSI HELPER: MONEY TRACKER & AI
// ==========================================
async function sendToFinanceGAS(action, payload) {
    try {
        const response = await fetch(MONEY_GAS_URL, {
            method: 'POST',
            body: JSON.stringify({ action, ...payload }),
            headers: { 'Content-Type': 'application/json' }
        });
        return await response.json();
    } catch (error) {
        console.error("[Finance GAS Error]", error);
        throw new Error("Gagal terhubung ke Database Keuangan.");
    }
}

async function aiCategorizeFinance(text = "", mediaBuffer = null, mimeType = null) {
    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash", 
            generationConfig: { responseMimeType: "application/json" } 
        });
        
        const prompt = `Kamu adalah asisten keuangan AI cerdas. Analisis input (bisa berupa teks keluhan/catatan, foto struk, atau transkrip Voice Note) dan ekstrak datanya ke dalam format JSON yang ketat.
        
        WAJIB gunakan format struktur JSON ini (hanya JSON, tanpa markdown): 
        {
          "nominal": <angka_tanpa_titik_atau_koma>, 
          "kategori": "<Pilih SATU: F&B, Transport, Belanja, Tagihan, Langganan, Gaji, Bisnis, Kesehatan, Sedekah, Lainnya>", 
          "tipe": "<Pilih SATU: pengeluaran atau pemasukan>", 
          "keterangan": "<deskripsi_singkat_barang_atau_jasa>"
        }`;

        let parts = [{ text: prompt }];
        if (text) parts.push({ text: `Input Konteks: "${text}"` });
        
        if (mediaBuffer && mimeType) {
            parts.push({
                inlineData: {
                    data: mediaBuffer.toString("base64"),
                    mimeType: mimeType
                }
            });
        }

        const result = await model.generateContent(parts);
        return JSON.parse(result.response.text());
    } catch (error) {
        console.error("[AI Error]", error);
        throw new Error("AI gagal memproses input. Pastikan struk atau suara cukup jelas.");
    }
}

// ==========================================
// FUNGSI PINTAR: FETCH WITH FALLBACK (RSUD)
// ==========================================
async function fetchWithFallback(endpointName, queryParams = "") {
    try {
        const vercelUrl = `https://ishiprsud.vercel.app/api/${endpointName}${queryParams ? '?' + queryParams : ''}`;
        const res = await fetch(vercelUrl);
        const data = await res.json();
        
        if (data.status && data.data && data.data.length > 0) return data;
        throw new Error("Vercel Kosong/Down");
    } catch (e) {
        try {
            const gasUrl = `${GAS_URL_RSUD}?type=${endpointName}`;
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
        } catch (err) {}
        return { status: false, data: [] };
    }
}

// ==========================================
// SMART CHRONOLOGICAL SORTING & DIFF ALGORITHM (RSUD)
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

function formatKlinikList(namaKlinik, iconKlinik, currentList, removedList) {
    let resultTxt = `${iconKlinik} *Klinik ${namaKlinik}*:\n`;
    let countBaru = 0; let countSelesai = 0;
    let listSelesai = []; let listBaru = [];

    if (removedList && removedList.length > 0) {
        removedList.forEach(p => { listSelesai.push(`${p.nama_pasien} *(SELESAI)*`); countSelesai++; });
    }

    currentList.forEach(p => {
        const st = (p.status || "").toUpperCase();
        if (st.includes("BATAL")) { listSelesai.push(`${p.nama_pasien} *(BATAL)*`); countSelesai++; } 
        else if (st.includes("ASUHAN KEPERAWATAN")) { listBaru.push(`${p.nama_pasien} *(BARU)*`); countBaru++; } 
        else if (st.includes("PULANG") || st.includes("SELESAI") || st.includes("DIPULANGKAN") || st.includes("SATUSEHAT")) {
            listSelesai.push(`${p.nama_pasien} *(SELESAI)*`); countSelesai++;
        } else { listBaru.push(`${p.nama_pasien} *(BARU)*`); countBaru++; }
    });

    let combinedList = [...listSelesai, ...listBaru];
    if (combinedList.length === 0) resultTxt += `_(Tidak ada pasien)_\n\n`;
    else { combinedList.forEach((item, index) => { resultTxt += `${index + 1}. ${item}\n`; }); resultTxt += `\n`; }

    return { txt: resultTxt, baru: countBaru, selesai: countSelesai };
}

// ... (Fungsi forceSendRanapPrimer, forceSendRajalPrimer, checkApiUpdates tetap sama seperti sebelumnya) ...
async function checkApiUpdates(sock) {
    // ... Logika auto polling RSUD Anda tidak berubah ...
}

// ==========================================
// EXPORT HANDLER UTAMA
// ==========================================
let isIntervalStarted = false;
let currentSock = null;

export default function setupMessageHandler(sock) {
    currentSock = sock; 

    if (!isIntervalStarted) {
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
            
            // --- WEEKLY MONEY SIGNAL (Setiap Minggu 19:00 WITA) ---
            const d = new Date();
            const hari = d.toLocaleString('en-US', { weekday: 'long', timeZone: 'Asia/Makassar' });
            const jam = d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Makassar' });
            if (hari === 'Sunday' && jam === '19' && d.getMinutes() === 0 && d.getSeconds() === 0) {
                try {
                    const gasRes = await sendToFinanceGAS('get_baseline', {});
                    if (gasRes.status === 'success') {
                        const income = gasRes.data.income || 0;
                        const expense = gasRes.data.expense || 0;
                        let msg = `🔔 *WEEKLY MONEY SIGNAL*\nLaporan Keuangan Otomatis\n\n` +
                                  `Pemasukan: Rp ${income.toLocaleString('id-ID')}\nPengeluaran: Rp ${expense.toLocaleString('id-ID')}\n` +
                                  `Saldo: Rp ${(income - expense).toLocaleString('id-ID')}\n\n_Semangat mengatur finansial minggu depan!_`;
                        await currentSock.sendMessage(ownerNumber, { text: msg });
                    }
                } catch(e) {}
            }
        }, 30000); 

        // setInterval(() => { if (currentSock) checkApiUpdates(currentSock); }, 60000); // RSUD Polling
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
                // ... (Logika RSUD Cek Rajal Anda tidak berubah) ...
                return; 
            }

            switch (command) {
                case 'menu':
                case 'help':
                    const menuText = `*🤖 BOT MENU 🤖*\n\n` +
                                     `*🏥 RSUD KLINIK:*\n` +
                                     `* !jadwalranap* - Cek pasien Rawat Inap\n` +
                                     `* !cekrajal...* - (Cek command rajal)\n\n` +
                                     
                                     `*💸 MONEY TRACKER (AI POWERED):*\n` +
                                     `* !catat [teks/struk/vn]* - AI Catat Keuangan\n` +
                                     `* !baseline* - Cek Saldo & Pemasukan Bulan Ini\n` +
                                     `* !emergencyfund <pengeluaran>* - Hitung Dana Darurat\n` +
                                     `* !subs* - Audit Biaya Langganan Bulanan\n` +
                                     `* !cekgajian* - Checklist Finansial\n` +
                                     `* !lifemap* - Life Map Dashboard\n\n` +

                                     `*⚙️ SISTEM & LAINNYA:*\n` +
                                     `* !autoranap on/off*\n` +
                                     `* !autorajal on/off*\n` +
                                     `* !refresh* - 🔄 Paksa Ekstensi Scrape!\n` +
                                     `* !addjadwal* / *!listjadwal* / *!deljadwal*\n` +
                                     `* !runtime* - Cek sistem info\n`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;

                // =====================================
                // BLOK MONEY TRACKER COMMANDS
                // =====================================
                case 'catat':
                    await sock.sendMessage(sender, { text: "⏳ _AI sedang memproses input keuanganmu..._" }, { quoted: msg });
                    try {
                        const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                        const isImage = msg.message.imageMessage || quotedMsg?.imageMessage;
                        const isAudio = msg.message.audioMessage || quotedMsg?.audioMessage;
                        let aiData;

                        if (isImage) {
                            const targetMsg = msg.message.imageMessage ? msg : msg.message.extendedTextMessage.contextInfo.quotedMessage;
                            const buffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                            const promptTeks = args.join(" ") || "Analisis total belanja di struk ini, dan carikan kategorinya.";
                            aiData = await aiCategorizeFinance(promptTeks, buffer, "image/jpeg");
                        } 
                        else if (isAudio) {
                            const targetMsg = msg.message.audioMessage ? msg : msg.message.extendedTextMessage.contextInfo.quotedMessage;
                            const buffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                            aiData = await aiCategorizeFinance("Tolong transkrip audio Voice Note ini, lalu catat angka pengeluaran atau pemasukan beserta kategorinya.", buffer, "audio/ogg");
                        }
                        else if (args.length > 0) {
                            aiData = await aiCategorizeFinance(args.join(" "));
                        }
                        else {
                            await sock.sendMessage(sender, { text: "⚠️ Kirim teks, foto struk, atau Voice Note dengan awalan *!catat*" }, { quoted: msg });
                            break;
                        }

                        aiData.sumber = isImage ? "AI Vision (Struk)" : (isAudio ? "AI Voice Note" : "Teks Natural");
                        const gasRes = await sendToFinanceGAS('add_record', aiData);

                        if (gasRes.status === 'success') {
                            const reply = `✅ *Tercatat Otomatis oleh AI!*\n\n` +
                                          `Tipe: ${aiData.tipe.toUpperCase()}\n` +
                                          `Kategori: ${aiData.kategori}\n` +
                                          `Keterangan: ${aiData.keterangan}\n` +
                                          `Nominal: Rp ${aiData.nominal.toLocaleString('id-ID')}\n\n` +
                                          `📊 _Cek Dashboard: !baseline_`;
                            await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                        } else throw new Error(gasRes.message);
                    } catch (e) {
                        await sock.sendMessage(sender, { text: `❌ *Gagal:* ${e.message}` }, { quoted: msg });
                    }
                    break;

                case 'baseline':
                    await sock.sendMessage(sender, { text: "⏳ _Menarik data dashboard finansial..._" }, { quoted: msg });
                    try {
                        const gasRes = await sendToFinanceGAS('get_baseline', {});
                        if (gasRes.status === 'success') {
                            const income = gasRes.data.income || 0; const expense = gasRes.data.expense || 0;
                            const reply = `📊 *FINANCIAL BASELINE CHECK-UP*\nBulan Ini\n\n` +
                                          `📈 Total Pemasukan: Rp ${income.toLocaleString('id-ID')}\n` +
                                          `📉 Total Pengeluaran: Rp ${expense.toLocaleString('id-ID')}\n` +
                                          `💰 Saldo Bersih: Rp ${(income - expense).toLocaleString('id-ID')}\n\n` +
                                          `_Link Spreadsheet tersedia di Server._`;
                            await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                        }
                    } catch (e) { await sock.sendMessage(sender, { text: "❌ Gagal." }, { quoted: msg }); }
                    break;

                case 'emergencyfund':
                    if (!args[0] || isNaN(args[0])) {
                        await sock.sendMessage(sender, { text: "⚠️ Format: *!emergencyfund <rata_pengeluaran_bulanan>*" }, { quoted: msg }); break;
                    }
                    const p = parseInt(args[0]);
                    const efReply = `🛡️ *EMERGENCY FUND CALCULATOR*\n\nPengeluaran Bulanan: Rp ${p.toLocaleString('id-ID')}\n\n` +
                                    `🎯 *Target Dana Darurat:*\n• Lajang (3x): Rp ${(p * 3).toLocaleString('id-ID')}\n` +
                                    `• Menikah (6x): Rp ${(p * 6).toLocaleString('id-ID')}\n• Freelance (12x): Rp ${(p * 12).toLocaleString('id-ID')}`;
                    await sock.sendMessage(sender, { text: efReply }, { quoted: msg });
                    break;

                case 'subs':
                    await sock.sendMessage(sender, { text: "⏳ _Menganudit langganan (Subscription)..._" }, { quoted: msg });
                    try {
                        const gasRes = await sendToFinanceGAS('get_subs', {});
                        let subReply = `🔄 *SUBSCRIPTION AUDIT TOOL*\n\n`; let totalSub = 0;
                        if(gasRes.data && gasRes.data.length > 0) {
                            gasRes.data.forEach((s, i) => { subReply += `${i+1}. ${s.keterangan}: Rp ${s.nominal.toLocaleString('id-ID')}\n`; totalSub += s.nominal; });
                        } else { subReply += `_Tidak ada pengeluaran 'Langganan' tercatat._\n`; }
                        subReply += `\n💸 *Total Biaya:* Rp ${totalSub.toLocaleString('id-ID')}`;
                        await sock.sendMessage(sender, { text: subReply }, { quoted: msg });
                    } catch (e) {}
                    break;

                case 'cekgajian':
                    await sock.sendMessage(sender, { text: `💸 *"SEBELUM GAJIAN" CHECKLIST* 💸\n\n[ ] 🕌 *Spiritual/Sedekah* (2.5-5%)\n[ ] 🛡️ *Investasi* (Min. 10%)\n[ ] 🧾 *Tagihan Pasti*\n[ ] 🛒 *Kebutuhan Hidup*\n[ ] 💆‍♂️ *Hiburan/Keinginan*` }, { quoted: msg });
                    break;

                case 'lifemap':
                    await sock.sendMessage(sender, { text: `🗺️ *FINANCIAL LIFE MAP*\n\n1. Dana Darurat Penuh (Target 6 Bulan)\n2. Bebas Hutang Konsumtif\n3. Dana Pendidikan/Menikah\n4. Investasi Saham/Properti` }, { quoted: msg });
                    break;

                // =====================================
                // KEMBALI KE COMMAND RSUD / SISTEM
                // =====================================
                case 'runtime':
                    // (Logika runtime dari script awal Anda diletakkan disini)
                    break;
                case 'addjadwal':
                    // (Logika addjadwal dari script awal Anda)
                    break;
                case 'listjadwal':
                    // (Logika listjadwal)
                    break;
                case 'deljadwal':
                    // (Logika deljadwal)
                    break;
                case 'ping':
                    await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${Date.now() - (msg.messageTimestamp * 1000)} ms` }, { quoted: msg }); 
                    break;
                case 'ai': 
                    if(handleAiCommand) await handleAiCommand(sock, msg, args); 
                    break;
                case 'sticker': 
                case 's': 
                    if(handleStickerCommand) await handleStickerCommand(sock, msg); 
                    break;
            }
        } catch (error) { console.error('Error proses pesan:', error); }
    });
}