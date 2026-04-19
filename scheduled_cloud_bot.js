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

client.on('ready', async () => {
    console.log('✅ CONNECTED! Waiting 15 seconds for WhatsApp to fetch old offline messages before scanning...');
    
    // WA Web ko thoda time chahiye hota hai offline messages download karne ke liye
    setTimeout(async () => {
        const myId = client.info.wid._serialized;

        try {
            const chat = await client.getChatById(myId);
            const allMessages = await chat.fetchMessages({ limit: 100 });
            
            // MAGIC FIX: Puraane process hue messages ko chhod kar, sirf naye wale message uthao!
            const newMessages = allMessages.filter(m => m.timestamp > appState.lastProcessedTimestamp);
            console.log(`Found ${newMessages.length} NEW messages in Self-Chat since your last sync.`);

            // Dhyan se dekhne ke liye logs
            if (newMessages.length > 0) {
                console.log("---- MESSAGE LIST ----");
                newMessages.forEach((m, idx) => {
                    console.log(`${idx+1}. Media: ${m.hasMedia}, Type: ${m.type}, Text: ${m.body ? m.body.substring(0,15) : 'none'}`);
                });
                console.log("----------------------");
            }

            let currentBatch = { images: [], textMsg: null };

            for (const msg of newMessages) {
                if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
                    currentBatch.images.push(msg);
                } 
                else if (msg.body && currentBatch.images.length >= 1) {
                    currentBatch.textMsg = msg;
                    console.log(`-> Batch pakda gaya! Images: ${currentBatch.images.length}. PDF ban raha hai...`);
                    
                    await createAndSendPDF(currentBatch);
                    
                    // Jaise hi PDF ban jaye, is aakhri message ka time save karlo taki dubara isey na padhe
                    appState.lastProcessedTimestamp = msg.timestamp;
                    saveState();
                    
                    currentBatch = { images: [], textMsg: null }; // Reset agle batch ke liye
                }
            }
        } catch (err) { console.error("Sync Error:", err); }

        if (appState.telegramChatId) bot.sendMessage(appState.telegramChatId, "✅ Aaj ka Sync Process poora ho gaya!");
        setTimeout(() => { process.exit(0); }, 30000);

    }, 20000); // 20 Seconds ki delay
});

async function createAndSendPDF(batch) {
    const title = `Saree_${appState.counter.toString().padStart(2, '0')}`;
    appState.counter++;
    saveState();
    
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
        console.log(`!! SUCCESS !! ${title} Sent to Telegram.`);
    } catch (e) { console.error("PDF Fail:", e); }
}

client.initialize();
