import fs from 'fs';
import process from 'process';
import os from 'os';
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ==========================================
// KONFIGURASI GLOBAL
// ==========================================
const ownerNumber = "6285256739684@s.whatsapp.net";
const GAS_URL = "https://script.google.com/macros/s/AKfycbzhDou1e-e4QXDILWfM_mkyagViYOvcpLLv7xL-kJ6cVhpR_R5_bVICdnUYxp0AA90/exec";
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
// FUNGSI PINTAR: FETCH WITH FALLBACK (VERCEL -> GAS)
// ==========================================
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

// ==========================================
// SMART DIFF ALGORITHM & UPGRADE LOGIC
// ==========================================
let lastRanapData = null;
let lastRajalEndoData = null;
let lastRajalBMData = null;
let lastRajalPerioData = null; 
let lastRajalUmumData = null; 

function getDifferences(oldList, newList) {
    const makeKey = (p) => `${p.no_rm}_${p.nama_pasien}`;
    const oldMap = new Map(oldList.map(p => [makeKey(p), p]));
    const newMap = new Map(newList.map(p => [makeKey(p), p]));
    
    const added = newList.filter(p => !oldMap.has(makeKey(p)));
    const removed = oldList.filter(p => !newMap.has(makeKey(p)));
    
    // Cek jika ada perubahan Text Status menjadi PULANG / SELESAI / BATAL / ASUHAN KEPERAWATAN di dalam antrean
    const changed = newList.filter(p => {
        if (oldMap.has(makeKey(p))) {
            const oldP = oldMap.get(makeKey(p));
            const oldStatus = (oldP.status || "").toUpperCase();
            const newStatus = (p.status || "").toUpperCase();
            if (oldStatus !== newStatus) return true;
        }
        return false;
    });
    
    return { 
        added, 
        removed, 
        changed, 
        hasDiff: added.length > 0 || removed.length > 0 || changed.length > 0 
    };
}

// Fungsi Upgrade Logic Rawat Jalan (List bersambung & Teratur berdasarkan Status)
function formatKlinikList(namaKlinik, iconKlinik, currentList, removedList) {
    let resultTxt = `${iconKlinik} *Klinik ${namaKlinik}*:\n`;
    let countBaru = 0;
    let countSelesai = 0;

    let listSelesai = [];
    let listBaru = [];

    // 1. Masukkan pasien yang terhapus/hilang dari server (Otomatis dianggap Selesai)
    if (removedList && removedList.length > 0) {
        removedList.forEach(p => {
            listSelesai.push(`${p.nama_pasien} *(SELESAI / BATAL)*`);
            countSelesai++;
        });
    }

    // 2. Filter list saat ini, Cek Trigger dari tulisan status
    currentList.forEach(p => {
        const st = (p.status || "").toUpperCase();
        
        if (st.includes("PULANG") || st.includes("BATAL") || st.includes("SELESAI")) {
            listSelesai.push(`${p.nama_pasien} *(SELESAI / BATAL)*`);
            countSelesai++;
        } else if (st.includes("ASUHAN KEPERAWATAN")) {
            // Eksplisit dimasukkan ke BARU sesuai permintaan
            listBaru.push(`${p.nama_pasien} *(BARU)*`);
            countBaru++;
        } else {
            // Default jika status lain (antri/kosong) tetap masuk ke BARU
            listBaru.push(`${p.nama_pasien} *(BARU)*`);
            countBaru++;
        }
    });

    let combinedList = [...listSelesai, ...listBaru];

    if (combinedList.length === 0) {
        resultTxt += `_(Tidak ada pasien)_\n\n`;
    } else {
        // Penomoran teratur (1, 2, 3...)
        combinedList.forEach((item, index) => {
            resultTxt += `${index + 1}. ${item}\n`;
        });
        resultTxt += `\n`;
    }

    return { txt: resultTxt, baru: countBaru, selesai: countSelesai };
}

// ==========================================
// FUNGSI PENGIRIMAN DATA PRIMER (SAAT ON)
// ==========================================
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
            fetchWithFallback('RajalEndo_AntrianPx', `tanggal=${dateWITA}`),
            fetchWithFallback('RajalBM_AntrianPx', `tanggal=${dateWITA}`),
            fetchWithFallback('RajalPerio_AntrianPx', `tanggal=${dateWITA}`),
            fetchWithFallback('RajalUmum_AntrianPx', `tanggal=${dateWITA}`)
        ]);

        const currentEndo = dataEndo.data || [];
        const currentBM = dataBM.data || [];
        const currentPerio = dataPerio.data || [];
        const currentUmum = dataUmum.data || [];

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
        msg += `📊 *Total Antrean (SELESAI: SUDAH DIKERJA):* Endo (${formatEndo.selesai}), BM (${formatBM.selesai}), Perio (${formatPerio.selesai}), Umum (${formatUmum.selesai})`;
        
        await sock.sendMessage(jid, { text: msg });
    } catch (e) {
        console.error("Gagal load primer Rajal:", e);
    }
}

