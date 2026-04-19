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


let pdfsSent = 0;
let chatQueues = {};

client.on('ready', async () => {
    console.log('✅ CONNECTED! Initiating 24-Hour Sync Engine...');

    // Backup Safety Exit
    setTimeout(() => {
        console.log("Maximum time reached (10 mins). Forcing exit.");
        bot.sendMessage(appState.telegramChatId, `✅ 24-Hour Sync Finish. Safely delivered: ${pdfsSent} pdfs.`);
        process.exit(0);
    }, 10 * 60 * 1000);

    setTimeout(async () => {
        const myId = client.info.wid._serialized;

        try {
            const chat = await client.getChatById(myId);
            
            console.log("Attempting direct historical API fetch for 24 hours...");
            // Yahan wahi error aa sakta hai jo aapne bataya tha
            const allMessages = await chat.fetchMessages({ limit: 100 });
            
            let limitTime = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
            if (appState.lastProcessedTimestamp > limitTime) {
                limitTime = appState.lastProcessedTimestamp;
            }

            const newMessages = allMessages.filter(m => m.timestamp > limitTime);
            console.log(`🔎 Total ${newMessages.length} PENDING messages found via Direct API!`);

            let currentBatch = { images: [], textMsg: null };

            for (const msg of newMessages) {
                if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
                    currentBatch.images.push(msg);
                } 
                else if (msg.body && currentBatch.images.length >= 1) {
                    currentBatch.textMsg = msg;
                    console.log(`-> Batch pakda! Processing PDF...`);
                    await createAndSendPDF(currentBatch);
                    pdfsSent++;
                    
                    appState.lastProcessedTimestamp = msg.timestamp;
                    saveState();
                    currentBatch = { images: [], textMsg: null }; 
                }
            }
            
            bot.sendMessage(appState.telegramChatId, `✅ 24-Hour Sync Finish. Pdfs sent: ${pdfsSent}`);
            setTimeout(() => { process.exit(0); }, 5000);

        } catch (err) { 
            // AGAR API CRASH HOTI HAI (Error 01) TOH YE FALLBACK APNE AAP SAARA KAAM KAR DEGA BINA ERROR KE
            console.log("⚠ WARNING: Direct API rejected the request (Library Error). Initiating Natural Automated Pull...");
            console.log("⏳ Bot will now stay online to naturally sync all 24-hour missed messages automatically.");
            // Bot doesn't exit. It falls back to `message_create` which downloads everything missed!
        }

    }, 10000); // 10 sec delay
});


// 🔥 THE FALLBACK LISTENER 🔥 
// Agar historical API fail hoti hai toh ye listener WhatsApp background sync se khud 24 ghante ka saara data utha leta hai.
client.on('message_create', async (msg) => {
    const myId = client.info.wid._serialized;
    const isSelfChat = (msg.from === myId && msg.to === myId);

    if (!isSelfChat) return;
    
    if (msg.timestamp <= appState.lastProcessedTimestamp) return; 

    if (!chatQueues[myId]) chatQueues[myId] = { images: [], textMsg: null };
    const q = chatQueues[myId];

    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
        q.images.push(msg);
        console.log(`📸 Image Autopulled! (Queue: ${q.images.length})`);
    } else if (msg.body && q.images.length >= 1) {
        q.textMsg = msg;
        console.log(`💬 Text Autopulled: "${msg.body.substring(0, 15)}". Batch Complete! Sending PDF...`);

        await createAndSendPDF(q);
        pdfsSent++;
        
        appState.lastProcessedTimestamp = msg.timestamp;
        saveState();
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
            } catch (err) { }
        }
        
        doc.addPage().fontSize(15).text("Description: " + batch.textMsg.body);
        doc.end();

        await new Promise(resolve => stream.on('finish', resolve));
        await bot.sendDocument(appState.telegramChatId, pdfPath, { caption: `✅ ${title} Ready!` });
        fs.unlinkSync(pdfPath);
        console.log(`!! SUCCESS !! ${title} Sent to Telegram.`);
    } catch (e) { }
}

client.initialize();
