import process from 'process';
import os from 'os';

// Jika Anda masih menyimpan command eksternal, biarkan import ini
import handleAiCommand from './commands/ai.js';
import handleStickerCommand from './commands/sticker.js';

// ====================================================================
// 🚀 KONFIGURASI REST API GATEWAY & DATABASE CLOUD DEPT. RKG
// ====================================================================
// Base URL REST API Next.js Anda (Rute route.ts yang baru digabungkan)
const RKG_API_BASE_URL = process.env.RKG_API_URL || "https://absensi.maksaarsyad.xyz/api/wa";

// ====================================================================
// 🗄️ REDIS CLIENT (UNTUK BACA DATA SCHEDULING DARI CLOUD)
// ====================================================================
class Redis {
    constructor(config) {
        this.url = config.url || '';
        this.token = config.token || '';
        if (this.url.endsWith('/')) this.url = this.url.slice(0, -1);
    }
    
    static fromEnv() {
        let url = process.env.NEXT_PUBLIC_UPSTASH_REDIS_REST_URL || process.env.NEXT_PUBLIC_KV_REST_API_URL || '';
        let token = process.env.NEXT_PUBLIC_UPSTASH_REDIS_REST_TOKEN || process.env.NEXT_PUBLIC_KV_REST_API_TOKEN || '';
        return new Redis({ url, token });
    }

    async get(key) {
        if (!this.url || !this.token) return null;
        try {
            const res = await fetch(this.url, { 
                method: 'POST',
                headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify(["GET", key]), 
                cache: 'no-store' 
            });
            if (!res.ok) throw new Error('Fetch failed');
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (data.result === null || data.result === undefined) return null;
            try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } 
            catch (e) { return data.result; }
        } catch (e) { return null; }
    }

    async set(key, value) {
        if (!this.url || !this.token) return;
        try {
            const strVal = typeof value === 'string' ? value : JSON.stringify(value);
            const res = await fetch(this.url, { 
                method: 'POST', 
                headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify(["SET", key, strVal]) 
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            return data;
        } catch (e) { throw e; }
    }
}

// ====================================================================
// 📁 FORMATTER UTILITIES
// ====================================================================
function formatWaNumber(id) {
    if (!id) return "";
    let p = String(id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.slice(1);
    else if (p.startsWith('8')) p = '62' + p;
    return p;
}

function getRelativeTime(seconds) {
    const m = Math.floor(seconds / 60); const h = Math.floor(seconds / 3600); const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d} hari yang lalu`; if (h > 0) return `${h} jam yang lalu`; if (m > 0) return `${m} menit yang lalu`;
    return `${Math.floor(seconds)} detik yang lalu`;
}

// Helper Tanggal Local (WITA / Asia/Makassar)
function getWitaTime() {
    const d = new Date();
    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    return new Date(utc + (3600000 * 8)); // +8 hours untuk WITA
}

const getLocalYYYYMMDD = (dateInput) => {
    const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// Fungsi helper penembak REST API dari dalam Cron Job
const triggerWA_API = async (noHp, scenarioId, payloadData) => {
    if (!noHp) return;
    try {
        await fetch(RKG_API_BASE_URL, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ no_hp: noHp, scenario: scenarioId, data: payloadData })
        });
    } catch(e) { 
        console.error(`[Cron Trigger Error] Gagal memanggil API untuk Skenario ${scenarioId}:`, e.message); 
    }
};

// --- AKHIR BAGIAN 1 ---
