const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const { io: Client } = require('socket.io-client');
const assert = require('assert');
const sharp = require('sharp');

// Set port dan environment khusus untuk pengujian digiCamControl
const TEST_PORT = 3099;
const MOCK_DIGICAM_PORT = 8899;
const TEST_TMP_DIR = path.join(__dirname, '..', 'runtime', 'test-digicam');
const TEST_DIGICAM_WATCH_DIR = path.join(TEST_TMP_DIR, 'digicam_session');
const TEST_SESSION_DIR = path.join(TEST_TMP_DIR, 'photos');

process.env.NODE_ENV = 'test';
process.env.PORT = String(TEST_PORT);
process.env.CAMERA_DRIVER = 'digicam';
process.env.DIGICAM_URL = `http://127.0.0.1:${MOCK_DIGICAM_PORT}`;
process.env.DIGICAM_PHOTO_FOLDER = TEST_DIGICAM_WATCH_DIR;
process.env.BASE_PHOTO_FOLDER = TEST_SESSION_DIR;
process.env.MOCK_PRINTER = 'true';

const config = require('../config/config');
const { app, server } = require('../app');
const cameraService = require('../services/cameraService');
const session = require('../state/session');

// Server tiruan digiCamControl HTTP API
let mockDigiCamServer = null;
let lastCommandsReceived = [];
let isLiveViewOpen = false;
let mockLiveViewBuffer = null;

async function createSampleJpeg(width = 640, height = 480, text = 'digiCamControl') {
    return sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 40, g: 70, b: 120 }
        }
    })
    .composite([
        {
            input: Buffer.from(
                `<svg width="${width}" height="${height}">
                    <text x="50%" y="50%" text-anchor="middle" fill="#FFFFFF" font-size="24">${text}</text>
                </svg>`
            ),
            top: 0,
            left: 0
        }
    ])
    .jpeg({ quality: 80 })
    .toBuffer();
}

function startMockDigiCamServer(port) {
    return new Promise((resolve) => {
        mockDigiCamServer = http.createServer(async (req, res) => {
            lastCommandsReceived.push(req.url);

            if (req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h1>digiCamControl Web Server</h1><p>Canon EOS 1500D</p></body></html>');
            } else if (req.url.includes('LiveViewWnd_Show')) {
                isLiveViewOpen = true;
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK: LiveView Shown');
            } else if (req.url.includes('LiveViewWnd_Hide')) {
                isLiveViewOpen = false;
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK: LiveView Hidden');
            } else if (req.url.includes('/liveview.jpg')) {
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                res.end(mockLiveViewBuffer);
            } else if (req.url.includes('capture')) {
                // Simulasikan digiCamControl mengambil foto dan menyimpannya di folder sesi digiCam
                setTimeout(async () => {
                    const samplePhoto = await createSampleJpeg(1920, 1080, 'Captured DSLR Photo');
                    const photoPath = path.join(TEST_DIGICAM_WATCH_DIR, `DSC_${Date.now()}.JPG`);
                    fs.writeFileSync(photoPath, samplePhoto);
                }, 100);

                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK: Captured');
            } else if (req.url.includes('autofocus') || req.url.includes('set')) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            }
        });

        mockDigiCamServer.listen(port, '127.0.0.1', resolve);
    });
}

