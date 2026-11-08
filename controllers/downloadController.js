const fs = require('fs-extra');
const path = require('path');
const config = require('../config/config');
const { streamSessionZip } = require('../services/zipService');
const logger = require('../services/logger');
const sessionState = require('../state/session');

function getSessionMeta(sessionId, sessionDir) {
    const parsed = sessionState.parseSessionId(sessionId);
    const userName = parsed.userName || 'GUEST';
    let createdAt = null;

    if (parsed.ymd && parsed.time && parsed.ymd.length === 8 && parsed.time.length === 6) {
        const y = parsed.ymd.substring(0, 4);
        const m = parsed.ymd.substring(4, 6);
        const d = parsed.ymd.substring(6, 8);
        const hh = parsed.time.substring(0, 2);
        const mm = parsed.time.substring(2, 4);
        const ss = parsed.time.substring(4, 6);
        createdAt = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
    } else if (sessionDir && fs.existsSync(sessionDir)) {
        createdAt = fs.statSync(sessionDir).birthtime;
    } else {
        createdAt = new Date();
    }

    const expiryDays = config.SESSION_EXPIRY_DAYS || 3;
    const expiresAt = new Date(createdAt.getTime() + expiryDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const isExpired = now.getTime() > expiresAt.getTime();
    const remainingMs = Math.max(0, expiresAt.getTime() - now.getTime());
    const hoursRemaining = Math.floor(remainingMs / (1000 * 60 * 60));
    const daysRemaining = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));

    return {
        sessionId,
        userName,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        isExpired,
        hoursRemaining,
        daysRemaining,
        expiryDays,
        adminWhatsApp: config.ADMIN_WHATSAPP || ''
    };
}

function getSessionFiles(sessionId) {
    const sessionDir = path.join(config.BASE_PHOTO_FOLDER, sessionId);
    if (!fs.existsSync(sessionDir)) {
        return null;
    }

    const allFiles = fs.readdirSync(sessionDir);
    let frameFile = null;
    let gifFile = null;
    const rawPhotos = [];

    for (const f of allFiles) {
        if (f.endsWith('_mirror.jpg') || f.includes('_print.')) continue;

        if (f.startsWith('Cetak_Frame_') && /\.(png|jpg|jpeg)$/i.test(f)) {
            frameFile = f;
        } else if (f.startsWith('Animasi_Foto_') && f.endsWith('.gif')) {
            gifFile = f;
        } else if (/\.(jpe?g|png)$/i.test(f)) {
            rawPhotos.push(f);
        }
    }

    return {
        sessionId,
        sessionDir,
        frameFile,
        gifFile,
        rawPhotos
    };
}

/**
 * Controller: Render halaman web download responsif
 */
function renderDownloadPage(req, res) {
    const { sessionId } = req.params;
    const sessionDir = path.join(config.BASE_PHOTO_FOLDER, sessionId);
    const sessionData = getSessionFiles(sessionId);
    const meta = getSessionMeta(sessionId, sessionDir);

    if (!sessionData) {
        const waLink = `https://wa.me/${meta.adminWhatsApp}?text=${encodeURIComponent(
            `Halo Admin Diceritakita, saya ingin mencari backup foto photobox event yang kedaluwarsa atas nama ${meta.userName} (ID Sesi: ${sessionId}).`
        )}`;

        return res.status(404).send(`
            <!DOCTYPE html>
            <html lang="id">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Foto Tidak Ditemukan - Diceritakita Photobox</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f111a; color: #fff; text-align: center; padding: 50px 20px; margin: 0; }
                    .card { background: #1a1d2b; max-width: 440px; margin: 40px auto; padding: 36px 28px; border-radius: 24px; border: 1px solid #2e344d; box-shadow: 0 12px 30px rgba(0,0,0,0.4); }
                    .badge { display: inline-block; padding: 4px 12px; background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 20px; font-size: 13px; font-weight: bold; margin-bottom: 16px; }
                    h2 { color: #f87171; margin-top: 0; font-size: 22px; }
                    p { color: #94a3b8; line-height: 1.6; font-size: 15px; }
                    .session-pill { background: #0f111a; padding: 8px 12px; border-radius: 10px; font-family: monospace; color: #38bdf8; display: block; margin: 12px 0; word-break: break-all; }
                    .btn-wa { display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: #25D366; color: #fff; text-decoration: none; padding: 14px 24px; border-radius: 14px; font-weight: bold; margin-top: 20px; width: 100%; box-sizing: border-box; box-shadow: 0 4px 15px rgba(37, 211, 102, 0.3); transition: transform 0.2s; }
                    .btn-wa:hover { transform: scale(1.02); }
                </style>
            </head>
            <body>
                <div class="card">
                    <span class="badge">KEDALUWARSA / TIDAK DITEMUKAN</span>
                    <h2>Foto Tidak Ditemukan</h2>
                    <p>Sesi foto tamu atas nama <b>${meta.userName}</b> telah melewati batas waktu unduh (${meta.expiryDays} hari) atau telah diarsipkan dari server lokal.</p>
                    <span class="session-pill">${sessionId}</span>
                    <p>Jangan khawatir! Admin kami biasanya menyimpan master backup offline. Hubungi admin untuk bantuan pencarian:</p>
                    <a class="btn-wa" href="${waLink}" target="_blank">
                        💬 Hubungi Admin via WhatsApp
                    </a>
                </div>
            </body>
            </html>
        `);
    }

    res.sendFile(path.join(__dirname, '..', 'public', 'download.html'));
}

function getSessionDetails(req, res) {
    const { sessionId } = req.params;
    const sessionDir = path.join(config.BASE_PHOTO_FOLDER, sessionId);
    const sessionData = getSessionFiles(sessionId);

    if (!sessionData) {
        return res.status(404).json({ ok: false, error: 'Sesi tidak ditemukan' });
    }

    const { frameFile, gifFile, rawPhotos } = sessionData;
    const meta = getSessionMeta(sessionId, sessionDir);

    res.json({
        ok: true,
        ...meta,
        frame: frameFile ? `/photos/${encodeURIComponent(sessionId)}/${encodeURIComponent(frameFile)}` : null,
        gif: gifFile ? `/photos/${encodeURIComponent(sessionId)}/${encodeURIComponent(gifFile)}` : null,
        rawPhotos: rawPhotos.map(f => `/photos/${encodeURIComponent(sessionId)}/${encodeURIComponent(f)}`),
        zipUrl: `/api/session/${encodeURIComponent(sessionId)}/zip`
    });
}

function downloadZip(req, res) {
    const { sessionId } = req.params;
    const sessionDir = path.join(config.BASE_PHOTO_FOLDER, sessionId);
    const meta = getSessionMeta(sessionId, sessionDir);
    logger.info('zip_download_requested', { sessionId, guest: meta.userName });
    streamSessionZip(sessionDir, res, `Photobox_${sessionId}.zip`);
}

function downloadFile(req, res) {
    const { sessionId, filename } = req.params;
    const filePath = path.join(config.BASE_PHOTO_FOLDER, sessionId, path.basename(filename));

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File tidak ditemukan');
    }

    res.download(filePath);
}

module.exports = {
    renderDownloadPage,
    getSessionDetails,
    downloadZip,
    downloadFile,
    getSessionMeta
};
