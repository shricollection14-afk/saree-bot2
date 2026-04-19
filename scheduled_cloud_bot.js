require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = Number(process.env.TELEGRAM_CHAT_ID);

// 👉 ONLY NUMBER (no +, no spaces)
const TARGET_NUMBER = '916376620435';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP_DIR);

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        executablePath: '/usr/bin/google-chrome-stable',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security'
        ]
    }
});

client.on('ready', async () => {
    console.log('✅ WhatsApp Connected');

    try {
        const chatId = `${TARGET_NUMBER}@c.us`;

        // ⏳ IMPORTANT: wait for full WhatsApp load
        console.log("⏳ Waiting for WhatsApp to stabilize...");
        await new Promise(r => setTimeout(r, 15000));

        // 🔁 RETRY SYSTEM (fixes waitForChatLoading crash)
        let targetChat;
        for (let i = 0; i < 3; i++) {
            try {
                console.log(`🔄 Attempt ${i + 1} to fetch chat...`);
                targetChat = await client.getChatById(chatId);
                if (targetChat) break;
            } catch (err) {
                console.log("Retry error:", err.message);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (!targetChat) {
            throw new Error("❌ Chat not found after retries");
        }

        console.log("✅ Chat Found:", targetChat.name || TARGET_NUMBER);

        // 📥 Fetch messages
        const messages = await targetChat.fetchMessages({ limit: 100 });
        console.log("📩 Messages fetched:", messages.length);

        const now = Date.now();
        const last24hrs = now - (24 * 60 * 60 * 1000);

        let validMessages = [];

        for (let msg of messages) {
            if (!msg.timestamp) continue;

            const msgTime = msg.timestamp > 1000000000000
                ? msg.timestamp
                : msg.timestamp * 1000;

            const diff = (now - msgTime) / (1000 * 60 * 60);
            console.log(`⏱ ${diff.toFixed(2)} hrs ago | Type: ${msg.type}`);

            if (msgTime >= last24hrs) {
                validMessages.push({ msg, msgTime });
            }
        }

        console.log("✅ Last 24h messages:", validMessages.length);

        // sort properly
        validMessages.sort((a, b) => a.msgTime - b.msgTime);

        // 📤 PROCESS AFTER FETCH
        for (let item of validMessages) {
            const msg = item.msg;

            try {
                if (msg.hasMedia) {
                    const media = await msg.downloadMedia();

                    if (media) {
                        const filePath = path.join(TEMP_DIR, `img_${Date.now()}.jpg`);
                        fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));

                        await bot.sendPhoto(TELEGRAM_CHAT_ID, filePath);
                        fs.unlinkSync(filePath);

                        console.log("📤 Image sent");
                    }
                } 
                else if (msg.body) {
                    await bot.sendMessage(TELEGRAM_CHAT_ID, msg.body);
                    console.log("📤 Text sent");
                }

                // small delay (avoid block)
                await new Promise(r => setTimeout(r, 1000));

            } catch (err) {
                console.error("❌ Send error:", err.message);
            }
        }

        await bot.sendMessage(TELEGRAM_CHAT_ID, "✅ 24-Hour Sync Completed");

        console.log("🎉 DONE");
        process.exit(0);

    } catch (err) {
        console.error("❌ MAIN ERROR:", err.message);
        await bot.sendMessage(TELEGRAM_CHAT_ID, "❌ Bot Error: " + err.message);
        process.exit(1);
    }
});

client.initialize();
