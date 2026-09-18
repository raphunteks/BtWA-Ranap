import fs from 'fs';
import path from 'path';

// =========================================================================
// KONFIGURASI BOT & PENYIMPANAN KONTAK
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

// Pastikan direktori penyimpanan tersedia
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
}

// In-memory set untuk melacak nomor yang sudah pernah dibalas
const repliedContacts = new Set();

// Load kontak lama dari file JSON saat bot berjalan
if (fs.existsSync(repliedContactsFile)) {
    try {
        const rawData = fs.readFileSync(repliedContactsFile, 'utf-8');
        const parsed = JSON.parse(rawData);
        if (Array.isArray(parsed)) {
            parsed.forEach(id => repliedContacts.add(id));
        }
    } catch (e) {
        console.error('[Storage Error] Gagal membaca replied_contacts.json:', e.message);
    }
}

// Simpan data kontak ke file secara berkala/asynchronous
let saveTimer = null;
function persistRepliedContacts() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(repliedContactsFile, JSON.stringify([...repliedContacts], null, 2));
        } catch (e) {
            console.error('[Storage Error] Gagal menyimpan kontak:', e.message);
        }
    }, 1000);
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

            // Filter: Abaikan pesan grup, story/broadcast WhatsApp
            if (senderInfo.isGroup || senderInfo.isBroadcast || remoteJid === 'status@broadcast') {
                return;
            }

            // Validasi teks atau media masuk
            const incomingText = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption || '';

            const isMedia = !!(msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage || msg.message.audioMessage || msg.message.stickerMessage);

            if (!incomingText.trim() && !isMedia) return;

            const trackingKey = senderInfo.id; // Nomor HP atau LID pengguna

            // FILTER: Jika nomor sudah pernah chat sebelumnya, jangan kirim lagi
            if (repliedContacts.has(trackingKey)) {
                return;
            }

            console.log(`[PENGGUNA BARU] Menerima chat perdana dari ${senderInfo.targetJid}`);

            // Simpan nomor pengirim ke daftar kontak yang sudah dibalas
            repliedContacts.add(trackingKey);
            persistRepliedContacts();

            // Efek mengetik singkat agar respon terlihat natural
            try {
                await sock.sendPresenceUpdate('composing', senderInfo.targetJid);
                await new Promise(res => setTimeout(res, 1500));
            } catch (e) {}

            // Kirim gambar dari URL beserta caption teks
            await sock.sendMessage(senderInfo.targetJid, {
                image: { url: WELCOME_IMAGE_URL },
                caption: WELCOME_CAPTION
            }, { quoted: msg });

            // Hentikan status mengetik
            try {
                await sock.sendPresenceUpdate('paused', senderInfo.targetJid);
            } catch (e) {}

            console.log(`[SUKSES] Pesan selamat datang & gambar berhasil dikirim ke ${senderInfo.targetJid}`);

        } catch (error) {
            console.error('[Error Handler Chat Baru]:', error);
        }
    });
}
