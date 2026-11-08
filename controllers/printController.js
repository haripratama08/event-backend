const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const config = require('../config/config');
const logger = require('../services/logger');
const printerService = require('../services/printerService');

let framesData = [];
try {
    framesData = require(config.FRAMES_DATA_FILE);
} catch (e) {
    logger.warn('frames_data_load_failed', { error: e.message });
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const preparePrintReadyImage = async (sourcePath, baseWidth, baseHeight, density) => {
    const safeScale = clamp(Number(config.PRINT_SAFE_SCALE) || 0.96, 0.9, 1);
    const contentWidth = Math.max(1, Math.round(baseWidth * safeScale));
    const contentHeight = Math.max(1, Math.round(baseHeight * safeScale));
    const horizontalRoom = baseWidth - contentWidth;
    const verticalRoom = baseHeight - contentHeight;
    const left = Math.round(horizontalRoom / 2);
    const top = Math.round(verticalRoom / 2);
    const right = horizontalRoom - left;
    const bottom = verticalRoom - top;

    const parsed = path.parse(sourcePath);
    const printPath = path.join(parsed.dir, `${parsed.name}_print${parsed.ext}`);

    await sharp(sourcePath)
        .resize({
            width: contentWidth,
            height: contentHeight,
            fit: 'fill',
            kernel: sharp.kernel.lanczos3
        })
        .extend({ top, bottom, left, right, extendWith: 'copy' })
        .withMetadata({ density })
        .png({ compressionLevel: 6, adaptiveFiltering: true })
        .toFile(printPath);

    return printPath;
};

const processAndPrint = async ({
    mergedImageBase64,
    frameName,
    photos,
    userFolderPath,
    printCopies = 1
}) => {
    const baseWidth = config.PRINT_WIDTH;
    const baseHeight = config.PRINT_HEIGHT;
    const outputDensity = Math.max(72, Math.round(Math.min(baseWidth / 4, baseHeight / 6)));
    const finalCollagePath = path.join(userFolderPath, `Cetak_Frame_${Date.now()}.png`);
    let renderingDone = false;

    if (frameName && photos && photos.length > 0) {
        // Cari konfigurasi frame
        const frameConfig = framesData.find((f) => f.name === frameName) || framesData[0];
        if (frameConfig) {
            let frameFileName = frameConfig.asset_path ? path.basename(frameConfig.asset_path) : 'frame_1.png';
            let frameLocalPath = path.join(config.FRAMES_FOLDER, frameFileName);

            // Fallback jika file frame tidak ada
            if (!fs.existsSync(frameLocalPath)) {
                const foundFiles = fs.readdirSync(config.FRAMES_FOLDER).filter(f => f.endsWith('.png') || f.endsWith('.PNG'));
                if (foundFiles.length > 0) {
                    frameLocalPath = path.join(config.FRAMES_FOLDER, foundFiles[0]);
                }
            }

            const compositeOperations = [];

            // 1. Masukkan foto-foto ke slot masing-masing
            for (let i = 0; i < photos.length; i++) {
                if (!frameConfig.slots || !frameConfig.slots[i]) continue;
                const slot = frameConfig.slots[i];
                let photoItem = photos[i];

                // Tangani baik URL maupun absolute path
                let absolutePhotoPath = photoItem;
                if (photoItem.startsWith('http')) {
                    const parsedUrl = new URL(photoItem);
                    const rel = decodeURIComponent(parsedUrl.pathname.replace(/^\/photos\//, ''));
                    absolutePhotoPath = path.join(config.BASE_PHOTO_FOLDER, rel);
                } else if (!path.isAbsolute(photoItem)) {
                    absolutePhotoPath = path.join(userFolderPath, photoItem);
                }

                if (fs.existsSync(absolutePhotoPath)) {
                    const slotWidth = Math.round(baseWidth * slot.w);
                    const slotHeight = Math.round(baseHeight * slot.h);
                    const slotLeft = Math.round(baseWidth * slot.l);
                    const slotTop = Math.round(baseHeight * slot.t);

                    const resizedBuffer = await sharp(absolutePhotoPath)
                        .rotate()
                        .resize({
                            width: slotWidth,
                            height: slotHeight,
                            fit: 'cover',
                            kernel: sharp.kernel.lanczos3
                        })
                        .toBuffer();

                    compositeOperations.push({
                        input: resizedBuffer,
                        left: slotLeft,
                        top: slotTop
                    });
                }
            }

            // 2. Tempelkan template Frame transparan di atas foto
            if (fs.existsSync(frameLocalPath)) {
                const frameBuffer = await sharp(frameLocalPath)
                    .resize(baseWidth, baseHeight, {
                        fit: 'fill',
                        kernel: sharp.kernel.lanczos3
                    })
                    .toBuffer();

                compositeOperations.push({
                    input: frameBuffer,
                    left: 0,
                    top: 0
                });
            }

            // 3. Render kanvas putih dengan semua layer
            await sharp({
                create: {
                    width: baseWidth,
                    height: baseHeight,
                    channels: 4,
                    background: { r: 255, g: 255, b: 255, alpha: 1 }
                }
            })
            .composite(compositeOperations)
            .withMetadata({ density: outputDensity })
            .png({ compressionLevel: 6, adaptiveFiltering: true })
            .toFile(finalCollagePath);

            logger.info('collage_rendered', { path: finalCollagePath, frame: frameName });
            renderingDone = true;
        }
    }

    // Fallback jika Flutter mengirim base64 langsung
    if (!renderingDone && mergedImageBase64) {
        const base64Data = mergedImageBase64.replace(/^data:image\/\w+;base64,/, '');
        await sharp(Buffer.from(base64Data, 'base64'))
            .resize({
                width: baseWidth,
                height: baseHeight,
                fit: 'cover',
                kernel: sharp.kernel.lanczos3
            })
            .withMetadata({ density: outputDensity })
            .png({ compressionLevel: 6, adaptiveFiltering: true })
            .toFile(finalCollagePath);
        renderingDone = true;
    }

    if (!renderingDone || !fs.existsSync(finalCollagePath)) {
        throw new Error('Gagal merender kolase foto frame');
    }

    // Kirim proses print ke background agar QR code langsung tampil tanpa menunggu spooler printer
    (async () => {
        try {
            const printReadyPath = await preparePrintReadyImage(finalCollagePath, baseWidth, baseHeight, outputDensity);
            await printerService.printCollage(printReadyPath, printCopies);
        } catch (e) {
            logger.warn('print_spool_failed', { error: e.message });
        }
    })();

    return finalCollagePath;
};

module.exports = {
    processAndPrint
};
