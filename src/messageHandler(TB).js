import fs from 'fs';
import path from 'path';

// =========================================================================
// KONFIGURASI BOT, BOSS & PENYIMPANAN DATA KLIEN
// =========================================================================
const sessionPath = './session';
const repliedContactsFile = path.join(sessionPath, 'replied_contacts.json');

// Nomor WhatsApp Boss / Chief Penerima Notifikasi & Pengendali Bot
const BOSS_NUMBER = "6282299588447@s.whatsapp.net";
const BOSS_CLEAN_ID = "6282299588447";

// URL Gambar Selamat Datang
const WELCOME_IMAGE_URL = "https://i.ibb.co.com/HLSNLbzf/Whats-App-Image-2026-09-18-at-16-53-40.jpg";

// Teks Pesan Pembuka
const WELCOME_CAPTION = `*Halo Mams/Paps👋🏻*
Salam Kenal, Saya Umi Dien 💟
Verified Seller Resmi Wellous.id
*ID Distributor: i1664*

Terimakasih sudah hubungi Umi Dien, Umi menyediakan beberapa produk untuk kebutuhan yang berbeda-beda 🍀

Sebelum Umi kirimkan katalognya, boleh Umi tahu dulu keluhan yang paling ingin mams/paps atasi apa ya? 🤗`;

if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
}

// Map memori: Kunci = ID/Nomor -> Nilai = { name, jid, date }
const repliedContactsMap = new Map();

// Load data kontak dan nama dari file JSON saat startup
if (fs.existsSync(repliedContactsFile)) {
    try {
        const rawData = fs.readFileSync(repliedContactsFile, 'utf-8');
        const parsed = JSON.parse(rawData);
        
        if (Array.isArray(parsed)) {
            parsed.forEach(item => {
                if (typeof item === 'string') {
                    repliedContactsMap.set(item, { name: 'Klien Lama', jid: item, date: '-' });
                } else if (item && item.id) {
                    repliedContactsMap.set(item.id, {
                        name: item.name || 'Tanpa Nama',
                        jid: item.jid || item.id,
                        date: item.date || '-'
                    });
                }
            });
        }
    } catch (e) {
        console.error('[Storage Error] Gagal membaca file replied_contacts.json:', e.message);
    }
}

// Simpan data kontak ke file JSON secara berkala
let saveTimer = null;
function persistRepliedContacts() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const dataArray = Array.from(repliedContactsMap.entries()).map(([id, info]) => ({
                id,
                name: info.name,
                jid: info.jid,
                date: info.date
            }));
            fs.writeFileSync(repliedContactsFile, JSON.stringify(dataArray, null, 2));
        } catch (e) {
            console.error('[Storage Error] Gagal menyimpan data kontak:', e.message);
        }
    }, 1000);
}

// Format waktu lokal Indonesia
function getFormattedDateTime() {
    return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Makassar'
    }).format(new Date());
}

// =========================================================================
// HELPER PARSER SENDER & NORMALISASI NOMOR
// =========================================================================
function formatToInternational(raw) {
    if (!raw && raw !== 0) return '';
    let p = String(raw).trim().replace(/\D/g, '');
    if (p.startsWith('0')) p = '62' + p.substring(1);
    else if (p.startsWith('8')) p = '62' + p;
    else if (!p.startsWith('62') && p.length >= 8) p = '62' + p;
    return p;
}

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
        targetJid = `${formatToInternational(cleanId)}@s.whatsapp.net`;
    }

    return {
        rawJid: jidStr,
        id: cleanId,
        isLid,
        isGroup,
        isBroadcast,
        targetJid
    };
}

