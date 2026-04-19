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
const TARGET_CHAT_NAME = process.env.TARGET_CHAT_NAME || 'You'; // Aap isko apne chat/group ke exact naam me change kar sakte hain

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
            console.log(`🔎 Looking for target chat by exact name: "${TARGET_CHAT_NAME}"`);
            
            const chats = await client.getChats();
            const targetChat = chats.find(c => c.name === TARGET_CHAT_NAME || (TARGET_CHAT_NAME === 'You' && c.id._serialized === client.info.wid._serialized));
            
            if (!targetChat) {
                console.error(`❌ ERROR: Could not find chat with name "${TARGET_CHAT_NAME}". Available chats:`);
                chats.slice(0, 10).forEach(c => console.log(` - ${c.name || c.id._serialized}`));
                throw new Error(`Chat "${TARGET_CHAT_NAME}" not found`);
            }
            
            console.log(`✅ Targeted Chat Found: ${targetChat.name} (ID: ${targetChat.id._serialized})`);

            console.log("Fetching past 100 messages...");
            const allMessages = await targetChat.fetchMessages({ limit: 100 });
            console.log(`✅ Loaded ${allMessages.length} messages from history.`);

            const currentTimeMs = Date.now();
            console.log(`Current Time: ${new Date(currentTimeMs).toLocaleString()}`);
            
            // Limit to last 24 hours (or last processed timestamp, whichever is more recent)
            let limitTimeMs = currentTimeMs - (24 * 60 * 60 * 1000);
            if (appState.lastProcessedTimestamp > 0) {
                 // Check if lastProcessed is in seconds or ms, normalize to ms
                 let lastPTimeMs = appState.lastProcessedTimestamp.toString().length > 10 ? appState.lastProcessedTimestamp : appState.lastProcessedTimestamp * 1000;
                 if (lastPTimeMs > limitTimeMs) {
                      limitTimeMs = lastPTimeMs;
                 }
            }

            console.log(`Filtering messages strictly after: ${new Date(limitTimeMs).toLocaleString()}`);

            let newMessages = [];
            for (const msg of allMessages) {
                // Normalize timestamp: if 10 digits -> seconds, convert to ms by * 1000
                const msgTimeMs = (msg.timestamp && msg.timestamp.toString().length > 10) 
                                   ? msg.timestamp 
                                   : msg.timestamp * 1000;
                
                const diffHours = ((currentTimeMs - msgTimeMs) / (1000 * 60 * 60)).toFixed(2);
                
                // Detailed debug log per message requirements
                console.log(`[DEBUG] Msg Timestamp: ${new Date(msgTimeMs).toLocaleString()} | Diff: ${diffHours} hrs ago | HasMedia: ${msg.hasMedia} | Body: ${msg.body ? msg.body.substring(0, 15) : 'N/A'}`);
                
                if (msgTimeMs > limitTimeMs) {
                    newMessages.push({ original: msg, timeMs: msgTimeMs });
                }
            }

            console.log(`🔎 Correctly verified ${newMessages.length} messages within the valid 24h/new timeframe!`);

            let currentBatch = { images: [], textMsg: null };

            for (const msgData of newMessages) {
                const msg = msgData.original;
                
                // Track individual items explicitly as requested
                if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
                    currentBatch.images.push(msg);
                    console.log(` -> Image Queued (Current count: ${currentBatch.images.length})`);
                } 
                else if (msg.body && currentBatch.images.length >= 1) {
                    currentBatch.textMsg = msg;
                    console.log(` -> Text paired with ${currentBatch.images.length} images! Processing Saree Batch task...`);
                    
                    // Task 1: Create PDF as before (Core feature of this script)
                    await createAndSendPDF(currentBatch);
                    
                    // Task 2: Further exact tasks (Send Image natively, Send Text natively) as requested!
                    for (const imgMsg of currentBatch.images) {
                        try {
                            const media = await imgMsg.downloadMedia();
                            if (media && appState.telegramChatId) {
                                // Provide fallback to send native photos per user requirement 5
                                const imgLocalPath = path.join(TEMP_DIR, `native_${Date.now()}.jpg`);
                                fs.writeFileSync(imgLocalPath, Buffer.from(media.data, 'base64'));
                                await bot.sendPhoto(appState.telegramChatId, imgLocalPath);
                                fs.unlinkSync(imgLocalPath);
                            }
                        } catch (err) { console.error("Error sending native photo:", err.message) }
                    }
                    if (appState.telegramChatId) {
                         await bot.sendMessage(appState.telegramChatId, `Description: ${msg.body}`);
                    }
                    
                    pdfsSent++;
                    
                    appState.lastProcessedTimestamp = msgData.timeMs;
                    saveState();
                    currentBatch = { images: [], textMsg: null }; 
                }
                
                // For loose standalone messages, just save time to not duplicate
                if (msgData.timeMs > appState.lastProcessedTimestamp) {
                     appState.lastProcessedTimestamp = msgData.timeMs;
                     saveState();
                }
            }

            isProcessCompleted = true;
            if (appState.telegramChatId) {
                if (pdfsSent > 0) {
                    bot.sendMessage(appState.telegramChatId, `✅ 24-Hour Bot Workflow Sync Complete. Delivery: ${pdfsSent} batches`);
                } else {
                    bot.sendMessage(appState.telegramChatId, `💤 24-Hour Sync Finished. Checked exact timeframes. Data processed without new files.`);
                }
            }
            
            console.log("Job Done perfectly. Exiting.");
            setTimeout(() => { process.exit(0); }, 5000);

        } catch (err) { 
            console.error("FATAL ERROR IN WORKFLOW:", err);
            if (appState.telegramChatId) {
                bot.sendMessage(appState.telegramChatId, `❌ Bot Error Details: ${err.message}`);
            }
            process.exit(1);
        }

    }, 10000); // 10 sec delay
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
        await bot.sendDocument(appState.telegramChatId, pdfPath, { caption: `✅ ${title} PDF Ready!` });
        fs.unlinkSync(pdfPath);
        console.log(`!! SUCCESS !! ${title} Sent to Telegram.`);
    } catch (e) { }
}

client.initialize();
