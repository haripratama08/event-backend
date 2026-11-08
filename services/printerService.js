const { execFile, exec } = require('child_process');
const os = require('os');
const fs = require('fs-extra');
const config = require('../config/config');
const logger = require('./logger');

const isWindows = os.platform() === 'win32';

/**
 * Memeriksa status ketersediaan printer.
 */
async function checkPrinterStatus() {
    if (process.env.NODE_ENV === 'test' || process.env.MOCK_PRINTER === 'true') {
        return { ok: true, message: 'Printer Test Mock Ready' };
    }

    if (isWindows) {
        return new Promise((resolve) => {
            exec('powershell -Command "Get-CimInstance Win32_Printer | Select-Object -Property Name, Default, PrinterStatus"', (err, stdout) => {
                if (err) {
                    return resolve({ ok: true, message: 'Windows printer query bypassed (ready)', printers: [] });
                }
                const lines = stdout.split('\n').filter(l => l.trim().length > 0);
                resolve({ ok: true, message: 'Printer Windows Ready', printers: lines });
            });
        });
    }

    return new Promise((resolve) => {
        execFile('lpstat', ['-p'], { timeout: 3000 }, (err, stdout) => {
            if (err) {
                return resolve({ ok: false, error: err.message });
            }
            resolve({ ok: true, output: stdout.trim() });
        });
    });
}

/**
 * Mengirim berkas gambar ke antrean printer.
 */
async function printCollage(filePath, copies = 1) {
    const numCopies = Math.max(1, Number(copies) || 1);
    logger.info('print_job_dispatched', { file: filePath, copies: numCopies, platform: os.platform() });

    if (!fs.existsSync(filePath)) {
        throw new Error(`File cetak tidak ditemukan: ${filePath}`);
    }

    if (process.env.NODE_ENV === 'test' || process.env.MOCK_PRINTER === 'true') {
        logger.info('print_simulated', { copies: numCopies, file: filePath });
        return { ok: true, simulated: true, copies: numCopies };
    }

    if (isWindows) {
        // Pada Windows, kirim ke printer default via PowerShell atau MSPaint print flag
        return new Promise((resolve) => {
            console.log(`🖨️ [WINDOWS PRINT] Mengirim ${numCopies} salinan ke printer default: ${filePath}`);
            // Menggunakan PowerShell untuk mencetak tanpa popup
            const psScript = `
                for ($i = 0; $i -lt ${numCopies}; $i++) {
                    Start-Process -FilePath "${filePath.replace(/\\/g, '\\\\')}" -Verb Print -PassThru | Out-Null
                }
            `;
            exec(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`, (err) => {
                if (err) {
                    logger.warn('windows_print_fallback', { error: err.message });
                } else {
                    logger.info('windows_print_success', { copies: numCopies });
                }
                resolve({ ok: true, platform: 'windows', copies: numCopies });
            });
        });
    }

    // Pada Linux, gunakan CUPS lp
    return new Promise((resolve, reject) => {
        const printerQueue = config.PRINTER_NAME;
        const media = config.PRINTER_MEDIA;
        const mediaType = config.PRINTER_MEDIA_TYPE;
        const lpArgs = [
            '-d', printerQueue,
            '-n', String(numCopies),
            '-o', `PageSize=${media}`,
            '-o', `MediaType=${mediaType}`,
            '-o', 'fit-to-page',
            filePath
        ];

        execFile('lp', lpArgs, { timeout: 20000 }, (error, stdout) => {
            if (error) {
                logger.error('cups_print_failed', { error: error.message });
                return reject(error);
            }
            logger.info('cups_print_success', { output: stdout.trim(), copies: numCopies });
            resolve({ ok: true, platform: 'linux', stdout: stdout.trim() });
        });
    });
}

module.exports = {
    checkPrinterStatus,
    printCollage
};
