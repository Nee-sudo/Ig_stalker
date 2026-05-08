const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const sharp = require('sharp');
const cron = require('node-cron');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

let proxyList = [];
const { MONGODB_URI, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

const app = express();
app.use(express.json());

// --- PROXY MANAGER FOR ROUNDPROXIES ---
async function updateProxyList() {
    try {
        // Fetching fresh proxies from RoundProxies
        const apiUrl = 'https://roundproxies.com/api/get-free-proxies?limit=100&page=1&sort_by=lastChecked&sort_type=desc';
        const response = await axios.get(apiUrl);

        // Expected: { data: [ { ip: "...", port: "...", protocol: "..." }, ... ] }
        if (response.data && Array.isArray(response.data.data)) {
            proxyList = response.data.data
                .map(p => {
                    const proto = (p.protocol || '').toLowerCase();
                    if (!proto || !p.ip || !p.port) return null;
                    return `${proto}://${p.ip}:${p.port}`;
                })
                .filter(Boolean);

            console.log(`✅ RoundProxies Loaded: ${proxyList.length} proxies.`);
        }
    } catch (err) {
        console.error('❌ RoundProxies API Error:', err.message);
    }
}

// Initial fetch and update every 1 hour
updateProxyList();
cron.schedule('0 * * * *', updateProxyList);

// --- UPDATED AGENT HELPER ---
function getRandomProxyAgent() {
    if (proxyList.length === 0) return null;

    const proxyUrl = proxyList[Math.floor(Math.random() * proxyList.length)];
    return {
        agent: proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl),
        url: proxyUrl
    };
}

// --- CORE SCRAPER WITH HIGHER RETRIES ---
async function getInstagramDPUrl(username, retries = 10) {
    for (let i = 0; i < retries; i++) {
        const proxyObj = getRandomProxyAgent();
        if (!proxyObj) continue;

        try {
            // Using a mirror that is slightly less aggressive with blocks
            const url = `https://imginn.com/${username}/`;

            const response = await axios.get(url, {
                httpAgent: proxyObj.agent,
                httpsAgent: proxyObj.agent,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                },
                timeout: 5000
            });

            const match = response.data.match(/<div class="logo">[\s\S]*?<img src="([^"]+)"/);
            if (match && !match[1].includes('static')) {
                console.log(`✨ SUCCESS! Found DP via ${proxyObj.url}`);
                return match[1];
            }
        } catch (error) {
            process.stdout.write('.');
        }
    }

    console.log(`\n❌ All proxies failed for @${username}`);
    return null;
}

// --- DATABASE ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    lastHash: String,
    lastUpdated: { type: Date, default: Date.now }
});
const IgUser = mongoose.model('IgUser', UserSchema);

// --- TELEGRAM HELPER (Replaces Nodemailer) ---
async function sendTelegramAlert(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('📨 Telegram Alert Sent!');
        return true;
    } catch (err) {
        console.error('❌ Telegram Failed:', err.message);
        return false;
    }
}

// --- HELPERS ---
async function getPerceptualHash(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = await sharp(response.data)
            .resize(8, 8, { fit: 'fill' })
            .greyscale()
            .raw()
            .toBuffer();
        return buffer.toString('hex');
    } catch (e) {
        return null;
    }
}

// --- CORE MONITORING LOGIC ---
async function checkAllUsers() {
    console.log(`\n[${new Date().toLocaleTimeString()}] 🔍 Checking users...`);
    const users = await IgUser.find();

    for (let user of users) {
        try {
            const currentImageUrl = await getInstagramDPUrl(user.username);

            // Filter out the "Static Asset" blocks that cause false alarms
            if (!currentImageUrl || currentImageUrl.includes('static') || currentImageUrl.includes('anonymous')) {
                console.log(`⚠️ Skip @${user.username}: IG is blocking the request (serving static image).`);
                continue;
            }

            const currentHash = await getPerceptualHash(currentImageUrl);
            if (!currentHash) continue;

            if (user.lastHash && user.lastHash !== currentHash) {
                console.log(`🚨 REAL CHANGE detected for @${user.username}!`);

                const alertMsg = `🚨 <b>DP Changed!</b>\n\nAccount: @${user.username}\n<a href="https://www.instagram.com/${user.username}/">Check Profile</a>`;

                const sent = await sendTelegramAlert(alertMsg);

                if (sent) {
                    user.lastHash = currentHash;
                    user.lastUpdated = Date.now();
                    await user.save();
                    console.log(`✅ DB updated for @${user.username}`);
                }
            } else if (!user.lastHash) {
                user.lastHash = currentHash;
                await user.save();
                console.log(`✅ Initial hash stored for @${user.username}`);
            } else {
                console.log(`😴 @${user.username}: No change.`);
            }
        } catch (error) {
            console.error(`❌ Error with @${user.username}:`, error.message);
        }
    }
}

// --- ROUTES ---
app.post('/api/track', async (req, res) => {
    const { username } = req.body;
    const imageUrl = await getInstagramDPUrl(username);
    if (!imageUrl) return res.status(404).json({ error: 'Profile not found' });

    const hash = await getPerceptualHash(imageUrl);
    await IgUser.findOneAndUpdate({ username }, { username, lastHash: hash }, { upsert: true });
    res.json({ message: `Tracking @${username}` });
});

// Use 2 minutes for Render stability
// cron.schedule('*/2 * * * *', checkAllUsers);
function scheduleRandom() {
    // Between 30 sec and 2 min
    const min = 30 * 1000;
    const max = 2 * 60 * 1000;

    const randomDelay = Math.floor(Math.random() * (max - min) + min);

    console.log(`Next run in ${randomDelay / 1000}s`);

    setTimeout(async () => {
        await checkAllUsers();
        scheduleRandom();
    }, randomDelay);
}

scheduleRandom();
const PORT = 8000;
app.listen(PORT || 3000, () => console.log('🚀 Monitor Active'));

