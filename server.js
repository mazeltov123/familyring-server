// ============================================================
// FamilyRing Cloud Server v4
// Based on proven Base44/Telnyx Call Control API v2 approach
// Runs 24/7 on Railway — no computer needed
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_FROM    = normalizePhone(process.env.TELNYX_FROM_NUMBER || '');
const TELNYX_CONN_ID = process.env.TELNYX_CONNECTION_ID || '';
const SERVER_URL     = (process.env.SERVER_URL || '').replace(/\/$/, '');

// Persist data to file so it survives server restarts within a session
const DATA_FILE = '/tmp/familyring_data.json';

function loadData() {
  try {
    if (require('fs').existsSync(DATA_FILE)) {
      const d = JSON.parse(require('fs').readFileSync(DATA_FILE, 'utf8'));
      console.log(`📂 Loaded persisted data: ${d.contacts?.length||0} contacts, ${d.audioLib?.length||0} audio files`);
      return d;
    }
  } catch(e) { console.log('No persisted data found, starting fresh'); }
  return null;
}

function saveData() {
  try {
    require('fs').writeFileSync(DATA_FILE, JSON.stringify({
      contacts: DATA.contacts,
      audioLib: DATA.audioLib,
      ivrSettings: DATA.ivrSettings,
      scheduled: DATA.scheduled.filter(s=>s.status==='pending'),
      inboundSms: DATA.inboundSms.slice(-200),
    }));
  } catch(e) { console.error('Save data error:', e.message); }
}

