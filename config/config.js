const path = require('path');
const os = require('os');
const dotenv = require('dotenv');

const apiRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(apiRoot, '.env') });

const resolveApiPath = (value, fallback) => {
    const selected = value || fallback;
    return path.isAbsolute(selected) ? selected : path.resolve(apiRoot, selected);
};

const boxId = process.env.BOX_ID || 'PHOTOBOX_EVENT';
const boxSlug = process.env.BOX_SLUG || 'box-event';
const port = Number(process.env.PORT || 3005);
const host = process.env.HOST || '0.0.0.0';

// Default folder digiCamControl pada Windows: Pictures/digiCamControl/Session1
const defaultDigiCamFolder = path.join(os.homedir(), 'Pictures', 'digiCamControl', 'Session1');

module.exports = {
    BOX_ID: boxId,
    BOX_SLUG: boxSlug,
    PORT: port,
    HOST: host,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '',
    BASE_PHOTO_FOLDER: resolveApiPath(
        process.env.BASE_PHOTO_FOLDER,
        `runtime/${boxSlug}/photos`
    ),
    FRAMES_FOLDER: resolveApiPath(
        process.env.FRAMES_FOLDER,
        'frames'
    ),
    FRAMES_DATA_FILE: resolveApiPath(
        process.env.FRAMES_DATA_FILE,
        'data/frames.json'
    ),
    DEVICE_CONFIG_FILE: resolveApiPath(
        process.env.DEVICE_CONFIG_FILE,
        'config/devices.json'
    ),
    LOG_FILE: resolveApiPath(process.env.LOG_FILE, 'state/logs/photobox_event.jsonl'),
    PRINTER_NAME: process.env.PRINTER_NAME || 'PHOTO_EVENT',
    PRINTER_AUTO_REBIND: process.env.PRINTER_AUTO_REBIND !== 'false',
    PRINTER_MEDIA: process.env.PRINTER_MEDIA || 'T4X6FULL',
    PRINTER_MEDIA_TYPE: process.env.PRINTER_MEDIA_TYPE || 'PLAIN_HIGH',
    PRINTER_BORDERLESS: process.env.PRINTER_BORDERLESS !== 'false',
    PRINTER_BORDERLESS_MEDIA_TYPE: process.env.PRINTER_BORDERLESS_MEDIA_TYPE || 'GLOSSYPHOTO_HIGH',
    PRINTER_INK: process.env.PRINTER_INK || 'COLOR',
    PRINT_WIDTH: Number(process.env.PRINT_WIDTH || 2880),
    PRINT_HEIGHT: Number(process.env.PRINT_HEIGHT || 4320),
    PRINT_DPI: Number(process.env.PRINT_DPI || 720),
    PRINT_SAFE_SCALE: Number(process.env.PRINT_SAFE_SCALE || 0.96),
    PRINT_OFFSET_X_MM: Number(process.env.PRINT_OFFSET_X_MM || 0),
    PRINT_OFFSET_Y_MM: Number(process.env.PRINT_OFFSET_Y_MM || -1),

    GIF_ENABLED: process.env.GIF_ENABLED !== 'false',
    GIF_FRAME_DELAY_MS: Number(process.env.GIF_FRAME_DELAY_MS || 500),
    GIF_MAX_WIDTH: Number(process.env.GIF_MAX_WIDTH || 720),

    // Konfigurasi Kamera & Driver (digicam untuk Windows, gphoto2 untuk Linux, mock untuk test)
    CAMERA_DRIVER: process.env.CAMERA_DRIVER || 'auto',
    DIGICAM_URL: process.env.DIGICAM_URL || 'http://127.0.0.1:8080',
    DIGICAM_PHOTO_FOLDER: process.env.DIGICAM_PHOTO_FOLDER || defaultDigiCamFolder,
    LIVEVIEW_FPS: Math.max(5, Math.min(60, Number(process.env.LIVEVIEW_FPS || 25))),

    SESSION_EXPIRY_DAYS: Number(process.env.SESSION_EXPIRY_DAYS || 3),
    ADMIN_WHATSAPP: process.env.ADMIN_WHATSAPP || '628123456789'
};
