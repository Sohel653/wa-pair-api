const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(express.json());

// সক্রিয় WhatsApp Socket অবজেক্টগুলো স্টোর করার জন্য
const activeSockets = {};

// ১. পেয়ারিং কোড নেওয়ার রুট
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: "Phone number required" });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${phone}`);
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);

        // কানেকশন আপডেট হ্যান্ডলার
        sock.ev.on('connection.update', (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log(`WhatsApp connected for: ${phone}`);
                activeSockets[phone] = sock; // সেশন মেমোরিতে সেভ
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);
            const code = await sock.requestPairingCode(phone);
            return res.json({ status: true, code: code });
        } else {
            activeSockets[phone] = sock; // ইতোমধ্যে রেজিস্ট্রেশন করা থাকলে মেমোরিতে রাখা
            return res.json({ status: false, error: "Already registered" });
        }
    } catch (err) {
        return res.status(500).json({ status: false, error: err.message });
    }
});

// ২. নম্বর চেক করার নতুন রুট (WhatsApp Active কি না)
app.get('/check', async (req, res) => {
    let { sender, target } = req.query;

    if (!sender || !target) {
        return res.status(400).json({ status: false, error: "sender (লগইন করা নম্বর) এবং target (চেক করার নম্বর) দুটিই প্রয়োজন।" });
    }

    sender = sender.replace(/[^0-9]/g, '');
    target = target.replace(/[^0-9]/g, '');

    const sock = activeSockets[sender];

    if (!sock) {
        return res.status(400).json({ status: false, error: "Sender number is not connected or logged in." });
    }

    try {
        // WhatsApp এ নম্বরটি আছে কি না চেক
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
