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
let appState = { counter: 5, telegramChatId: ENV_CHAT_ID, lastProcessedTimestamp: 0 };

if (fs.existsSync(STATE_FILE)) {
    try {
        const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        appState.counter = savedState.counter || 5;
        appState.telegramChatId = ENV_CHAT_ID || savedState.telegramChatId;
        appState.lastProcessedTimestamp = savedState.lastProcessedTimestamp || 0;
    } catch (e) {}
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
    qrcodeTerminal.generate(qr, { small: true });
    if (appState.telegramChatId) {
        try {
            const qrImageBuffer = await QRCode.toBuffer(qr);
            await bot.sendPhoto(appState.telegramChatId, qrImageBuffer, { caption: "🚨 *Scan QR*" });
        } catch(e) {}
    }
});


let chatQueues = {};
let pdfsSent = 0;

client.on('ready', async () => {
    console.log('✅ CONNECTED! Listening for pending messages...');
    
    // Server poore 5 Minute (300 sec) ON rahega, taki offline msgs naturally aate rahein:
    setTimeout(() => {
        if (appState.telegramChatId) {
            if (pdfsSent > 0) {
                bot.sendMessage(appState.telegramChatId, `✅ Cloud Sync Complete. Saree pdfs delivered: ${pdfsSent}`);
            } else {
                bot.sendMessage(appState.telegramChatId, `💤 Cloud Sync Complete. Aaj koi naya saree data nahi mila.`);
            }
        }
        console.log("5 minutes complete. Exiting gracefully.");
        process.exit(0);
    }, 5 * 60 * 1000); 
});

client.on('message_create', async (msg) => {
    const myId = client.info.wid._serialized;
    const isSelfChat = (msg.from === myId && msg.to === myId);

    if (!isSelfChat) return;

    if (msg.timestamp <= appState.lastProcessedTimestamp) {
        return; 
    }

    if (!chatQueues[myId]) chatQueues[myId] = { images: [], textMsg: null };
    const q = chatQueues[myId];

    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
        q.images.push(msg);
        console.log(`📸 Image Received & Queued! (Total: ${q.images.length})`);
    } else if (msg.body && q.images.length >= 1) {
        q.textMsg = msg;
        console.log(`💬 Text Received: "${msg.body.substring(0, 20)}". Generating PDF...`);

        // Batch processing shuru hone wala hai
        await createAndSendPDF(q);
        
        // Pura ho jaye tab timestamp update hoga
        appState.lastProcessedTimestamp = msg.timestamp;
        saveState();
        
        pdfsSent++;
        delete chatQueues[myId];
    }
});

async function createAndSendPDF(batch) {
    const title = `Saree_${appState.counter.toString().padStart(2, '0')}`;
    appState.counter++;
    saveState();
    
    const pdfPath = path.join(TEMP_DIR, `${title}.pdf`);
    console.log(`Creating: ${title}.pdf`);

    try {
        const doc = new PDFDocument();
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);
        doc.fontSize(25).text(title, { align: 'center' });

        for (const imgMsg of batch.images) {
            try {
                const media = await imgMsg.downloadMedia();
                if (media) {
                    const imgLocalPath = path.join(TEMP_DIR, `temp_${Date.now()}_${Math.random()}.jpg`);
                    fs.writeFileSync(imgLocalPath, Buffer.from(media.data, 'base64'));
                    doc.addPage().image(imgLocalPath, { fit: [500, 700], align: 'center' });
                    fs.unlinkSync(imgLocalPath);
                }
            } catch (err) {
                 console.error("⚠ Photo download error. Skipping one image.", err.message);
            }
        }
        
        doc.addPage().fontSize(15).text("Description: " + batch.textMsg.body);
        doc.end();

        await new Promise(resolve => stream.on('finish', resolve));
        await bot.sendDocument(appState.telegramChatId, pdfPath, { caption: `✅ ${title} Ready!` });
        fs.unlinkSync(pdfPath);
        console.log(`!! SUCCESS !! ${title} Sent to Telegram.`);
    } catch (e) { console.error("PDF Fail:", e); }
}

client.initialize();
