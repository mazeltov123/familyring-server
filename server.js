// ============================================================
// FamilyRing Cloud Server
// 24/7 automated IVR + broadcast system
// Deploy to Railway.app or Render.com (free tier)
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());

// ── In-memory data store (persists while server runs) ────────────────────
// On Railway/Render, use environment variables for persistence
let DATA = {
  contacts: [],        // { id, name, phone, group, groups[] }
  audioLib: [],        // { id, name, data (base64), type, size, date }
  ivrSettings: {
    enabled: true,
    greetingUrl: null,   // public URL to greeting MP3
    line2Url: null,      // public URL to press-2 info MP3
    broadcastPin: process.env.BROADCAST_PIN || '1234',
  },
  broadcasts: [],      // broadcast history
  callLog: [],         // call records
  voicemails: [],      // recorded voicemails
  recordingSessions: {}, // active recording sessions { callControlId: {chunks} }
};

// Load persisted data from env (JSON encoded)
if (process.env.FAMILYRING_DATA) {
  try { DATA = { ...DATA, ...JSON.parse(process.env.FAMILYRING_DATA) }; }
  catch(e) { console.log('Could not parse FAMILYRING_DATA env'); }
}

// ── Telnyx config ────────────────────────────────────────────────────────
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || ''; // your Telnyx number e.g. +12125551234
const SERVER_URL = process.env.SERVER_URL || 'https://your-app.railway.app'; // your deployed URL

// ── Helpers ──────────────────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

function telnyxHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TELNYX_API_KEY}`,
  };
}

async function telnyxApi(method, path, body) {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    method,
    headers: telnyxHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) console.error('Telnyx API error:', JSON.stringify(json));
  return json;
}

// ── TeXML IVR routes ─────────────────────────────────────────────────────
// These return XML that Telnyx executes server-side — no browser needed

// Main entry: called when someone dials your Telnyx number
app.post('/ivr/incoming', (req, res) => {
  console.log('📞 Incoming call:', req.body);
  const from = req.body.From || req.body.from || 'Unknown';

  // Log the call
  const logEntry = { id: uid(), direction: 'inbound', number: from, name: matchName(from),
    startTime: Date.now(), status: 'active' };
  DATA.callLog.push(logEntry);
  DATA.callLog = DATA.callLog.slice(-500);

  const greetingUrl = DATA.ivrSettings.greetingUrl;

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greetingUrl
    ? `<Play url="${greetingUrl}"/>`
    : `<Say voice="alice">Welcome to Family Ring. </Say>`
  }
  <Gather action="${SERVER_URL}/ivr/menu" method="POST" numDigits="1" timeout="10">
    <Say voice="alice">Press 1 to hear past broadcasts. Press 2 for voicemail. Press 3 to record and send a broadcast with your PIN.</Say>
  </Gather>
  <Redirect>${SERVER_URL}/ivr/menu</Redirect>
</Response>`);
});

