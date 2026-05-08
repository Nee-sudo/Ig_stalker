const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const sharp = require('sharp');
const cron = require('node-cron');
require('dotenv').config();

const { MONGODB_URI, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

const app = express();
app.use(express.json());

// --- DATABASE ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    lastHash: String,
    lastUpdated: { type: Date, default: Date.now }
});
const IgUser = mongoose.model('IgUser', UserSchema);

// --- TELEGRAM HELPER ---
async function sendTelegramAlert(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        return true;
    } catch (err) {
        console.error("❌ Telegram Failed:", err.message);
        return false;
    }
}

// --- HELPERS ---
async function getPerceptualHash(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        // Using normalize() and a slightly higher resolution to avoid false triggers
        // from CDN compression artifacts.
        const buffer = await sharp(response.data)
            .resize(32, 32, { fit: 'fill' }) 
            .grayscale()
            .normalize() 
            .raw()
            .toBuffer();
        return buffer.toString('base64'); 
    } catch (e) {
        return null;
    }
}

async function getInstagramDPUrl(username) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'X-IG-App-ID': '936619743392459',
    };

    try {
        // Method 1: Internal API
        const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
        const response = await axios.get(url, { headers });
        if (response.data?.data?.user) {
            const user = response.data.data.user;
            return user.profile_pic_url_hd || user.profile_pic_url;
        }
    } catch (error) {
        try {
            // Fallback: Scraper
            const fallbackRes = await axios.get(`https://www.instagram.com/${username}/`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
            });
            const match = fallbackRes.data.match(/<meta property="og:image" content="([^"]+)"/);
            return match ? match[1].replace(/&amp;/g, "&") : null;
        } catch (err) {
            return null;
        }
    }
    return null;
}

// --- CORE MONITORING LOGIC ---
async function checkAllUsers() {
    console.log(`\n[${new Date().toLocaleTimeString()}] 🔍 Checking users...`);
    const users = await IgUser.find();
    
    for (let user of users) {
        try {
            const currentImageUrl = await getInstagramDPUrl(user.username);
            
            // Refined False-Positive Filter:
            // Checks for common default silhouette URLs used when IG blocks the request
            if (!currentImageUrl || 
                currentImageUrl.includes("static") || 
                currentImageUrl.includes("anonymous") ||
                currentImageUrl.includes("11891582_422498044601191_1454999532_a.jpg")) {
                console.log(`⚠️ Skip @${user.username}: IG returned a placeholder/static image.`);
                continue; 
            }

            const currentHash = await getPerceptualHash(currentImageUrl);
            if (!currentHash) continue;

            if (user.lastHash && user.lastHash !== currentHash) {
                console.log(`🚨 REAL CHANGE detected for @${user.username}!`);
                
                const alertMsg = `🚨 <b>DP Changed!</b>\n\nAccount: @${user.username}\n<a href="https://www.instagram.com/${user.username}/">View Profile</a>`;
                
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
    if (!username) return res.status(400).json({ error: "Username required" });

    const imageUrl = await getInstagramDPUrl(username);
    if (!imageUrl) return res.status(404).json({ error: "Profile not found or private" });

    const hash = await getPerceptualHash(imageUrl);
    await IgUser.findOneAndUpdate({ username }, { username, lastHash: hash }, { upsert: true });
    
    res.json({ message: `Now tracking @${username}`, currentHash: hash });
});

// --- SCHEDULER ---
function scheduleRandom() {
    const min = 45 * 1000; // 45 seconds
    const max = 3 * 60 * 1000; // 3 minutes
    const randomDelay = Math.floor(Math.random() * (max - min) + min);

    setTimeout(async () => {
        await checkAllUsers();
        scheduleRandom();
    }, randomDelay);
}

scheduleRandom();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Monitor Active on Port ${PORT}`));