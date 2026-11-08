const { execFile } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const config = require('../config/config');
const logger = require('./logger');

let isLiveViewActive = false;
let previewBuffer = null;

// Generate dummy frame for preview if no camera attached
const createFallbackPreview = async () => {
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
                    <text x="50%" y="45%" text-anchor="middle" fill="#FFFFFF" font-size="32" font-family="sans-serif" font-weight="bold">PHOTOBOX EVENT LIVEVIEW</text>
                    <text x="50%" y="55%" text-anchor="middle" fill="#8888AA" font-size="20" font-family="sans-serif">Kamera Siap / Mode Standby</text>
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
 * Capture foto ke folder tujuan.
 */
async function capturePhoto(targetFolder) {
    fs.ensureDirSync(targetFolder);
    const filename = `IMG_${Date.now()}.jpg`;
    const destPath = path.join(targetFolder, filename);

    // Cek apakah mode mock atau gphoto2 gagal
    if (config.CAMERA_DRIVER === 'mock') {
        return createMockPhoto(destPath);
    }

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

async function getSinglePreviewFrame(res) {
    if (!previewBuffer) {
        previewBuffer = await createFallbackPreview();
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(previewBuffer);
}

function startLiveView(io) {
    isLiveViewActive = true;
}

function stopLiveView() {
    isLiveViewActive = false;
}

async function shutdown() {
    stopLiveView();
}

module.exports = {
    capturePhoto,
    getSinglePreviewFrame,
    startLiveView,
    stopLiveView,
    shutdown
};
