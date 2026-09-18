import fs from 'fs';
import path from 'path';

// =========================================================================
// KONFIGURASI BOT & PENYIMPANAN DATA KLIEN
// =========================================================================
const sessionPath = './session';
const repliedContactsFile = path.join(sessionPath, 'replied_contacts.json');

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
                // Kompatibilitas jika file sebelumnya hanya berisi string ID
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

// Format tanggal lokal Indonesia
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

            // =====================================================================
            // MENU PERINTAH ADMIN (!help, !hellp, !checkclient, !clearclient)
            // =====================================================================
            if (cleanText.startsWith('!')) {
                const args = cleanText.slice(1).trim().split(/ +/);
                const command = args.shift().toLowerCase();

                switch (command) {
                    case 'help':
                    case 'hellp':
                        const menuText = `*🤖 PANEL KONTROL BOT UMI DIEN 🤖*\n\n` +
                            `Berikut daftar perintah pengelolaan data kontak:\n\n` +
                            `* !checkclient* - 📋 Cek seluruh daftar nama & nomor WA yang sudah pernah chat\n` +
                            `* !clearclient* - 🗑️ Hapus seluruh memori/file JSON (bot akan menganggap semua nomor sebagai chat baru lagi)\n` +
                            `* !help* / *!hellp* - ℹ️ Menampilkan panduan menu ini`;

                        await sock.sendMessage(senderInfo.targetJid, { text: menuText }, { quoted: msg });
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
                                `Sebanyak *${totalCleared} data klien* berhasil dihapus dari memori dan file JSON.\n` +
                                `Kini nomor mana pun yang mengirim chat akan otomatis dibalas dengan gambar & pesan selamat datang.`
                        }, { quoted: msg });
                        return;

                    default:
                        // Jika bukan perintah yang dikenal, abaikan agar tidak mengganggu alur pesan
                        break;
                }
            }

            // =====================================================================
            // LOGIKA FILTER NOMOR BARU
            // =====================================================================
            const trackingKey = senderInfo.id;

            // Jika nomor sudah terdata di memori, lewati (jangan kirim ulang)
            if (repliedContactsMap.has(trackingKey)) {
                return;
            }

            console.log(`[PENGGUNA BARU] Menerima chat perdana dari ${pushName} (${senderInfo.targetJid})`);

            // Simpan nama WhatsApp dan nomor pengirim ke database memori
            repliedContactsMap.set(trackingKey, {
                name: pushName,
                jid: senderInfo.targetJid,
                date: getFormattedDateTime()
            });
            persistRepliedContacts();

            // Efek sedang mengetik
            try {
                await sock.sendPresenceUpdate('composing', senderInfo.targetJid);
                await new Promise(res => setTimeout(res, 1200));
            } catch (e) {}

            // Kirim gambar dan caption
            await sock.sendMessage(senderInfo.targetJid, {
                image: { url: WELCOME_IMAGE_URL },
                caption: WELCOME_CAPTION
            }, { quoted: msg });

            try {
                await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
            } catch (e) {}

            console.log(`[SUKSES] Pesan selamat datang & gambar berhasil dikirim ke ${pushName} (${senderInfo.targetJid})`);

        } catch (error) {
            console.error('[Error Handler Chat Baru]:', error);
        }
    });
}
