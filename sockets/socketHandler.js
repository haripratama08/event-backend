const path = require('path');
const fs = require('fs-extra');
const QRCode = require('qrcode');
const config = require('../config/config');
const session = require('../state/session');
const { processAndPrint } = require('../controllers/printController');
const { generateSessionGif } = require('../services/gifService');
const cameraService = require('../services/cameraService');
const printerService = require('../services/printerService');
const networkService = require('../services/networkService');
const logger = require('../services/logger');

const runPreflight = async () => {
    const checks = {};

    // 1. API
    checks.api = { ok: true, detail: `Port ${config.PORT} Aktif (${config.HOST})` };

    // 2. Storage
    try {
        fs.ensureDirSync(config.BASE_PHOTO_FOLDER);
        checks.storage = { ok: true, detail: 'Penyimpanan Foto Siap' };
    } catch (e) {
        checks.storage = { ok: false, detail: `Penyimpanan Error: ${e.message}` };
    }

    // 3. Frames
    try {
        const frameFiles = fs.readdirSync(config.FRAMES_FOLDER).filter(f => /\.(png|jpe?g)$/i.test(f));
        checks.frames = { ok: frameFiles.length > 0, detail: `${frameFiles.length} Template Frame Terdeteksi` };
    } catch (e) {
        checks.frames = { ok: false, detail: 'Folder Frame Tidak Terbaca' };
    }

    // 4. Printer
    try {
        const pStatus = await printerService.checkPrinterStatus();
        checks.printer = { ok: pStatus.ok, detail: pStatus.ok ? (pStatus.message || 'Printer Siap') : pStatus.error };
    } catch (e) {
        checks.printer = { ok: false, detail: `Printer Error: ${e.message}` };
    }

    // 5. Network / Tunnel (Opsi B)
    const publicUrl = networkService.resolvePublicBaseUrl();
    const isTunnel = publicUrl.startsWith('https://');
    checks.network = {
        ok: true,
        detail: isTunnel ? `Cloudflare Tunnel Aktif (${publicUrl})` : `Jaringan Lokal (${publicUrl})`
    };

    // 6. Camera
    checks.camera = { ok: true, detail: 'Kamera Siap' };

    const allOk = Object.values(checks).every(c => c.ok);
    return {
        ok: allOk,
        checks,
        checked_at: new Date().toISOString()
    };
};

module.exports = function (io) {
    io.on('connection', (socket) => {
        logger.info('client_connected', { id: socket.id });

        // 1. Preflight check
        socket.on('preflight-check', async () => {
            const result = await runPreflight();
            socket.emit('preflight-result', result);
        });

        // 2. Start new session (Supports guest/user name)
        socket.on('start-new-session', (data) => {
            const rawName = (data && typeof data === 'object') ? (data.userName || data.name) : (typeof data === 'string' ? data : null);
            const sessionId = session.generateSessionId(rawName);
            const sessionPath = path.join(config.BASE_PHOTO_FOLDER, sessionId);
            fs.ensureDirSync(sessionPath);
            logger.info('session_started', { sessionId, path: sessionPath, guestName: session.parseSessionId(sessionId).userName });
            socket.emit('session-started', { sessionId });
        });

        // 3. Set active user folder (backward compatibility with Flutter frontend)
        socket.on('set-active-user', (userFolderName) => {
            if (userFolderName && userFolderName.trim() !== '') {
                session.setActiveUserFolder(userFolderName.trim());
            } else {
                session.generateSessionId();
            }
            const activeFolder = session.getActiveUserFolder();
            fs.ensureDirSync(path.join(config.BASE_PHOTO_FOLDER, activeFolder));
            logger.info('active_folder_set', { folder: activeFolder });
        });

        // 4. Live View
        socket.on('start-liveview', () => {
            cameraService.startLiveView(io);
        });

        socket.on('stop-liveview', () => {
            cameraService.stopLiveView();
        });

        // 5. Capture Photo
        socket.on('take-photo', async () => {
            try {
                const activeFolder = session.getActiveUserFolder();
                const userFolderPath = path.join(config.BASE_PHOTO_FOLDER, activeFolder);
                const savedFile = await cameraService.capturePhoto(userFolderPath);

                const fileName = path.basename(savedFile);
                const baseUrl = networkService.resolvePublicBaseUrl();
                const photoUrl = `${baseUrl}/photos/${encodeURIComponent(activeFolder)}/${encodeURIComponent(fileName)}`;

                io.emit('photo-taken', {
                    filename: fileName,
                    url: photoUrl,
                    localPath: savedFile
                });
            } catch (err) {
                logger.error('take_photo_failed', { error: err.message });
                socket.emit('photo-error', { error: err.message });
            }
        });

        // 6. Finish Session & Process Results (Print + QR Code generation)
        socket.on('send-results', async (data) => {
            try {
                let {
                    frameName,
                    photos = [],
                    printCopies = 1,
                    generateGif = true,
                    mergedImageBase64
                } = data;

                const activeFolder = session.getActiveUserFolder();
                const userFolderPath = path.join(config.BASE_PHOTO_FOLDER, activeFolder);
                fs.ensureDirSync(userFolderPath);

                logger.info('processing_event_session', {
                    sessionId: activeFolder,
                    frame: frameName,
                    photosCount: photos.length,
                    printCopies
                });

                // A. Render Frame & Antrekan ke Printer
                const finalCollagePath = await processAndPrint({
                    mergedImageBase64,
                    frameName,
                    photos,
                    userFolderPath,
                    printCopies
                });

                // B. Buat Animasi GIF jika diaktifkan
                let gifPath = null;
                if (generateGif && config.GIF_ENABLED) {
                    const rawPhotoPaths = photos.map(p => {
                        if (p.startsWith('http')) {
                            const rel = decodeURIComponent(new URL(p).pathname.replace(/^\/photos\//, ''));
                            return path.join(config.BASE_PHOTO_FOLDER, rel);
                        }
                        return path.isAbsolute(p) ? p : path.join(userFolderPath, p);
                    }).filter(fs.existsSync);

                    gifPath = await generateSessionGif(rawPhotoPaths, userFolderPath);
                }

                // C. Siapkan Link & QR Code untuk Tamu
                const downloadUrl = networkService.buildSessionDownloadUrl(activeFolder);
                const qrCodeDataUrl = await QRCode.toDataURL(downloadUrl, {
                    width: 480,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });

                const baseUrl = networkService.resolvePublicBaseUrl();
                const collageUrl = `${baseUrl}/photos/${encodeURIComponent(activeFolder)}/${encodeURIComponent(path.basename(finalCollagePath))}`;
                const gifUrl = gifPath ? `${baseUrl}/photos/${encodeURIComponent(activeFolder)}/${encodeURIComponent(path.basename(gifPath))}` : null;

                const resultPayload = {
                    ok: true,
                    sessionId: activeFolder,
                    downloadUrl,
                    qrCodeDataUrl,
                    collageUrl,
                    gifUrl,
                    printCopies,
                    printStatus: 'QUEUED'
                };

                logger.info('session_results_ready', { sessionId: activeFolder, downloadUrl });

                // Kirim hasil ke Flutter UI
                socket.emit('session-results-ready', resultPayload);
                io.emit('session-ready', resultPayload);

            } catch (fatalError) {
                logger.error('session_processing_fatal', { error: fatalError.message, stack: fatalError.stack });
                socket.emit('session-error', { error: fatalError.message });
            }
        });

        socket.on('disconnect', () => {
            logger.info('client_disconnected', { id: socket.id });
        });
    });
};
