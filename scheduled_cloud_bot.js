require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');

// Priority: SECRET first, then state file
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8747605183:AAGW6zNtd5CVscCWCf_5ZoGqnlRlnvqTWno';
const ENV_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const TEMP_DIR = path.join(__dirname, 'temp');
const STATE_FILE = path.join(__dirname, 'state.json');

fs.ensureDirSync(TEMP_DIR);

let appState = { counter: 5, telegramChatId: ENV_CHAT_ID };

if (fs.existsSync(STATE_FILE)) {
    try {
        const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        appState.counter = savedState.counter || 5;
        // Use secret if available, otherwise use from file
        appState.telegramChatId = ENV_CHAT_ID || savedState.telegramChatId;
    } catch (e) {
        console.error("Error reading state.json:", e);
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2));
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

client.on('qr', async (qr) => {
    console.log('SCAN THIS QR CODE WITH YOUR WHATSAPP:');
    qrcodeTerminal.generate(qr, { small: true });

    if (appState.telegramChatId) {
        try {
            const qrImageBuffer = await QRCode.toBuffer(qr);
            await bot.sendPhoto(appState.telegramChatId, qrImageBuffer, {
                caption: "🚨 *WhatsApp Login Required*\nScan this QR code using WhatsApp on your phone.",
                parse_mode: "Markdown"
            });
            console.log("Sent QR code to Telegram successfully.");
        } catch (err) {
            console.error("Error sending QR to Telegram:", err.message);
        }
    } else {
        console.log("CRITICAL ERROR: TELEGRAM_CHAT_ID is still empty. Please check GitHub Secrets.");
    }
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    if (appState.telegramChatId) {
        bot.sendMessage(appState.telegramChatId, "✅ Cloud Saree Bot connected and ready!");
    }
    setTimeout(() => { process.exit(0); }, 10 * 60 * 1000);
});

// ... (Baaki saara code niche ka same rahega)
// (Queue handling and PDF generation)