async function checkApiUpdates(sock) {
    if (!sock) return;
    try {
        const resTrigger = await fetch('https://ishiprsud.vercel.app/api/trigger');
        const dataTrigger = await resTrigger.json();
        if (dataTrigger.notify && dataTrigger.notify.trim() !== "") {
            await sock.sendMessage(ownerNumber, { text: dataTrigger.notify });
        }

        // =======================================
        // 1. AUTO INFO: RAWAT INAP (RANAP)
        // =======================================
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
                        for (const jid of botSettings.autoRanap) await sock.sendMessage(jid, { text: msg });
                    }
                }
                lastRanapData = currentRanap;
            }
        }

        // =======================================
        // 2. AUTO INFO: RAWAT JALAN (4 KLINIK)
        // =======================================
        if (botSettings.autoRajal.length > 0) {
            const dateWITA = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' }); 
            
            const [dataEndo, dataBM, dataPerio, dataUmum] = await Promise.all([
                fetchWithFallback('RajalEndo_AntrianPx', `tanggal=${dateWITA}`),
                fetchWithFallback('RajalBM_AntrianPx', `tanggal=${dateWITA}`),
                fetchWithFallback('RajalPerio_AntrianPx', `tanggal=${dateWITA}`),
                fetchWithFallback('RajalUmum_AntrianPx', `tanggal=${dateWITA}`)
            ]);

            const currentEndo = dataEndo.data || [];
            const currentBM = dataBM.data || [];
            const currentPerio = dataPerio.data || [];
            const currentUmum = dataUmum.data || [];

            if (lastRajalEndoData !== null && lastRajalBMData !== null && lastRajalPerioData !== null && lastRajalUmumData !== null) {
                const diffEndo = getDifferences(lastRajalEndoData, currentEndo);
                const diffBM = getDifferences(lastRajalBMData, currentBM);
                const diffPerio = getDifferences(lastRajalPerioData, currentPerio);
                const diffUmum = getDifferences(lastRajalUmumData, currentUmum);
                
                // Jika ada pasien bertambah, berkurang, ATAU ada status yang diubah ke PULANG/ASUHAN KEPERAWATAN dll
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
                    msg += `📊 *Total Antrean (SELESAI: SUDAH DIKERJA):* Endo (${formatEndo.selesai}), BM (${formatBM.selesai}), Perio (${formatPerio.selesai}), Umum (${formatUmum.selesai})`;
                    
                    for (const jid of botSettings.autoRajal) await sock.sendMessage(jid, { text: msg });
                }
            }
            lastRajalEndoData = currentEndo;
            lastRajalBMData = currentBM;
            lastRajalPerioData = currentPerio;
            lastRajalUmumData = currentUmum;
        }
    } catch (e) { console.error("[Auto Info] Error polling API:", e); }
}

// ==========================================
// EXPORT HANDLER
// ==========================================
let isIntervalStarted = false;
let currentSock = null;

