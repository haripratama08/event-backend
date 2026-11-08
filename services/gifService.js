const { execFile } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const config = require('../config/config');
const logger = require('./logger');

const execFilePromise = (command, args, options = {}) =>
    new Promise((resolve, reject) => {
        execFile(command, args, options, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                return reject(error);
            }
            resolve({ stdout, stderr });
        });
    });

const prepareFrames = async (photoPaths, tempDir, maxWidth = 720) => {
    const framePaths = [];
    for (let index = 0; index < photoPaths.length; index += 1) {
        const srcPath = photoPaths[index];
        if (!fs.existsSync(srcPath)) continue;

        const outFramePath = path.join(tempDir, `frame_${String(index).padStart(3, '0')}.jpg`);
        await sharp(srcPath)
            .rotate()
            .resize({
                width: maxWidth,
                fit: 'inside',
                withoutEnlargement: true,
                kernel: sharp.kernel.lanczos3
            })
            .jpeg({ quality: 90 })
            .toFile(outFramePath);

        framePaths.push(outFramePath);
    }
    return framePaths;
};

const generateGifWithFfmpeg = async (framePaths, outputPath, delayMs = 500) => {
    const tempDir = path.dirname(framePaths[0]);
    const listFile = path.join(tempDir, `concat_${Date.now()}.txt`);
    const durationSeconds = Math.max(0.1, delayMs / 1000);

    let concatContent = '';
    for (const framePath of framePaths) {
        const normalized = path.resolve(framePath).replace(/\\/g, '/');
        concatContent += `file '${normalized}'\nduration ${durationSeconds}\n`;
    }
    if (framePaths.length > 0) {
        const lastFrame = path.resolve(framePaths[framePaths.length - 1]).replace(/\\/g, '/');
        concatContent += `file '${lastFrame}'\n`;
    }

    await fs.writeFile(listFile, concatContent, 'utf8');

    const fps = Math.max(1, Math.round(1 / durationSeconds));
    const filterComplex = `fps=${fps},split[s0][s1];[s0]palettegen=max_colors=256:reserve_transparent=0[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;

    const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-filter_complex', filterComplex,
        '-loop', '0',
        outputPath
    ];

    try {
        await execFilePromise('ffmpeg', args, { timeout: 30000 });
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            return true;
        }
    } catch (ffmpegErr) {
        logger.warn('gif_ffmpeg_failed', { error: ffmpegErr.message });
    } finally {
        await fs.remove(listFile).catch(() => {});
    }
    return false;
};

async function generateSessionGif(photoPaths, outputDir, options = {}) {
    if (!config.GIF_ENABLED || !photoPaths || photoPaths.length === 0) {
        return null;
    }

    const delayMs = Number(options.delayMs || config.GIF_FRAME_DELAY_MS || 500);
    const maxWidth = Number(options.maxWidth || config.GIF_MAX_WIDTH || 720);
    const tempDir = path.join(outputDir, `_temp_gif_${Date.now()}`);

    try {
        await fs.ensureDir(tempDir);
        const validFrames = await prepareFrames(photoPaths, tempDir, maxWidth);

        if (validFrames.length === 0) {
            return null;
        }

        const gifFilename = `Animasi_Foto_${Date.now()}.gif`;
        const outputPath = path.join(outputDir, gifFilename);

        const success = await generateGifWithFfmpeg(validFrames, outputPath, delayMs);
        if (success) {
            logger.info('gif_created', { path: outputPath, frames: validFrames.length });
            return outputPath;
        }
        return null;
    } catch (err) {
        logger.error('gif_generation_failed', { error: err.message });
        return null;
    } finally {
        await fs.remove(tempDir).catch(() => {});
    }
}

module.exports = {
    generateSessionGif
};
