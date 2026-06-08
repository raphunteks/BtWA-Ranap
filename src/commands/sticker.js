import { downloadMediaMessage } from '@whiskeysockets/baileys';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import { exec } from 'child_process';

export default async function handleStickerCommand(sock, msg) {
    const sender = msg.key.remoteJid;
    
    // Cek apakah pesan adalah gambar atau membalas (reply) gambar
    const isImage = msg.message.imageMessage;
    const isQuotedImage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

    if (!isImage && !isQuotedImage) {
        await sock.sendMessage(sender, { text: '❌ Kirim gambar dengan caption !sticker, atau reply gambar dengan !sticker' }, { quoted: msg });
        return;
    }

    try {
        await sock.sendMessage(sender, { text: '⏳ Sedang membuat stiker...' }, { quoted: msg });

        // Tentukan target pesan mana yang mau di-download (pesan saat ini atau yang di-reply)
        const targetMessage = isQuotedImage ? 
            { message: msg.message.extendedTextMessage.contextInfo.quotedMessage } : 
            msg;

        // Download media menggunakan fungsi bawaan Baileys
        const buffer = await downloadMediaMessage(
            targetMessage,
            'buffer',
            {},
            { logger: console } // opsional
        );

        const inputTemp = `./temp_${Date.now()}.jpeg`;
        const outputTemp = `./temp_${Date.now()}.webp`;

        fs.writeFileSync(inputTemp, buffer);

        // Konversi Gambar ke format WebP (Syarat Stiker WA) menggunakan FFmpeg
        ffmpeg(inputTemp)
            .input(inputTemp)
            .on('error', async (err) => {
                console.error(err);
                fs.unlinkSync(inputTemp);
                await sock.sendMessage(sender, { text: '❌ Gagal mengkonversi gambar.' }, { quoted: msg });
            })
            .on('end', async () => {
                // Kirim stiker
                await sock.sendMessage(sender, { sticker: { url: outputTemp } }, { quoted: msg });
                
                // Bersihkan file sementara
                fs.unlinkSync(inputTemp);
                fs.unlinkSync(outputTemp);
            })
            .addOutputOptions([
                '-vcodec',
                'libwebp',
                '-vf',
                // Perintah untuk menjaga aspek rasio dan membuat background transparan jika diperlukan
                "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse"
            ])
            .toFormat('webp')
            .save(outputTemp);

    } catch (error) {
        console.error('Sticker Error:', error);
        await sock.sendMessage(sender, { text: '❌ Terjadi kesalahan saat membuat stiker.' }, { quoted: msg });
    }
}