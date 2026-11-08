const { execFile } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const config = require('../config/config');
const logger = require('./logger');

// Nonaktifkan cache Sharp agar tidak menahan file handle lock pada Windows
sharp.cache(false);

let isLiveViewActive = false;
let liveViewTimer = null;
let previewBuffer = null;
let isCaptureInProgress = false;
let folderWatcher = null;

/**
 * Menentukan driver kamera yang aktif.
 * 'digicam'  : Digunakan pada Windows via digiCamControl web server
 * 'gphoto2'  : Digunakan pada Linux via gphoto2 CLI
 * 'mock'     : Mode simulator (otomatis saat testing atau offline)
 */
function resolveDriver() {
    if (config.CAMERA_DRIVER && config.CAMERA_DRIVER !== 'auto') {
        return config.CAMERA_DRIVER.toLowerCase();
    }
    return os.platform() === 'win32' ? 'digicam' : 'gphoto2';
}

/**
 * Generate frame dummy untuk Live View standby atau fallback
 */
const createFallbackPreview = async (statusText = 'Kamera Standby') => {
    return sharp({
        create: {
            width: 960,
            height: 640,
            channels: 3,
            background: { r: 35, g: 35, b: 45 }
        }
    })
    .composite([
        {
            input: Buffer.from(
                `<svg width="960" height="640">
                    <rect width="960" height="640" fill="#23232D"/>
                    <circle cx="480" cy="270" r="90" fill="#3D3D4E"/>
                    <path d="M 430 270 L 530 270 M 480 220 L 480 320" stroke="#8888AA" stroke-width="6" stroke-linecap="round"/>
                    <text x="50%" y="420" text-anchor="middle" fill="#FFFFFF" font-size="30" font-family="sans-serif" font-weight="bold">PHOTOBOX EVENT LIVEVIEW</text>
                    <text x="50%" y="465" text-anchor="middle" fill="#A0A0C0" font-size="20" font-family="sans-serif">${statusText}</text>
                </svg>`
            ),
            top: 0,
            left: 0
        }
    ])
    .jpeg({ quality: 80 })
    .toBuffer();
};

/**
 * Memeriksa status koneksi kamera / server digiCamControl.
 */
async function getCameraStatus() {
    const driver = resolveDriver();

    if (driver === 'mock') {
        return {
            ok: true,
            connected: true,
            model: 'Mock Simulator Camera (Test Mode)',
            driver: 'mock'
        };
    }

    if (driver === 'digicam') {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(`${config.DIGICAM_URL}/`, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (res.ok) {
                return {
                    ok: true,
                    connected: true,
                    model: 'DSLR via digiCamControl (Windows)',
                    driver: 'digicam',
                    url: config.DIGICAM_URL
                };
            }
            return {
                ok: false,
                connected: false,
                error: `digiCamControl merespons dengan HTTP ${res.status}`,
                driver: 'digicam'
            };
        } catch (err) {
            return {
                ok: false,
                connected: false,
                error: `digiCamControl tidak terhubung pada ${config.DIGICAM_URL} (${err.message})`,
                driver: 'digicam'
            };
        }
    }

    // Driver gphoto2 (Linux)
    return new Promise((resolve) => {
        execFile('gphoto2', ['--summary'], { timeout: 4000 }, (err, stdout) => {
            if (!err && stdout && !stdout.toLowerCase().includes('error')) {
                return resolve({
                    ok: true,
                    connected: true,
                    model: 'DSLR via gphoto2 (Linux)',
                    driver: 'gphoto2'
                });
            }
            resolve({
                ok: false,
                connected: false,
                error: err ? err.message : 'Kamera gphoto2 tidak terdeteksi',
                driver: 'gphoto2'
            });
        });
    });
}

/**
 * Mengirim perintah kontrol ke digiCamControl HTTP API
 */
async function sendDigiCamCommand(commandPath) {
    const url = `${config.DIGICAM_URL}${commandPath.startsWith('/') ? '' : '/'}${commandPath}`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        return { ok: res.ok, status: res.status };
    } catch (err) {
        logger.warn('digicam_command_failed', { command: commandPath, error: err.message });
        return { ok: false, error: err.message };
    }
}

/**
 * Autofocus kamera
 */
async function triggerAutoFocus() {
    const driver = resolveDriver();
    if (driver === 'digicam') {
        return sendDigiCamCommand('/?slc=autofocus');
    }
    return { ok: true, simulated: true };
}