const _saved = loadData();
const DATA = {
  contacts:    _saved?.contacts    || [],
  audioLib:    _saved?.audioLib    || [],
  ivrSettings: _saved?.ivrSettings || { greetingId: null, line2Id: null, broadcastPin: process.env.BROADCAST_PIN || '1234' },
  broadcasts:  [],
  callLog:     [],
  voicemails:  [],
  inboundSms:  [],
  scheduled:   _saved?.scheduled   || [],
};
// Ensure PIN from env takes precedence if set
if (process.env.BROADCAST_PIN) DATA.ivrSettings.broadcastPin = process.env.BROADCAST_PIN;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
function normalizePhone(p) {
  if (!p) return '';
  let c = p.replace(/[^\d+]/g, '');
  if (c.startsWith('+')) return c;
  if (c.length === 10) return '+1' + c;
  if (c.length === 11 && c.startsWith('1')) return '+' + c;
  return '+' + c;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function enc(o) { return Buffer.from(JSON.stringify(o)).toString('base64'); }
function dec(s) { try { return JSON.parse(Buffer.from(s||'','base64').toString()); } catch { return {}; } }
function getAudio(id) { return id ? DATA.audioLib.find(a => a.id === id) : null; }
function matchName(num) { const d=(num||'').replace(/\D/g,''); return DATA.contacts.find(c=>(c.phone||'').replace(/\D/g,'')===d)?.name||''; }

async function cmd(ccid, action, body={}) {
  console.log(`[CMD] ${action} ${ccid?.slice(0,18)}`);
  const r = await fetch(`https://api.telnyx.com/v2/calls/${ccid}/actions/${action}`, {
    method:'POST',
    headers:{'Authorization':`Bearer ${TELNYX_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify(body),
  });
  if (!r.ok) console.error(`[CMD] ${action} FAILED:`, (await r.text()).slice(0,200));
  return r.ok;
}

async function handleInbound(type, payload, ccid, state) {
  const caller  = state.callerPhone || payload?.from || 'Unknown';
  const greeting = getAudio(DATA.ivrSettings.greetingId);
  const line2    = getAudio(DATA.ivrSettings.line2Id);

  if (type === 'call.initiated') {
    console.log(`[IVR] Incoming from ${caller}`);
    await cmd(ccid, 'answer', { client_state: enc({ mode:'inbound_ivr', step:'answering', callerPhone:caller }) });

  } else if (type === 'call.answered') {
    if (greeting?.publicUrl) {
      await cmd(ccid, 'gather_using_audio', {
        audio_url: greeting.publicUrl, minimum_digits:1, maximum_digits:1,
        valid_digits:'123', inter_digit_timeout_secs:10,
        client_state: enc({ mode:'inbound_ivr', step:'menu', callerPhone:caller }),
      });
    } else {
      await cmd(ccid, 'gather_using_speak', {
        payload:'Press 1 for past broadcasts. Press 2 for voicemail. Press 3 to record and send a broadcast.',
        voice:'female', language:'en-US', minimum_digits:1, maximum_digits:1,
        valid_digits:'123', inter_digit_timeout_secs:10,
        client_state: enc({ mode:'inbound_ivr', step:'menu', callerPhone:caller }),
      });
    }

  } else if (type === 'call.gather.ended') {
    const digits = payload?.digits || '';
    console.log(`[IVR] digits="${digits}" step="${state.step}"`);

    if (state.step === 'menu') {
      if (digits === '1') {
        // Include audio used in any past broadcast OR flagged as broadcast
        const usedAudioIds=new Set(DATA.broadcasts.map(b=>b.audioId).filter(Boolean));
        const list=DATA.audioLib.filter(a=>a.publicUrl&&(a.isBroadcast||usedAudioIds.has(a.id))).reverse();
        console.log(`[IVR] Broadcast list: ${list.length} items, audioLib: ${DATA.audioLib.length}, broadcasts: ${DATA.broadcasts.length}`);
        if (!list.length) {
          await cmd(ccid,'speak',{payload:'No broadcasts available. Goodbye.',voice:'female',language:'en-US',client_state:enc({mode:'inbound_ivr',step:'goodbye',callerPhone:caller})});
        } else {
          await cmd(ccid,'speak',{payload:`Playing broadcast: ${list[0].name}.`,voice:'female',language:'en-US',
            client_state:enc({mode:'inbound_ivr',step:'announce_broadcast',callerPhone:caller,broadcastIndex:0,totalBroadcasts:list.length})});
        }
      } else if (digits === '2') {
        if (line2?.publicUrl) {
          await cmd(ccid,'playback_start',{audio_url:line2.publicUrl,client_state:enc({mode:'inbound_ivr',step:'line2_playing',callerPhone:caller})});
        } else {
          await cmd(ccid,'speak',{payload:'Please record your message after the beep. Hang up when done.',voice:'female',language:'en-US',
            client_state:enc({mode:'inbound_ivr',step:'record_prompt',callerPhone:caller})});
        }
      } else if (digits === '3') {
        await cmd(ccid,'gather_using_speak',{payload:'Enter your PIN then press pound.',voice:'female',language:'en-US',
          minimum_digits:4,maximum_digits:8,inter_digit_timeout_secs:15,
          client_state:enc({mode:'inbound_ivr',step:'pin_entry',callerPhone:caller})});
      } else { await cmd(ccid,'hangup',{}); }

    } else if (state.step === 'pin_entry') {
      const pin = (digits||'').replace('#','');
      if (pin === DATA.ivrSettings.broadcastPin) {
        await cmd(ccid,'speak',{payload:'PIN accepted. Record your message after the beep. Press pound when finished.',
          voice:'female',language:'en-US',client_state:enc({mode:'inbound_ivr',step:'record_broadcast_prompt',callerPhone:caller})});
      } else {
        await cmd(ccid,'gather_using_speak',{payload:'Incorrect PIN. Try again.',voice:'female',language:'en-US',
          minimum_digits:4,maximum_digits:8,inter_digit_timeout_secs:15,
          client_state:enc({mode:'inbound_ivr',step:'pin_entry',callerPhone:caller})});
      }

    } else if (state.step === 'broadcast_review') {
      const d = (digits||'').replace('#','');
      if (d === '1') {
        const audio = {id:uid(),name:'Inbound Broadcast '+new Date().toLocaleString(),publicUrl:state.recordingUrl,isBroadcast:true,date:new Date().toLocaleDateString()};
        DATA.audioLib.push(audio);saveData();
        await cmd(ccid,'speak',{payload:`Approved. Sending to all ${DATA.contacts.length} contacts. Thank you. Goodbye.`,
          voice:'female',language:'en-US',client_state:enc({mode:'inbound_ivr',step:'goodbye',callerPhone:caller})});
        setTimeout(()=>triggerBroadcast(audio,DATA.contacts).catch(console.error),2000);
      } else if (d === '2') {
        await cmd(ccid,'speak',{payload:'Record again after the beep.',voice:'female',language:'en-US',
          client_state:enc({mode:'inbound_ivr',step:'record_broadcast_prompt',callerPhone:caller})});
      } else { await cmd(ccid,'hangup',{}); }
    }

  } else if (type === 'call.speak.ended') {
    const step = state.step;
    if (step === 'announce_broadcast') {
      const usedAudioIds2=new Set(DATA.broadcasts.map(b=>b.audioId).filter(Boolean));
      const list = DATA.audioLib.filter(a=>a.publicUrl&&(a.isBroadcast||usedAudioIds2.has(a.id))).reverse();
      const idx  = state.broadcastIndex||0;
      if (list[idx]?.publicUrl) {
        await cmd(ccid,'playback_start',{audio_url:list[idx].publicUrl,
          client_state:enc({mode:'inbound_ivr',step:'playing_broadcast',callerPhone:caller,broadcastIndex:idx,totalBroadcasts:list.length})});
      } else { await cmd(ccid,'hangup',{}); }
    } else if (step === 'record_prompt') {
      await cmd(ccid,'record_start',{format:'mp3',channels:'single',play_beep:true,max_length:180,timeout_secs:5,
        client_state:enc({mode:'inbound_ivr',step:'recording_voicemail',callerPhone:caller})});
    } else if (step === 'record_broadcast_prompt') {
      await cmd(ccid,'record_start',{format:'mp3',channels:'single',play_beep:true,max_length:180,timeout_secs:5,
        client_state:enc({mode:'inbound_ivr',step:'recording_broadcast',callerPhone:caller})});
    } else if (step === 'playback_before_review') {
      if (state.recordingUrl) {
        await cmd(ccid,'playback_start',{audio_url:state.recordingUrl,
          client_state:enc({...state,step:'reviewing_broadcast'})});
      }
    } else if (step === 'goodbye' || step === 'record_saved') {
      await cmd(ccid,'hangup',{});
    }

  } else if (type === 'call.playback.ended') {
    const step = state.step;
    if (step === 'line2_playing') {
      await cmd(ccid,'speak',{payload:'Please record your message after the beep. Hang up when done.',voice:'female',language:'en-US',
        client_state:enc({mode:'inbound_ivr',step:'record_prompt',callerPhone:caller})});
    } else if (step === 'playing_broadcast') {
      const usedAudioIds3=new Set(DATA.broadcasts.map(b=>b.audioId).filter(Boolean));
      const list = DATA.audioLib.filter(a=>a.publicUrl&&(a.isBroadcast||usedAudioIds3.has(a.id))).reverse();
      const next = (state.broadcastIndex||0)+1;
      if (next < list.length && list[next]?.publicUrl) {
        await cmd(ccid,'speak',{payload:`Next: ${list[next].name}.`,voice:'female',language:'en-US',
          client_state:enc({mode:'inbound_ivr',step:'announce_broadcast',callerPhone:caller,broadcastIndex:next,totalBroadcasts:list.length})});
      } else {
        await cmd(ccid,'speak',{payload:'That was the last broadcast. Goodbye.',voice:'female',language:'en-US',
          client_state:enc({mode:'inbound_ivr',step:'goodbye',callerPhone:caller})});
      }
    } else if (step === 'reviewing_broadcast') {
      await cmd(ccid,'gather_using_speak',{
        payload:'Press 1 to approve and send to everyone. Press 2 to record again.',
        voice:'female',language:'en-US',minimum_digits:1,maximum_digits:1,
        valid_digits:'12',inter_digit_timeout_secs:15,
        client_state:enc({mode:'inbound_ivr',step:'broadcast_review',callerPhone:caller,recordingUrl:state.recordingUrl}),
      });
    }

  } else if (type === 'call.recording.saved') {
    const url = payload?.recording_urls?.mp3 || payload?.public_recording_urls?.mp3 || '';
    console.log(`[IVR] Recording saved: ${url} step: ${state.step}`);
    if (state.step === 'recording_voicemail') {
      DATA.voicemails.push({id:uid(),from:caller,name:matchName(caller),recordingUrl:url,date:new Date().toISOString()});
      await cmd(ccid,'speak',{payload:'Thank you. Message saved. Goodbye.',voice:'female',language:'en-US',
        client_state:enc({mode:'inbound_ivr',step:'record_saved',callerPhone:caller})});
    } else if (state.step === 'recording_broadcast') {
      await cmd(ccid,'speak',{payload:'Recording complete. Here is your message.',voice:'female',language:'en-US',
        client_state:enc({mode:'inbound_ivr',step:'playback_before_review',callerPhone:caller,recordingUrl:url})});
    }

  } else if (type === 'call.hangup') {
    console.log(`[IVR] Call ended from ${caller}`);
    DATA.callLog.push({id:uid(),direction:'inbound',number:caller,name:matchName(caller),startTime:Date.now(),status:'completed'});
  }
}

async function handleOutbound(type, payload, ccid, state) {
  const { audioUrl, contactName, phone, broadcastId, rsvp } = state;

  if (type === 'call.answered') {
    console.log(`[OUT] Answered: ${contactName} rsvp=${!!rsvp}`);
    if (audioUrl) {
      await cmd(ccid,'playback_start',{audio_url:audioUrl,client_state:enc(state)});
    } else {
      await cmd(ccid,'speak',{payload:'Hello, this is a message from Family Ring.',voice:'female',language:'en-US',client_state:enc(state)});
    }

  } else if (type === 'call.playback.ended' || type === 'call.speak.ended') {
    // If RSVP options exist, gather response after audio plays
    if (rsvp && rsvp.options && rsvp.options.length > 0 && state.step !== 'rsvp_done') {
      const prompt = rsvp.options.map((o,i) => `Press ${o.key} ${o.label}`).join('. ');
      const validDigits = rsvp.options.map(o=>o.key).join('');
      await cmd(ccid, 'gather_using_speak', {
        payload: prompt,
        voice: 'female', language: 'en-US',
        minimum_digits: 1, maximum_digits: 1,
        valid_digits: validDigits,
        inter_digit_timeout_secs: 10,
        client_state: enc({...state, step:'rsvp_waiting'}),
      });
    } else {
      await cmd(ccid,'hangup',{});
    }

  } else if (type === 'call.gather.ended' && state.step === 'rsvp_waiting') {
    const digit = payload?.digits || '';
    const option = rsvp?.options?.find(o => o.key === digit);
    console.log(`[RSVP] ${contactName} pressed ${digit} = ${option?.label || 'unknown'}`);
    // Save the response
    if (broadcastId) {
      const br = DATA.broadcasts.find(b => b.id === broadcastId);
      if (br) {
        if (!br.rsvpResponses) br.rsvpResponses = [];
        br.rsvpResponses.push({
          contactName, phone, digit,
          label: option?.label || digit,
          time: new Date().toISOString(),
        });
        saveData();
      }
    }
    // Thank them and hang up
    const thanks = option?.thanks || 'Thank you. Goodbye.';
    await cmd(ccid, 'speak', {
      payload: thanks, voice:'female', language:'en-US',
      client_state: enc({...state, step:'rsvp_done'}),
    });

  } else if (type === 'call.hangup') {
    const cause = payload?.hangup_cause||'unknown';
    const s = payload?.start_time?new Date(payload.start_time):null;
    const e = payload?.end_time?new Date(payload.end_time):null;
    const dur = (s&&e)?Math.round((e-s)/1000):0;
    let status='failed';
    if (['normal_clearing','originator_cancel'].includes(cause)) status=dur>0?'answered':'no_answer';
    else if (cause==='user_busy') status='busy';
    else if (['no_answer','timeout','call_rejected'].includes(cause)) status='no_answer';
    console.log(`[OUT] Hangup ${contactName} — ${status} ${dur}s`);
    DATA.callLog.push({id:uid(),direction:'outbound',number:phone,name:contactName,broadcastId,duration:dur,status,startTime:Date.now()});
    if (broadcastId) {
      const br=DATA.broadcasts.find(b=>b.id===broadcastId);
      if (br) { if(status==='answered')br.answered++;else br.missed++; if(br.answered+br.missed>=br.totalContacts){br.status='completed';br.endTime=new Date().toISOString();} }
    }
  }
}

app.post('/ivr/incoming', async (req,res) => {
  res.sendStatus(200);
  const event   = req.body?.data || req.body;
  if (!event) return;
  const type    = event.event_type || event.type;
  const payload = event.payload || event;
  const ccid    = payload?.call_control_id;
  const state   = dec(payload?.client_state);
  const dir     = payload?.direction;
  console.log(`[EVT] ${type} | dir=${dir||'?'} | mode=${state.mode||'out'} | step=${state.step||'-'}`);
  if (!ccid) { console.log('Missing ccid, body:', JSON.stringify(req.body).slice(0,200)); return; }
  try {
    if (dir==='incoming'||state.mode==='inbound_ivr') await handleInbound(type,payload,ccid,state);
    else await handleOutbound(type,payload,ccid,state);
  } catch(e) { console.error('Handler error:',e.message,e.stack?.slice(0,300)); }
});

async function triggerBroadcast(audio, contacts, rsvp=null) {
  if (!contacts.length) return;
  console.log(`\n📢 BROADCAST "${audio.name}" → ${contacts.length} contacts`);
  // Mark audio as broadcast so IVR can play it back
  const audioEntry = DATA.audioLib.find(a=>a.id===audio.id);
  if(audioEntry && !audioEntry.isBroadcast){ audioEntry.isBroadcast=true; saveData(); }

  const rec={id:uid(),audioName:audio.name,audioId:audio.id,startTime:new Date().toISOString(),
    totalContacts:contacts.length,answered:0,missed:0,status:'running',
    rsvpOptions:rsvp?.options||null, rsvpResponses:[]};
  DATA.broadcasts.push(rec);
  for (let i=0;i<contacts.length;i++) {
    const c=contacts[i];
    if (!c.phone) continue;
    if (i>0) {
      const cpm = DATA.ivrSettings.callsPerMinute || 12;
      const delayMs = Math.round(60000 / cpm);
      await sleep(delayMs);
    }
    const phone=normalizePhone(c.phone);
    try {
      const r=await fetch('https://api.telnyx.com/v2/calls',{
        method:'POST',
        headers:{'Authorization':`Bearer ${TELNYX_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify({connection_id:TELNYX_CONN_ID,to:phone,from:TELNYX_FROM,
          webhook_url:`${SERVER_URL}/ivr/incoming`,webhook_url_method:'POST',
          client_state:enc({broadcastId:rec.id,contactName:c.name||'',phone,audioUrl:audio.publicUrl||'',rsvp:rsvp||null}),
          timeout_secs:30}),
      });
      if (r.ok) console.log(`  ✅ ${i+1}/${contacts.length} ${c.name} (${phone})`);
      else { const t=await r.text(); console.error(`  ❌ ${c.name}: ${t.slice(0,150)}`); rec.missed++; }
    } catch(e) { console.error(`  ❌ ${c.name}: ${e.message}`); rec.missed++; }
  }
  console.log('📢 All calls initiated');
}

function startScheduler() {
  setInterval(async()=>{
    const now=new Date();
    const due=DATA.scheduled.filter(s=>s.status==='pending'&&new Date(s.scheduledFor)<=now);
    for (const s of due) {
      console.log(`⏰ Firing: ${s.name}`);
      s.status='fired';
      const audio=getAudio(s.audioId);
      const contacts=s.recipientIds?.length?DATA.contacts.filter(c=>s.recipientIds.includes(c.id)):DATA.contacts;
      if (audio&&contacts.length) triggerBroadcast(audio,contacts).catch(console.error);
      else console.error(`Missing audio or contacts for scheduled: ${s.id}`);
    }
  },60000);
  console.log('⏰ Scheduler running (every 60s)');
}

// PWA Manifest
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'FamilyRing',
    short_name: 'FamilyRing',
    description: 'Family broadcast calling system',
    start_url: '/app',
    display: 'standalone',
    background_color: '#f6f1eb',
    theme_color: '#2a2420',
    orientation: 'portrait',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ]
  });
});