async function runDigiCamTestSuite() {
    console.log('🧪 [TEST SUITE] Memulai Pengujian Khusus Windows & digiCamControl Integration Suite...\n');

    fs.ensureDirSync(TEST_DIGICAM_WATCH_DIR);
    fs.ensureDirSync(TEST_SESSION_DIR);
    mockLiveViewBuffer = await createSampleJpeg(640, 480, 'digiCam LiveView Frame');

    // 1. Jalankan Mock Server digiCamControl
    await startMockDigiCamServer(MOCK_DIGICAM_PORT);
    console.log(`✅ [1/8] Mock digiCamControl server aktif pada http://127.0.0.1:${MOCK_DIGICAM_PORT}`);

    // 2. Start API Server
    await new Promise((resolve) => {
        server.listen(TEST_PORT, '127.0.0.1', resolve);
    });
    const apiUrl = `http://127.0.0.1:${TEST_PORT}`;
    console.log(`✅ [2/8] Photobox Event API aktif pada ${apiUrl}`);

    // 3. Uji Driver Resolution
    const activeDriver = cameraService.resolveDriver();
    assert.strictEqual(activeDriver, 'digicam', 'Driver kamera harus "digicam"');
    console.log(`✅ [3/8] Driver terdeteksi dengan tepat: ${activeDriver.toUpperCase()}`);

    // 4. Uji Status Kamera (Online vs Offline)
    // A. Online
    const statusOnline = await cameraService.getCameraStatus();
    assert.strictEqual(statusOnline.ok, true);
    assert.strictEqual(statusOnline.connected, true);
    assert.strictEqual(statusOnline.driver, 'digicam');

    // Uji endpoint HTTP /api/system/camera-status
    const resHttp = await fetch(`${apiUrl}/api/system/camera-status`);
    const jsonHttp = await resHttp.json();
    assert.strictEqual(jsonHttp.ok, true);
    assert.strictEqual(jsonHttp.driver, 'digicam');
    console.log('✅ [4/8] Status kamera online terverifikasi (Service & HTTP Endpoint)');

    // 5. Uji Perintah Hardware Kamera (Autofocus, ISO, Shutter, Mirror)
    lastCommandsReceived = [];
    const afRes = await cameraService.triggerAutoFocus();
    assert.strictEqual(afRes.ok, true);
    const isoRes = await cameraService.setIso('800');
    assert.strictEqual(isoRes.ok, true);
    const shutterRes = await cameraService.setShutterSpeed('1/125');
    assert.strictEqual(shutterRes.ok, true);
    const mirrorRes = await cameraService.setMirror(true);
    assert.strictEqual(mirrorRes.ok, true);

    assert.ok(lastCommandsReceived.some(cmd => cmd.includes('autofocus')), 'Command autofocus terkirim');
    assert.ok(lastCommandsReceived.some(cmd => cmd.includes('iso')), 'Command ISO terkirim');
    assert.ok(lastCommandsReceived.some(cmd => cmd.includes('shutterspeed')), 'Command shutter terkirim');
    assert.ok(lastCommandsReceived.some(cmd => cmd.includes('flip.horizontal')), 'Command mirror terkirim');
    console.log('✅ [5/8] Semua perintah hardware kamera (Autofocus, ISO, Shutter, Mirror) berhasil dieksekusi');

    // 6. Hubungkan Socket.IO Client dan Uji Live View Streaming
    const socketClient = Client(apiUrl);
    await new Promise((resolve, reject) => {
        socketClient.on('connect', resolve);
        socketClient.on('connect_error', reject);
    });

    const receivedFrameBase64 = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout menunggu liveview-frame')), 5000);
        socketClient.on('liveview-frame', (base64Data) => {
            clearTimeout(timeout);
            resolve(base64Data);
        });
        socketClient.emit('start-liveview');
    });

    assert.ok(receivedFrameBase64 && receivedFrameBase64.length > 50, 'Liveview frame harus berupa base64 non-empty');
    assert.strictEqual(isLiveViewOpen, true, 'digiCamControl LiveView window harus aktif');

    // Hentikan live view
    socketClient.emit('stop-liveview');
    await new Promise(r => setTimeout(r, 200));
    console.log(`✅ [6/8] Live View streaming Socket.IO berhasil menerima frame (~${receivedFrameBase64.length} bytes base64)`);

    // 7. Uji Pengambilan Foto (take-photo via digiCamControl)
    session.setActiveUserFolder('EVT_TEST_WINDOWS_001');
    const userFolder = path.join(TEST_SESSION_DIR, 'EVT_TEST_WINDOWS_001');
    fs.ensureDirSync(userFolder);

    const photoResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout menunggu photo-ready / photo-taken')), 15000);
        let readyReceived = null;
        let takenReceived = null;

        const checkDone = () => {
            if (readyReceived && takenReceived) {
                clearTimeout(timeout);
                resolve({ readyReceived, takenReceived });
            }
        };

        socketClient.on('photo-ready', (data) => {
            readyReceived = data;
            checkDone();
        });
        socketClient.on('photo-taken', (data) => {
            takenReceived = data;
            checkDone();
        });

        socketClient.emit('take-photo');
    });

    assert.ok(photoResult.readyReceived.url.includes('EVT_TEST_WINDOWS_001'), 'URL photo-ready harus valid');
    assert.ok(photoResult.takenReceived.url.includes('EVT_TEST_WINDOWS_001'), 'URL photo-taken harus valid');
    assert.ok(fs.existsSync(photoResult.readyReceived.localPath), 'File hasil foto harus tersimpan di session folder');

    // Verifikasi metadata berkas foto menggunakan sharp
    const photoMeta = await sharp(photoResult.readyReceived.localPath).metadata();
    assert.strictEqual(photoMeta.format, 'jpeg');
    console.log(`✅ [7/8] Siklus jepret digiCamControl sukses: file ${photoMeta.width}x${photoMeta.height} px tersimpan & kedua event (photo-ready + photo-taken) diterima`);

    // 8. Uji Remote Shutter Eksternal (Folder Watcher Ingestion)
    const remotePhotoResult = await new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout menunggu remote shutter ingestion')), 10000);
        socketClient.on('photo-ready', (data) => {
            if (data.filename.includes('REMOTE')) {
                clearTimeout(timeout);
                resolve(data);
            }
        });

        // Simulasikan kamera dipicu tombol fisik/remote nirkabel -> file muncul di folder digiCamControl
        const remoteBuffer = await createSampleJpeg(1920, 1080, 'Physical Remote Shutter Click');
        const remoteFilePath = path.join(TEST_DIGICAM_WATCH_DIR, `DSC_REMOTE_${Date.now()}.JPG`);
        fs.writeFileSync(remoteFilePath, remoteBuffer);
    });

    assert.ok(fs.existsSync(remotePhotoResult.localPath), 'Foto dari remote shutter fisik harus berhasil diamankan ke sesi');
    console.log(`✅ [8/8] Deteksi Shutter Tombol Fisik / Remote Nirkabel (Folder Watcher) berhasil mengamankan foto: ${remotePhotoResult.filename}`);

    // Bersihkan resources
    socketClient.disconnect();
    await cameraService.shutdown();
    await new Promise(r => server.close(r));
    await new Promise(r => mockDigiCamServer.close(r));
    await new Promise(r => setTimeout(r, 500));
    await fs.remove(TEST_TMP_DIR).catch(() => {});

    console.log('\n🎉 SEMUA 8/8 PENGUJIAN DIGICAMCONTROL & WINDOWS BERHASIL LULUS 100% (EXIT CODE 0)\n');
}

runDigiCamTestSuite().catch((err) => {
    console.error('\n❌ TEST SUITE DIGICAM GAGAL:', err);
    process.exit(1);
});