/**
 * Atur ISO kamera
 */
async function setIso(isoValue) {
    const driver = resolveDriver();
    if (driver === 'digicam') {
        return sendDigiCamCommand(`/?slc=set&param1=iso&param2=${encodeURIComponent(isoValue)}`);
    }
    return { ok: true, simulated: true };
}

/**
 * Atur Kecepatan Shutter kamera
 */
async function setShutterSpeed(shutterValue) {
    const driver = resolveDriver();
    if (driver === 'digicam') {
        return sendDigiCamCommand(`/?slc=set&param1=shutterspeed&param2=${encodeURIComponent(shutterValue)}`);
    }
    return { ok: true, simulated: true };
}

/**
 * Atur mode cermin (flip horizontal) pada Live View digiCamControl
 */
async function setMirror(isMirror) {
    const driver = resolveDriver();
    if (driver === 'digicam') {
        const val = isMirror ? 'true' : 'false';
        return sendDigiCamCommand(`/?slc=set&param1=liveview.flip.horizontal&param2=${val}`);
    }
    return { ok: true, simulated: true };
}

/**
 * Memulai Live View stream.
 * Mengirim event 'liveview-frame' (base64) secara berkala ke Socket.IO clients.
 */
function startLiveView(io) {
    if (isLiveViewActive) return;
    isLiveViewActive = true;
    const driver = resolveDriver();

    logger.info('liveview_started', { driver });

    if (driver === 'digicam') {
        // Beritahu digiCamControl untuk membuka LiveView
        sendDigiCamCommand('/?CMD=LiveViewWnd_Show').catch(() => {});

        const frameIntervalMs = Math.floor(1000 / config.LIVEVIEW_FPS);

        liveViewTimer = setInterval(async () => {
            if (!isLiveViewActive || isCaptureInProgress) return;

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 800);
                const res = await fetch(`${config.DIGICAM_URL}/liveview.jpg`, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (res.ok) {
                    const arrayBuffer = await res.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    previewBuffer = buffer;
                    const base64 = buffer.toString('base64');
                    io.emit('liveview-frame', base64);
                }
            } catch (err) {
                // Jangan penuhi log pada setiap tick frame yang terlewat
            }
        }, frameIntervalMs);

    } else {
        // Fallback / Mock stream untuk testing atau non-digicam
        let frameCount = 0;
        liveViewTimer = setInterval(async () => {
            if (!isLiveViewActive || isCaptureInProgress) return;
            try {
                frameCount++;
                if (!previewBuffer || frameCount % 30 === 0) {
                    previewBuffer = await createFallbackPreview('Mode Simulasi Siap');
                }
                io.emit('liveview-frame', previewBuffer.toString('base64'));
            } catch (e) {}
        }, 100);
    }
}

/**
 * Menghentikan Live View stream.
 */
function stopLiveView() {
    if (!isLiveViewActive) return;
    isLiveViewActive = false;

    if (liveViewTimer) {
        clearInterval(liveViewTimer);
        liveViewTimer = null;
    }

    const driver = resolveDriver();
    if (driver === 'digicam') {
        sendDigiCamCommand('/?CMD=LiveViewWnd_Hide').catch(() => {});
    }

    logger.info('liveview_stopped');
}

/**
 * Capture foto ke folder target (mendukung digiCamControl, gphoto2, dan mock)
 */
async function capturePhoto(targetFolder) {
    fs.ensureDirSync(targetFolder);
    const filename = `IMG_${Date.now()}.jpg`;
    const destPath = path.join(targetFolder, filename);
    const driver = resolveDriver();

    if (driver === 'mock') {
        return createMockPhoto(destPath);
    }

    isCaptureInProgress = true;
    const wasLiveViewActive = isLiveViewActive;

    try {
        if (driver === 'digicam') {
            return await captureDigiCamPhoto(targetFolder, destPath);
        } else {
            return await captureGphotoPhoto(targetFolder, destPath);
        }
    } finally {
        isCaptureInProgress = false;
        // Kembalikan status liveview jika sebelumnya aktif
        if (wasLiveViewActive && isLiveViewActive && driver === 'digicam') {
            sendDigiCamCommand('/?CMD=LiveViewWnd_Show').catch(() => {});
        }
    }
}

