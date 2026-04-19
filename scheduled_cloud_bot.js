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
const TARGET_CHAT_NAME = '+91 63766 20435'; // Fixed as per your WhatsApp exact displayed name pattern

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

client.on('loading_screen', (percent, message) => {
    console.log('Loading:', percent, message);
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
    console.log('✅ CONNECTED! Starting 24-Hour Sync Process...');

    // Backup Safety Exit
    setTimeout(() => {
        console.log("Maximum time reached (10 mins). Forcing exit.");
        if (appState.telegramChatId && !isProcessCompleted) {
            bot.sendMessage(appState.telegramChatId, `✅ 24-Hour Sync Finish. Delivered: ${pdfsSent}`);
        }
        process.exit(0);
    }, 10 * 60 * 1000);

    setTimeout(async () => {
        try {
            console.log(`🔎 Seeking target chat Name/ID: "${TARGET_CHAT_NAME}"`);
            
            const chats = await client.getChats();
            const rawSearchNumber = TARGET_CHAT_NAME.replace(/\D/g, ''); // Sab kuch hta kar sirf digits
            
            let targetChat = chats.find(c => {
                // Exact Name check
                if (c.name === TARGET_CHAT_NAME) return true;
                
                // Advanced Internal ID Check
                const cNameRaw = (c.name || '').replace(/\D/g, '');
                const cIdRaw = c.id ? c.id.user : '';
                
                // Agar target no. exactly match ho gaya
                if (rawSearchNumber && rawSearchNumber.length > 8) {
                    if (cNameRaw === rawSearchNumber || cIdRaw === rawSearchNumber) return true;
                }
                return false;
            });
            
            // Failsafe Algorithm: Agar recent list me hi chat object exist na kare toh directly server ID bypass karenge
            if (!targetChat) {
                console.log(`⚠️ List me chat nahi mila. Direct ID inject karke fetch kar rahe hain...`);
                let chatId = `${TARGET_CHAT_NAME}@c.us`;
                if (rawSearchNumber) {
                     chatId = `${rawSearchNumber}@c.us`;
                }
                
                // ⏳ WhatsApp ko fully load hone do
                console.log("⏳ Waiting 30 sec for full load...");
                await new Promise(r => setTimeout(r, 30000));

                // 🔁 Retry system (very important)
                for (let i = 0; i < 5; i++) {
                    try {
                        console.log(`🔄 Attempt ${i + 1} to fetch chat...`);
                        targetChat = await client.getChatById(chatId);
                        if (targetChat) break;
                    } catch (err) {
                        console.log("Retry due to load issue...");
                        await new Promise(r => setTimeout(r, 7000));
                    }
                }

                if (!targetChat) {
                    throw new Error("❌ Chat not found after retries");
                }
            }
            
            console.log(`✅ Targeted Chat SUCCESSFULLY Found: ${targetChat.name || targetChat.id.user} (ID: ${targetChat.id._serialized})`);
            await processTargetChat(targetChat);

        } catch (err) { 
            console.error("FATAL ERROR IN WORKFLOW:", err);
            if (appState.telegramChatId) bot.sendMessage(appState.telegramChatId, `❌ Bot Error Details: ${err.message}`);
            process.exit(0);
        }

    }, 10000); // 10 sec start delay
});

