const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const nodemailer = require('nodemailer');
const sharp = require('sharp');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const { MONGODB_URI, EMAIL_USER, EMAIL_PASS, RECEIVER, PORT } = process.env;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// --- MAILER ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    // Optional debug
    logger: true,
    debug: true
});

// --- HELPERS ---

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

// Scraper using Instagram API + fallback
async function getInstagramDPUrl(username) {
    try {
        const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
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
            console.log(`⚠️ API blocked for @${username}, trying Meta Fallback...`);

            const fallbackRes = await axios.get(`https://www.instagram.com/${username}/`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
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
    console.log(`\n[${new Date().toLocaleTimeString()}] 🔍 Checking all tracked users...`);

    try {
        const users = await IgUser.find();
        console.log(`📊 Found ${users.length} users`);

        for (let user of users) {
            try {
                console.log(`👀 Checking @${user.username}...`);

                const currentImageUrl = await getInstagramDPUrl(user.username);
                if (!currentImageUrl) {
                    console.log(`⚠️ No image found for @${user.username}`);
                    continue;
                }

                const currentHash = await getPerceptualHash(currentImageUrl);
                if (!currentHash) {
                    console.log(`⚠️ Hash failed for @${user.username}`);
                    continue;
                }

                if (user.lastHash !== currentHash) {
                    console.log(`🚨 REAL CHANGE detected for @${user.username}!`);

                    // ✅ EMAIL WITH LOGS
                    try {
                        const info = await transporter.sendMail({
                            from: EMAIL_USER,
                            to: RECEIVER,
                            subject: `🚨 DP Changed: @${user.username}`,
                            text: `The actual profile picture for @${user.username} has changed!\n\nhttps://www.instagram.com/${user.username}/`
                        });

                        console.log(`📧 Email SENT for @${user.username}`);
                        console.log(`📨 Message ID: ${info.messageId}`);

                    } catch (emailError) {
                        console.error(`❌ Email FAILED for @${user.username}`);
                        console.error(`💥 Reason: ${emailError.message}`);
                    }

                    // Update DB
                    user.lastHash = currentHash;
                    user.lastUpdated = Date.now();
                    await user.save();

                    console.log(`✅ Database updated for @${user.username}`);

                } else {
                    console.log(`😴 @${user.username}: pixels are identical (No Change)`);
                }

            } catch (userError) {
                console.error(`❌ Error processing @${user.username}:`, userError.message);
            }
        }

        console.log(`✅ Cycle complete\n`);

    } catch (err) {
        console.error("❌ Global check error:", err.message);
    }
}

// --- API ROUTES ---
app.post('/api/track', async (req, res) => {
    const { username } = req.body;

    try {
        const imageUrl = await getInstagramDPUrl(username);
        if (!imageUrl) {
            return res.status(404).json({
                error: "Profile not found / private"
            });
        }

        const hash = await getPerceptualHash(imageUrl);

        await IgUser.findOneAndUpdate(
            { username },
            { username, lastHash: hash, lastUpdated: Date.now() },
            { upsert: true }
        );

        console.log(`➕ Started tracking @${username}`);

        res.json({ message: `Now tracking @${username}` });

    } catch (err) {
        console.error("❌ Track API error:", err.message);
        res.status(500).json({ error: "Server error" });
    }
});

app.get('/api/users', async (req, res) => {
    const users = await IgUser.find();
    res.json(users);
});

// --- SCHEDULE ---
cron.schedule('*/1 * * * *', checkAllUsers);

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`\n🚀 DP Monitor Pro Started`);
    console.log(`🔗 http://localhost:${PORT}`);
    console.log(`⏱️ Running every 1 minute\n`);
});