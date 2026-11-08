const os = require('os');
const config = require('../config/config');

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
 * Menentukan Base URL yang digunakan untuk QR Code dan link unduh.
 * Prioritas:
 * 1. PUBLIC_BASE_URL (Cloudflare Tunnel / Custom Domain di .env)
 * 2. http://<IP_LAN>:<PORT> (Fallback otomatis agar HP tamu bisa akses di jaringan lokal)
 */
function resolvePublicBaseUrl() {
    if (config.PUBLIC_BASE_URL && config.PUBLIC_BASE_URL.trim() !== '') {
        return config.PUBLIC_BASE_URL.replace(/\/+$/, '');
    }
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

module.exports = {
    getLocalIpAddress,
    resolvePublicBaseUrl,
    buildSessionDownloadUrl
};