// Menu handler — processes key press
app.post('/ivr/menu', (req, res) => {
  const digit = req.body.Digits || req.body.digits || '';
  const callControlId = req.body.CallSid || req.body.call_control_id || uid();
  console.log('📱 Menu digit:', digit);

  res.type('text/xml');

  if (digit === '1') {
    // Play latest broadcast
    const broadcasts = DATA.audioLib.filter(a => a.isBroadcast).reverse();
    if (!broadcasts.length) {
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">There are no past broadcasts available.</Say>
  <Gather action="${SERVER_URL}/ivr/menu" method="POST" numDigits="1" timeout="8">
    <Say voice="alice">Press 2 for voicemail or press 3 to record a message.</Say>
  </Gather>
</Response>`);
    } else {
      // Build playlist of all broadcasts
      const plays = broadcasts.slice(0, 5).map(b =>
        b.publicUrl ? `<Play url="${b.publicUrl}"/>` : ''
      ).filter(Boolean).join('\n  ');

      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Playing ${broadcasts.length} past broadcast${broadcasts.length !== 1 ? 's' : ''}. Most recent first.</Say>
  ${plays || '<Say voice="alice">Broadcasts are not publicly accessible. Please contact the administrator.</Say>'}
  <Gather action="${SERVER_URL}/ivr/menu" method="POST" numDigits="1" timeout="8">
    <Say voice="alice">Press 1 to hear again, press 2 for voicemail, press 3 to record a message.</Say>
  </Gather>
</Response>`);
    }

  } else if (digit === '2') {
    // Info message + voicemail
    const line2Url = DATA.ivrSettings.line2Url;
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${line2Url ? `<Play url="${line2Url}"/>` : ''}
  <Say voice="alice">Please leave your message after the beep. Press pound when finished.</Say>
  <Record action="${SERVER_URL}/ivr/voicemail-done" method="POST"
    maxLength="180" finishOnKey="#" playBeep="true"
    transcribe="false"/>
</Response>`);

  } else if (digit === '3') {
    // PIN entry for broadcast recording
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="${SERVER_URL}/ivr/pin" method="POST" numDigits="10" finishOnKey="#" timeout="15">
    <Say voice="alice">Please enter your PIN followed by the pound key.</Say>
  </Gather>
  <Say voice="alice">No input received. Goodbye.</Say>
  <Hangup/>
</Response>`);

  } else {
    // No input or invalid
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="${SERVER_URL}/ivr/menu" method="POST" numDigits="1" timeout="10">
    <Say voice="alice">Press 1 to hear past broadcasts. Press 2 for voicemail. Press 3 to record a broadcast message.</Say>
  </Gather>
  <Hangup/>
</Response>`);
  }
});

// PIN verification
app.post('/ivr/pin', (req, res) => {
  const enteredPin = (req.body.Digits || '').replace('#', '');
  const correctPin = DATA.ivrSettings.broadcastPin;
  console.log('🔐 PIN attempt:', enteredPin, '==' , correctPin);

  res.type('text/xml');

  if (enteredPin === correctPin) {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">PIN accepted. Please record your broadcast message after the beep. Press pound when finished. Maximum 3 minutes.</Say>
  <Record action="${SERVER_URL}/ivr/broadcast-done" method="POST"
    maxLength="180" finishOnKey="#" playBeep="true"
    transcribe="false"/>
</Response>`);
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Incorrect PIN.</Say>
  <Gather action="${SERVER_URL}/ivr/pin" method="POST" numDigits="10" finishOnKey="#" timeout="15">
    <Say voice="alice">Please try again. Enter your PIN followed by pound.</Say>
  </Gather>
  <Hangup/>
</Response>`);
  }
});

// Voicemail recorded
app.post('/ivr/voicemail-done', (req, res) => {
  const recordingUrl = req.body.RecordingUrl || req.body.recording_url || '';
  const duration = req.body.RecordingDuration || req.body.recording_duration || 0;
  const from = req.body.From || req.body.from || 'Unknown';

  console.log('📬 Voicemail recorded:', recordingUrl, 'duration:', duration);

  if (recordingUrl) {
    DATA.voicemails.push({
      id: uid(),
      from,
      name: matchName(from),
      recordingUrl,
      duration: parseInt(duration),
      date: new Date().toISOString(),
    });
  }

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you. Your message has been recorded. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

// Broadcast recording done — play back then ask to approve
app.post('/ivr/broadcast-done', (req, res) => {
  const recordingUrl = req.body.RecordingUrl || req.body.recording_url || '';
  const duration = req.body.RecordingDuration || 0;
  const from = req.body.From || '';
  const sessionId = uid();

  console.log('🎙️ Broadcast recorded:', recordingUrl);

  // Store temporarily for approval
  DATA.recordingSessions[sessionId] = { recordingUrl, duration, from, created: Date.now() };

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Recording complete. Here is your message.</Say>
  ${recordingUrl ? `<Play url="${recordingUrl}"/>` : ''}
  <Gather action="${SERVER_URL}/ivr/broadcast-approve?session=${sessionId}" method="POST" numDigits="1" timeout="15">
    <Say voice="alice">Press 1 to approve and send this message to all ${DATA.contacts.length} contacts. Press 2 to record again.</Say>
  </Gather>
  <Say voice="alice">No response. Recording cancelled. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

// Approve or re-record
app.post('/ivr/broadcast-approve', (req, res) => {
  const digit = req.body.Digits || '';
  const sessionId = req.query.session;
  const session = DATA.recordingSessions[sessionId];

  res.type('text/xml');

  if (digit === '1' && session) {
    // Approved — trigger broadcast to all contacts
    console.log('✅ Broadcast approved, sending to', DATA.contacts.length, 'contacts');

    // Save to audio library as a broadcast
    const newAudio = {
      id: uid(),
      name: 'Inbound Broadcast ' + new Date().toLocaleString(),
      publicUrl: session.recordingUrl,
      data: null, // no base64 — use public URL
      isBroadcast: true,
      date: new Date().toLocaleDateString(),
      size: 0,
    };
    DATA.audioLib.push(newAudio);

    // Trigger outbound calls to all contacts asynchronously
    triggerBroadcast(newAudio, DATA.contacts).catch(console.error);

    delete DATA.recordingSessions[sessionId];

    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Your message has been approved and is now being sent to all ${DATA.contacts.length} contacts. Thank you. Goodbye.</Say>
  <Hangup/>
</Response>`);

  } else if (digit === '2') {
    // Re-record
    delete DATA.recordingSessions[sessionId];
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please record your message again after the beep. Press pound when finished.</Say>
  <Record action="${SERVER_URL}/ivr/broadcast-done" method="POST"
    maxLength="180" finishOnKey="#" playBeep="true"/>
</Response>`);

  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Cancelled. Goodbye.</Say>
  <Hangup/>
</Response>`);
  }
});

