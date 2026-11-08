let activeUserFolder = 'EVT_DEFAULT';
let currentSessionId = null;

const sanitizeUserName = (raw) => {
    if (!raw || typeof raw !== 'string') return 'GUEST';
    const clean = raw.trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase();
    return clean.substring(0, 15) || 'GUEST';
};

const parseSessionId = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') return { userName: 'GUEST' };
    const parts = sessionId.split('_');
    if (parts.length >= 5) {
        const ymd = parts[1];
        const time = parts[2];
        const userName = parts.slice(3, parts.length - 1).join('_');
        return { ymd, time, userName };
    } else if (parts.length === 4) {
        return { ymd: parts[1], time: parts[2], userName: 'GUEST' };
    }
    return { userName: 'GUEST' };
};

module.exports = {
    sanitizeUserName,
    parseSessionId,
    getActiveUserFolder: () => activeUserFolder,
    setActiveUserFolder: (folder) => {
        activeUserFolder = folder;
    },
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: (id) => {
        currentSessionId = id;
    },
    generateSessionId: (userNameInput) => {
        const now = new Date();
        const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
        const random = Math.floor(100 + Math.random() * 900);
        const namePart = sanitizeUserName(userNameInput);
        const id = `EVT_${ymd}_${time}_${namePart}_${random}`;
        activeUserFolder = id;
        currentSessionId = id;
        return id;
    }
};
