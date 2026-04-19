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
let isProcessCompleted = false;

client.on('ready', async () => {
    console.log('✅ CONNECTED! Waiting 15 Seconds before doing anything...');
    
    // Safety Force Exit after 10 mins
    setTimeout(() => {
        if (!isProcessCompleted) {
             console.log("Forcing exit after 10 mins.");
             process.exit(0);
        }
    }, 10 * 60 * 1000);

    setTimeout(async () => {
        const myId = client.info.wid._serialized;

        try {
            const chat = await client.getChatById(myId);
            
            // MAGIC FIX FOR 'waitForChatLoading' ERROR:
            // Hum bot se pehle ek chota sa message send karwayenge. Message send karte hi 
            // WhatsApp ka internal UI "Wake up" (Jaag) ho jata hai aur purane errors gayab ho jate h.
            console.log("Waking up chat UI...");
            await chat.sendMessage("🔄 Cloud bot is scanning your past 24h messages...");
            
            // Wait 5 seconds after sending the message to let data load
            await new Promise(resolve => setTimeout(resolve, 5000));

            console.log("Fetching past messages...");
            const allMessages = await chat.fetchMessages({ limit: 100 });
            
            // 24 HOURS TIME FILTER (Aur unhe ignore karna chhod jo already ho chuke hain)
            let limitTime = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
            if (appState.lastProcessedTimestamp > limitTime) {
                limitTime = appState.lastProcessedTimestamp;
            }

            const newMessages = allMessages.filter(m => m.timestamp > limitTime && !m.body.includes('Cloud bot'));
            console.log(`🔎 Total ${newMessages.length} PENDING messages found in the last 24 hours!`);

            let currentBatch = { images: [], textMsg: null };

            for (const msg of newMessages) {
                if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
                    currentBatch.images.push(msg);
                } 
                else if (msg.body && currentBatch.images.length >= 1) {
                    currentBatch.textMsg = msg;
                    console.log(`-> Batch pakda gaya! Images: ${currentBatch.images.length}. PDF ban raha hai...`);
                    
                    await createAndSendPDF(currentBatch);
                    pdfsSent++;
                    
                    // Saath-saath save karo
                    appState.lastProcessedTimestamp = msg.timestamp;
                    saveState();
                    
                    currentBatch = { images: [], textMsg: null }; 
                }
                
                // Update timestamp for standalone texts otherwise so we don't scan them again
                if (msg.timestamp > appState.lastProcessedTimestamp) {
                     appState.lastProcessedTimestamp = msg.timestamp;
                     saveState();
                }
            }

            isProcessCompleted = true;
            if (appState.telegramChatId) {
                if (pdfsSent > 0) {
                    bot.sendMessage(appState.telegramChatId, `✅ 24-Hour Sync Complete. Saree pdfs delivered: ${pdfsSent}`);
                } else {
                    bot.sendMessage(appState.telegramChatId, `💤 24-Hour Sync Complete. Koi nai saree photos nahi mili.`);
                }
            }
            
            console.log("Job Done. Closing bot in 5 seconds.");
            setTimeout(() => { process.exit(0); }, 5000);

        } catch (err) { 
            console.error("Sync Error:", err); 
            process.exit(1);
        }

    }, 15000); // 15 Seconds Start Delay
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