// Outbound call webhook — plays broadcast audio when contact answers
app.post('/ivr/outbound-answered', (req, res) => {
  const audioUrl = req.query.audioUrl;
  console.log('📤 Outbound answered, playing:', audioUrl);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${audioUrl
    ? `<Play url="${decodeURIComponent(audioUrl)}"/>`
    : '<Say voice="alice">Hello, this is a message from Family Ring.</Say>'
  }
  <Hangup/>
</Response>`);
});

// ── Broadcast engine ─────────────────────────────────────────────────────
async function triggerBroadcast(audio, contacts) {
  console.log(`📢 Starting broadcast: "${audio.name}" to ${contacts.length} contacts`);

  const audioUrl = audio.publicUrl || '';
  const callbackUrl = `${SERVER_URL}/ivr/outbound-answered?audioUrl=${encodeURIComponent(audioUrl)}`;

  const broadcastRecord = {
    id: uid(),
    audioName: audio.name,
    startTime: new Date().toISOString(),
    totalContacts: contacts.length,
    answered: 0, missed: 0,
    status: 'running',
  };
  DATA.broadcasts.push(broadcastRecord);

  let delay = 0;
  for (const contact of contacts) {
    if (!contact.phone) continue;
    await new Promise(r => setTimeout(r, delay));
    delay += 3000; // 3 second gap between calls

    try {
      const result = await telnyxApi('POST', '/calls', {
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: contact.phone,
        from: TELNYX_FROM_NUMBER,
        webhook_url: callbackUrl,
        webhook_url_method: 'POST',
        timeout_secs: 30,
      });

      const callId = result?.data?.call_control_id;
      console.log(`📞 Calling ${contact.name} (${contact.phone}) — call_id: ${callId}`);

      DATA.callLog.push({
        id: uid(),
        direction: 'outbound',
        number: contact.phone,
        name: contact.name,
        startTime: Date.now(),
        broadcastId: broadcastRecord.id,
        status: 'calling',
      });
    } catch (e) {
      console.error(`Failed to call ${contact.name}:`, e.message);
    }
  }

  broadcastRecord.status = 'completed';
  broadcastRecord.endTime = new Date().toISOString();
  console.log('📢 Broadcast complete');
}

// ── REST API for FamilyRing browser app ─────────────────────────────────
// The browser app syncs data with this server

// GET all data
app.get('/api/data', (req, res) => {
  res.json({
    contacts: DATA.contacts,
    audioLib: DATA.audioLib.map(a => ({ ...a, data: undefined })), // don't send base64
    ivrSettings: { ...DATA.ivrSettings, broadcastPin: '****' }, // hide PIN
    broadcasts: DATA.broadcasts,
    callLog: DATA.callLog.slice(-200),
    voicemails: DATA.voicemails,
  });
});

// Sync contacts from browser app
app.post('/api/sync/contacts', (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts must be array' });
  DATA.contacts = contacts;
  console.log(`✅ Synced ${contacts.length} contacts`);
  res.json({ ok: true, count: contacts.length });
});

// Sync IVR settings
app.post('/api/sync/ivr', (req, res) => {
  const { greetingUrl, line2Url, broadcastPin, enabled } = req.body;
  if (greetingUrl !== undefined) DATA.ivrSettings.greetingUrl = greetingUrl;
  if (line2Url !== undefined) DATA.ivrSettings.line2Url = line2Url;
  if (broadcastPin) DATA.ivrSettings.broadcastPin = broadcastPin;
  if (enabled !== undefined) DATA.ivrSettings.enabled = enabled;
  console.log('✅ IVR settings updated');
  res.json({ ok: true });
});

// Upload audio file — stores URL for IVR to use
app.post('/api/audio/upload', (req, res) => {
  const { name, data, type, isBroadcast } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'name and data required' });

  // For the server, store base64 and serve it as a URL
  const id = uid();
  const entry = { id, name, data, type: type || 'audio/mpeg', isBroadcast: !!isBroadcast,
    publicUrl: `${SERVER_URL}/api/audio/${id}`, date: new Date().toLocaleDateString(), size: data.length };
  DATA.audioLib.push(entry);
  console.log(`✅ Audio uploaded: "${name}"`);
  res.json({ ok: true, id, publicUrl: entry.publicUrl });
});

// Serve audio file by ID (Telnyx needs a public URL)
app.get('/api/audio/:id', (req, res) => {
  const audio = DATA.audioLib.find(a => a.id === req.params.id);
  if (!audio || !audio.data) return res.status(404).send('Not found');
  // Convert base64 data URI to binary
  const base64 = audio.data.split(',')[1] || audio.data;
  const buf = Buffer.from(base64, 'base64');
  res.type(audio.type || 'audio/mpeg');
  res.send(buf);
});

// Trigger broadcast from browser app
app.post('/api/broadcast', async (req, res) => {
  const { audioId, contactIds } = req.body;
  const audio = DATA.audioLib.find(a => a.id === audioId);
  if (!audio) return res.status(404).json({ error: 'Audio not found' });

  const contacts = contactIds
    ? DATA.contacts.filter(c => contactIds.includes(c.id))
    : DATA.contacts;

  if (!contacts.length) return res.status(400).json({ error: 'No contacts' });

  triggerBroadcast(audio, contacts).catch(console.error);
  res.json({ ok: true, contacts: contacts.length, audio: audio.name });
});

// Get voicemails
app.get('/api/voicemails', (req, res) => {
  res.json(DATA.voicemails);
});

// Delete voicemail
app.delete('/api/voicemails/:id', (req, res) => {
  DATA.voicemails = DATA.voicemails.filter(v => v.id !== req.params.id);
  res.json({ ok: true });
});

// Get call log
app.get('/api/calllog', (req, res) => {
  res.json(DATA.callLog.slice(-200).reverse());
});

// Get broadcast history
app.get('/api/broadcasts', (req, res) => {
  res.json([...DATA.broadcasts].reverse());
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'FamilyRing Server running ✅',
    contacts: DATA.contacts.length,
    audioFiles: DATA.audioLib.length,
    broadcasts: DATA.broadcasts.length,
    voicemails: DATA.voicemails.length,
    ivrEnabled: DATA.ivrSettings.enabled,
  });
});

// ── Helper ───────────────────────────────────────────────────────────────
function matchName(number) {
  if (!number) return '';
  const digits = number.replace(/\D/g, '');
  const match = DATA.contacts.find(c => c.phone && c.phone.replace(/\D/g, '') === digits);
  return match?.name || '';
}

// ── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 FamilyRing Server running on port ${PORT}`);
  console.log(`📞 IVR webhook URL: ${SERVER_URL}/ivr/incoming`);
  console.log(`👥 Contacts loaded: ${DATA.contacts.length}`);
  console.log(`🔐 Broadcast PIN: ${DATA.ivrSettings.broadcastPin ? '****' : 'NOT SET'}`);
  console.log(`\nTelnyx setup:`);
  console.log(`  API Key: ${TELNYX_API_KEY ? '✅ set' : '❌ MISSING - set TELNYX_API_KEY env var'}`);
  console.log(`  From Number: ${TELNYX_FROM_NUMBER || '❌ MISSING - set TELNYX_FROM_NUMBER env var'}`);
  console.log(`  Server URL: ${SERVER_URL}`);
});
