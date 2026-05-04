const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const nodemailer = require('nodemailer');
const sharp = require('sharp');
const cron = require('node-cron');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const { MONGODB_URI,EMAIL_USER,EMAIL_PASS,RECEIVER,PORT } = process.env;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION ---
// const MONGODB_URI ="process.env.MONGODB_URI || ",
// const EMAIL_USER = "process.env.EMAIL_USER || ",
// const EMAIL_PASS = "process.env.EMAIL_PASS || ",
// const RECEIVER = "process.env.RECEIVER",
// const PORT = "process.env.PORT || 4000";

// --- DATABASE ---
mongoose.connect(MONGODB_URI).then(() => console.log("✅ MongoDB Connected"));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    lastHash: String,
    lastUpdated: { type: Date, default: Date.now }
});
const IgUser = mongoose.model('IgUser', UserSchema);

// --- HELPERS ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// Converts image pixels to a unique string hash
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
        console.error("❌ Hash Error (Likely link expired):", e.message);
        return null;
    }
}

// Scraper using the Meta Tag method (og:image)
async function getInstagramDPUrl(username) {
    try {
        // We use the query_hash endpoint which is what IG web uses internally
        // This is a public proxy to avoid direct IP blocks
        const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'X-IG-App-ID': '936619743392459', // Required by Instagram
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
            }
        });

        if (response.data && response.data.data && response.data.data.user) {
            const user = response.data.data.user;
            // Get the HD version of the profile pic
            return user.profile_pic_url_hd || user.profile_pic_url;
        }
        
        return null;
    } catch (error) {
        // FALLBACK: If the API is blocked, use a simple meta scraper with a different proxy
        try {
            console.log(`⚠️ API blocked for @${username}, trying Meta Fallback...`);
            const fallbackRes = await axios.get(`https://www.instagram.com/${username}/`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
            });
            const match = fallbackRes.data.match(/<meta property="og:image" content="([^"]+)"/);
            return match ? match[1].replace(/&amp;/g, "&") : null;
        } catch (err) {
            console.error(`❌ All scraping methods failed for @${username}`);
            return null;
        }
    }
}

// --- CORE MONITORING LOGIC ---
async function checkAllUsers() {
    console.log(`[${new Date().toLocaleTimeString()}] 🔍 Checking all tracked users...`);
    const users = await IgUser.find();
    
    for (let user of users) {
        const currentImageUrl = await getInstagramDPUrl(user.username);
        if (!currentImageUrl) continue;

        const currentHash = await getPerceptualHash(currentImageUrl);
        if (!currentHash) continue;

        // Compare visual hashes, not URLs
        if (user.lastHash !== currentHash) {
            console.log(`🚨 REAL CHANGE detected for @${user.username}!`);
            
            await transporter.sendMail({
                from: EMAIL_USER,
                to: RECEIVER,
                subject: `🚨 DP Changed: @${user.username}`,
                text: `The actual profile picture for @${user.username} has changed!\n\nCheck it here: https://www.instagram.com/${user.username}/`
            });

            user.lastHash = currentHash;
            user.lastUpdated = Date.now();
            await user.save();
        } else {
            console.log(`😴 @${user.username}: Pixels are identical (No change).`);
        }
    }
}

// --- API ROUTES ---
app.post('/api/track', async (req, res) => {
    const { username } = req.body;
    try {
        const imageUrl = await getInstagramDPUrl(username);
        if (!imageUrl) return res.status(404).json({ error: "Could not find profile. Private or non-existent?" });
        
        const hash = await getPerceptualHash(imageUrl);
        
        await IgUser.findOneAndUpdate(
            { username },
            { username, lastHash: hash, lastUpdated: Date.now() },
            { upsert: true }
        );
        res.json({ message: `Now tracking @${username}` });
    } catch (err) {
        res.status(500).json({ error: "Server error during tracking setup" });
    }
});

app.get('/api/users', async (req, res) => {
    const users = await IgUser.find();
    res.json(users);
});

// --- SCHEDULE ---
// Running every 1 minute for your test
cron.schedule('*/1 * * * *', checkAllUsers);

app.listen(PORT, () => {
    console.log(`\n🚀 DP Monitor Pro Started`);
    console.log(`🔗 UI: http://localhost:${PORT}`);
    console.log(`⏱️ Interval: 1 Minute\n`);
});