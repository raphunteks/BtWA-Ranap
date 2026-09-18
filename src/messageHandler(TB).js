import fs from 'fs';
import path from 'path';

// =========================================================================
// KONFIGURASI BOT, BOSS & PENYIMPANAN DATA KLIEN
// =========================================================================
const sessionPath = './session';
const repliedContactsFile = path.join(sessionPath, 'replied_contacts.json');
const bossConfigFile = path.join(sessionPath, 'boss_config.json');

// Konfigurasi Baku Boss / Chief (LID Default Terpasang)
let bossConfig = {
    bossNumber: "6282299588447@s.whatsapp.net",
    bossLid: "165837881213080" // LID Boss Resmi
};

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

// Muat konfigurasi Boss jika ada perubahan tersimpan
if (fs.existsSync(bossConfigFile)) {
    try {
        const rawBossData = fs.readFileSync(bossConfigFile, 'utf-8');
        bossConfig = { ...bossConfig, ...JSON.parse(rawBossData) };
    } catch (e) {
        console.error('[Boss Config Error] Gagal membaca boss_config.json:', e.message);
    }
}

function saveBossConfig() {
    try {
        fs.writeFileSync(bossConfigFile, JSON.stringify(bossConfig, null, 2));
    } catch (e) {
        console.error('[Boss Config Error] Gagal menyimpan boss_config.json:', e.message);
    }
}

// Map memori: Kunci = ID/Nomor -> Nilai = { name, jid, date }
const repliedContactsMap = new Map();

// Muat data riwayat kontak dari file JSON
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

// Simpan data kontak secara berkala
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

function getFormattedDateTime() {
    return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Makassar'
    }).format(new Date());
}

