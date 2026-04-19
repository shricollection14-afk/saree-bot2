require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8747605183:AAGW6zNtd5CVscCWCf_5ZoGqnlRlnvqTWno';
const ENV_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const TEMP_DIR = path.join(__dirname, 'temp');
const STATE_FILE = path.join(__dirname, 'state.json');

fs.ensureDirSync(TEMP_DIR);

let appState = { counter: 5, telegramChatId: ENV_CHAT_ID };

// Load State
if (fs.existsSync(STATE_FILE)) {
    try {
        const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        appState.counter = savedState.counter || 5;
        appState.telegramChatId = ENV_CHAT_ID || savedState.telegramChatId;
    } catch (e) { console.error("Error reading state.json:", e); }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2));
}

// Initialize WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions'
        ],
        executablePath: '/usr/bin/google-chrome-stable'
    }
});

client.on('qr', async (qr) => {
    console.log('SCAN THIS QR CODE WITH YOUR WHATSAPP:');
    qrcodeTerminal.generate(qr, { small: true });

    if (appState.telegramChatId) {
        try {
            const qrImageBuffer = await QRCode.toBuffer(qr);
            await bot.sendPhoto(appState.telegramChatId, qrImageBuffer, {
                caption: "🚨 *WhatsApp Login Required*\nScan this QR code using WhatsApp on your phone."
            });
            console.log("Sent QR to Telegram!");
        } catch (err) { console.error("Telegram QR Error:", err.message); }
    }
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    if (appState.telegramChatId) {
        bot.sendMessage(appState.telegramChatId, "✅ Cloud Saree Bot connected and ready!");
    }
    // Shut down after 10 mins
    setTimeout(() => { process.exit(0); }, 10 * 60 * 1000);
});

const chatQueues = {};

async function processBatch(chatId) {
    const queue = chatQueues[chatId];
    if (!queue || queue.images.length < 5) return;

    const currentCount = appState.counter++;
    saveState();
    const title = `Saree_${currentCount.toString().padStart(2, '0')}`;
    const pdfPath = path.join(TEMP_DIR, `${title}.pdf`);

    console.log(`Creating PDF for ${title}...`);
    try {
        const doc = new PDFDocument();
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);
        doc.fontSize(25).text(title, { align: 'center' });

        for (const msg of queue.images) {
            const media = await msg.downloadMedia();
            if (media) {
                const imgPath = path.join(TEMP_DIR, `temp_${Date.now()}.jpg`);
                fs.writeFileSync(imgPath, Buffer.from(media.data, 'base64'));
                doc.addPage().image(imgPath, { fit: [500, 700], align: 'center' });
                fs.unlinkSync(imgPath);
            }
        }
        doc.addPage().fontSize(15).text("Description: " + queue.textMsg.body);
        doc.end();

        stream.on('finish', async () => {
            await bot.sendDocument(appState.telegramChatId, pdfPath);
            fs.unlinkSync(pdfPath);
            console.log("PDF Sent!");
        });
    } catch (e) { console.error(e); }
    delete chatQueues[chatId];
}

client.on('message_create', async (msg) => {
    const chatId = msg.from;
    if (!chatQueues[chatId]) chatQueues[chatId] = { images: [], textMsg: null };
    const q = chatQueues[chatId];

    if (msg.hasMedia && msg.type === 'image') {
        q.images.push(msg);
    } else if (msg.body && q.images.length > 0) {
        q.textMsg = msg;
        processBatch(chatId);
    }
});

console.log("Starting WhatsApp Client...");
client.initialize();
