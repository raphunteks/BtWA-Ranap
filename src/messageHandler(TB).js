import fs from 'fs';
import path from 'path';

// =========================================================================
// KONFIGURASI BOT, BOSS & PENYIMPANAN DATA
// =========================================================================
const sessionPath = './session';
const repliedContactsFile = path.join(sessionPath, 'replied_contacts.json');
const bossConfigFile = path.join(sessionPath, 'boss_config.json');
const lidCacheFile = path.join(sessionPath, 'lid_mappings.json');

// Konfigurasi Baku Boss / Chief (Nomor Telepon & LID Terkunci Otomatis)
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

// Muat konfigurasi Boss jika ada modifikasi
if (fs.existsSync(bossConfigFile)) {
    try {
        const rawBossData = fs.readFileSync(bossConfigFile, 'utf-8');
        bossConfig = { ...bossConfig, ...JSON.parse(rawBossData) };
    } catch (e) {
        console.error('[Boss Config Error]:', e.message);
    }
}

function saveBossConfig() {
    try {
        fs.writeFileSync(bossConfigFile, JSON.stringify(bossConfig, null, 2));
    } catch (e) {
        console.error('[Boss Config Save Error]:', e.message);
    }
}

// =========================================================================
// BIDIRECTIONAL MAPPING (LID <-> PHONE JID)
// =========================================================================
const lidToPhoneMap = new Map();
const phoneToLidMap = new Map();

if (fs.existsSync(lidCacheFile)) {
    try {
        const saved = JSON.parse(fs.readFileSync(lidCacheFile, 'utf-8'));
        for (const [lid, phone] of Object.entries(saved.lidToPhone || {})) {
            lidToPhoneMap.set(lid, phone);
        }
        for (const [phone, lid] of Object.entries(saved.phoneToLid || {})) {
            phoneToLidMap.set(phone, lid);
        }
    } catch (e) {}
}

function persistLidMappings() {
    try {
        const data = {
            lidToPhone: Object.fromEntries(lidToPhoneMap),
            phoneToLid: Object.fromEntries(phoneToLidMap)
        };
        fs.writeFileSync(lidCacheFile, JSON.stringify(data, null, 2));
    } catch (e) {}
}

// Map kontak klien yang pernah chat
const repliedContactsMap = new Map();

if (fs.existsSync(repliedContactsFile)) {
    try {
        const rawData = fs.readFileSync(repliedContactsFile, 'utf-8');
        const parsed = JSON.parse(rawData);
        if (Array.isArray(parsed)) {
            parsed.forEach(item => {
                if (item && item.id) {
                    repliedContactsMap.set(item.id, item);
                    if (item.phone) {
                        repliedContactsMap.set(item.phone, item);
                        if (item.lid) {
                            lidToPhoneMap.set(item.lid, item.phone);
                            phoneToLidMap.set(item.phone, item.lid);
                        }
                    }
                }
            });
        }
    } catch (e) {
        console.error('[Storage Error]:', e.message);
    }
}

