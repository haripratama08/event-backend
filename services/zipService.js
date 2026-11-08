const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

/**
 * Membuat stream ZIP dari folder sesi foto untuk langsung di-pipe ke respon HTTP.
 * @param {string} folderPath Direktori folder sesi fisik
 * @param {object} res Express Response Object
 * @param {string} zipFilename Nama file ZIP saat diunduh
 */
function streamSessionZip(folderPath, res, zipFilename = 'Foto_Photobox_Event.zip') {
    if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ error: 'Folder sesi tidak ditemukan' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', {
        zlib: { level: 6 }
    });

    archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
            logger.warn('zip_warning', { message: err.message });
        } else {
            throw err;
        }
    });

    archive.on('error', (err) => {
        logger.error('zip_error', { message: err.message });
        if (!res.headersSent) {
            res.status(500).send({ error: 'Gagal membuat file ZIP' });
        }
    });

    archive.pipe(res);

    const files = fs.readdirSync(folderPath);
    for (const file of files) {
        if (file.endsWith('_mirror.jpg')) continue;
        const filePath = path.join(folderPath, file);
        if (fs.statSync(filePath).isFile()) {
            archive.file(filePath, { name: file });
        }
    }

    archive.finalize();
}

module.exports = {
    streamSessionZip
};
