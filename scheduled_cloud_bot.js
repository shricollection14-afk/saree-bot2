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

let isProcessCompleted = false;

client.on('ready', async () => {
    console.log('✅ CONNECTED! Waiting 30 SECONDS for WhatsApp to fetch old offline messages before scanning...');
    if (appState.telegramChatId) {
        bot.sendMessage(appState.telegramChatId, "✅ Sync shuru ho gaya. Purane messages download ho rahe hain...");
    }

    // 10 minute ka absolute timeout. 10 min baad script zarur band hogi.
    setTimeout(() => {
        if (!isProcessCompleted) {
            console.log("10 minutes up. Finishing process.");
            process.exit(0);
        }
    }, 10 * 60 * 1000);

    // WA Web ko pakka time chahiye hota hai old messages fetch karne ke liye (30 seconds)
    setTimeout(async () => {
        const myId = client.info.wid._serialized;

        try {
            // Hum LIVE message_create event ka bhi istaamal karenge safety ke liye
            const chat = await client.getChatById(myId);
            const allMessages = await chat.fetchMessages({ limit: 100 });
            
            // MAGIC FIX: Puraane process hue messages ko chhod kar, sirf naye wale message uthao!
            // Agar pehli baar chal raha hai toh pichle kuch din ke hi dekho 
            let minimumTime = appState.lastProcessedTimestamp;
            if (minimumTime === 0) {
                 minimumTime = Math.floor(Date.now() / 1000) - (24 * 60 * 60); // 24 hours ago limits
            }

            const newMessages = allMessages.filter(m => m.timestamp > minimumTime);
            console.log(`🔎 Total ${newMessages.length} NEW messages found in Self-Chat since your last check.`);

            // Dhyan se dekhne ke liye logs
            if (newMessages.length > 0) {
                console.log("---- WHATSAPP SE KYA MILA ----");
                newMessages.forEach((m, idx) => {
                    console.log(`Msg ${idx+1}: FROM=${m.from}, TO=${m.to}, Media=${m.hasMedia}, Text=${m.body ? m.body.substring(0,25) : 'None'}, Time=${m.timestamp}`);
                });
                console.log("----------------------");
            } else {
                 console.log("⚠ Koi naye message nahi mile hain. Ho sakta hai aapne self-chat me bheje hi na ho, ya pehle se processed ho.");
            }

            let currentBatch = { images: [], textMsg: null };
            let pdfsSent = 0;

            for (const msg of newMessages) {
                if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
                    currentBatch.images.push(msg);
                } 
                else if (msg.body && currentBatch.images.length >= 1) {
                    currentBatch.textMsg = msg;
                    console.log(`-> EK BATCH MIL GAYA! Jisme ${currentBatch.images.length} images hain. File ban rahi hai...`);
                    
                    await createAndSendPDF(currentBatch);
                    pdfsSent++;
                    
                    // Update cache timestamp taaki dubara yahi file na bane
                    appState.lastProcessedTimestamp = msg.timestamp;
                    saveState();
                    
                    currentBatch = { images: [], textMsg: null }; // Reset agle batch ke liye
                }
            }

            isProcessCompleted = true; // Taaki exit cleanly ho jaye
            if (appState.telegramChatId) {
                if (pdfsSent > 0) {
                    bot.sendMessage(appState.telegramChatId, `✅ Aaj ka Sync Process poora ho gaya! ${pdfsSent} nai saree/PDF add hue.`);
                } else {
                     bot.sendMessage(appState.telegramChatId, `✅ Sync pura hua. Koi naye saree batch photos nahi mile.`);
                }
            }
            // Sync poora hote hi band kardo
            console.log("All done, exiting cleanly.");
            setTimeout(() => { process.exit(0); }, 5000);

        } catch (err) { 
            console.error("Sync Error:", err); 
            process.exit(1);
        }

    }, 30000); // 30 SECONDS DELAY
});

async function createAndSendPDF(batch) {
    const title = `Saree_${appState.counter.toString().padStart(2, '0')}`;
    appState.counter++;
    saveState();
    
    const pdfPath = path.join(TEMP_DIR, `${title}.pdf`);
    console.log(`⏳ PDF Bani jaa rhi hai: ${pdfPath}`);

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
                } else {
                    console.log("⚠ Ek photo load nahi ho payi WhatsApp server se.");
                }
            } catch (err) {
                 console.error("⚠ Photo download error:", err.message);
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
