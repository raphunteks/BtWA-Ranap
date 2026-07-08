import fs from 'fs';
import process from 'process';
import os from 'os';

import { generateWAMessageFromContent } from '@whiskeysockets/baileys'; 

// Handler perintah eksternal (Sticker & AI tetap dipertahankan)
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

const ownerNumber = process.env.OWNER_NUMBER || "6285256739684@s.whatsapp.net";

// 🚀 API FILTER BY CAN (Sesuai dengan Deploy Web App GAS Terbaru)
const FILTER_API_URL = process.env.FILTER_API_URL || "https://script.google.com/macros/s/AKfycbxS9GzjYgnegsamBeD7OTaKuEuK8VntMTPXeX6p-Q4psRy96XAecNZs3T9-9RXe8r9-/exec";

// ====================================================================
// 📁 SESSION & MULTI-ADMIN LOGIC
// ====================================================================
const sessionPath = './session';
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log("[System] Folder session dibuat.");
}

const adminsFile = `${sessionPath}/admins.json`;

// 🚀 ADMIN BARU TELAH DITAMBAHKAN
let botAdmins = [ownerNumber, "6282122224408@s.whatsapp.net"]; 

if (fs.existsSync(adminsFile)) {
    try { 
        let savedAdmins = JSON.parse(fs.readFileSync(adminsFile, 'utf-8')); 
        botAdmins = [...new Set([...botAdmins, ...savedAdmins])];
    } catch(e){}
} else {
    fs.writeFileSync(adminsFile, JSON.stringify(botAdmins));
}

function saveAdmins() {
    fs.writeFileSync(adminsFile, JSON.stringify(botAdmins, null, 2));
}

function formatPhoneToJid(phone) {
    if (phone.endsWith('@lid') || phone.endsWith('@s.whatsapp.net') || phone.endsWith('@g.us')) return phone;
    let p = phone.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    if (p.startsWith('8')) p = '62' + p;
    return p + "@s.whatsapp.net";
}

// 🚀 HYBRID BROADCASTER (Teks Selalu Dikirim Dulu, Tombol Menyusul)
async function broadcastToAdmins(sock, textPayload, interactivePayload = null) {
    for (const adminId of botAdmins) {
        try { 
            // 1. Kirim Teks Manual
            if (typeof textPayload === 'string') { 
                await sock.sendMessage(adminId, { text: textPayload }); 
            } else {
                await sock.sendMessage(adminId, textPayload); 
            }

            // 2. Susulkan Tombol Interaktif
            if (interactivePayload) {
                try {
                    const msgContent = generateWAMessageFromContent(adminId, {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                                interactiveMessage: interactivePayload
                            }
                        }
                    }, { userJid: sock.user?.id || sock.user?.jid });

                    await sock.relayMessage(adminId, msgContent.message, { messageId: msgContent.key.id });
                } catch (err) {
                    console.log(`[System] Tombol interaktif gagal untuk ${adminId}`);
                }
            }
        } catch(err){}
    }
}

