// ============================================================
// FamilyRing Cloud Server - Telnyx Call Control API v2
// Deploy to Railway.app - works 24/7 without any computer
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');


const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());

// ── Data store ───────────────────────────────────────────────
let DATA = {
  contacts: [],
  audioLib: [],
  ivrSettings: {
    enabled: true,
    greetingId: null,
    line2Id: null,
    broadcastPin: process.env.BROADCAST_PIN || '1234',
  },
  broadcasts: [],
  callLog: [],
  voicemails: [],
  callSessions: {},
};

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_FROM = process.env.TELNYX_FROM_NUMBER || '';
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || '';
const SERVER_URL = (process.env.SERVER_URL || '').replace(/\/$/, '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

// ── Telnyx Call Control helpers ──────────────────────────────
async function cc(callControlId, action, body = {}) {
  const res = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TELNYX_API_KEY}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error(`cc/${action} error:`, JSON.stringify(json).slice(0, 200));
  return json;
}

const answer     = id => cc(id, 'answer');
const hangup     = id => cc(id, 'hangup');
const speak      = (id, text) => cc(id, 'speak', { payload: text, voice: 'female', language: 'en-US' });
const playAudio  = (id, url) => cc(id, 'playback_start', { audio_url: url });
const gather     = (id, text, max = 1) => cc(id, 'gather_using_speak', {
  payload: text, voice: 'female', language: 'en-US',
  valid_digits: '0123456789#*', max_digits: max, timeout_millis: 10000,
});
const startRec   = id => cc(id, 'record_start', { format: 'mp3', channels: 'single' });

// ── Main inbound webhook ─────────────────────────────────────
app.post('/ivr/incoming', async (req, res) => {
  res.sendStatus(200);
  const event = req.body?.data;
  if (!event) return;

  const type = event.event_type;
  const payload = event.payload || {};
  const ccid = payload.call_control_id;
  const from = payload.from || '';

  console.log(`[${type}] from=${from} ccid=${ccid?.slice(0,16)}`);
  if (!ccid) return;

  if (!DATA.callSessions[ccid]) {
    DATA.callSessions[ccid] = { state: 'new', from, pinBuffer: '', recordingUrl: null, broadcastIdx: 0 };
  }
  const s = DATA.callSessions[ccid];

  try {
    if (type === 'call.initiated') {
      await answer(ccid);

    } else if (type === 'call.answered') {
      s.state = 'greeting';
      DATA.callLog.push({ id: uid(), direction: 'inbound', number: from,
        name: matchName(from), startTime: Date.now(), status: 'active' });
      const g = getAudio(DATA.ivrSettings.greetingId);
      if (g?.publicUrl) await playAudio(ccid, g.publicUrl);
      else await showMenu(ccid, s);

    } else if (type === 'call.playback.ended') {
      if (s.state === 'greeting') await showMenu(ccid, s);
      else if (s.state === 'line2') {
        await gather(ccid, 'Press 1 to record your voicemail after the beep.');
        s.state = 'voicemail-prompt';
      } else if (s.state === 'broadcast-playback') {
        await gather(ccid, 'Press 1 for next broadcast. Press 2 for voicemail. Press 3 to record a message.');
        s.state = 'menu';
      } else if (s.state === 'playing-for-hangup') {
        await hangup(ccid);
      }

    } else if (type === 'call.gather.ended') {
      await handleDigits(ccid, s, payload.digits || '');

    } else if (type === 'call.speak.ended') {
      if (s.state === 'menu-spoken') await showMenu(ccid, s);
      else if (s.state === 'hanging-up') await hangup(ccid);

    } else if (type === 'call.recording.saved') {
      const url = payload.recording_urls?.mp3 || payload.public_recording_urls?.mp3 || '';
      console.log('🎙️ Recording saved:', url);
      if (s.state === 'recording-broadcast') {
        s.recordingUrl = url;
        s.state = 'review';
        await gather(ccid, 'Recording complete. Press 1 to approve and send to all contacts. Press 2 to record again.');
      } else if (s.state === 'recording-voicemail') {
        DATA.voicemails.push({ id: uid(), from, name: matchName(from),
          recordingUrl: url, date: new Date().toISOString() });
        s.state = 'hanging-up';
        await speak(ccid, 'Thank you. Your voicemail has been saved. Goodbye.');
      }

    } else if (type === 'call.hangup') {
      delete DATA.callSessions[ccid];
    }
  } catch (e) { console.error('Error:', e.message); }
});

async function showMenu(ccid, s) {
  s.state = 'menu';
  await gather(ccid, 'Press 1 to hear past broadcasts. Press 2 to leave a voicemail. Press 3 to record and send a broadcast message.');
}

