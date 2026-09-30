const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const activeSockets = {};
const PORT = process.env.PORT || 3000;

const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

async function startWASocket(phone) {
    if (activeSockets[phone]) return activeSockets[phone];

    const sessionPath = path.join(sessionsDir, phone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 500
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed for ${phone}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                await delay(1500);
                delete activeSockets[phone];
                await startWASocket(phone);
            } else {
                delete activeSockets[phone];
                try {
                    if (fs.existsSync(sessionPath)) {
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                    }
                } catch (e) {}
            }
        } else if (connection === 'open') {
            console.log(`WhatsApp connected successfully for: ${phone}`);
            activeSockets[phone] = sock;
        }
    });

    activeSockets[phone] = sock;
    return sock;
}

async function initExistingSessions() {
    if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);
        for (const folder of folders) {
            if (fs.lstatSync(path.join(sessionsDir, folder)).isDirectory()) {
                console.log(`Restoring existing session for: ${folder}`);
                try {
                    await startWASocket(folder);
                } catch (e) {
                    console.error(`Failed to restore session for ${folder}:`, e.message);
                }
            }
        }
    }
}

// 1. Pairing Code Endpoint
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ status: false, error: "Phone number required" });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const sock = await startWASocket(phone);

        if (!sock.authState.creds.registered) {
            await delay(3000);
            const code = await sock.requestPairingCode(phone);
            return res.json({ status: true, code: code });
        } else {
            return res.json({ status: false, error: "Already registered and connected" });
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: false, error: err.message });
    }
});

// 2. Session Status Endpoint
app.get('/status', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ status: false, error: "Phone number required" });
    phone = phone.replace(/[^0-9]/g, '');

    const sock = activeSockets[phone];
    if (sock && sock.user) {
        return res.json({ status: true, connected: true, user: sock.user });
    } else {
        return res.json({ status: true, connected: false });
    }
});

// 3. Delete / Logout Endpoint
app.get('/logout', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ status: false, error: "Phone number required" });
    phone = phone.replace(/[^0-9]/g, '');

    const sock = activeSockets[phone];
    const sessionPath = path.join(sessionsDir, phone);

    try {
        if (sock) {
            await sock.logout();
            delete activeSockets[phone];
        }
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        return res.json({ status: true, message: "Session deleted successfully" });
    } catch (err) {
        return res.status(500).json({ status: false, error: err.message });
    }
});

// 4. Number Check Endpoint
app.get('/check', async (req, res) => {
    let { sender, target } = req.query;

    if (!sender || !target) {
        return res.status(400).json({ status: false, error: "sender and target required" });
    }

    sender = sender.replace(/[^0-9]/g, '');
    target = target.replace(/[^0-9]/g, '');

    const sock = activeSockets[sender];

    if (!sock) {
        return res.status(400).json({ status: false, error: "Sender number is not connected" });
    }

    try {
        const results = await sock.onWhatsApp(target);

        if (results && results.length > 0 && results[0].exists) {
            return res.json({
                status: true,
                exists: true,
                jid: results[0].jid,
                phone: target,
                message: "WhatsApp account exists!"
            });
        } else {
            return res.json({
                status: true,
                exists: false,
                phone: target,
                message: "No WhatsApp account found."
            });
        }
    } catch (err) {
        return res.status(500).json({ status: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`WA Pairing & Checker API running on port ${PORT}`);
    initExistingSessions();
});