async function processTargetChat(targetChat) {
    console.log("Fetching past 100 messages...");
    const allMessages = await targetChat.fetchMessages({ limit: 100 });
    console.log(`✅ Loaded ${allMessages.length} messages from history.`);

    const currentTimeMs = Date.now();
    
    let limitTimeMs = currentTimeMs - (24 * 60 * 60 * 1000);
    if (appState.lastProcessedTimestamp > 0) {
         let lastPTimeMs = appState.lastProcessedTimestamp.toString().length > 10 ? appState.lastProcessedTimestamp : appState.lastProcessedTimestamp * 1000;
         if (lastPTimeMs > limitTimeMs) {
              limitTimeMs = lastPTimeMs;
         }
    }

    console.log(`Filtering messages strictly after: ${new Date(limitTimeMs).toLocaleString()}`);

    let newMessages = [];
    for (const msg of allMessages) {
        const msgTimeMs = (msg.timestamp && msg.timestamp.toString().length > 10) 
                           ? msg.timestamp 
                           : msg.timestamp * 1000;
        
        const diffHours = ((currentTimeMs - msgTimeMs) / (1000 * 60 * 60)).toFixed(2);
        
        if (msgTimeMs > limitTimeMs) {
            newMessages.push({ original: msg, timeMs: msgTimeMs });
            // Advanced Debug format jisse filter failures pata chal jaayein user request no. 4 ke hisaab se:
            console.log(`[DEBUG - OK ] Time: ${new Date(msgTimeMs).toLocaleString()} | Diff: ${diffHours} hr | Media: ${msg.hasMedia} | Type: ${msg.type}`);
        }
    }

    console.log(`🔎 Correctly verified ${newMessages.length} fresh messages within the 24h cycle!`);

    let currentBatch = { images: [], textMsg: null };

    // Sort to ensure chronologic order perfectly maintaining sequence
    newMessages.sort((a,b) => a.timeMs - b.timeMs);

    for (const msgData of newMessages) {
        const msg = msgData.original;
        
        if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
            currentBatch.images.push(msg);
            console.log(` -> Image Queued (Current Queue count: ${currentBatch.images.length})`);
        } 
        // Changed to msg.type==='chat' so it does not falsely match system announcements/links as text
        else if (msg.type === 'chat' && msg.body && currentBatch.images.length >= 1) {
            currentBatch.textMsg = msg;
            console.log(` -> Text paired with ${currentBatch.images.length} images! Processing Native PDF + Images Delivery Task...`);
            
            // #1 Create native legacy PDF format
            await createAndSendPDF(currentBatch);
            
            // #2 Direct Telegram Action Fallback
            for (const imgMsg of currentBatch.images) {
                try {
                    const media = await imgMsg.downloadMedia();
                    if (media && appState.telegramChatId) {
                        const imgLocalPath = path.join(TEMP_DIR, `native_${Date.now()}_${Math.random()}.jpg`);
                        fs.writeFileSync(imgLocalPath, Buffer.from(media.data, 'base64'));
                        await bot.sendPhoto(appState.telegramChatId, imgLocalPath);
                        fs.unlinkSync(imgLocalPath);
                    }
                } catch (err) { console.error("Error sending native photo:", err.message) }
            }
            if (appState.telegramChatId) {
                 await bot.sendMessage(appState.telegramChatId, `📝 Full Description:\n\n${msg.body}`);
            }
            
            pdfsSent++;
            appState.lastProcessedTimestamp = msgData.timeMs;
            saveState();
            
            currentBatch = { images: [], textMsg: null }; 
        }
        
        // Prevent looping through same stray photos across runs
        if (msgData.timeMs > appState.lastProcessedTimestamp) {
             appState.lastProcessedTimestamp = msgData.timeMs;
             saveState();
        }
    }

    isProcessCompleted = true;
    if (appState.telegramChatId) {
        if (pdfsSent > 0) {
            bot.sendMessage(appState.telegramChatId, `✅ 24-Hour Workflow Sync Complete. Final Batch Validations: ${pdfsSent}`);
        } else {
            bot.sendMessage(appState.telegramChatId, `💤 24-Hour Sync Checked. Found no fresh media-to-text image patterns.`);
        }
    }
    
    console.log("Job Done perfectly. Exiting process.");
    setTimeout(() => { process.exit(0); }, 5000);
}

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
        await bot.sendDocument(appState.telegramChatId, pdfPath, { caption: `✅ ${title} PDF Compilation Ready!` });
        fs.unlinkSync(pdfPath);
        console.log(`!! SUCCESS !! ${title} Sent.`);
    } catch (e) { }
}

client.initialize();
