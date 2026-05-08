const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const sharp = require('sharp');
const cron = require('node-cron');
const path = require('path');
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

// --- TELEGRAM HELPER (Replaces Nodemailer) ---
async function sendTelegramAlert(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log("📨 Telegram Alert Sent!");
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

async function getInstagramDPUrl(username) {
    try {
        // Method 1: Target the internal API
        const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'X-IG-App-ID': '936619743392459',
            }
        });
        if (response.data?.data?.user) {
            const user = response.data.data.user;
            return user.profile_pic_url_hd || user.profile_pic_url;
        }
        return null;
    } catch (error) {
        try {
            // Fallback: Meta Scraper
            const fallbackRes = await axios.get(`https://www.instagram.com/${username}/`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
            });
            const match = fallbackRes.data.match(/<meta property="og:image" content="([^"]+)"/);
            return match ? match[1].replace(/&amp;/g, "&") : null;
        } catch (err) {
            return null;
        }
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
            if (!currentImageUrl || currentImageUrl.includes("static") || currentImageUrl.includes("anonymous")) {
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
    if (!imageUrl) return res.status(404).json({ error: "Profile not found" });
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

    const randomDelay = Math.floor(
        Math.random() * (max - min) + min
    );

    console.log(`Next run in ${randomDelay / 1000}s`);

    setTimeout(async () => {
        await checkAllUsers();
        scheduleRandom();
    }, randomDelay);
}

scheduleRandom();
const PORT = 3000
app.listen(PORT || 3000, () => console.log(`🚀 Monitor Active`));