let saveTimer = null;
function persistRepliedContacts() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const uniqueList = Array.from(new Set(repliedContactsMap.values()));
            fs.writeFileSync(repliedContactsFile, JSON.stringify(uniqueList, null, 2));
            persistLidMappings();
        } catch (e) {
            console.error('[Storage Save Error]:', e.message);
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
// HELPER PARSER & REVERSE RESOLVER (LID ➔ NOMOR TELEPON ASLI)
// =========================================================================
function formatPhoneNumber(raw) {
    if (!raw && raw !== 0) return '';
    let p = String(raw).trim().replace(/\D/g, '');
    if (p.startsWith('0')) p = '62' + p.substring(1);
    else if (p.startsWith('8')) p = '62' + p;
    return p;
}

// Ekstraksi nomor telepon asli jika tersedia di payload pesan Baileys
function extractPhoneFromMessage(msg) {
    if (!msg) return null;
    const candidates = [
        msg.key?.participantPn,
        msg.participantPn,
        msg.key?.remoteJidAlt,
        msg.key?.addressingIdentity?.phone
    ];
    for (const c of candidates) {
        if (c && typeof c === 'string') {
            const clean = c.replace(/@.*$/, '').replace(/\D/g, '');
            if (clean.startsWith('62') || clean.startsWith('08') || clean.startsWith('8')) {
                return formatPhoneNumber(clean);
            }
        }
    }
    return null;
}

// Query Server WhatsApp (USYNC IQ & Signal Repository) untuk Mengonversi LID ➔ Nomor HP
async function resolvePhoneFromLid(sock, rawLid) {
    const cleanLid = String(rawLid).replace(/@lid$/i, '').replace(/\D/g, '');
    if (!cleanLid || cleanLid.length < 10) return null;

    if (lidToPhoneMap.has(cleanLid)) {
        return lidToPhoneMap.get(cleanLid);
    }

    // 1. Coba baca dari Signal Repository lokal Baileys
    try {
        if (sock?.signalRepository?.lidToJid) {
            const jidResult = await sock.signalRepository.lidToJid(`${cleanLid}@lid`);
            if (jidResult) {
                const phone = formatPhoneNumber(jidResult);
                if (phone && phone.length >= 9 && phone.length <= 15) {
                    lidToPhoneMap.set(cleanLid, phone);
                    phoneToLidMap.set(phone, cleanLid);
                    persistLidMappings();
                    return phone;
                }
            }
        }
    } catch (e) {}

    // 2. Query USYNC ke Server WhatsApp
    try {
        const usyncNode = {
            tag: 'iq',
            attrs: {
                to: 's.whatsapp.net',
                type: 'get',
                xmlns: 'usync',
            },
            content: [
                {
                    tag: 'usync',
                    attrs: {
                        sid: `usync-rev-${Date.now()}`,
                        mode: 'query',
                        last: 'true',
                        index: '0',
                        context: 'interactive',
                    },
                    content: [
                        {
                            tag: 'query',
                            attrs: {},
                            content: [
                                { tag: 'contact', attrs: {} },
                                { tag: 'phone', attrs: {} }
                            ]
                        },
                        {
                            tag: 'list',
                            attrs: {},
                            content: [
                                {
                                    tag: 'user',
                                    attrs: { jid: `${cleanLid}@lid` }
                                }
                            ]
                        }
                    ]
                }
            ]
        };

        const res = await sock.query(usyncNode);
        if (res && res.content) {
            const extractPhoneNode = (node) => {
                if (!node) return null;
                if (node.attrs && (node.attrs.phone || node.attrs.jid)) {
                    const raw = node.attrs.phone || node.attrs.jid;
                    const p = formatPhoneNumber(raw);
                    if (p && p.length >= 9 && p.length <= 15) return p;
                }
                if (Array.isArray(node.content)) {
                    for (const c of node.content) {
                        const found = extractPhoneNode(c);
                        if (found) return found;
                    }
                }
                return null;
            };

            const resolved = extractPhoneNode(res);
            if (resolved) {
                lidToPhoneMap.set(cleanLid, resolved);
                phoneToLidMap.set(resolved, cleanLid);
                persistLidMappings();
                return resolved;
            }
        }
    } catch (e) {}

    return null;
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
        targetJid = `${formatPhoneNumber(cleanId)}@s.whatsapp.net`;
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

            // Verifikasi Hak Akses Boss (Bisa via Nomor WA atau Akun LID 165837881213080)
            const isBoss = (
                senderInfo.targetJid === bossConfig.bossNumber ||
                senderInfo.id === "6282299588447" ||
                senderInfo.id === bossConfig.bossLid ||
                senderInfo.id === "165837881213080" ||
                senderInfo.targetJid === `${bossConfig.bossLid}@lid` ||
                senderInfo.targetJid === "165837881213080@lid"
            );

            // Alamat notifikasi ke Boss
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
                            `* !balas <No WA / JID / LID> <pesan>* - 💬 Balas chat klien via bot\n` +
                            `  _Contoh: !balas 6285256739684@s.whatsapp.net Halo kak ready ya_\n` +
                            `  _Atau: !balas 6285256739684 Halo kak ready ya_\n` +
                            `* !mylid* - 🔍 Cek status identitas LID WhatsApp Anda\n` +
                            `* !checkclient* - 📋 Cek seluruh kontak klien tersimpan\n` +
                            `* !clearclient* - 🗑️ Hapus riwayat database kontak`;

                        await sock.sendMessage(senderInfo.targetJid, { text: menuText }, { quoted: msg });
                        return;

                    case 'mylid':
                        const subCmd = args[0] ? args[0].toLowerCase() : '';
                        if (subCmd === 'set' || subCmd === 'boss') {
                            bossConfig.bossLid = senderInfo.id;
                            saveBossConfig();
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `👑 *LID Boss Berhasil Diperbarui:*\n\`${senderInfo.id}@lid\``
                            }, { quoted: msg });
                            return;
                        }

                        const myInfo = `🔍 *DATA IDENTITAS WHATSAPP*\n\n` +
                            `👤 *Nama:* ${pushName}\n` +
                            `🆔 *ID:* \`${senderInfo.id}\`\n` +
                            `📡 *Target JID:* \`${senderInfo.targetJid}\`\n` +
                            `🛡️ *Status Boss:* ${isBoss ? '✅ Terverifikasi' : '❌ Bukan Boss'}\n` +
                            `📌 *LID Boss Aktif:* \`${bossConfig.bossLid}\``;

                        await sock.sendMessage(senderInfo.targetJid, { text: myInfo }, { quoted: msg });
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
                                text: `⚠️ *Format salah!*\n\nGunakan:\n*!balas <No WA / JID> <pesan>*\n\nContoh:\n*!balas 6285256739684@s.whatsapp.net Boleh kak ready ya*\natau\n*!balas 6285256739684 Boleh kak ready ya*`
                            }, { quoted: msg });
                            return;
                        }

                        const rawTarget = args.shift().trim();
                        const replyContent = args.join(' ').trim();

                        // =========================================================
                        // CONVERTER TARGET JID: OTOMATIS UBAH LID KE NO WA RESMI
                        // =========================================================
                        let cleanTargetDigits = rawTarget.replace(/\D/g, '');

                        // Perbaiki anomali jika ada awalan 62 yang tidak sengaja tertempel ke LID
                        if (cleanTargetDigits.startsWith('62') && cleanTargetDigits.length >= 16) {
                            const trimmed = cleanTargetDigits.substring(2);
                            if (lidToPhoneMap.has(trimmed) || repliedContactsMap.has(trimmed)) {
                                cleanTargetDigits = trimmed;
                            }
                        }

                        let targetClientJid = '';

                        // 1. Jika Boss langsung mengetik format @s.whatsapp.net
                        if (rawTarget.toLowerCase().endsWith('@s.whatsapp.net')) {
                            const phoneOnly = formatPhoneNumber(cleanTargetDigits);
                            targetClientJid = `${phoneOnly}@s.whatsapp.net`;
                        }
                        // 2. Jika target adalah nomor HP seluler biasa (10-13 digit)
                        else if (!rawTarget.toLowerCase().endsWith('@lid') && cleanTargetDigits.length >= 9 && cleanTargetDigits.length <= 13) {
                            const phoneOnly = formatPhoneNumber(cleanTargetDigits);
                            targetClientJid = `${phoneOnly}@s.whatsapp.net`;
                        }
                        // 3. Jika target adalah LID (panjang digit >= 14 atau berakhiran @lid), konversi otomatis ke JID HP
                        else {
                            let resolvedPhone = lidToPhoneMap.get(cleanTargetDigits) || repliedContactsMap.get(cleanTargetDigits)?.phone;

                            if (!resolvedPhone) {
                                resolvedPhone = await resolvePhoneFromLid(sock, cleanTargetDigits);
                            }

                            if (resolvedPhone) {
                                targetClientJid = `${resolvedPhone}@s.whatsapp.net`;
                                console.log(`[CONVERT BERHASIL] LID ${cleanTargetDigits} dikonversi ke JID ${targetClientJid}`);
                            } else if (rawTarget.toLowerCase().endsWith('@lid')) {
                                targetClientJid = `${cleanTargetDigits}@lid`;
                            } else {
                                targetClientJid = `${cleanTargetDigits}@s.whatsapp.net`;
                            }
                        }

                        try {
                            await sock.sendPresenceUpdate('composing', targetClientJid);
                            await new Promise(res => setTimeout(res, 800));

                            // Kirim langsung ke WhatsApp klien
                            await sock.sendMessage(targetClientJid, { text: replyContent });

                            await sock.sendPresenceUpdate('paused', targetClientJid);

                            // Laporan sukses ke Boss
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `✅ *PESAN TERKIRIM KE KLIEN*\n\n` +
                                    `🎯 *Tujuan JID:* \`${targetClientJid}\`\n` +
                                    `💬 *Isi Pesan:* "${replyContent}"\n` +
                                    `🕒 *Waktu:* ${getFormattedDateTime()}`
                            }, { quoted: msg });

                            console.log(`[BALAS SUKSES] Pesan Boss berhasil sampai di ${targetClientJid}`);
                        } catch (errBalas) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `❌ *Gagal Mengirim ke \`${targetClientJid}\`:*\n${errBalas.message}`
                            }, { quoted: msg });
                        }
                        return;

                    case 'checkclient':
                        if (repliedContactsMap.size === 0) {
                            await sock.sendMessage(senderInfo.targetJid, {
                                text: `ℹ️ *Belum ada data klien yang tersimpan.*`
                            }, { quoted: msg });
                            return;
                        }

                        const uniqueEntries = Array.from(new Set(repliedContactsMap.values()));
                        let clientListText = `📋 *DAFTAR KLIEN TERSIMPAN (${uniqueEntries.length} Kontak)*\n\n`;
                        let index = 1;

                        for (const data of uniqueEntries) {
                            clientListText += `${index++}. *${data.name}*\n` +
                                `   📱 No WA: ${data.phone ? `*${data.phone}*` : '_(Belum ter-resolve)_'}\n` +
                                `   🆔 LID: \`${data.lid || data.id}\`\n` +
                                `   🕒 Masuk: ${data.date}\n\n`;
                        }

                        await sock.sendMessage(senderInfo.targetJid, { text: clientListText.trim() }, { quoted: msg });
                        return;

                    case 'clearclient':
                        const totalCleared = repliedContactsMap.size;
                        repliedContactsMap.clear();
                        lidToPhoneMap.clear();
                        phoneToLidMap.clear();

                        try {
                            if (fs.existsSync(repliedContactsFile)) fs.writeFileSync(repliedContactsFile, JSON.stringify([], null, 2));
                            if (fs.existsSync(lidCacheFile)) fs.writeFileSync(lidCacheFile, JSON.stringify({}, null, 2));
                        } catch (errClear) {}

                        await sock.sendMessage(senderInfo.targetJid, {
                            text: `✅ *BERHASIL DIRESET!*\n\nSemua riwayat kontak dan cache LID telah dibersihkan.`
                        }, { quoted: msg });
                        return;

                    default:
                        break;
                }
            }

            // Abaikan pesan biasa dari Boss agar tidak meneruskan chat diri sendiri
            if (isBoss) return;

            const trackingKey = senderInfo.id;
            const incomingTime = getFormattedDateTime();
            const previewMessage = incomingText.trim() ? incomingText.trim() : `_(Klien mengirim Media/Lampiran)_`;

            // =====================================================================
            // DETEKSI & KONVERSI IDENTITAS KLIEN (LID ➔ NOMOR TELEPON)
            // =====================================================================
            let detectedPhone = '';
            if (senderInfo.isLid) {
                // Ekstraksi dari metadata pesan
                detectedPhone = extractPhoneFromMessage(msg);
                // Jika belum ada, lakukan query USYNC server
                if (!detectedPhone) {
                    detectedPhone = await resolvePhoneFromLid(sock, senderInfo.id);
                }
            } else {
                detectedPhone = formatPhoneNumber(senderInfo.id);
            }

            const clientDataObj = {
                id: senderInfo.id,
                name: pushName,
                lid: senderInfo.isLid ? senderInfo.id : (phoneToLidMap.get(detectedPhone) || ''),
                phone: detectedPhone || '',
                jid: detectedPhone ? `${detectedPhone}@s.whatsapp.net` : senderInfo.targetJid,
                date: incomingTime
            };

            // Simpan pemetaan identitas
            if (detectedPhone && senderInfo.isLid) {
                lidToPhoneMap.set(senderInfo.id, detectedPhone);
                phoneToLidMap.set(detectedPhone, senderInfo.id);
                persistLidMappings();
            }

            // Template balasan langsung menggunakan nomor telepon asli jika sudah ditemukan
            const directReplyTarget = detectedPhone 
                ? `${detectedPhone}@s.whatsapp.net` 
                : senderInfo.targetJid;

            // =====================================================================
            // 2. KLIEN LAMA: FORWARD PESAN BALASAN KE BOSS
            // =====================================================================
            if (repliedContactsMap.has(trackingKey) || (detectedPhone && repliedContactsMap.has(detectedPhone))) {
                const existing = repliedContactsMap.get(trackingKey) || repliedContactsMap.get(detectedPhone);
                if (pushName && pushName !== 'Klien') existing.name = pushName;
                if (detectedPhone) existing.phone = detectedPhone;
                persistRepliedContacts();

                console.log(`[FORWARD CHAT] Balasan dari klien: ${pushName} (JID: ${directReplyTarget})`);

                try {
                    let forwardText = `💬 *BALASAN DARI KLIEN* 💬\n\n` +
                        `👤 *Nama Klien:* ${pushName}\n`;

                    if (detectedPhone) {
                        forwardText += `📱 *Nomor WA:* ${detectedPhone}\n` +
                            `🔗 *Link WA:* https://wa.me/${detectedPhone}\n`;
                    }
                    if (senderInfo.isLid) {
                        forwardText += `🆔 *LID:* \`${senderInfo.id}@lid\`\n`;
                    }

                    forwardText += `🕒 *Waktu:* ${incomingTime}\n` +
                        `💬 *Isi Pesan:*\n"${previewMessage}"\n\n` +
                        `-----------------------------------------\n` +
                        `👉 *Balas Cepat (Salin & Tempel):*\n` +
                        `*!balas ${directReplyTarget} <isi pesan>*`;

                    await sock.sendMessage(targetBossNotification, { text: forwardText });
                    console.log(`[FORWARD SUKSES] Diteruskan ke Boss.`);
                } catch (errFwd) {
                    console.error('[Gagal Forward]:', errFwd.message);
                }
                return;
            }

            // =====================================================================
            // 3. KLIEN BARU: BALAS PERDANA DENGAN GAMBAR & LAPORKAN KE BOSS
            // =====================================================================
            console.log(`[KLIEN BARU] Chat perdana dari ${pushName} (${senderInfo.targetJid})`);

            repliedContactsMap.set(trackingKey, clientDataObj);
            if (detectedPhone) repliedContactsMap.set(detectedPhone, clientDataObj);
            persistRepliedContacts();

            // Kirim gambar dan pesan pembuka ke nomor klien
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

            // Kirim laporan ke WhatsApp Boss
            try {
                let notifBoss = `🔔 *NOTIFIKASI KLIEN BARU MASUK* 🔔\n\n` +
                    `👤 *Nama Klien:* ${pushName}\n`;

                if (detectedPhone) {
                    notifBoss += `📱 *Nomor WA:* ${detectedPhone}\n` +
                        `🔗 *Link WA:* https://wa.me/${detectedPhone}\n`;
                }
                if (senderInfo.isLid) {
                    notifBoss += `🆔 *LID Pengirim:* \`${senderInfo.id}@lid\`\n`;
                }

                notifBoss += `🕒 *Waktu Chat:* ${incomingTime}\n` +
                    `💬 *Pesan Pertama:* "${previewMessage}"\n\n` +
                    `_Pesan sambutan Umi Dien telah otomatis dikirimkan._ ✅\n\n` +
                    `-----------------------------------------\n` +
                    `👉 *Balas Cepat (Salin & Tempel):*\n` +
                    `*!balas ${directReplyTarget} <isi pesan>*`;

                await sock.sendMessage(targetBossNotification, { text: notifBoss });
                console.log(`[NOTIFIKASI BOSS] Laporan klien baru terkirim.`);
            } catch (errBoss) {
                console.error('[Gagal Notif Boss]:', errBoss.message);
            }

        } catch (error) {
            console.error('[Error Handler Chat]:', error);
        }
    });
}
