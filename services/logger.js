const fs = require('fs-extra');
const path = require('path');

const logPath = path.resolve(__dirname, '..', 'state', 'logs', 'photobox_event.jsonl');
fs.ensureDirSync(path.dirname(logPath));

const writeLog = (level, event, data = {}) => {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        event,
        ...data
    };
    try {
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) {}
    if (level === 'error') {
        console.error(`[ERROR] [${event}]`, data);
    } else {
        console.log(`[${level.toUpperCase()}] [${event}]`, Object.keys(data).length ? JSON.stringify(data) : '');
    }
};

module.exports = {
    info: (event, data) => writeLog('info', event, data),
    warn: (event, data) => writeLog('warn', event, data),
    error: (event, data) => writeLog('error', event, data)
};