// =========================================================================
// HELPER PARSER SENDER & NORMALISASI NOMOR / LID
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

            // Abaikan grup dan status WhatsApp
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

            // Verifikasi Otoritas Boss: Validasi Nomor Telepon & LID 165837881213080
            const isBoss = (
                senderInfo.targetJid === bossConfig.bossNumber ||
                senderInfo.id === "6282299588447" ||
                senderInfo.id === bossConfig.bossLid ||
                senderInfo.id === "165837881213080" ||
                senderInfo.targetJid === `${bossConfig.bossLid}@lid` ||
                senderInfo.targetJid === "165837881213080@lid"
            );

            // Rute tujuan notifikasi ke Boss (prioritas ke LID aktif Boss)
            const targetBossNotification = bossConfig.bossLid 
                ? `${bossConfig.bossLid}@lid` 
                : bossConfig.bossNumber;

            // =====================================================================
            // 1. MENU PERINTAH ADMIN & BOSS
            // =====================================================================
            if (cleanText.startsWith('!')) {
                const args = cleanText.slice(1).trim().split(/ +/);
                const command = args.shift().toLowerCase();

                switch (command) {
                    case 'help':
                    case 'hellp':
                        const menuText = `*🤖 PANEL KONTROL BOT UMI DIEN 🤖*\n\n` +
                            `Berikut daftar perintah yang tersedia:\n\n` +
                            `* !mylid* - 🔍 Cek ID & status LID WhatsApp Anda saat ini\n` +
                            `* !mylid set* - 👑 Daftarkan LID pengirim sebagai Boss\n` +
                            `* !balas <LID/No WA> <pesan>* - 💬 Kirim balasan ke klien via bot\n` +
                            `  _Contoh: !balas 247922893566044@lid Halo kak ready ya_\n` +
                            `  _Atau: !balas 247922893566044 Halo kak ready ya_\n` +
                            `* !checkclient* - 📋 Cek daftar klien yang tersimpan\n` +
                            `* !clearclient* - 🗑️ Reset seluruh riwayat kontak bot\n` +
                            `* !help* - ℹ️ Tampilkan panduan ini`;

                        await sock.sendMessage(senderInfo.targetJid, { text: menuText }, { quoted: msg });
                        return;

                    case 'mylid':
                        const subCmd = args[0] ? args[0].toLowerCase() : '';

                        if (subCmd === 'set' || subCmd === 'boss') {
                            bossConfig.bossLid = senderInfo.id;
                            saveBossConfig();

                            const successBindText = `👑 *LID BOSS BERHASIL DIPERBARUI!* 👑\n\n` +
                                `Akun WhatsApp Anda kini terkunci sebagai Boss resmi:\n` +
                                `🆔 *Boss LID:* \`${senderInfo.id}\`\n` +
                                `📡 *Target JID:* \`${senderInfo.targetJid}\`\n` +
                                `💾 *Penyimpanan:* \`./session/boss_config.json\``;

                            await sock.sendMessage(senderInfo.targetJid, { text: successBindText }, { quoted: msg });
                            return;
                        }

                        const infoLidText = `🔍 *INFORMASI IDENTITAS PENGIRIM*\n\n` +
                            `👤 *Nama:* ${pushName}\n` +
                            `🆔 *ID:* \`${senderInfo.id}\`\n` +
                            `📡 *Target JID:* \`${senderInfo.targetJid}\`\n` +
                            `🛡️ *Status Otoritas:* ${isBoss ? '✅ *Boss Terverifikasi*' : '❌ *Bukan Boss*'}\n` +
                            `📌 *LID Boss Terdaftar:* \`${bossConfig.bossLid}\`\n\n` +
                            `_Ketik *!mylid set* jika ingin mengubah LID Boss ke nomor ini._`;

                        await sock.sendMessage(senderInfo.targetJid, { text: infoLidText }, { quoted: msg });
                        return;

                    case 'balas':
                        if (!isBoss) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `❌ Akses ditolak. Akun Anda (\`${senderInfo.id}\`) belum terdaftar sebagai Boss.`
                            }, { quoted: msg });
                            return;
                        }

                        if (args.length < 2) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `⚠️ *Format salah!*\n\nGunakan:\n*!balas <ID/LID/No WA> <isi pesan>*\n\nContoh:\n*!balas 247922893566044@lid Boleh kak*\natau\n*!balas 247922893566044 Boleh kak*`
                            }, { quoted: msg });
                            return;
                        }

                        const rawTarget = args.shift().trim();
                        const replyContent = args.join(' ').trim();
                        const cleanDigits = rawTarget.replace(/\D/g, '');

                        // =========================================================
                        // RESOLVER TARGET JID (MENCEGAH ERROR PREFIX 62 PADA LID)
                        // =========================================================
                        let targetClientJid = '';

                        if (rawTarget.toLowerCase().endsWith('@lid')) {
                            // 1. Jika Boss menyertakan akhiran @lid secara eksplisit
                            targetClientJid = `${cleanDigits}@lid`;
                        } else if (rawTarget.toLowerCase().endsWith('@s.whatsapp.net')) {
                            // 2. Jika Boss menyertakan akhiran @s.whatsapp.net
                            targetClientJid = `${formatToInternational(cleanDigits)}@s.whatsapp.net`;
                        } else if (repliedContactsMap.has(cleanDigits)) {
                            // 3. Cocokkan langsung dengan data memori klien yang tersimpan saat chat masuk
                            targetClientJid = repliedContactsMap.get(cleanDigits).jid;
                        } else if (cleanDigits.length >= 14) {
                            // 4. Deteksi otomatis: Panjang digit LID WhatsApp selalu 14 digit ke atas
                            targetClientJid = `${cleanDigits}@lid`;
                        } else {
                            // 5. Nomor telepon seluler standar (10-13 digit)
                            targetClientJid = `${formatToInternational(cleanDigits)}@s.whatsapp.net`;
                        }

                        try {
                            await sock.sendPresenceUpdate('composing', targetClientJid);
                            await new Promise(res => setTimeout(res, 800));

                            // Kirimkan pesan langsung ke target JID yang tepat
                            await sock.sendMessage(targetClientJid, { text: replyContent });

                            await sock.sendPresenceUpdate('paused', targetClientJid);

                            // Kirim laporan status sukses ke Boss
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `✅ *PESAN TERKIRIM KE KLIEN*\n\n` +
                                    `🎯 *Tujuan:* \`${targetClientJid}\`\n` +
                                    `💬 *Isi Pesan:* "${replyContent}"\n` +
                                    `🕒 *Waktu:* ${getFormattedDateTime()}`
                            }, { quoted: msg });

                            console.log(`[BALAS SUKSES] Pesan Boss terkirim ke ${targetClientJid}`);
                        } catch (errBalas) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `❌ *Gagal Mengirim ke \`${targetClientJid}\`:*\n${errBalas.message}`
                            }, { quoted: msg });
                        }
                        return;

                    case 'checkclient':
                        if (repliedContactsMap.size === 0) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `ℹ️ *Belum ada data kontak klien tersimpan.*`
                            }, { quoted: msg });
                            return;
                        }

                        let clientListText = `📋 *DAFTAR KLIEN TERSIMPAN (${repliedContactsMap.size} Kontak)*\n\n`;
                        let index = 1;

                        for (const [id, data] of repliedContactsMap.entries()) {
                            clientListText += `${index++}. *${data.name}*\n` +
                                `   📡 JID: \`${data.jid}\`\n` +
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
                            text: `✅ *BERHASIL DIRESET!*\n\nSebanyak *${totalCleared} data klien* berhasil dibersihkan.`
                        }, { quoted: msg });
                        return;

                    default:
                        break;
                }
            }

            // Abaikan chat biasa dari Boss agar tidak meneruskan chat diri sendiri
            if (isBoss) return;

            const trackingKey = senderInfo.id;
            const incomingTime = getFormattedDateTime();
            const previewMessage = incomingText.trim() ? incomingText.trim() : `_(Klien mengirim Media/Lampiran)_`;
            
            // Siapkan template perintah balas yang sesuai dengan identitas klien
            const cmdBalasTarget = senderInfo.isLid ? `${senderInfo.id}@lid` : formatToInternational(senderInfo.id);

            // =====================================================================
            // 2. KLIEN LAMA: TERUSKAN BALASAN KLIEN KE BOSS
            // =====================================================================
            if (repliedContactsMap.has(trackingKey)) {
                const existingData = repliedContactsMap.get(trackingKey);
                if (pushName && pushName !== 'Klien' && existingData.name !== pushName) {
                    existingData.name = pushName;
                    persistRepliedContacts();
                }

                console.log(`[FORWARD CHAT] Balasan dari klien: ${pushName} (${senderInfo.targetJid})`);

                try {
                    const forwardToBossText = `💬 *BALASAN DARI KLIEN* 💬\n\n` +
                        `👤 *Nama Klien:* ${pushName}\n` +
                        `🆔 *Identitas JID:* \`${senderInfo.targetJid}\`\n` +
                        `🕒 *Waktu:* ${incomingTime}\n` +
                        `💬 *Isi Pesan:*\n"${previewMessage}"\n\n` +
                        `-----------------------------------------\n` +
                        `👉 *Balas Cepat (Salin & Tempel):*\n` +
                        `*!balas ${cmdBalasTarget} <isi pesan>*`;

                    await sock.sendMessage(targetBossNotification, { text: forwardToBossText });
                    console.log(`[FORWARD SUKSES] Pesan ${pushName} diteruskan ke Boss (${targetBossNotification})`);
                } catch (errFwd) {
                    console.error('[Gagal Forward ke Boss]:', errFwd.message);
                }
                return;
            }

            // =====================================================================
            // 3. KLIEN BARU: BALAS GAMBAR & LAPORKAN KE BOSS
            // =====================================================================
            console.log(`[KLIEN BARU] Chat perdana dari ${pushName} (${senderInfo.targetJid})`);

            // 1. Simpan targetJid asli klien ke map memori
            repliedContactsMap.set(trackingKey, {
                name: pushName,
                jid: senderInfo.targetJid,
                date: incomingTime
            });
            persistRepliedContacts();

            // 2. Kirim gambar sambutan beserta caption
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

            console.log(`[SUKSES] Pesan selamat datang terkirim ke ${pushName}`);

            // 3. Notifikasi ke WhatsApp Boss
            try {
                const notifBossText = `🔔 *NOTIFIKASI KLIEN BARU MASUK* 🔔\n\n` +
                    `👤 *Nama Klien:* ${pushName}\n` +
                    `🆔 *Identitas JID:* \`${senderInfo.targetJid}\`\n` +
                    `🕒 *Waktu Chat:* ${incomingTime}\n` +
                    `💬 *Pesan Pertama:* "${previewMessage}"\n\n` +
                    `_Pesan sambutan Umi Dien telah dikirimkan ke kontak tersebut._ ✅\n\n` +
                    `-----------------------------------------\n` +
                    `👉 *Balas Cepat (Salin & Tempel):*\n` +
                    `*!balas ${cmdBalasTarget} <isi pesan>*`;

                await sock.sendMessage(targetBossNotification, { text: notifBossText });
                console.log(`[NOTIFIKASI BOSS] Laporan klien baru (${pushName}) terkirim ke Boss (${targetBossNotification})`);
            } catch (errBoss) {
                console.error('[Gagal Kirim Notif ke Boss]:', errBoss.message);
            }

        } catch (error) {
            console.error('[Error Handler Chat]:', error);
        }
    });
}