async function handleDigits(ccid, s, digits) {
  const d = digits.replace(/[^0-9]/g, '').slice(-1);
  console.log(`  digit="${d}" state="${s.state}"`);

  if (s.state === 'menu') {
    if (d === '1') {
      const list = DATA.audioLib.filter(a => a.isBroadcast && a.publicUrl).reverse();
      if (!list.length) { await gather(ccid, 'No broadcasts available. Press 2 for voicemail or 3 to record.'); return; }
      s.broadcastIdx = 0;
      s.state = 'broadcast-playback';
      await playAudio(ccid, list[0].publicUrl);
    } else if (d === '2') {
      s.state = 'line2';
      const l2 = getAudio(DATA.ivrSettings.line2Id);
      if (l2?.publicUrl) await playAudio(ccid, l2.publicUrl);
      else { await gather(ccid, 'Press 1 to record your voicemail.'); s.state = 'voicemail-prompt'; }
    } else if (d === '3') {
      s.state = 'pin-entry';
      s.pinBuffer = '';
      await gather(ccid, 'Enter your PIN then press pound.', 8);
    } else { await showMenu(ccid, s); }

  } else if (s.state === 'voicemail-prompt') {
    if (d === '1') {
      s.state = 'recording-voicemail';
      await speak(ccid, 'Recording after the beep. Press pound when done.');
      setTimeout(() => startRec(ccid), 2500);
    } else await showMenu(ccid, s);

  } else if (s.state === 'pin-entry') {
    const pin = digits.replace('#', '');
    if (pin === DATA.ivrSettings.broadcastPin) {
      s.state = 'recording-broadcast';
      await speak(ccid, 'PIN accepted. Record your message after the beep. Press pound when finished.');
      setTimeout(() => startRec(ccid), 3000);
    } else {
      s.pinBuffer = '';
      await gather(ccid, 'Incorrect PIN. Try again.', 8);
    }

  } else if (s.state === 'review') {
    if (d === '1') {
      const newAudio = { id: uid(), name: 'Broadcast ' + new Date().toLocaleString(),
        publicUrl: s.recordingUrl, isBroadcast: true, date: new Date().toLocaleDateString() };
      DATA.audioLib.push(newAudio);
      s.state = 'playing-for-hangup';
      await speak(ccid, `Approved. Sending to ${DATA.contacts.length} contacts. Goodbye.`);
      setTimeout(() => triggerBroadcast(newAudio, DATA.contacts).catch(console.error), 3000);
    } else if (d === '2') {
      s.state = 'recording-broadcast';
      await speak(ccid, 'Recording again after the beep. Press pound when done.');
      setTimeout(() => startRec(ccid), 3000);
    } else await showMenu(ccid, s);

  } else if (s.state === 'broadcast-playback') {
    if (d === '1') {
      const list = DATA.audioLib.filter(a => a.isBroadcast && a.publicUrl).reverse();
      s.broadcastIdx = (s.broadcastIdx || 0) + 1;
      if (s.broadcastIdx >= list.length) {
        s.broadcastIdx = 0;
        await gather(ccid, 'End of broadcasts. Press 1 to replay or 2 for voicemail.');
        s.state = 'menu';
      } else await playAudio(ccid, list[s.broadcastIdx].publicUrl);
    } else await handleDigits(ccid, { ...s, state: 'menu' }, digits);

  } else await showMenu(ccid, s);
}

// ── Outbound broadcast ────────────────────────────────────────
async function triggerBroadcast(audio, contacts) {
  console.log(`📢 Broadcast "${audio.name}" → ${contacts.length} contacts`);
  const rec = { id: uid(), audioName: audio.name, startTime: new Date().toISOString(),
    totalContacts: contacts.length, status: 'running' };
  DATA.broadcasts.push(rec);

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    if (!c.phone) continue;
    if (i > 0) await new Promise(r => setTimeout(r, 3000));
    try {
      await fetch('https://api.telnyx.com/v2/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TELNYX_API_KEY}` },
        body: JSON.stringify({
          connection_id: TELNYX_CONNECTION_ID,
          to: c.phone, from: TELNYX_FROM,
          webhook_url: `${SERVER_URL}/ivr/outbound?url=${encodeURIComponent(audio.publicUrl || '')}`,
          timeout_secs: 30,
        }),
      });
      console.log(`  📞 ${c.name} ${c.phone}`);
    } catch (e) { console.error(`  ❌ ${c.name}:`, e.message); }
  }
  rec.status = 'completed'; rec.endTime = new Date().toISOString();
}

// ── Outbound call webhook ─────────────────────────────────────
app.post('/ivr/outbound', async (req, res) => {
  res.sendStatus(200);
  const event = req.body?.data;
  if (!event) return;
  const type = event.event_type;
  const ccid = event.payload?.call_control_id;
  const audioUrl = decodeURIComponent(req.query.url || '');
  if (!ccid) return;
  if (type === 'call.initiated') await answer(ccid);
  else if (type === 'call.answered') {
    if (audioUrl) await playAudio(ccid, audioUrl);
    else await speak(ccid, 'Hello, this is a message from Family Ring.');
  } else if (type === 'call.playback.ended' || type === 'call.speak.ended') await hangup(ccid);
});

