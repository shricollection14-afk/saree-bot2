require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8747605183:AAGW6zNtd5CVscCWCf_5ZoGqnlRlnvqTWno';
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

const TEMP_DIR = path.join(__dirname, 'temp');
const STATE_FILE = path.join(__dirname, 'state.json');

fs.ensureDirSync(TEMP_DIR);

let appState = { counter: 5, telegramChatId: null };

// Load state if exists
if (fs.existsSync(STATE_FILE)) {
    try {
        appState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading state.json:", e);
    }
} else {
    // If running in GitHub Actions, use a default fallback
    appState.telegramChatId = process.env.TELEGRAM_CHAT_ID || null;
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2));
}

let isReady = false;

// Initialize WhatsApp Web with LocalAuth
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async (qr) => {
    console.log('SCAN THIS QR CODE WITH YOUR WHATSAPP:');
    qrcodeTerminal.generate(qr, { small: true });

    if (appState.telegramChatId) {
        try {
            const qrImageBuffer = await QRCode.toBuffer(qr);
            bot.sendPhoto(appState.telegramChatId, qrImageBuffer, {
                caption: "🚨 *WhatsApp Login Required on Cloud Server*\nScan this QR code using WhatsApp on your phone to link the cloud action.",
                parse_mode: "Markdown"
            });
            console.log("Sent QR code to Telegram securely.");
        } catch (err) {
            console.error("Error sending QR to Telegram:", err);
        }
    } else {
        console.log("WARNING: Please add TELEGRAM_CHAT_ID to GitHub Secrets to receive QR codes directly.");
    }
});

client.on('ready', () => {
    isReady = true;
    console.log('WhatsApp Client is ready! Processing offline messages...');
    if (appState.telegramChatId) {
        bot.sendMessage(appState.telegramChatId, "✅ Cloud Action triggered! Processing your Saree Messages now.");
    }
    
    // Shut down securely after 10 minutes (Gives enough time to catch up on all daily messages)
    setTimeout(() => {
        console.log("10 Minutes completed. Gracefully shutting down the Cloud Action until tomorrow.");
        if (appState.telegramChatId) {
            bot.sendMessage(appState.telegramChatId, "💤 Successfully synced today's batches. Cloud Action sleeping now.");
        }
        process.exit(0);
    }, 10 * 60 * 1000);
});

client.on('authenticated', () => {
    console.log("WhatsApp Authenticated Cache restored gracefully!");
});

const chatQueues = {};
const BATCH_TIMEOUT = 5 * 60 * 1000;

async function processBatch(chatId) {
    const queue = chatQueues[chatId];
    if (!queue) return;

    const images = queue.images || [];
    const textMsg = queue.textMsg;
    delete chatQueues[chatId];

    if (images.length < 5) return;
    if (!textMsg) return;

    const description = textMsg.body;
    
    // Process counter
    const currentCount = appState.counter++;
    saveState();

    const paddedCount = currentCount.toString().padStart(2, '0');
    const title = `Saree_${paddedCount}`;
    const pdfFileName = `${title}.pdf`;
    const pdfFilePath = path.join(TEMP_DIR, pdfFileName);

    console.log(`Processing ${title} with ${images.length} images...`);

    try {
        const doc = new PDFDocument({ autoFirstPage: true });
        const writeStream = fs.createWriteStream(pdfFilePath);
        doc.pipe(writeStream);

        doc.fontSize(24).text(title, { align: 'center' });
        doc.moveDown();

        for (let i = 0; i < images.length; i++) {
            const msg = images[i];
            const media = await msg.downloadMedia();
            if (media && media.data) {
                const imageBuffer = Buffer.from(media.data, 'base64');
                const imageExt = media.mimetype.split('/')[1].split(';')[0];
                const tempImagePath = path.join(TEMP_DIR, `temp_${Date.now()}_${i}.${imageExt}`);
                
                fs.writeFileSync(tempImagePath, imageBuffer);
                try {
                    doc.addPage();
                    doc.image(tempImagePath, { fit: [500, 700], align: 'center', valign: 'center' });
                } catch (imgErr) {
                    console.error("Error adding image to PDF:", imgErr);
                } finally {
                    if (fs.existsSync(tempImagePath)) fs.unlinkSync(tempImagePath);
                }
            }
        }

        doc.addPage();
        doc.fontSize(16).text('Description:', { underline: true });
        doc.moveDown();
        doc.fontSize(12).text(description);

        doc.end();

        writeStream.on('finish', async () => {
            if (appState.telegramChatId) {
                try {
                    await bot.sendDocument(appState.telegramChatId, pdfFilePath, {
                        caption: `Cloud Generated file for ${title}`
                    });
                    console.log('Sent successfully to Telegram from Cloud!');
                } catch (telErr) {
                    console.error('Error sending to Telegram:', telErr);
                }
            }
            if (fs.existsSync(pdfFilePath)) fs.unlinkSync(pdfFilePath);
        });
    } catch (err) {
        console.error("Error processing batch:", err);
    }
}

client.on('message_create', async (msg) => {
    const chatId = msg.from;

    if (!chatQueues[chatId]) {
        chatQueues[chatId] = { images: [], timer: null, textMsg: null };
    }

    const queue = chatQueues[chatId];
    if (queue.timer) clearTimeout(queue.timer);

    queue.timer = setTimeout(() => {
        if (chatQueues[chatId] && chatQueues[chatId].images.length > 0) {
            delete chatQueues[chatId];
        }
    }, BATCH_TIMEOUT);

    if (msg.hasMedia && msg.type === 'image') {
        queue.images.push(msg);
    } else if (msg.type === 'chat' && msg.body.trim().length > 0) {
        if (queue.images.length > 0) {
            queue.textMsg = msg;
            clearTimeout(queue.timer);
            processBatch(chatId);
        } else {
            delete chatQueues[chatId];
        }
    } else {
        if (queue.images.length > 0) delete chatQueues[chatId];
    }
});

client.initialize(); 
// Ensure it exits if something gets fully stuck for more than 15 mins overall.
setTimeout(() => { process.exit(0); }, 15 * 60 * 1000);
