const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs-extra');

const config = require('./config/config');
const networkService = require('./services/networkService');
const cameraService = require('./services/cameraService');
const downloadController = require('./controllers/downloadController');
const socketHandler = require('./sockets/socketHandler');
const logger = require('./services/logger');

const app = express();
const server = http.createServer(app);

// Inisialisasi Socket.IO
const io = require('socket.io')(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e8
});

// Pastikan folder runtime ada
fs.ensureDirSync(config.BASE_PHOTO_FOLDER);
fs.ensureDirSync(config.FRAMES_FOLDER);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Static Assets
app.use('/photos', express.static(config.BASE_PHOTO_FOLDER));
app.use('/frames', express.static(config.FRAMES_FOLDER));
app.use('/download-assets', express.static(path.join(__dirname, 'public')));

// Root info
app.get('/', (req, res) => {
    res.json({
        name: 'Diceritakita',
        version: '1.0.0',
        publicBaseUrl: networkService.resolvePublicBaseUrl(),
        localIp: networkService.getLocalIpAddress(),
        port: config.PORT
    });
});

// Portal Unduh Tamu (Scan QR Code)
app.get('/d/:sessionId', downloadController.renderDownloadPage);
app.get('/api/session/:sessionId/details', downloadController.getSessionDetails);
app.get('/api/session/:sessionId/zip', downloadController.downloadZip);
app.get('/api/session/:sessionId/download/:filename', downloadController.downloadFile);

// Info Jaringan & Status
app.get('/api/system/network-info', (req, res) => {
    res.json({
        localIp: networkService.getLocalIpAddress(),
        publicBaseUrl: networkService.resolvePublicBaseUrl(),
        isTunnel: networkService.resolvePublicBaseUrl().startsWith('https://'),
        port: config.PORT
    });
});

app.get('/preview-frame', (req, res) => {
    cameraService.getSinglePreviewFrame(res);
});


socketHandler(io);

if (require.main === module) {
    server.listen(config.PORT, config.HOST, () => {
        const publicUrl = networkService.resolvePublicBaseUrl();
        console.log(`====================================================`);
        console.log(`🎉 DICERITAKITA API BERHASIL AKTIF!`);
        console.log(`📡 Port Lokal : http://${config.HOST}:${config.PORT}`);
        console.log(`🌐 Base URL   : ${publicUrl}`);
        console.log(`📸 Simpan Foto: ${config.BASE_PHOTO_FOLDER}`);
        console.log(`🖼️ Folder Frame: ${config.FRAMES_FOLDER}`);
        console.log(`====================================================`);
        logger.info('server_started', { port: config.PORT, publicUrl });
    });
}

module.exports = { app, server };