// =========================================================================
// MAIN MESSAGE HANDLER ENGINE
// =========================================================================
export default function setupMessageHandler(sock) {
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message || msg.key.fromMe) return;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid) return;

            const senderInfo = parseSenderInfo(remoteJid);

            // Filter: Abaikan pesan grup dan status WhatsApp
            if (senderInfo.isGroup || senderInfo.isBroadcast || remoteJid === 'status@broadcast') {
                return;
            }

            const incomingText = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption || '';

            const isMedia = !!(msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage || msg.message.audioMessage || msg.message.stickerMessage);

            if (!incomingText.trim() && !isMedia) return;

            const pushName = msg.pushName || 'Klien';
            const cleanText = incomingText.trim();
            const isBoss = (senderInfo.id === BOSS_CLEAN_ID || senderInfo.targetJid === BOSS_NUMBER);

            // =====================================================================
            // 1. MENU PERINTAH ADMIN & BOSS (!help, !balas, !checkclient, !clearclient)
            // =====================================================================
            if (cleanText.startsWith('!')) {
                const args = cleanText.slice(1).trim().split(/ +/);
                const command = args.shift().toLowerCase();

                switch (command) {
                    case 'help':
                    case 'hellp':
                        const menuText = `*🤖 PANEL KONTROL BOT UMI DIEN 🤖*\n\n` +
                            `Berikut daftar perintah yang tersedia:\n\n` +
                            `* !balas <nomor/JID> <pesan>* - 💬 Teruskan balasan dari Boss ke klien via bot\n` +
                            `  _Contoh: !balas 6285256739684 Halo kak, keluhannya apa ya?_\n` +
                            `* !checkclient* - 📋 Cek daftar nama & nomor WA klien yang tersimpan\n` +
                            `* !clearclient* - 🗑️ Hapus seluruh riwayat memori/JSON klien\n` +
                            `* !help* / *!hellp* - ℹ️ Menampilkan panduan menu ini`;

                        await sock.sendMessage(senderInfo.targetJid, { text: menuText }, { quoted: msg });
                        return;

                    case 'balas':
                        // Fitur proteksi: Hanya Boss yang dapat menjalankan perintah !balas
                        if (!isBoss) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `❌ Akses ditolak. Perintah ini hanya dapat digunakan oleh Chief/Boss.`
                            }, { quoted: msg });
                            return;
                        }

                        if (args.length < 2) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ *Format salah!*\n\nGunakan format:\n*!balas <nomor target> <isi pesan>*\n\nContoh:\n*!balas 6285256739684 Boleh kak, produk ready stock ya*`
                            }, { quoted: msg });
                            return;
                        }

                        const rawTarget = args.shift();
                        const replyContent = args.join(' ').trim();

                        // Normalisasi format JID tujuan
                        let targetClientJid = '';
                        if (rawTarget.toLowerCase().endsWith('@lid')) {
                            targetClientJid = rawTarget.toLowerCase();
                        } else {
                            const cleanTargetNumber = formatToInternational(rawTarget);
                            targetClientJid = `${cleanTargetNumber}@s.whatsapp.net`;
                        }

                        try {
                            // Efek mengetik ke nomor customer sebelum mengirim
                            await sock.sendPresenceUpdate('composing', targetClientJid);
                            await new Promise(res => setTimeout(res, 1000));

                            // Kirim pesan dari bot ke customer
                            await sock.sendMessage(targetClientJid, { text: replyContent });

                            await sock.sendPresenceUpdate('paused', targetClientJid);

                            // Laporan konfirmasi kembali ke Boss
                            const clientDisplay = rawTarget.replace(/\D/g, '');
                            await sock.sendMessage(BOSS_NUMBER, {
                                text: `✅ *PESAN TERKIRIM KE KLIEN*\n\n` +
                                    `🎯 *Tujuan:* ${rawTarget}\n` +
                                    `💬 *Isi Pesan:* "${replyContent}"\n` +
                                    `🕒 *Waktu:* ${getFormattedDateTime()}`
                            }, { quoted: msg });

                            console.log(`[BALAS SUKSES] Pesan Boss terkirim ke ${targetClientJid}`);
                        } catch (errBalas) {
                            await sock.sendMessage(BOSS_NUMBER, {
                                text: `❌ *Gagal Mengirim Pesan:* ${errBalas.message}`
                            }, { quoted: msg });
                        }
                        return;

                    case 'checkclient':
                        if (repliedContactsMap.size === 0) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `ℹ️ *Belum ada data kontak klien.* Belum ada nomor yang tersimpan di sistem.`
                            }, { quoted: msg });
                            return;
                        }

                        let clientListText = `📋 *DAFTAR KLIEN TERSIMPAN (${repliedContactsMap.size} Kontak)*\n\n`;
                        let index = 1;

                        for (const [id, data] of repliedContactsMap.entries()) {
                            clientListText += `${index++}. *${data.name}*\n` +
                                `   📱 ID/No: ${id}\n` +
                                `   🕒 Masuk: ${data.date}\n\n`;
                        }

                        clientListText += `_Gunakan *!clearclient* jika ingin mereset riwayat ini._`;
                        await sock.sendMessage(senderInfo.targetJid, { text: clientListText.trim() }, { quoted: msg });
                        return;

                    case 'clearclient':
                        const totalCleared = repliedContactsMap.size;
                        repliedContactsMap.clear();

                        try {
                            if (fs.existsSync(repliedContactsFile)) {
                                fs.writeFileSync(repliedContactsFile, JSON.stringify([], null, 2));
                            }
                        } catch (errClear) {
                            console.error('[File Reset Error]:', errClear.message);
                        }

                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `✅ *BERHASIL DIRESET!*\n\n` +
                                `Sebanyak *${totalCleared} data klien* berhasil dihapus.\n` +
                                `Semua chat baru yang masuk akan kembali mendapatkan gambar & pesan pembuka.`
                        }, { quoted: msg });
                        return;

                    default:
                        break;
                }
            }

            // Jika Boss mengirim chat biasa tanpa awalan '!', abaikan agar tidak meneruskan chat Boss ke dirinya sendiri
            if (isBoss) return;

            const trackingKey = senderInfo.id;
            const incomingTime = getFormattedDateTime();
            const clientPhone = formatToInternational(senderInfo.id);
            const waDirectLink = `https://wa.me/${clientPhone}`;
            const previewMessage = incomingText.trim() ? incomingText.trim() : `_(Klien mengirim Media / Gambar / Dokumen)_`;

            // =====================================================================
            // 2. KLIEN LAMA: JIKA KLIEN MEMBALAS / MENGIRIM CHAT LANJUTAN
            // =====================================================================
            if (repliedContactsMap.has(trackingKey)) {
                // Update nama profil terbaru jika sebelumnya tanpa nama
                const existingData = repliedContactsMap.get(trackingKey);
                if (pushName && pushName !== 'Klien' && existingData.name !== pushName) {
                    existingData.name = pushName;
                    persistRepliedContacts();
                }

                console.log(`[FORWARD CHAT] Menerima balasan dari klien lama: ${pushName} (${clientPhone})`);

                // Otomatis teruskan pesan balasan klien ke WhatsApp Boss
                try {
                    const forwardToBossText = `💬 *BALASAN DARI KLIEN* 💬\n\n` +
                        `👤 *Nama Klien:* ${pushName}\n` +
                        `📱 *Nomor HP:* ${clientPhone}\n` +
                        `🔗 *Link Langsung:* ${waDirectLink}\n` +
                        `🕒 *Waktu:* ${incomingTime}\n` +
                        `💬 *Isi Pesan:*\n"${previewMessage}"\n\n` +
                        `-----------------------------------------\n` +
                        `👉 *Balas via Bot:* ketik:\n` +
                        `*!balas ${clientPhone} <isi pesan>*`;

                    await sock.sendMessage(BOSS_NUMBER, { text: forwardToBossText });
                    console.log(`[FORWARD SUKSES] Pesan dari ${pushName} diteruskan ke Boss.`);
                } catch (errFwd) {
                    console.error('[Gagal Forward ke Boss]:', errFwd.message);
                }
                return;
            }

            // =====================================================================
            // 3. KLIEN BARU: BALAS PERDANA DENGAN GAMBAR & LAPORKAN KE BOSS
            // =====================================================================
            console.log(`[KLIEN BARU] Chat perdana dari ${pushName} (${senderInfo.targetJid})`);

            // 1. Simpan ke daftar memori & file JSON
            repliedContactsMap.set(trackingKey, {
                name: pushName,
                jid: senderInfo.targetJid,
                date: incomingTime
            });
            persistRepliedContacts();

            // 2. Kirim gambar + caption pembuka ke klien
            try {
                await sock.sendPresenceUpdate('composing', senderInfo.targetJid);
                await new Promise(res => setTimeout(res, 1200));
            } catch (e) {}

            await sock.sendMessage(senderInfo.targetJid, {
                image: { url: WELCOME_IMAGE_URL },
                caption: WELCOME_CAPTION
            }, { quoted: msg });

            try {
                await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
            } catch (e) {}

            console.log(`[SUKSES] Pesan selamat datang & gambar terkirim ke ${pushName}`);

            // 3. Kirim notifikasi klien baru ke Boss beserta instruksi balasannya
            try {
                const notifBossText = `🔔 *NOTIFIKASI KLIEN BARU MASUK* 🔔\n\n` +
                    `👤 *Nama Klien:* ${pushName}\n` +
                    `📱 *Nomor HP:* ${clientPhone}\n` +
                    `🔗 *Link Langsung:* ${waDirectLink}\n` +
                    `🕒 *Waktu Chat:* ${incomingTime}\n` +
                    `💬 *Pesan Pertama:* "${previewMessage}"\n\n` +
                    `_Pesan sambutan Umi Dien telah dikirimkan ke kontak tersebut._ ✅\n\n` +
                    `-----------------------------------------\n` +
                    `👉 *Balas via Bot:* ketik:\n` +
                    `*!balas ${clientPhone} <isi pesan>*`;

                await sock.sendMessage(BOSS_NUMBER, { text: notifBossText });
                console.log(`[NOTIFIKASI BOSS] Laporan klien baru (${pushName}) terkirim ke Boss.`);
            } catch (errBoss) {
                console.error('[Gagal Kirim Notif ke Boss]:', errBoss.message);
            }

        } catch (error) {
            console.error('[Error Handler Chat]:', error);
        }
    });
}
