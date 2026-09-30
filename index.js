const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const activeSockets = {};
const PORT = process.env.PORT || 3000;

// সেশন ডিরেক্টরি নিশ্চিত করা
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// সকেট তৈরি ও হ্যান্ডলিংয়ের জন্য ফাংশন
async function startWASocket(phone) {
    if (activeSockets[phone]) return activeSockets[phone];

    const sessionPath = path.join(sessionsDir, phone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        // Baileys-এর জন্য সঠিক ব্রাউজার নাম যা 'Logging in...' হ্যাং হওয়া আটকাবে
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
                // ১.৫ সেকেন্ড বিরতি দিয়ে রিকানেক্ট
                await delay(1500);
                delete activeSockets[phone];
                await startWASocket(phone);
            } else {
                delete activeSockets[phone];
                // সেশন লগআউট হয়ে গেলে পুরোনো সেশন ফোল্ডার ডিলেট করা
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

// সার্ভার চালু হওয়ার সময় বিদ্যমান সেশন অটো রিকানেক্ট করার লজিক
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

// ১. পেয়ারিং কোড নেওয়ার রুট
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ status: false, error: "Phone number required" });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const sock = await startWASocket(phone);

        if (!sock.authState.creds.registered) {
            await delay(3000); // পেয়ারিং কোড জেনারেটের আগে ব্যাকএন্ডকে স্থির হওয়ার পর্যাপ্ত সময় দেওয়া
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

// ২. নম্বর চেক করার রুট
app.get('/check', async (req, res) => {
    let { sender, target } = req.query;

    if (!sender || !target) {
        return res.status(400).json({ status: false, error: "sender এবং target দুটিই প্রয়োজন।" });
    }

    sender = sender.replace(/[^0-9]/g, '');
    target = target.replace(/[^0-9]/g, '');

    const sock = activeSockets[sender];

    if (!sock) {
        return res.status(400).json({ status: false, error: "Sender number is not connected or logged in." });
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