// ====================================================================
// 🚀 MAIN HANDLER & POLLER E-COMMERCE
// ====================================================================
const notifiedOrders = new Set();
const pendingOrdersMap = new Map(); // Memori Penyimpanan { trxId: waCustomer }

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} days ago`; if (h > 0) return `${h} hours ago`; if (m > 0) return `${m} minutes ago`;
    return `${Math.floor(seconds)} seconds ago`;
}

export default async function setupMessageHandler(sock) {
    console.log("[System] BOT FILTER BY CAN Handler Aktif!");

    // ====================================================================
    // 🌐 POLLER ORDERAN BARU (Cek Setiap 15 Detik)
    // ====================================================================
    setInterval(async () => {
        try {
            const response = await fetch(`${FILTER_API_URL}?action=bot_get_pending`);
            const result = await response.json();

            if (result && result.length > 0) {
                for (const order of result) {
                    if (!notifiedOrders.has(order.trxId)) {
                        notifiedOrders.add(order.trxId);

                        // Format Nomor WA Customer
                        let hpClean = order.wa.replace(/[^0-9]/g, '');
                        if (hpClean.startsWith('0')) hpClean = '62' + hpClean.substring(1);
                        const customerJid = hpClean + "@s.whatsapp.net";
                        
                        // Simpan sementara di memori bot untuk pengiriman link GDrive nanti
                        pendingOrdersMap.set(order.trxId, customerJid);

                        const totalFmt = parseInt(order.grandTotal).toLocaleString('id-ID');
                        
                        const primaryText = `🛍️ *ORDERAN FILTER BARU* 🛍️\n\n🆔 *Trx ID:* ${order.trxId}\n👤 *Nama:* ${order.nama}\n📱 *WhatsApp:* wa.me/${hpClean}\n💰 *Total Bayar:* Rp${totalFmt}\n🛒 *Pesanan:*\n${order.detail}\n\n📄 *Cek Bukti TF:*\n${order.buktiTf || "Belum ada link"}\n\n*Aksi Konfirmasi:* Ketik perintah atau tekan tombol di bawah!\n_${order.commandKonfir}_`;
                        
                        const shortcutButton = {
                            body: { text: `Tekan tombol konfirmasi di bawah ini untuk mengirim Link Filter ke WhatsApp pembeli secara otomatis:` },
                            footer: { text: "Filter By Can Bot" },
                            nativeFlowMessage: {
                                buttons: [
                                    {
                                        name: "quick_reply",
                                        buttonParamsJson: JSON.stringify({
                                            display_text: "✅ Konfir & Kirim Link",
                                            id: order.commandKonfir
                                        })
                                    }
                                ]
                            }
                        };
                        
                        await broadcastToAdmins(sock, primaryText, shortcutButton);
                    }
                }
            }
        } catch (err) {
            // Abaikan error jaringan saat polling
        }
    }, 15000);

    // ====================================================================
    // 💬 MESSAGE LISTENER & COMMANDS
    // ====================================================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            // Tangkap Input dari Tombol Interaktif atau Teks Manual
            let text = '';
            if (msg.message.conversation) text = msg.message.conversation;
            else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
            else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;
            else if (msg.message.videoMessage?.caption) text = msg.message.videoMessage.caption;
            else if (msg.message.listResponseMessage?.singleSelectReply?.selectedRowId) text = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
            else if (msg.message.buttonsResponseMessage?.selectedButtonId) text = msg.message.buttonsResponseMessage.selectedButtonId;
            else if (msg.message.templateButtonReplyMessage?.selectedId) text = msg.message.templateButtonReplyMessage.selectedId;
            else if (msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
                try { 
                    let params = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson); 
                    text = params.id || ''; 
                } catch(e) {}
            }
                         
            const prefix = '!'; 
            if (!text || !text.startsWith(prefix)) return;

            const args = text.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            
            const replyJid = msg.key.remoteJid; 
            let senderJid = msg.key.remoteJid; 
            if (senderJid.endsWith('@g.us')) senderJid = msg.key.participant || senderJid;
            if (senderJid.includes(':')) senderJid = senderJid.substring(0, senderJid.indexOf(':')) + '@s.whatsapp.net';
            if (senderJid.endsWith('@lid') && msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
                senderJid = msg.key.remoteJid;
                if (senderJid.includes(':')) senderJid = senderJid.substring(0, senderJid.indexOf(':')) + '@s.whatsapp.net';
            }

            const isAdmin = botAdmins.includes(senderJid);
            
            // 🚀 PROTEKSI COMMAND ADMIN 
            const adminCommands = ['addadmin', 'deladmin', 'listadmin', 'restart'];
            if (command.startsWith('konfir')) adminCommands.push(command); // Kunci perintah konfirmasi
            
            if (adminCommands.includes(command) && !isAdmin) {
                return await sock.sendMessage(replyJid, { text: "⚠️ *Akses Ditolak*\nMaaf, perintah tersebut khusus untuk Admin sistem." }, { quoted: msg });
            }

            console.log(`[COMMAND] ${command} dieksekusi oleh: ${senderJid} (Admin: ${isAdmin})`);

            switch (command) {
                case 'restart':
                    await sock.sendMessage(replyJid, { text: "🔄 *Restarting Bot...*\nSistem sedang dimuat ulang." }, { quoted: msg });
                    setTimeout(() => { process.exit(1); }, 2000);
                    break;

                // 🚀 HYBRID MENU (CLEANED UP & FOCUSED)
                case 'menu':
                case 'help':
                    if (args[0] === 'ai') { return await sock.sendMessage(replyJid, { text: "🤖 *Cara Pakai AI:*\nKetik *!ai <pertanyaan>*\nContoh: !ai Apa itu filter cinematic?" }, { quoted: msg }); }
                    if (args[0] === 'sticker') { return await sock.sendMessage(replyJid, { text: "🖼️ *Cara Bikin Sticker:*\nKirimkan gambar dengan caption *!s* atau balas sebuah gambar dengan *!s*" }, { quoted: msg }); }

                    let manualMenuText = `🤖 *MENU BOT FILTER BY CAN* 🤖\n\n`;
                    if (isAdmin) {
                        manualMenuText += `*🛒 E-COMMERCE (Admin):*\n> !konfir-<ID>\n\n` +
                        `*⚙️ PENGATURAN (Admin):*\n> !addadmin <ID>\n> !deladmin <ID>\n> !listadmin\n> !restart\n\n`;
                    }
                    manualMenuText += `*✨ AI & UTILITIES:*\n> !ai <pertanyaan>\n> !s (buat stiker)\n> !myid\n> !runtime\n> !ping`;

                    await sock.sendMessage(replyJid, { text: manualMenuText }, { quoted: msg });

                    const menuSections = [];
                    if (isAdmin) {
                        menuSections.push({ title: "⚙️ PENGATURAN ADMIN", rows: [
                            { title: "👥 Daftar Admin", description: "Lihat siapa saja Admin Bot", id: "!listadmin" },
                            { title: "🔄 Restart Bot", description: "Muat ulang sistem server bot", id: "!restart" }
                        ]});
                    }
                    menuSections.push({ title: "✨ AI & MEDIA", rows: [{ title: "🤖 Cara Pakai AI", description: "Bantuan chat AI", id: "!help ai" }, { title: "🖼️ Cara Bikin Sticker", description: "Bantuan stiker WA", id: "!help sticker" }] });
                    menuSections.push({ title: "🛠️ INFO UTILITIES", rows: [{ title: "ℹ️ Cek ID Saya", description: "Untuk menambahkan Admin", id: "!myid" }, { title: "📈 Status Server", description: "Cek Kecepatan & Uptime Bot", id: "!runtime" }] });

                    const interactiveMenu = {
                        body: { text: `_Atau gunakan menu pintar di bawah untuk navigasi cepat:_` },
                        footer: { text: "Filter By Can Bot" },
                        nativeFlowMessage: {
                            buttons: [{
                                name: "single_select",
                                buttonParamsJson: JSON.stringify({ title: "Buka Menu Utama", sections: menuSections })
                            }]
                        }
                    };
                    
                    try {
                        const msgContent = generateWAMessageFromContent(replyJid, {
                            viewOnceMessage: {
                                message: {
                                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                                    interactiveMessage: interactiveMenu
                                }
                            }
                        }, { userJid: sock.user?.id || sock.user?.jid });

                        await sock.relayMessage(replyJid, msgContent.message, { messageId: msgContent.key.id });
                    } catch (err) {}
                    break;

                case 'myid': case 'cekid':
                    await sock.sendMessage(replyJid, { text: `*ℹ️ INFORMASI ID ANDA*\n\n*ID Pengirim:* \n${senderJid}\n\n_Ingin didaftarkan sebagai admin? Copy *ID Pengirim* di atas dan berikan ke Owner._\n\n_Owner dapat menambahkannya dengan cara:_\n*!addadmin ${senderJid}*` }, { quoted: msg });
                    break;

                case 'ping':
                    const pingProcess = Date.now() - (msg.messageTimestamp * 1000);
                    await sock.sendMessage(replyJid, { text: `🏓 *Pong!*\n⚡ *Kecepatan Response:* ${pingProcess} ms` }, { quoted: msg }); 
                    break;
                    
                case 'runtime':
                    const uptime = process.uptime();
                    await sock.sendMessage(replyJid, { text: `⏳ *Bot Uptime:* ${getRelativeTime(uptime)}\n🖥️ *OS Memory:* ${Math.round(os.freemem()/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB` }, { quoted: msg });
                    break;
                
                case 'ai': if(typeof handleAiCommand === 'function') await handleAiCommand(sock, msg, args); break;
                case 'sticker': case 's': if(typeof handleStickerCommand === 'function') await handleStickerCommand(sock, msg); break;

                case 'addadmin':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!addadmin 628xxx*" });
                    const newAdmin = formatPhoneToJid(args[0]);
                    if (!botAdmins.includes(newAdmin)) {
                        botAdmins.push(newAdmin); saveAdmins();
                        await sock.sendMessage(replyJid, { text: `✅ Berhasil! Nomor ${newAdmin} sukses ditambahkan sebagai Admin.` }, { quoted: msg });
                    } else await sock.sendMessage(replyJid, { text: `⚠️ Nomor tersebut sudah menjadi admin.` }, { quoted: msg });
                    break;

                case 'deladmin':
                    if (!args[0]) return await sock.sendMessage(replyJid, { text: "⚠️ Format: *!deladmin 628xxx*" });
                    const delTarget = formatPhoneToJid(args[0]);
                    if (delTarget === ownerNumber || delTarget === "6282122224408@s.whatsapp.net") return await sock.sendMessage(replyJid, { text: "❌ Anda tidak bisa menghapus ID Utama/Developer." });
                    if (botAdmins.includes(delTarget)) {
                        botAdmins = botAdmins.filter(a => a !== delTarget); saveAdmins();
                        await sock.sendMessage(replyJid, { text: `✅ Berhasil! Nomor ${delTarget} sukses dicabut hak Admin-nya.` }, { quoted: msg });
                    } else await sock.sendMessage(replyJid, { text: `⚠️ Nomor tidak ditemukan dalam daftar admin.` }, { quoted: msg });
                    break;

                case 'listadmin':
                    let adList = "👥 *DAFTAR ADMIN FILTER BY CAN*\n\n";
                    botAdmins.forEach((a, i) => adList += `${i+1}. ${a.split('@')[0]}\n`);
                    await sock.sendMessage(replyJid, { text: adList }, { quoted: msg });
                    break;

                default:
                    // 🚀 LOGIKA INTI: KONFIRMASI DAN PENGIRIMAN LINK GDRIVE OTOMATIS 🚀
                    // Menangkap "!konfir DAZZ-0001" ataupun "!konfir-DAZZ-0001"
                    if (command === 'konfir' || command.startsWith('konfir-')) {
                        let trxId = '';
                        if (command === 'konfir') {
                            trxId = args[0] ? args[0].toUpperCase() : '';
                        } else if (command.startsWith('konfir-')) {
                            trxId = command.replace('konfir-', '').toUpperCase();
                        }

                        if (!trxId) return await sock.sendMessage(replyJid, { text: "⚠️ *Format Salah.* Gunakan format: *!konfir-DAZZ-0001*" }, { quoted: msg });
                        
                        await sock.sendMessage(replyJid, { text: `⏳ _Memproses konfirmasi dan menarik link GDrive dari Database untuk ID ${trxId}..._` }, { quoted: msg });
                        
                        try {
                            const response = await fetch(`${FILTER_API_URL}?action=bot_get_links&trxId=${trxId}`);
                            const result = await response.json();
                            
                            if (result.error) {
                                return await sock.sendMessage(replyJid, { text: `❌ *Gagal:* ${result.error}\nPastikan ID Transaksi benar.` }, { quoted: msg });
                            }

                            const customerJid = pendingOrdersMap.get(trxId);
                            
                            if (!customerJid) {
                                // Jika bot baru di-restart sehingga memori hilang
                                return await sock.sendMessage(replyJid, { text: `⚠️ *WA Customer tidak ada di memori Bot!*\nServer Bot sepertinya baru direstart. Silakan teruskan (forward) pesan ini secara manual kepada pembeli.\n\n*Link Produk:*\n${result.links.map(l => `📦 ${l.nama}\n🔗 ${l.linkGdrive}`).join('\n\n')}` }, { quoted: msg });
                            }

                            // 📩 SUSUN PESAN UNTUK CUSTOMER
                            let custMsg = `Halo Kak! 👋\nTerima kasih telah berbelanja di *FILTER BY CAN*.\n\nPembayaran untuk Order *${trxId}* telah kami konfirmasi! 🎉\n\nBerikut adalah link akses Google Drive untuk mendownload filter pesanan Kakak:\n\n`;
                            
                            result.links.forEach((l, i) => {
                                custMsg += `*${i+1}. ${l.nama}*\n🔗 Link: ${l.linkGdrive}\n\n`;
                            });

                            custMsg += `_PENTING: Jangan bagikan link ini ke orang lain, file dilindungi hak cipta & akses terpantau oleh admin._\n\nJika ada kendala saat pemakaian, silakan balas pesan ini. Selamat mengedit foto jadi lebih keren! ✨`;

                            // Kirim langsung ke WhatsApp Customer
                            await sock.sendMessage(customerJid, { text: custMsg });

                            // Notifikasi Sukses ke Admin
                            await sock.sendMessage(replyJid, { text: `✅ *PENGIRIMAN LINK SUKSES!*\n\nPesanan *${trxId}* selesai dikonfirmasi. Link filter telah otomatis meluncur ke WhatsApp Customer (wa.me/${customerJid.split('@')[0]}).` }, { quoted: msg });

                            // Hapus ID dari memori antrean karena sudah selesai
                            pendingOrdersMap.delete(trxId);

                        } catch (err) { 
                            await sock.sendMessage(replyJid, { text: `❌ *Gagal terhubung ke Database Google API (GAS).*` }, { quoted: msg }); 
                        }
                    }
                    break;
            }
        } catch (error) { console.error('Error proses pesan:', error); }
    });
}