export default function setupMessageHandler(sock) {
    currentSock = sock; // Update referensi socket agar selalu menggunakan koneksi terbaru

    // Jalankan scheduler & polling API hanya sekali untuk mencegah memory leaks
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
        }, 30000); 

        setInterval(() => {
            if (currentSock) checkApiUpdates(currentSock);
        }, 60000);

        isIntervalStarted = true;
    }

    // Listener Pesan Masuk
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
                await sock.sendMessage(sender, { text: `⏳ _Sedang mengambil data rawat jalan dari server..._` }, { quoted: msg });
                try {
                    const isEndo = command.includes('endo'); 
                    const isPerio = command.includes('perio');
                    const isUmum = command.includes('umum') || command.includes('gigi'); // Tambahan integrasi command Umum
                    const isRiwayat = command.includes('riwayat');
                    const isAntrian = command.includes('antrianpx'); 
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

            switch (command) {
                case 'menu':
                case 'help':
                    const menuText = `*🤖 BOT MENU 🤖*\n\n` +
                                     `*🏥 DAFTAR PERINTAH KLINIK:*\n` +
                                     `* !jadwalranap* - Cek pasien Rawat Inap\n\n` +
                                     `*(HARI INI)*\n` +
                                     `* !cekrajalriwayatendo*\n` +
                                     `* !cekrajalantrianpxendo*\n` +
                                     `* !cekrajalriwayatbm*\n` +
                                     `* !cekrajalantrianpxbm*\n` +
                                     `* !cekrajalriwayatperio*\n` +
                                     `* !cekrajalantrianpxperio*\n` +
                                     `* !cekrajalriwayatumum*\n` +
                                     `* !cekrajalantrianpxumum*\n\n` +
                                     `*(BESOK)*\n` +
                                     `* !cekrajalriwayatendobsk*\n` +
                                     `* !cekrajalantrianpxendobsk*\n` +
                                     `* !cekrajalriwayatbmbsk*\n` +
                                     `* !cekrajalantrianpxbmbsk*\n` +
                                     `* !cekrajalriwayatperiobsk*\n` +
                                     `* !cekrajalantrianpxperiobsk*\n` +
                                     `* !cekrajalriwayatumumbsk*\n` +
                                     `* !cekrajalantrianpxumumbsk*\n\n` +
                                     `*🔔 AUTO INFO (GROUP/CHAT):*\n` +
                                     `* !autoranap on/off* - Notif Otomatis Ranap\n` +
                                     `* !autorajal on/off* - Notif Otomatis Rajal\n\n` +
                                     `*⚙️ SISTEM & LAINNYA:*\n` +
                                     `* !refresh* - 🔄 Paksa Ekstensi Scrape!\n` +
                                     `* !addjadwal* - Tambah auto-send\n` +
                                     `* !listjadwal* - Lihat auto-send\n` +
                                     `* !deljadwal <id>* - Hapus auto-send\n` +
                                     `* !ping* - Cek ping bot\n` +
                                     `* !runtime* - Cek sistem info\n` +
                                     `* !tagall* - Tag semua member grup\n`;
                    await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;

                case 'autoranap':
                    if (args[0] === 'on') {
                        if (!botSettings.autoRanap.includes(sender)) botSettings.autoRanap.push(sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info Rawat Inap AKTIF* di obrolan ini.\nBot akan otomatis mengirim pesan laporan jika mendeteksi ada pasien yang masuk atau keluar (pulang).' }, { quoted: msg });
                        
                        // Men-trigger pengiriman Data Primer secara instan
                        await forceSendRanapPrimer(sock, sender);

                    } else if (args[0] === 'off') {
                        botSettings.autoRanap = botSettings.autoRanap.filter(jid => jid !== sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info Rawat Inap NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autoranap on* atau *!autoranap off*' }, { quoted: msg });
                    }
                    break;

                case 'autorajal':
                    if (args[0] === 'on') {
                        if (!botSettings.autoRajal.includes(sender)) botSettings.autoRajal.push(sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '✅ *Auto Info Rawat Jalan AKTIF* di obrolan ini.\nBot akan otomatis mengirim laporan ke obrolan ini setiap kali antrean Klinik bertambah atau berkurang pada hari ini.' }, { quoted: msg });
                        
                        // Men-trigger pengiriman Data Primer secara instan
                        await forceSendRajalPrimer(sock, sender);

                    } else if (args[0] === 'off') {
                        botSettings.autoRajal = botSettings.autoRajal.filter(jid => jid !== sender);
                        saveSettings();
                        await sock.sendMessage(sender, { text: '❌ *Auto Info Rawat Jalan NONAKTIF* di obrolan ini.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: '⚠️ Format salah. Gunakan: *!autorajal on* atau *!autorajal off*' }, { quoted: msg });
                    }
                    break;

                case 'refresh':
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

                case 'jadwalranap':
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
                    } catch (error) { await sock.sendMessage(sender, { text: '❌ *Gagal menghubungkan ke Server API Vercel maupun Google Sheets.*\nPastikan Ekstensi di PC menyala.' }, { quoted: msg }); }
                    break;
                    
                case 'addjadwal':
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

                case 'listjadwal':
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

                case 'deljadwal':
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

                case 'runtime':
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

                case 'tagall':
                    if (!sender.endsWith('@g.us')) return;
                    const groupMetadata = await sock.groupMetadata(sender);
                    const tagParticipants = groupMetadata.participants.map(p => p.id);
                    let mentionText = `*📢 PERHATIAN SEMUA 📢*\n\n`;
                    tagParticipants.forEach(p => mentionText += `👉 @${p.split('@')[0]}\n`);
                    await sock.sendMessage(sender, { text: mentionText, mentions: tagParticipants }, { quoted: msg });
                    break;

                case 'ping':
                    await sock.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ *Kecepatan:* ${Date.now() - (msg.messageTimestamp * 1000)} ms` }, { quoted: msg }); 
                    break;
                    
                case 'ai': 
                    await handleAiCommand(sock, msg, args); 
                    break;
                    
                case 'sticker': 
                case 's': 
                    await handleStickerCommand(sock, msg); 
                    break;
            }
        } catch (error) { console.error('Error proses pesan:', error); }
    });
}
