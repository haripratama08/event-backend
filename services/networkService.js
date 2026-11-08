const os = require('os');
const config = require('../config/config');

let cachedTunnelUrl = null;
let tunnelWatcherTimer = null;
let lastDetectedType = 'none';

/**
 * Mendapatkan IP LAN lokal aktif (IPv4 non-internal).
 */
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            // Abaikan 127.0.0.1 dan IPv6
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

/**
 * Mendeteksi tunnel ngrok yang sedang aktif melalui local management API (port 4040).
 */
async function detectNgrokTunnel(apiUrl = process.env.NGROK_API_URL || 'http://127.0.0.1:4040/api/tunnels') {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);
        const res = await fetch(apiUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) return null;
        const data = await res.json();
        if (data && Array.isArray(data.tunnels) && data.tunnels.length > 0) {
            // Utamakan tunnel berprotokol HTTPS
            const httpsTunnel = data.tunnels.find(t => t.proto === 'https' || (t.public_url && t.public_url.startsWith('https://')));
            const chosen = httpsTunnel || data.tunnels[0];
            if (chosen && chosen.public_url) {
                return chosen.public_url.replace(/\/+$/, '');
            }
        }
    } catch (err) {
        // ngrok tidak sedang berjalan pada port 4040
    }
    return null;
}

/**
 * Memperbarui cache URL publik/tunnel secara asinkron.
 * Prioritas:
 * 1. PUBLIC_BASE_URL (dari .env jika diset manual, misal: domain Cloudflare / ngrok custom domain)
 * 2. Auto-Detect ngrok tunnel lokal (port 4040)
 * 3. Fallback: IP LAN lokal
 */
async function refreshTunnelUrl() {
    if (config.PUBLIC_BASE_URL && config.PUBLIC_BASE_URL.trim() !== '') {
        cachedTunnelUrl = config.PUBLIC_BASE_URL.replace(/\/+$/, '');
        lastDetectedType = cachedTunnelUrl.includes('trycloudflare') || cachedTunnelUrl.includes('cloudflare')
            ? 'cloudflare'
            : (cachedTunnelUrl.includes('ngrok') ? 'ngrok' : 'custom_domain');
        return cachedTunnelUrl;
    }

    const ngrokUrl = await detectNgrokTunnel();
    if (ngrokUrl) {
        cachedTunnelUrl = ngrokUrl;
        lastDetectedType = 'ngrok';
        return cachedTunnelUrl;
    }

    cachedTunnelUrl = null;
    lastDetectedType = 'local_ip';
    return null;
}

/**
 * Menentukan Base URL yang digunakan untuk QR Code dan link unduh.
 */
function resolvePublicBaseUrl() {
    // 1. Jika ada di config/env
    if (config.PUBLIC_BASE_URL && config.PUBLIC_BASE_URL.trim() !== '') {
        return config.PUBLIC_BASE_URL.replace(/\/+$/, '');
    }

    // 2. Jika tunnel ngrok terdeteksi
    if (cachedTunnelUrl) {
        return cachedTunnelUrl;
    }

    // 3. Fallback IP LAN Lokal
    const localIp = getLocalIpAddress();
    return `http://${localIp}:${config.PORT}`;
}

/**
 * Membangun URL unduh sesi untuk tamu.
 */
function buildSessionDownloadUrl(sessionId) {
    const baseUrl = resolvePublicBaseUrl();
    return `${baseUrl}/d/${encodeURIComponent(sessionId)}`;
}

/**
 * Memeriksa apakah saat ini sedang menggunakan URL publik/tunnel resmi (bukan IP lokal)
 */
function isTunnelActive() {
    const baseUrl = resolvePublicBaseUrl();
    return baseUrl.startsWith('https://') || baseUrl.includes('ngrok') || baseUrl.includes('cloudflare');
}

/**
 * Memulai watcher berkala untuk mendeteksi tunnel secara otomatis jika dinyalakan belakangan.
 */
function startTunnelWatcher(intervalMs = 4000) {
    if (tunnelWatcherTimer) return;
    refreshTunnelUrl().catch(() => {});
    tunnelWatcherTimer = setInterval(() => {
        refreshTunnelUrl().catch(() => {});
    }, intervalMs);
}

function stopTunnelWatcher() {
    if (tunnelWatcherTimer) {
        clearInterval(tunnelWatcherTimer);
        tunnelWatcherTimer = null;
    }
}

// Mulai watcher background saat modul dimuat
if (process.env.NODE_ENV !== 'test') {
    startTunnelWatcher();
}

module.exports = {
    getLocalIpAddress,
    detectNgrokTunnel,
    refreshTunnelUrl,
    resolvePublicBaseUrl,
    buildSessionDownloadUrl,
    isTunnelActive,
    startTunnelWatcher,
    stopTunnelWatcher,
    getTunnelType: () => lastDetectedType
};