// ── REST API ──────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: '✅ FamilyRing Server', contacts: DATA.contacts.length,
  audio: DATA.audioLib.length, broadcasts: DATA.broadcasts.length,
  voicemails: DATA.voicemails.length, pin: DATA.ivrSettings.broadcastPin ? '✅' : '❌',
  greeting: DATA.ivrSettings.greetingId ? '✅' : '❌ (not uploaded)',
}));

app.post('/api/sync/contacts', (req, res) => {
  if (!Array.isArray(req.body.contacts)) return res.status(400).json({ error: 'array required' });
  DATA.contacts = req.body.contacts;
  console.log(`✅ ${DATA.contacts.length} contacts synced`);
  res.json({ ok: true, count: DATA.contacts.length });
});

app.post('/api/sync/ivr', (req, res) => {
  const { broadcastPin, enabled, greetingId, line2Id } = req.body;
  if (broadcastPin) DATA.ivrSettings.broadcastPin = broadcastPin;
  if (enabled !== undefined) DATA.ivrSettings.enabled = enabled;
  if (greetingId !== undefined) DATA.ivrSettings.greetingId = greetingId;
  if (line2Id !== undefined) DATA.ivrSettings.line2Id = line2Id;
  res.json({ ok: true, settings: { ...DATA.ivrSettings, broadcastPin: '****' } });
});

app.post('/api/audio/upload', (req, res) => {
  const { name, data, type, isBroadcast, isGreeting, isLine2 } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'name+data required' });
  const id = uid();
  const entry = { id, name, data, type: type || 'audio/mpeg',
    isBroadcast: !!isBroadcast, isGreeting: !!isGreeting, isLine2: !!isLine2,
    publicUrl: `${SERVER_URL}/api/audio/${id}`, date: new Date().toLocaleDateString() };
  DATA.audioLib.push(entry);
  if (isGreeting) { DATA.ivrSettings.greetingId = id; console.log('✅ Greeting set:', name); }
  if (isLine2) { DATA.ivrSettings.line2Id = id; console.log('✅ Line2 set:', name); }
  res.json({ ok: true, id, publicUrl: entry.publicUrl });
});

app.get('/api/audio/:id', (req, res) => {
  const a = DATA.audioLib.find(x => x.id === req.params.id);
  if (!a?.data) return res.status(404).send('Not found');
  const b64 = a.data.includes(',') ? a.data.split(',')[1] : a.data;
  res.type(a.type || 'audio/mpeg');
  res.send(Buffer.from(b64, 'base64'));
});

app.post('/api/broadcast', async (req, res) => {
  const { audioId, contactIds } = req.body;
  const audio = DATA.audioLib.find(a => a.id === audioId);
  if (!audio) return res.status(404).json({ error: 'Audio not found' });
  const contacts = contactIds ? DATA.contacts.filter(c => contactIds.includes(c.id)) : DATA.contacts;
  triggerBroadcast(audio, contacts).catch(console.error);
  res.json({ ok: true, contacts: contacts.length, audio: audio.name });
});

app.get('/api/voicemails', (req, res) => res.json(DATA.voicemails));
app.delete('/api/voicemails/:id', (req, res) => {
  DATA.voicemails = DATA.voicemails.filter(v => v.id !== req.params.id);
  res.json({ ok: true });
});
app.get('/api/calllog', (req, res) => res.json(DATA.callLog.slice(-200).reverse()));
app.get('/api/broadcasts', (req, res) => res.json([...DATA.broadcasts].reverse()));
app.get('/api/data', (req, res) => res.json({
  contacts: DATA.contacts.length,
  audioLib: DATA.audioLib.map(a => ({ id: a.id, name: a.name, publicUrl: a.publicUrl,
    isBroadcast: a.isBroadcast, isGreeting: a.isGreeting, isLine2: a.isLine2 })),
  ivrSettings: { ...DATA.ivrSettings, broadcastPin: '****' },
  broadcasts: DATA.broadcasts, voicemails: DATA.voicemails,
}));

function getAudio(id) { return id ? DATA.audioLib.find(a => a.id === id) : null; }
function matchName(num) {
  const d = (num || '').replace(/\D/g, '');
  return DATA.contacts.find(c => c.phone?.replace(/\D/g, '') === d)?.name || '';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 FamilyRing Server on port ${PORT}`);
  console.log(`📞 Webhook: ${SERVER_URL}/ivr/incoming`);
  console.log(`👥 Contacts: ${DATA.contacts.length}`);
  console.log(`Telnyx: key=${TELNYX_API_KEY ? '✅' : '❌'} from=${TELNYX_FROM} conn=${TELNYX_CONNECTION_ID ? '✅' : '❌'}`);
});