// Generate a simple PNG icon programmatically
function generateIconPng(size) {
  // Minimal valid PNG with FamilyRing colors (dark background, phone emoji area)
  // We'll serve a simple colored square PNG
  const { createCanvas } = (() => { try { return require('canvas'); } catch(e) { return null; } })() || {};
  return null; // fallback to SVG-based approach below
}

app.get('/icon-:size.png', (req, res) => {
  const size = parseInt(req.params.size) || 192;
  // Serve an SVG as PNG fallback (browsers accept this for PWA icons)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${size*0.2}" fill="#2a2420"/>
    <text x="50%" y="55%" font-size="${size*0.55}" text-anchor="middle" dominant-baseline="middle" font-family="Arial">📞</text>
    <text x="50%" y="83%" font-size="${size*0.14}" text-anchor="middle" fill="#d4853a" font-family="Arial" font-weight="bold">FamilyRing</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

// Service worker for offline support
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => clients.claim());
  `);
});

// Serve the FamilyRing web app
let APP_HTML = null;
app.get('/app', (req, res) => {
  if (APP_HTML) {
    res.type('text/html');
    res.send(APP_HTML);
  } else {
    res.type('text/html');
    res.send('<h2>App not uploaded yet. POST the HTML to /api/app/upload</h2><p>Or visit <a href="/">server status</a></p>');
  }
});

// Upload the app HTML (call this once after deploying)
app.post('/api/app/upload', (req, res) => {
  const { html } = req.body;
  if (!html) return res.status(400).json({ error: 'html required' });
  APP_HTML = html;
  console.log(`✅ App HTML uploaded (${Math.round(html.length/1024)}KB)`);
  res.json({ ok: true, url: SERVER_URL + '/app', size: Math.round(html.length/1024) + 'KB' });
});

app.get('/',(req,res)=>res.json({status:'✅ FamilyRing Server',contacts:DATA.contacts.length,audio:DATA.audioLib.length,
  broadcasts:DATA.broadcasts.length,voicemails:DATA.voicemails.length,
  scheduled:DATA.scheduled.filter(s=>s.status==='pending').length,
  greeting:DATA.ivrSettings.greetingId?'✅':'❌ not uploaded',pin:DATA.ivrSettings.broadcastPin?'✅':'❌',
  webhook:`${SERVER_URL}/ivr/incoming`,
  smsWebhook:`${SERVER_URL}/ivr/sms`,
  inboundSms:DATA.inboundSms.length,
  app:`${SERVER_URL}/app`}));

app.post('/api/sync/contacts',(req,res)=>{
  if(!Array.isArray(req.body.contacts))return res.status(400).json({error:'array required'});
  DATA.contacts=req.body.contacts;saveData();console.log(`✅ ${DATA.contacts.length} contacts`);res.json({ok:true,count:DATA.contacts.length});});

app.post('/api/sync/ivr',(req,res)=>{
  const{broadcastPin,enabled,greetingId,line2Id}=req.body;
  if(broadcastPin!==undefined)DATA.ivrSettings.broadcastPin=broadcastPin;
  if(enabled!==undefined)DATA.ivrSettings.enabled=enabled;
  if(req.body.callsPerMinute!==undefined)DATA.ivrSettings.callsPerMinute=parseInt(req.body.callsPerMinute)||12;
  if(greedingId!==undefined)DATA.ivrSettings.greetingId=greetingId;
  if(line2Id!==undefined)DATA.ivrSettings.line2Id=line2Id;
  saveData();res.json({ok:true});});

app.post('/api/audio/upload',(req,res)=>{
  const{name,data,type,isBroadcast,isGreeting,isLine2}=req.body;
  if(!name||!data)return res.status(400).json({error:'name+data required'});
  const id=uid();
  const entry={id,name,data,type:type||'audio/mpeg',isBroadcast:!!isBroadcast,isGreeting:!!isGreeting,isLine2:!!isLine2,
    publicUrl:`${SERVER_URL}/api/audio/${id}`,date:new Date().toLocaleDateString()};
  DATA.audioLib.push(entry);
  if(isGreeting){DATA.ivrSettings.greetingId=id;console.log(`✅ Greeting: "${name}"`);}
  if(isLine2){DATA.ivrSettings.line2Id=id;console.log(`✅ Line2: "${name}"`);}
  saveData();
  console.log(`✅ Audio: "${name}" (${Math.round(data.length/1024)}KB)`);
  res.json({ok:true,id,publicUrl:entry.publicUrl});});

app.get('/api/audio/:id',(req,res)=>{
  const a=DATA.audioLib.find(x=>x.id===req.params.id);
  if(!a?.data)return res.status(404).send('Not found');
  const b64=a.data.includes(',')? a.data.split(',')[1]:a.data;
  res.setHeader('Content-Type',a.type||'audio/mpeg');
  res.setHeader('Cache-Control','public,max-age=3600');
  res.send(Buffer.from(b64,'base64'));});

app.post('/api/broadcast',async(req,res)=>{
  const{audioId,contactIds,rsvp,callsPerMinute}=req.body;
  if(callsPerMinute)DATA.ivrSettings.callsPerMinute=parseInt(callsPerMinute)||12;
  const audio=DATA.audioLib.find(a=>a.id===audioId);
  if(!audio)return res.status(404).json({error:'Audio not found'});
  const contacts=contactIds?.length?DATA.contacts.filter(c=>contactIds.includes(c.id)):DATA.contacts;
  if(!contacts.length)return res.status(400).json({error:'No contacts'});
  // Create broadcast record immediately so we can return the ID
  const bcastId=uid();
  const rec={id:bcastId,audioName:audio.name,audioId:audio.id,startTime:new Date().toISOString(),
    totalContacts:contacts.length,answered:0,missed:0,status:'running',
    rsvpOptions:rsvp?.options||null,rsvpResponses:[]};
  DATA.broadcasts.push(rec);
  res.json({ok:true,contacts:contacts.length,audio:audio.name,broadcastId:bcastId});
  triggerBroadcast(audio,contacts,rsvp||null,bcastId).catch(console.error);});

// Inbound SMS webhook (Telnyx sends here when someone texts your number)
app.post('/ivr/sms', (req, res) => {
  res.sendStatus(200);
  const payload = req.body?.data?.payload || req.body?.payload || req.body;
  const from    = payload?.from?.phone_number || payload?.from || '';
  const to      = payload?.to?.[0]?.phone_number || payload?.to || '';
  const text    = payload?.text || payload?.body || '';
  if (!from || !text) return;
  const name    = matchName(from);
  console.log(`📩 Inbound SMS from ${name||from}: "${text.slice(0,80)}"`);
  DATA.inboundSms.push({
    id: uid(), from, to, name, text,
    date: new Date().toISOString(),
    read: false,
  });
  saveData();
});

// Get inbound SMS
app.get('/api/sms/inbox', (req,res) => res.json([...DATA.inboundSms].reverse()));

// Mark SMS as read
app.post('/api/sms/inbox/:id/read', (req,res) => {
  const m = DATA.inboundSms.find(s=>s.id===req.params.id);
  if(m) m.read = true;
  res.json({ok:true});
});

// Delete SMS
app.delete('/api/sms/inbox/:id', (req,res) => {
  DATA.inboundSms = DATA.inboundSms.filter(s=>s.id!==req.params.id);
  saveData();
  res.json({ok:true});
});

// SMS broadcast
app.post('/api/sms', async (req,res) => {
  const { message, contactIds } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const contacts = contactIds?.length
    ? DATA.contacts.filter(c => contactIds.includes(c.id))
    : DATA.contacts;
  if (!contacts.length) return res.status(400).json({ error: 'No contacts' });

  res.json({ ok: true, sent: contacts.length, message: message.slice(0,50)+'…' });

  // Fire SMS async
  (async () => {
    console.log(`💬 SMS broadcast to ${contacts.length} contacts`);
    let sent = 0, failed = 0;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      if (!c.phone) continue;
      if (i > 0) await sleep(500); // 500ms between SMS
      const phone = normalizePhone(c.phone);
      try {
        const r = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: TELNYX_FROM,
            to: phone,
            text: message,
          }),
        });
        if (r.ok) { sent++; console.log(`  ✅ SMS ${i+1}/${contacts.length} ${c.name} (${phone})`); }
        else { const t=await r.text(); console.error(`  ❌ SMS ${c.name}: ${t.slice(0,150)}`); failed++; }
      } catch(e) { console.error(`  ❌ SMS ${c.name}: ${e.message}`); failed++; }
    }
    console.log(`💬 SMS done — sent: ${sent}, failed: ${failed}`);
  })().catch(console.error);
});

app.post('/api/schedule',(req,res)=>{
  const{audioId,recipientIds,scheduledFor,name}=req.body;
  if(!audioId||!scheduledFor)return res.status(400).json({error:'audioId+scheduledFor required'});
  const audio=DATA.audioLib.find(a=>a.id===audioId);
  if(!audio)return res.status(404).json({error:'Audio not found'});
  const entry={id:uid(),audioId,recipientIds:recipientIds||[],scheduledFor,name:name||audio.name,status:'pending',created:new Date().toISOString()};
  DATA.scheduled.push(entry);
  saveData();
  console.log(`⏰ Scheduled: "${entry.name}" for ${scheduledFor}`);
  res.json({ok:true,id:entry.id});});

app.delete('/api/schedule/:id',(req,res)=>{
  const s=DATA.scheduled.find(x=>x.id===req.params.id);
  if(!s)return res.status(404).json({error:'Not found'});
  s.status='cancelled';res.json({ok:true});});

app.get('/api/scheduled',(req,res)=>res.json(DATA.scheduled));
app.get('/api/voicemails',(req,res)=>res.json(DATA.voicemails));
app.delete('/api/voicemails/:id',(req,res)=>{DATA.voicemails=DATA.voicemails.filter(v=>v.id!==req.params.id);res.json({ok:true});});
app.get('/api/calllog',(req,res)=>res.json(DATA.callLog.slice(-200).reverse()));
app.get('/api/broadcasts',(req,res)=>res.json([...DATA.broadcasts].reverse()));
app.get('/api/broadcasts/:id/rsvp',(req,res)=>{
  const br=DATA.broadcasts.find(b=>b.id===req.params.id);
  if(!br)return res.status(404).json({error:'Not found'});
  res.json({broadcastId:br.id,audioName:br.audioName,rsvpOptions:br.rsvpOptions||[],responses:br.rsvpResponses||[],totalContacts:br.totalContacts,answered:br.answered});
});
// Mark audio as available for IVR broadcast playback
app.post('/api/audio/:id/mark-broadcast',(req,res)=>{
  const a=DATA.audioLib.find(x=>x.id===req.params.id);
  if(!a)return res.status(404).json({error:'Not found'});
  a.isBroadcast=true;saveData();
  res.json({ok:true,name:a.name});
});

app.get('/api/data',(req,res)=>res.json({contacts:DATA.contacts.length,
  audioLib:DATA.audioLib.map(a=>({id:a.id,name:a.name,publicUrl:a.publicUrl,isBroadcast:a.isBroadcast,isGreeting:a.isGreeting,isLine2:a.isLine2})),
  ivrSettings:{...DATA.ivrSettings,broadcastPin:'****'},broadcasts:DATA.broadcasts,voicemails:DATA.voicemails,scheduled:DATA.scheduled}));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`\n🚀 FamilyRing Server v4 on port ${PORT}`);
  console.log(`📞 Webhook: ${SERVER_URL}/ivr/incoming`);
  console.log(`🔑 API Key: ${TELNYX_API_KEY?'✅':'❌ MISSING'}`);
  console.log(`📱 From: ${TELNYX_FROM||'❌ MISSING'}`);
  console.log(`🔗 Conn ID: ${TELNYX_CONN_ID?'✅':'❌ MISSING'}`);
  console.log(`🔐 PIN: ${DATA.ivrSettings.broadcastPin?'****':'NOT SET'}`);
  startScheduler();
});
