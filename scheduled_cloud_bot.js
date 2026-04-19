require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');

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
        appState.telegramChatId = ENV_CHAT_ID || savedState.telegramChatId;
    } catch (e) { console.error("Error reading state.json:", e); }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2));
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        executablePath: '/usr/bin/google-chrome-stable'
    }
});

client.on('qr', async (qr) => {
    console.log('SCAN THIS QR CODE:');
    qrcodeTerminal.generate(qr, { small: true });
    if (appState.telegramChatId) {
        try {
            const qrImageBuffer = await QRCode.toBuffer(qr);
            await bot.sendPhoto(appState.telegramChatId, qrImageBuffer, { caption: "🚨 *WhatsApp Login Required*" });
        } catch (err) { console.error("QR Error:", err.message); }
    }
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready! Monitoring SELF CHAT only.');
    if (appState.telegramChatId) bot.sendMessage(appState.telegramChatId, "✅ Cloud Saree Bot connected! Monitoring Self-Chat only.");
    setTimeout(() => { process.exit(0); }, 10 * 60 * 1000);
});

const chatQueues = {};

client.on('message_create', async (msg) => {
    // SIRF SELF CHAT CHECK: Kya ye message mere khud ke number se hai aur mujhe hi bhej gaya hai?
    const myId = client.info.wid._serialized;
    const isSelfChat = (msg.from === myId && msg.to === myId);

    if (!isSelfChat) return; // Agar self-chat nahi hai, toh kuch mat karo.

    if (!chatQueues[myId]) chatQueues[myId] = { images: [], textMsg: null };
    const q = chatQueues[myId];

    if (msg.hasMedia && msg.type === 'image') {
        q.images.push(msg);
        console.log(`Self Chat: Queued ${q.images.length} images`);
    } else if (msg.body && q.images.length >= 5) {
        q.textMsg = msg;
        console.log("Self Chat: Description received. Creating PDF...");

        // PDF Generation Logic
        const title = `Saree_${appState.counter.toString().padStart(2, '0')}`;
        appState.counter++;
        saveState();
        const pdfPath = path.join(TEMP_DIR, `${title}.pdf`);

        try {
            const doc = new PDFDocument();
            const stream = fs.createWriteStream(pdfPath);
            doc.pipe(stream);
            doc.fontSize(25).text(title, { align: 'center' });
            for (const imgMsg of q.images) {
                const media = await imgMsg.downloadMedia();
                if (media) {
                    const imgLocalPath = path.join(TEMP_DIR, `temp_${Date.now()}.jpg`);
                    fs.writeFileSync(imgLocalPath, Buffer.from(media.data, 'base64'));
                    doc.addPage().image(imgLocalPath, { fit: [500, 700], align: 'center' });
                    fs.unlinkSync(imgLocalPath);
                }
            }
            doc.addPage().fontSize(15).text("Description: " + q.textMsg.body);
            doc.end();
            stream.on('finish', async () => {
                await bot.sendDocument(appState.telegramChatId, pdfPath, { caption: `Generated for ${title}` });
                fs.unlinkSync(pdfPath);
                console.log(`Success: ${title} sent to Telegram!`);
            });
        } catch (e) { console.error(e); }
        delete chatQueues[myId]; // Reset queue after processing
    }
});

console.log("Starting WhatsApp Client...");
client.initialize();
