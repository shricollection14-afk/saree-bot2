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
    console.log('✅ CONNECTED! Searching Self-Chat for Saree batches...');
    const myId = client.info.wid._serialized;

    try {
        const chat = await client.getChatById(myId);
        const allMessages = await chat.fetchMessages({ limit: 100 });
        
        // Time Filter: Pichle 24 ghante (Last 24 Hours)
        const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
        
        const recentMessages = allMessages.filter(m => m.timestamp >= twentyFourHoursAgo);
        console.log(`Searching through ${recentMessages.length} recent messages...`);

        let currentBatch = { images: [], textMsg: null };

        for (const msg of recentMessages) {
            // Media detection
            if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
                currentBatch.images.push(msg);
                console.log(`   -> Found Image! (Queue: ${currentBatch.images.length})`);
            } 
            // Text detection (Batch end)
            else if (msg.body && currentBatch.images.length >= 1) {
                currentBatch.textMsg = msg;
                console.log(`   -> Found Text: "${msg.body.substring(0,20)}...". Sending PDF!`);
                await createAndSendPDF(currentBatch);
                currentBatch = { images: [], textMsg: null }; // Reset
            }
        }
    } catch (err) { console.error("Critical Error:", err); }

    if (appState.telegramChatId) bot.sendMessage(appState.telegramChatId, "✅ Sync Job Finished.");
    setTimeout(() => { process.exit(0); }, 30000);
});

async function createAndSendPDF(batch) {
    const title = `Saree_${appState.counter.toString().padStart(2, '0')}`;
    appState.counter++;
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState));
    
    const pdfPath = path.join(TEMP_DIR, `${title}.pdf`);
    console.log(`Creating: ${pdfPath}`);

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
        await bot.sendDocument(appState.telegramChatId, pdfPath, { caption: `✅ ${title} Ready!` });
        fs.unlinkSync(pdfPath);
        console.log(`Sent: ${title} Successfully!`);
    } catch (e) { console.error("PDF Creation Failed:", e); }
}

client.initialize();
