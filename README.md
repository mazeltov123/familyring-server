# FamilyRing Cloud Server — Setup Guide

## What this does
This server runs 24/7 on the cloud (free) and handles:
- ✅ **Incoming calls** — plays greeting, detects key presses
- ✅ **Press 1** — plays past broadcasts automatically
- ✅ **Press 2** — plays info message + records voicemail
- ✅ **Press 3 + PIN** — caller records message, approves it, broadcasts to everyone
- ✅ **Outbound broadcasts** — calls all contacts and plays audio, no computer needed

---

## Step 1 — Deploy to Railway.app (free)

1. Go to **[railway.app](https://railway.app)** → Sign up free with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Upload this folder to a GitHub repo first:
   - Go to **[github.com](https://github.com)** → New repository → name it `familyring-server`
   - Upload all files from this folder
4. Connect Railway to your GitHub repo
5. Railway will auto-deploy

---

## Step 2 — Set Environment Variables in Railway

In Railway → your project → **Variables**, add:

| Variable | Value |
|----------|-------|
| `TELNYX_API_KEY` | Your key from portal.telnyx.com → API Keys |
| `TELNYX_FROM_NUMBER` | Your Telnyx number e.g. `+17185551234` |
| `TELNYX_CONNECTION_ID` | Your SIP connection ID from Telnyx portal |
| `SERVER_URL` | Your Railway app URL e.g. `https://familyring-production.up.railway.app` |
| `BROADCAST_PIN` | Your secret PIN e.g. `5678` |

---

## Step 3 — Connect Telnyx to your server

1. Go to **[portal.telnyx.com](https://portal.telnyx.com)**
2. Go to **Numbers** → click your phone number
3. Set **Voice** handler to **TeXML**
4. Set the **TeXML URL** to: `https://your-app.railway.app/ivr/incoming`
5. Save

That's it! Now when anyone calls your Telnyx number, the server handles it automatically.

---

## Step 4 — Sync your contacts from FamilyRing browser app

In the FamilyRing browser app, open the **Debug panel** and run:

```javascript
// Sync contacts to cloud server
fetch('https://your-app.railway.app/api/sync/contacts', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({ contacts: contacts })
}).then(r => r.json()).then(console.log);
```

Or use the **⬆ Sync to Cloud** button (will be added to FamilyRing).

---

## Step 5 — Upload your greeting and audio files

For the IVR greeting, the server needs a **public URL** to your MP3.
Upload your greeting MP3 to the server:

```
POST https://your-app.railway.app/api/audio/upload
Body: { "name": "Greeting", "data": "data:audio/mpeg;base64,...", "type": "audio/mpeg" }
```

Then sync IVR settings:
```
POST https://your-app.railway.app/api/sync/ivr
Body: { "greetingUrl": "https://your-app.railway.app/api/audio/YOUR_AUDIO_ID", "broadcastPin": "1234" }
```

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server status |
| `/ivr/incoming` | POST | Telnyx webhook — incoming call |
| `/api/data` | GET | Get all data |
| `/api/sync/contacts` | POST | Sync contacts from browser app |
| `/api/sync/ivr` | POST | Update IVR settings |
| `/api/audio/upload` | POST | Upload audio file |
| `/api/audio/:id` | GET | Serve audio file (public URL for Telnyx) |
| `/api/broadcast` | POST | Trigger outbound broadcast |
| `/api/voicemails` | GET | List voicemails |
| `/api/calllog` | GET | Call history |
| `/api/broadcasts` | GET | Broadcast history |

---

## How the IVR flow works

```
Caller dials your number
        ↓
[Telnyx] → POST /ivr/incoming
        ↓
Plays greeting MP3
        ↓
"Press 1 for broadcasts, Press 2 for voicemail, Press 3 to record"
        ↓
[Caller presses key] → POST /ivr/menu?Digits=1
        ↓
Press 1 → Plays latest broadcast MP3
Press 2 → Records voicemail → saves to server
Press 3 → Asks for PIN → Records message → Plays back
        → Press 1 to approve → Calls all contacts automatically
        → Press 2 to re-record
```

---

## Need help?
- Railway docs: https://docs.railway.app
- Telnyx TeXML docs: https://developers.telnyx.com/docs/voice/programmable-voice/texml