/**
 * Capture foto menggunakan digiCamControl pada Windows.
 * Mengirim perintah trigger capture dan mengambil hasil berkas foto dari folder sesi digiCam.
 */
async function captureDigiCamPhoto(targetFolder, destPath) {
    const watchDir = config.DIGICAM_PHOTO_FOLDER;
    fs.ensureDirSync(watchDir);

    const startTime = Date.now();
    logger.info('digicam_capture_triggered', { url: config.DIGICAM_URL, watchDir });

    // 1. Kirim perintah capture ke digiCamControl
    const captureRes = await sendDigiCamCommand('/?slc=capture');
    if (!captureRes.ok) {
        logger.warn('digicam_slc_capture_failed_trying_cmd', { error: captureRes.error });
        await sendDigiCamCommand('/?CMD=Capture');
    }

    // 2. Tunggu dan cari berkas baru yang masuk di folder digiCamControl
    const foundFile = await waitForNewFileInFolder(watchDir, startTime, 15000);

    if (!foundFile) {
        logger.warn('digicam_photo_timeout_fallback_to_mock', { watchDir, timeoutMs: 15000 });
        return createMockPhoto(destPath);
    }

    // 3. Proses dan simpan foto ke targetFolder dengan kompresi optimal
    try {
        const imageBuffer = await fs.readFile(foundFile);
        await sharp(imageBuffer)
            .resize({ width: 2400, withoutEnlargement: true })
            .jpeg({ quality: 90, mozjpeg: true })
            .toFile(destPath);

        // Hapus file sumber dari folder sesi digiCam agar tidak menumpuk
        await fs.remove(foundFile).catch(() => {});

        logger.info('digicam_photo_saved', { file: destPath, original: foundFile });
        return destPath;
    } catch (processErr) {
        logger.warn('digicam_sharp_failed_copying_direct', { error: processErr.message });
        fs.copyFileSync(foundFile, destPath);
        await fs.remove(foundFile).catch(() => {});
        return destPath;
    }
}

/**
 * Menunggu berkas baru muncul pada folder target dalam batas waktu tertentu
 */
async function waitForNewFileInFolder(folderPath, sinceTime, timeoutMs = 15000) {
    const pollInterval = 200;
    const maxLoops = Math.floor(timeoutMs / pollInterval);

    for (let i = 0; i < maxLoops; i++) {
        await new Promise((r) => setTimeout(r, pollInterval));
        if (!fs.existsSync(folderPath)) continue;

        try {
            const files = fs.readdirSync(folderPath);
            const imageFiles = files.filter(f => /\.(jpe?g|png|cr2|cr3|nef|arw)$/i.test(f));

            for (const file of imageFiles) {
                const fullPath = path.join(folderPath, file);
                const stats = fs.statSync(fullPath);
                // Cek apakah berkas dimodifikasi/dibuat setelah trigger capture (toleransi mundur 1500ms)
                if (stats.mtimeMs >= (sinceTime - 1500)) {
                    // Pastikan file sudah selesai ditulis (ukuran stabil)
                    await new Promise((r) => setTimeout(r, 250));
                    return fullPath;
                }
            }
        } catch (e) {
            // Ignore temporary lock
        }
    }
    return null;
}

/**
 * Capture foto menggunakan gphoto2 (Linux)
 */
async function captureGphotoPhoto(targetFolder, destPath) {
    return new Promise((resolve) => {
        execFile('gphoto2', ['--capture-image-and-download', '--filename', destPath], { timeout: 15000 }, async (err) => {
            if (err || !fs.existsSync(destPath)) {
                logger.warn('gphoto2_failed_fallback_to_mock', { error: err ? err.message : 'File not found' });
                await createMockPhoto(destPath);
            } else {
                logger.info('photo_captured_hardware', { file: destPath });
            }
            resolve(destPath);
        });
    });
}

/**
 * Membuat foto mock untuk keperluan testing atau offline fallback
 */
