const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const { io: Client } = require('socket.io-client');
const assert = require('assert');

// Set testing environment
process.env.NODE_ENV = 'test';
process.env.MOCK_PRINTER = 'true';
process.env.PORT = '3088';
process.env.CAMERA_DRIVER = 'mock';
process.env.PRINT_WIDTH = '1200';
process.env.PRINT_HEIGHT = '1800';

const { app, server } = require('../app');
const config = require('../config/config');
const session = require('../state/session');

async function runTests() {
    console.log('🧪 [TEST SUITE] Memulai Pengujian Otomatis Photobox EVENT (User Naming & Expiry Suite)...\n');

    // 0. Unit Test: Sanitasi & Parsing Nama User
    const sanitized1 = session.sanitizeUserName('  Budi Santoso & Rina! ');
    assert.strictEqual(sanitized1, 'BUDI_SANTOSO_RI', 'Sanitasi nama harus huruf kapital, tanpa simbol aneh, maks 15 karakter');
    const sanitizedEmpty = session.sanitizeUserName('');
    assert.strictEqual(sanitizedEmpty, 'GUEST', 'Nama kosong harus fallback ke GUEST');

    const parsedSample = session.parseSessionId('EVT_20261104_143022_ANDI_782');
    assert.strictEqual(parsedSample.userName, 'ANDI');
    assert.strictEqual(parsedSample.ymd, '20261104');
    assert.strictEqual(parsedSample.time, '143022');
    console.log('✅ [1/8] Unit Test: Sanitasi nama user & parsing metadata sesi berhasil');

    // Start server untuk pengujian
    await new Promise((resolve) => {
        server.listen(3088, '127.0.0.1', resolve);
    });

    const serverUrl = `http://127.0.0.1:3088`;
    console.log(`✅ [2/8] Server aktif pada ${serverUrl}`);

    // 1. Uji Endpoint Root & Network Info & ngrok auto-skip warning header
    const rawRes = await makeRawResponse(`${serverUrl}/api/system/network-info`);
    assert.strictEqual(rawRes.headers['ngrok-skip-browser-warning'], 'true', 'Header bypass warning ngrok harus terpasang');
    const netInfo = JSON.parse(rawRes.body);
    assert.strictEqual(typeof netInfo.localIp, 'string');
    assert.strictEqual(netInfo.port, 3088);
    console.log(`✅ [3/8] Network Info valid: Local IP = ${netInfo.localIp}, Base URL = ${netInfo.publicBaseUrl} (Bypass ngrok header verified)`);

    // 1.1 Uji Auto-Detect ngrok Tunnel (Bebas IP)
    const mockNgrok = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            tunnels: [
                { proto: 'http', public_url: 'http://photobox.ngrok-free.app' },
                { proto: 'https', public_url: 'https://photobox.ngrok-free.app' }
            ]
        }));
    });
    await new Promise(r => mockNgrok.listen(4048, '127.0.0.1', r));
    const networkService = require('../services/networkService');
    const detectedUrl = await networkService.detectNgrokTunnel('http://127.0.0.1:4048/api/tunnels');
    assert.strictEqual(detectedUrl, 'https://photobox.ngrok-free.app', 'ngrok HTTPS tunnel harus otomatis terdeteksi');
    await new Promise(r => mockNgrok.close(r));

    // 2. Hubungkan Socket.IO Client
    const client = Client(serverUrl);
    await new Promise((resolve, reject) => {
        client.on('connect', resolve);
        client.on('connect_error', reject);
    });
    console.log('✅ [4/8] Socket.IO Client terhubung');

    // 3. Uji Preflight Check
    const preflight = await new Promise((resolve) => {
        client.emit('preflight-check');
        client.on('preflight-result', resolve);
    });
    assert.strictEqual(preflight.ok, true, 'Preflight harus OK');
    assert.ok(preflight.checks.api.ok, 'API check OK');
    assert.ok(preflight.checks.storage.ok, 'Storage check OK');
    console.log('✅ [5/8] Preflight Check Lulus (Tanpa dependensi WhatsApp)');

    // 4. Uji Mulai Sesi Baru dengan Nama Tamu
    const sessionRes = await new Promise((resolve) => {
        client.emit('start-new-session', { userName: 'Sarah' });
        client.on('session-started', resolve);
    });
    const sessionId = sessionRes.sessionId;
    assert.ok(sessionId.startsWith('EVT_'), 'Session ID harus berawalan EVT_');
    assert.ok(sessionId.includes('_SARAH_'), 'Session ID harus memuat nama SARAH');
    console.log(`✅ [6/8] Sesi tamu baru dengan nama terstruktur berhasil dibuat: ${sessionId}`);

    // Buat 3 mock photo di folder sesi
    const sessionFolder = path.join(config.BASE_PHOTO_FOLDER, sessionId);
    fs.ensureDirSync(sessionFolder);
    const mockPhotos = [];
    const sharp = require('sharp');
    for (let i = 1; i <= 3; i++) {
        const photoPath = path.join(sessionFolder, `IMG_${Date.now()}_${i}.jpg`);
        await sharp({
            create: { width: 600, height: 400, channels: 3, background: { r: 50 * i, g: 80, b: 120 } }
        }).jpeg().toFile(photoPath);
        mockPhotos.push(photoPath);
    }

    // 5. Uji Send-Results (Rendering Kolase + Generate QR Code + Spool Print)
    const resultReady = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout menunggu session-results-ready')), 30000);
        client.emit('send-results', {
            frameName: 'anniversary_1_year',
            photos: mockPhotos,
            printCopies: 2,
            generateGif: false
        });
        client.on('session-results-ready', (data) => {
            clearTimeout(timeout);
            resolve(data);
        });
    });

    assert.strictEqual(resultReady.ok, true);
    assert.strictEqual(resultReady.sessionId, sessionId);
    assert.strictEqual(resultReady.printCopies, 2, 'Jumlah cetak harus sesuai (2)');
    assert.ok(resultReady.qrCodeDataUrl.startsWith('data:image/png;base64,'), 'QR Code Data URL harus valid');
    assert.ok(resultReady.downloadUrl.includes(`/d/${sessionId}`), 'Download URL harus mengarah ke sesi');
    console.log(`✅ [7/8] Sesi foto SARAH berhasil diproses:`);
    console.log(`   - QR Code Data URL length: ${resultReady.qrCodeDataUrl.length} bytes`);
    console.log(`   - Download URL: ${resultReady.downloadUrl}`);
    console.log(`   - Kolase URL: ${resultReady.collageUrl}`);

    // 6. Uji Endpoint Download untuk Tamu & Validasi Masa Aktif / Expiry
    const pageHtml = await makeRawRequest(`${serverUrl}/d/${sessionId}`);
    assert.ok(pageHtml.includes('sessionStatusCard'), 'Halaman web harus memuat card status masa unduh');
    assert.ok(pageHtml.includes('guestNameBadge'), 'Halaman web harus memuat badge nama tamu');
    assert.ok(pageHtml.includes('adminHelpCard'), 'Halaman web harus memuat kartu bantuan admin');

    const detailsJson = await makeRequest(`${serverUrl}/api/session/${sessionId}/details`);
    assert.strictEqual(detailsJson.ok, true);
    assert.strictEqual(detailsJson.userName, 'SARAH', 'Detail sesi harus mengembalikan nama SARAH');
    assert.strictEqual(detailsJson.isExpired, false, 'Sesi baru tidak boleh expired');
    assert.ok(detailsJson.daysRemaining >= 1, 'Masa aktif minimal 1 hari');
    assert.ok(detailsJson.adminWhatsApp, 'Kontak admin WhatsApp harus ada');
    assert.ok(detailsJson.frame.includes('Cetak_Frame_'), 'Frame foto harus terdeteksi');

    // 7. Uji Halaman Sesi Expired / Tidak Ditemukan
    const expiredRes = await makeRawResponse(`${serverUrl}/d/EVT_20261101_100000_BUDI_999`);
    assert.strictEqual(expiredRes.statusCode, 404, 'Sesi tidak ada/expired harus HTTP 404');
    assert.ok(expiredRes.body.includes('BUDI'), 'Halaman 404 harus menyebut nama tamu BUDI');
    assert.ok(expiredRes.body.includes('KEDALUWARSA / TIDAK DITEMUKAN'), 'Halaman 404 harus memuat label kedaluwarsa');
    assert.ok(expiredRes.body.includes('wa.me'), 'Halaman 404 harus memuat link direct WhatsApp admin');

    // 8. Uji Download ZIP Tamu
    const zipBuffer = await makeBufferRequest(`${serverUrl}/api/session/${sessionId}/zip`);
    assert.ok(zipBuffer.length > 500, 'ZIP file harus berisi data gambar');
    assert.strictEqual(zipBuffer[0], 0x50, 'Byte pertama ZIP harus PK');
    assert.strictEqual(zipBuffer[1], 0x4B, 'Byte kedua ZIP harus PK');
    console.log(`✅ [8/8] Verifikasi Lengkap Selesai:`);
    console.log(`   - Status Kadaluarsa: Valid & Aktif (${detailsJson.daysRemaining} hari tersisa)`);
    console.log(`   - Halaman 404 / Expired: Responsif dengan direct link WA admin`);
    console.log(`   - ZIP Archive Tamu: ${zipBuffer.length} bytes (Magic byte PK)`);

    client.disconnect();
    server.close();
    console.log('\n🎉 SEMUA 8/8 PENGUJIAN OTOMATIS BERHASIL LULUS 100% (EXIT CODE 0)\n');
    process.exit(0);
}

function makeRequest(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(data); }
            });
        }).on('error', reject);
    });
}

function makeRawRequest(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function makeRawResponse(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        }).on('error', reject);
    });
}

function makeBufferRequest(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

runTests().catch((err) => {
    console.error('❌ PENGUJIAN GAGAL:', err);
    process.exit(1);
});
