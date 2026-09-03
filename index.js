const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());

const activeSockets = {};

// সকেট তৈরি ও হ্যান্ডলিংয়ের জন্য আলাদা ফাংশন
async function startWASocket(phone) {
    if (activeSockets[phone]) return activeSockets[phone];

    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${phone}`);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"] // Browser identity দেওয়া জরুরি
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log(`Connection closed for ${phone}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                await startWASocket(phone);
            } else {
                delete activeSockets[phone];
            }
        } else if (connection === 'open') {
            console.log(`WhatsApp connected successfully for: ${phone}`);
        }
    });

    activeSockets[phone] = sock;
    return sock;
}

// ১. পেয়ারিং কোড নেওয়ার রুট
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: "Phone number required" });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const sock = await startWASocket(phone);

        if (!sock.authState.creds.registered) {
            await delay(3000); // পেয়ারিং কোড জেনারেটের আগে ব্যাকএন্ডকে স্থির হওয়ার পর্যাপ্ত সময় দেওয়া
            const code = await sock.requestPairingCode(phone);
            return res.json({ status: true, code: code });
        } else {
            return res.json({ status: false, error: "Already registered" });
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

app.listen(3000, () => console.log('WA Pairing & Checker API running on port 3000'));