async function createMockPhoto(destPath) {
    const timestamp = new Date().toLocaleTimeString();
    await sharp({
        create: {
            width: 1800,
            height: 1200,
            channels: 3,
            background: {
                r: Math.floor(100 + Math.random() * 80),
                g: Math.floor(100 + Math.random() * 80),
                b: Math.floor(140 + Math.random() * 80)
            }
        }
    })
    .composite([
        {
            input: Buffer.from(
                `<svg width="1800" height="1200">
                    <rect width="1800" height="1200" fill="none" stroke="#FFFFFF" stroke-width="20"/>
                    <circle cx="900" cy="500" r="180" fill="#FFFFFF" opacity="0.8"/>
                    <circle cx="900" cy="450" r="70" fill="#333333"/>
                    <path d="M 750 620 Q 900 700 1050 620 Z" fill="#333333"/>
                    <text x="50%" y="780" text-anchor="middle" fill="#FFFFFF" font-size="48" font-family="sans-serif" font-weight="bold">PHOTOBOX EVENT SNAPSHOT</text>
                    <text x="50%" y="850" text-anchor="middle" fill="#FFFFFF" font-size="28" font-family="sans-serif">${timestamp}</text>
                </svg>`
            ),
            top: 0,
            left: 0
        }
    ])
    .jpeg({ quality: 95 })
    .toFile(destPath);

    logger.info('mock_photo_created', { file: destPath });
    return destPath;
}

/**
 * Mengirimkan single frame JPEG untuk HTTP /preview-frame
 */
async function getSinglePreviewFrame(res) {
    if (!previewBuffer) {
        previewBuffer = await createFallbackPreview();
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(previewBuffer);
}

/**
 * Watcher folder digiCamControl untuk mengakomodir shutter dari tombol fisik / remote kamera.
 * Ketika kamera dijepret via tombol remote nirkabel, file otomatis diamankan ke sesi yang aktif.
 */
function initDigiCamWatcher(io, getActiveSessionFolder) {
    const watchFolder = config.DIGICAM_PHOTO_FOLDER;
    try {
        fs.ensureDirSync(watchFolder);
        if (folderWatcher) {
            folderWatcher.close();
        }

        folderWatcher = fs.watch(watchFolder, async (eventType, filename) => {
            if (!filename || !/\.(jpe?g|png)$/i.test(filename)) return;
            if (isCaptureInProgress) return; // Sudah di-handle oleh take-photo

            const sourcePath = path.join(watchFolder, filename);
            if (!fs.existsSync(sourcePath)) return;

            // Beri jeda kecil agar digiCam selesai transfer
            setTimeout(async () => {
                try {
                    if (!fs.existsSync(sourcePath)) return;
                    const sessionFolder = typeof getActiveSessionFolder === 'function'
                        ? getActiveSessionFolder()
                        : config.BASE_PHOTO_FOLDER;

                    fs.ensureDirSync(sessionFolder);
                    const destName = `IMG_${Date.now()}_${path.basename(filename)}`;
                    const destPath = path.join(sessionFolder, destName);

                    const sourceBuffer = await fs.readFile(sourcePath);
                    await sharp(sourceBuffer)
                        .resize({ width: 2400, withoutEnlargement: true })
                        .jpeg({ quality: 90, mozjpeg: true })
                        .toFile(destPath);

                    await fs.remove(sourcePath).catch(() => {});

                    const activeSessionName = path.basename(sessionFolder);
                    const baseUrl = require('./networkService').resolvePublicBaseUrl();
                    const photoUrl = `${baseUrl}/photos/${encodeURIComponent(activeSessionName)}/${encodeURIComponent(destName)}`;

                    const payload = {
                        filename: destName,
                        url: photoUrl,
                        localPath: destPath
                    };

                    io.emit('photo-taken', payload);
                    io.emit('photo-ready', payload);
                    logger.info('photo_captured_from_remote_shutter', { file: destPath });
                } catch (e) {
                    logger.warn('remote_shutter_ingest_failed', { error: e.message });
                }
            }, 300);
        });

        logger.info('digicam_folder_watcher_ready', { folder: watchFolder });
    } catch (err) {
        logger.warn('digicam_folder_watcher_init_failed', { error: err.message });
    }
}

async function shutdown() {
    stopLiveView();
    if (folderWatcher) {
        folderWatcher.close();
        folderWatcher = null;
    }
}

module.exports = {
    resolveDriver,
    getCameraStatus,
    triggerAutoFocus,
    setIso,
    setShutterSpeed,
    setMirror,
    startLiveView,
    stopLiveView,
    capturePhoto,
    getSinglePreviewFrame,
    createMockPhoto,
    createFallbackPreview,
    initDigiCamWatcher,
    shutdown
};
