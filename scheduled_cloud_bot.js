require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
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
    } catch (e) {}
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
    qrcodeTerminal.generate(qr, { small: true });
    if (appState.telegramChatId) {
        const qrImageBuffer = await QRCode.toBuffer(qr);
        await bot.sendPhoto(appState.telegramChatId, qrImageBuffer, { caption: "🚨 *Scan QR*" });
    }
});

client.on('ready', async () => {
    console.log('✅ CONNECTED! Scanning TODAY\'S messages only...');
    const myId = client.info.wid._serialized;

    try {
        const chat = await client.getChatById(myId);
        const messages = await chat.fetchMessages({ limit: 100 });
        
        // Aaj ki date ke liye start time (Subah 12 AM)
        const startOfToday = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        
        // Sirf Aaj ke messages ko filter karein
        const todaysMessages = messages.filter(m => m.timestamp >= startOfToday);
        console.log(`Found ${todaysMessages.length} messages from Today.`);

        let currentBatch = { images: [], textMsg: null };

        for (const msg of todaysMessages) {
            if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
                currentBatch.images.push(msg);
            } else if (msg.body && currentBatch.images.length >= 1) {
                currentBatch.textMsg = msg;
                await createAndSendPDF(currentBatch);
                currentBatch = { images: [], textMsg: null };
            }
        }
    } catch (err) { console.error(err); }

    if (appState.telegramChatId) bot.sendMessage(appState.telegramChatId, "✅ Today's sync complete!");
    setTimeout(() => { process.exit(0); }, 20000);
});

async function createAndSendPDF(batch) {
    const title = `Saree_${appState.counter.toString().padStart(2, '0')}`;
    appState.counter++;
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState));
    
    const pdfPath = path.join(TEMP_DIR, `${title}.pdf`);
    console.log(`Creating: ${title}`);

    try {
        const doc = new PDFDocument();
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);
        doc.fontSize(25).text(title, { align: 'center' });

        for (const imgMsg of batch.images) {
            const media = await imgMsg.downloadMedia();
            if (media) {
                const imgLocalPath = path.join(TEMP_DIR, `temp_${Date.now()}_${Math.random()}.jpg`);
                fs.writeFileSync(imgLocalPath, Buffer.from(media.data, 'base64'));
                doc.addPage().image(imgLocalPath, { fit: [500, 700], align: 'center' });
                fs.unlinkSync(imgLocalPath);
            }
        }
        doc.addPage().fontSize(15).text("Description: " + batch.textMsg.body);
        doc.end();

        await new Promise(resolve => stream.on('finish', resolve));
        await bot.sendDocument(appState.telegramChatId, pdfPath);
        fs.unlinkSync(pdfPath);
        console.log(`Sent: ${title}`);
    } catch (e) { console.error(e); }
}

console.log("Starting WhatsApp...");
client.initialize();
