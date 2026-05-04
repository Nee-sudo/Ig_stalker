# Igstalker Fix Tasks

## Final .env Fix

**Issues:** Spaces, quotes, commas in .env lines → parse errors

**Correct format (no spaces around =, no quotes/commas):**
```
MONGODB_URI=mongodb+srv://neer:bjFBXFCYd00Gifiv@pdf-uploading-site.ges8oic.mongodb.net/?retryWrites=true&w=majority
EMAIL_USER=vs0158213@gmail.com
EMAIL_PASS=qjpa biuy sohq pfwb
RECEIVER=bhuprajchauhan72087@gmail.com
PORT=4000
```

1. [x] Port fixed
2. [ ] User: Fix .env format (remove spaces/quotes/commas)
3. [ ] npm start → expect ✅ MongoDB Connected

**New issue:** MONGODB_URI fixed with Atlas URI provided\n\n1. [x] Fixed port error\n2. [ ] User: Add MONGODB_URI to .env & Gmail creds\n3. [ ] `npm start` to verify full startup (expect ✅ MongoDB Connected)"

2. [ ] User: Fix MONGODB_URI in .env to valid format like mongodb://user:pass@cluster... (get free from MongoDB Atlas)
3. [ ] Restart `npm start`
4. [ ] Verify full startup

**Quick MongoDB setup:**
1. mongodb.com → Create free cluster
2. Add IP 0.0.0.0/0
3. Get connection string, replace <password>
4. Paste as MONGODB_URI=...

Or comment mongoose.connect in server.js for dev without DB.
1. [x] Edit .env to fix PORT=4000; → PORT=4000\n2. [x] User: Manually fix .env PORT=4000; → PORT=4000 (confirmed), test with `npm start`\n3. [x] App verified working at http://localhost:4000\n4. [x] Task complete - run `npm start` anytime
