// khaali live — server-authoritative booking with berth locking.
//
// Run:  node server.mjs
// Then open the printed LAN address on every phone you want to test with.
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { ST, CLS, TRAINS, CORE_TRAINS } from './data.mjs';
import { GEO } from './geo.mjs';

const QRCode = createRequire(import.meta.url)('qrcode');
import {
  serves, stopIdxs, sMin, hhmm, plat, liveOf, fare, journeyKm, stationByCode,
  cancelledOn, oddsOf, oddsOf2, trainByNo,
} from './engine.mjs';
import * as store from './store.mjs';
import * as sentinel from './sentinel.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const TODAY = () => new Date().toISOString().slice(0, 10);

// Simulation clock: can be shifted to any time of day and run faster than real
// time, so a demo can watch the whole day's traffic in minutes.
let simAnchor = Date.now();        // real ms when the clock was last adjusted
let simAtAnchor = Date.now();      // simulated ms at that moment
let simSpeed = 1;                  // 1 = real time
const simNow = () => new Date(simAtAnchor + (Date.now() - simAnchor) * simSpeed);
const simShiftMin = () => Math.round((simNow().getTime() - Date.now()) / 60000);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

const send = (res, code, body, type = 'application/json') => {
  const b = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(b);
};

const readBody = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

const LAN_IPS = Object.values(os.networkInterfaces()).flat()
  .filter(n => n && n.family === 'IPv4' && !n.internal)
  .map(n => n.address)
  // 192.168.56.x is usually a VirtualBox adapter phones cannot see
  .sort((a, b) => (a.startsWith('192.168.56.') ? 1 : 0) - (b.startsWith('192.168.56.') ? 1 : 0));

/** Best address for a phone to reach this server, given how the caller got here. */
function lanBase(req) {
  const host = (req.headers.host || '').split(':')[0];
  if (host && host !== 'localhost' && host !== '127.0.0.1') return `http://${req.headers.host}`;
  return LAN_IPS.length ? `http://${LAN_IPS[0]}:${PORT}` : `http://localhost:${PORT}`;
}

// ----------------------------------------------------------------- Saarthi --
// Multilingual booking copilot backed by Sarvam AI. The key never reaches the
// browser; without one the endpoint degrades to a friendly notice.
// OpenAI writes sentences about numbers other code computed. It never
// decides an allotment, a price, or a probability - so a missing key or a
// dead quota costs the product nothing but prose.
const OPENAI_KEY = process.env.OPENAI_API_KEY
  || (() => { try { return fs.readFileSync(path.join(DIR, '.openai-key'), 'utf8').trim(); } catch { return ''; } })();
const narrCache = new Map();

// Identity is proved, not claimed. The browser sends its Supabase access
// token; we ask Supabase whose it is. A verified token is remembered for ten
// minutes so this costs one round trip per session, not per tap.
const SUPA_URL = process.env.SUPABASE_URL || 'https://bqzbdajkrtbuovhjimvp.supabase.co';
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_RGMBcLx0VUY1-5vfm___-Q_5ryOV-y0';
const tokenCache = new Map();                       // token -> { email, at }

async function whoIs(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok) return null;
  const hit = tokenCache.get(tok);
  if (hit && Date.now() - hit.at < 600000) return hit.email;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', {
      signal: ac.signal,
      headers: { apikey: SUPA_ANON, authorization: 'Bearer ' + tok },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const email = j && j.email;
    if (!email) return null;
    tokenCache.set(tok, { email, at: Date.now() });
    if (tokenCache.size > 500) tokenCache.delete(tokenCache.keys().next().value);
    return email;
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function narrate(cacheKey, system, user, maxTokens = 170) {
  if (narrCache.has(cacheKey)) return narrCache.get(cacheKey);
  if (!OPENAI_KEY) return '';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { authorization: 'Bearer ' + OPENAI_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini', temperature: 0.4, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    const out = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    if (out) { narrCache.set(cacheKey, out); if (narrCache.size > 300) narrCache.delete(narrCache.keys().next().value); }
    return out;
  } catch { return ''; }
  finally { clearTimeout(t); }
}

const NARR_RULES = 'You are khaali, an Indian railway booking product. Write plain, warm, '
  + 'concrete English for an ordinary traveller. Never invent a number: use only the figures given, '
  + 'and never contradict them. No markdown, no bullet points, no preamble, no exclamation marks. '
  + 'Two sentences, at most 45 words total.';

const SARVAM_KEY = process.env.SARVAM_KEY
  || (() => { try { return fs.readFileSync(path.join(DIR, '.sarvam-key'), 'utf8').trim(); } catch { return ''; } })();

async function sarvam(messages, maxTokens = 4096) {   // 4096 = starter-tier ceiling
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch('https://api.sarvam.ai/v1/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { 'api-subscription-key': SARVAM_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sarvam-105b', temperature: 0.2, max_tokens: maxTokens, messages }),
    });
    if (!r.ok) throw new Error('sarvam http ' + r.status);
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } finally { clearTimeout(t); }
}

const GREET_TEXT = '\u0928\u092e\u0938\u094d\u0924\u0947! \u092e\u0948\u0902 \u0916\u093e\u0932\u0940 \u0938\u0947 \u0938\u093e\u0930\u0925\u0940 \u092c\u094b\u0932 \u0930\u0939\u093e \u0939\u0942\u0901\u0964 \u092c\u0924\u093e\u0907\u090f, \u0906\u091c \u0915\u0939\u093e\u0901 \u091c\u093e\u0928\u093e \u0939\u0948?';
const ttsCache = new Map();          // lang|text -> base64 mp3
/** Voice-safe text: no bullets, '=', slashes, brackets or markdown to spell out. */
function speakable(t) {
  return String(t)
    .replace(/[*_#`~]/g, ' ')
    .replace(/^\s*[-\u2022\u25cf]\s*/gm, '')
    .replace(/\s[-\u2013\u2014]\s/g, ', ')
    .replace(/=/g, ', ')
    .replace(/\//g, ' ')
    .replace(/[()\[\]{}<>|]/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}
async function ttsAudio(text, lang) {
  text = speakable(text);
  const k = lang + '|' + text;
  if (ttsCache.has(k)) return ttsCache.get(k);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);
  const r = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST', signal: ac.signal,
    headers: { 'api-subscription-key': SARVAM_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, language_code: lang, model: 'bulbul:v3',
      speech_sample_rate: 22050, output_audio_codec: 'mp3' }),
  }).finally(() => clearTimeout(t));
  if (!r.ok) throw new Error('tts http ' + r.status);
  const j = await r.json();
  const audio = (j.audios && j.audios[0]) || '';
  if (audio) { ttsCache.set(k, audio); if (ttsCache.size > 80) ttsCache.delete(ttsCache.keys().next().value); }
  return audio;
}

/** Mayura: fast high-quality translation — the speed path for answers. */
async function translateTo(text, target, source) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 9000);
  const r = await fetch('https://api.sarvam.ai/translate', {
    method: 'POST', signal: ac.signal,
    headers: { 'api-subscription-key': SARVAM_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, source_language_code: source || 'en-IN', target_language_code: target }),
  }).finally(() => clearTimeout(t));
  if (!r.ok) throw new Error('translate http ' + r.status);
  const j = await r.json();
  return (j.translated_text || '').trim();
}

/** The model sometimes wraps its answer in the JSON envelope; always unwrap.
    A parsed envelope with an empty say yields '' (so fallbacks fire) — the
    raw JSON must never reach a chat bubble. */
function sayOf(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  const m = str.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && typeof j.say === 'string') return j.say.trim();
    } catch {}
    // JSON-looking but unparseable: salvage any text outside the braces
    const outside = str.replace(m[0], '').trim();
    return outside;
  }
  return str;
}

const RETRY_SAY = {
  'hi-IN': '\u092e\u093e\u092b \u0915\u0930\u0928\u093e, \u092e\u0948\u0902 \u0938\u092e\u091d \u0928\u0939\u0940\u0902 \u092a\u093e\u092f\u093e \u2014 \u090f\u0915 \u092c\u093e\u0930 \u092b\u093f\u0930 \u0938\u0947, \u0925\u094b\u0921\u093c\u093e \u0938\u0930\u0932 \u0936\u092c\u094d\u0926\u094b\u0902 \u092e\u0947\u0902 \u092a\u0942\u091b\u094b?',
  'en-IN': 'Sorry, I could not follow that \u2014 ask once more in simpler words?',
};
async function retrySayFor(sl) {
  const en = RETRY_SAY['en-IN'];
  if (!sl || sl[1] === 'hi-IN') return RETRY_SAY['hi-IN'];
  if (sl[1] === 'en-IN') return en;
  try { return (await translateTo(en, sl[1])) || RETRY_SAY['hi-IN']; }
  catch { return RETRY_SAY['hi-IN']; }
}

/** Did the traveller explicitly ask for a language? That always wins. */
function requestedLangOf(t) {
  const s = String(t).toLowerCase();
  const M = [
    [/\u092e\u0930\u093e\u0920\u0940|\u0cae\u0cb0\u0cbe\u0ca0\u0cbf|\u0bae\u0bb0\u0bbe\u0ba4\u0bcd\u0ba4\u0bbf|\u0c2e\u0c30\u0c3e\u0c20\u0c40|marathi/, ['Marathi', 'mr-IN']],
    [/\u0939\u093f\u0902\u0926\u0940|\u0939\u093f\u0928\u094d\u0926\u0940|\u0cb9\u0cbf\u0c82\u0ca6\u0cbf|\u0bb9\u0bbf\u0ba8\u0bcd\u0ba4\u0bbf|\u0b87\u0ba8\u0bcd\u0ba4\u0bbf|\u0c39\u0c3f\u0c02\u0c26\u0c40|\u0d39\u0d3f\u0d28\u0d4d\u0d26\u0d3f|hindi/, ['Hindi', 'hi-IN']],
    [/\u0c95\u0ca8\u0ccd\u0ca8\u0ca1|\u0915\u0928\u094d\u0928\u0921|\u0b95\u0ba9\u0bcd\u0ba9\u0b9f|\u0c15\u0c28\u0c4d\u0c28\u0c21|\u0d15\u0d28\u0d4d\u0d28\u0d21|kannada/, ['Kannada', 'kn-IN']],
    [/\u0ba4\u0bae\u0bbf\u0bb4\u0bcd|\u0924\u092e\u093f\u0932|\u0ca4\u0cae\u0cbf\u0cb3|\u0c24\u0c2e\u0c3f\u0c33|\u0d24\u0d2e\u0d3f\u0d34|tamil/, ['Tamil', 'ta-IN']],
    [/\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41|\u0924\u0947\u0932\u0941\u0917\u0941|\u0ca4\u0cc6\u0cb2\u0cc1\u0c97\u0cc1|\u0ba4\u0bc6\u0bb2\u0bc1\u0b99\u0bcd\u0b95\u0bc1|\u0d24\u0d46\u0d32\u0d41\u0d19\u0d4d\u0d15\u0d4d|telugu/, ['Telugu', 'te-IN']],
    [/\u0d2e\u0d32\u0d2f\u0d3e\u0d33\u0d02|\u092e\u0932\u092f\u093e\u0932\u092e|\u0cae\u0cb2\u0caf\u0cbe\u0cb3|\u0bae\u0bb2\u0bc8\u0baf\u0bbe\u0bb3|\u0c2e\u0c32\u0c2f\u0c3e\u0c33|malayalam/, ['Malayalam', 'ml-IN']],
    [/\u09ac\u09be\u0982\u09b2\u09be|\u092c\u093e\u0902\u0917\u094d\u0932\u093e|bangla|bengali/, ['Bengali', 'bn-IN']],
    [/\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0|\u0917\u0941\u091c\u0930\u093e\u0924\u0940|gujarati/, ['Gujarati', 'gu-IN']],
    [/\u0a2a\u0a70\u0a1c\u0a3e\u0a2c\u0a40|\u092a\u0902\u091c\u093e\u092c\u0940|punjabi/, ['Punjabi', 'pa-IN']],
    [/\u0b13\u0b21\u0b3c\u0b3f\u0b06|\u0913\u0921\u093f\u092f\u093e|\u0909\u0921\u093c\u093f\u092f\u093e|odia|oriya/, ['Odia', 'od-IN']],
    [/english|\u0905\u0902\u0917\u094d\u0930\u0947\u091c|\u0907\u0902\u0917\u094d\u0932\u093f\u0936|\u0c87\u0c82\u0c97\u0ccd\u0cb2\u0cbf\u0cb7\u0ccd|\u0b86\u0b99\u0bcd\u0b95\u0bbf\u0bb2|\u0c07\u0c02\u0c17\u0c4d\u0c32\u0c40\u0c37\u0c41|\u0d07\u0d02\u0d17\u0d4d\u0d32\u0d40\u0d37\u0d4d/, ['English', 'en-IN']],
  ];
  // When two language names appear ("papa doesn't know Kannada, explain in
  // Tamil"), the LAST mentioned one is the request.
  let best = null, bestAt = -1;
  for (const [re, v] of M) {
    const g = new RegExp(re.source, 'g');
    let mm, last = -1;
    while ((mm = g.exec(s))) last = mm.index;
    if (last > bestAt) { bestAt = last; best = v; }
  }
  return best;
}

/** Which Indic script is this text written in? Unicode ranges are exact. */
function scriptLangOf(t) {
  if (/[\u0D00-\u0D7F]/.test(t)) return ['Malayalam', 'ml-IN'];
  if (/[\u0C80-\u0CFF]/.test(t)) return ['Kannada', 'kn-IN'];
  if (/[\u0B80-\u0BFF]/.test(t)) return ['Tamil', 'ta-IN'];
  if (/[\u0C00-\u0C7F]/.test(t)) return ['Telugu', 'te-IN'];
  if (/[\u0980-\u09FF]/.test(t)) return ['Bengali', 'bn-IN'];
  if (/[\u0A80-\u0AFF]/.test(t)) return ['Gujarati', 'gu-IN'];
  if (/[\u0A00-\u0A7F]/.test(t)) return ['Punjabi', 'pa-IN'];
  if (/[\u0B00-\u0B7F]/.test(t)) return ['Odia', 'od-IN'];
  if (/[\u0900-\u097F]/.test(t)) return ['Hindi', 'hi-IN'];
  return null;
}

const SAARTHI_SYS = () => [
  'You are Saarthi, the travel copilot inside khaali, a demo rail booking app for the Bangarpet\u2013Mysuru corridor in Karnataka, India.',
  'CRITICAL: answer in the SAME language AND script the traveller wrote in — Kannada in Kannada script, Tamil in Tamil script, Hinglish in Hinglish. EXCEPTION: if they ASK for another language (for a family member, a friend, anyone), switch to it happily — never refuse a language request; you speak all Indian languages. Be warm and brief.',
  'Corridor stations (index:code name): ' + ST.map((s, i) => i + ':' + s.c + ' ' + s.n).join(', ') + '.',
  'Travellers write station names in any script or spelling — match them phonetically: Bangalore/Bengaluru/बेंगलुरु/ಬೆಂಗಳೂರು = index 5 (Bengaluru KSR City); Mysore/Mysuru/मैसूर/ಮೈಸೂರು = index 13 (Mysuru Jn); Whitefield = 1; Bangarpet = 0; Mandya/मंड्या/ಮಂಡ್ಯ = 11. If both stations are clear, DO return the search action — do not ask again.',
  'khaali sells interval berths: green = berth free for the whole journey; amber = berth occupied for part of the route and free for the rest, priced only for the empty stretch, so it is cheaper. Booking opens from tomorrow up to 60 days ahead. Payment is a simulated QR; this is a prototype, not IRCTC.',
  'Today is ' + TODAY() + '. Bookings run from today up to 60 days ahead. Relative days: aaj/ivattu/indru/today = today (' + TODAY() + ') \u2014 DO include it as the date, the system answers with today\u2019s running trains; kal/nale/nalaikku = today+1; parso/naadiddu/ellundhaikku = today+2 \u2014 always convert to a concrete YYYY-MM-DD.',
  'When the traveller asks about trains, seats, prices or availability between two corridor stations, respond ONLY with JSON: {"say":"","action":{"type":"search","from":<index>,"to":<index>,"cls":"SL","date":"YYYY-MM-DD"}} (cls one of SL, 3A, 2A, default SL; include "date" ONLY when the traveller names a day, resolved against today, otherwise omit it; include "around":"HH:MM" in 24-hour time ONLY when the traveller names a time of day \u2014 morning/subah/belagge/kaalai means AM, evening/shaam/sanje/maalai/raat means PM, so \u201caround 7:30 in the evening\u201d \u2192 "around":"19:30").',
  'NEVER ask the traveller which date before searching. With no date named, omit the date field and search anyway \u2014 the system picks the first bookable day and tells them which day it used.',
  'CANCELLATION QUESTIONS (which trains are cancelled / is X cancelled / kya cancel hai / \u0c95\u0ccd\u0caf\u0cbe\u0ca8\u0ccd\u0cb8\u0cb2\u0ccd): respond ONLY with JSON {"say":"","action":{"type":"cancellations","from":<index>,"to":<index>,"date":"YYYY-MM-DD"}} \u2014 from/to/date all OPTIONAL (omit for the whole corridor; date defaults to tomorrow; today is allowed).',
  'WAITLIST QUESTIONS (WL number, waiting confirm hogi kya, \u0cb5\u0cc7\u0caf\u0ccd\u0c9f\u0cbf\u0c82\u0c97\u0ccd): respond ONLY with JSON {"say":"","action":{"type":"odds","wl":<number>,"from":<index>,"to":<index>,"date":"YYYY-MM-DD","cls":"SL"}} \u2014 wl REQUIRED (their waitlist position), the rest optional.',
  'TICKET QUESTIONS (my ticket / meri booking / mera PNR / is my train ok / \u0ca8\u0ca8\u0ccd\u0ca8 \u0c9f\u0cbf\u0c95\u0cc6\u0c9f\u0ccd): respond ONLY with JSON {"say":"","action":{"type":"mybookings"}} \u2014 the system reads the traveller\u2019s real tickets and checks each for cancellation.',
  'For anything else respond ONLY with JSON: {"say":"<your answer>","action":null}.',
  'Your "say" text may be READ ALOUD: write plain flowing sentences only \u2014 never bullet lists, dashes, "=" signs, slashes, brackets, tables or markdown of any kind.',
  'ONGOING CONVERSATIONS: follow-ups inherit context from history. \u201caur parso?\u201d = same route, date today+2. \u201c3AC mein?\u201d = same route and date, cls 3A. \u201cwapas\u201d or \u201creturn\u201d = swap from and to. Resolve them and STILL return the search action \u2014 never ask for information already in the history.',
  'If a station is not on this corridor, say so and suggest the nearest corridor stations.',
].join(' ');

// ------------------------------------------------------------------ trains --
function trainCard(tr, from, to, date, cls) {
  const dep = sMin(tr, from, 'd'), arr = sMin(tr, to, 'a');
  const av = store.availability(tr.no, date, cls, from, to);
  const lv = liveOf(tr, simNow());
  return {
    no: tr.no, name: tr.name,
    dep: dep == null ? null : hhmm(dep), arr: arr == null ? null : hhmm(arr),
    depMin: dep, durMin: dep == null || arr == null ? null : ((arr - dep) + 1440) % 1440,
    platFrom: plat(tr, from), platTo: plat(tr, to),
    stops: stopIdxs(tr).length,
    counts: av.counts, price: av.price,
    cancelled: !!cancelledOn(tr.no, date),
    cancelReason: (cancelledOn(tr.no, date) || {}).reason || null,
    live: { state: lv.state, at: lv.at, atName: lv.at == null ? null : ST[lv.at].n, delay: lv.delay, prog: +(lv.prog || 0).toFixed(4) },
  };
}

function search(from, to, date, cls) {
  const list = TRAINS.filter(t => serves(t, from, to));
  return {
    from, to, date, cls,
    fromName: ST[from].n, toName: ST[to].n,
    km: journeyKm(from, to),
    trains: list.map(t => trainCard(t, from, to, date, cls))
      .sort((a, b) => (a.depMin % 1440) - (b.depMin % 1440)),
    noDirect: list.length === 0,
  };
}

// Warm the greeting voice at boot so even the first mic tap answers instantly.
if (SARVAM_KEY) ttsAudio(GREET_TEXT, 'hi-IN').catch(() => {});

// --------------------------------------------------------------------- SSE --
const sseClients = new Set();
store.subscribe(msg => {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
});
setInterval(() => {
  const line = `data: ${JSON.stringify({ type: 'tick', at: Date.now() })}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
}, 15000);

// --------------------------------------------------------------------- API --
async function api(req, res, url) {
  const q = url.searchParams;
  const p = url.pathname;

  // Render pings this to decide whether the instance is alive, and an uptime
  // pinger hits it to stop the free tier falling asleep between judges. It
  // touches no state and costs nothing, so it is safe to call every minute.
  if (p === '/api/health') {
    return send(res, 200, {
      ok: true, up: Math.round(process.uptime()),
      sarvam: !!SARVAM_KEY, openai: !!OPENAI_KEY, narrated: narrCache.size,
    });
  }

  if (p === '/api/meta') {
    return send(res, 200, {
      stations: ST.map((s, i) => ({ i, ...s })),
      classes: CLS.map(c => ({ k: c.k, label: c.label, coaches: c.coaches, per: c.per })),
      trains: TRAINS.map(t => ({
        no: t.no, name: t.name, dir: t.dir, stops: t.stops,
        src: t.src || null, dst: t.dst || null, core: !!t.core,
      })),
      today: TODAY(), holdMs: store.HOLD_MS,
      // so a QR shown on the laptop still points somewhere a phone can reach
      lanBase: lanBase(req),
    });
  }

  if (p === '/api/search') {
    const from = +q.get('from'), to = +q.get('to');
    if (!(from >= 0 && to >= 0 && from !== to)) return send(res, 400, { error: 'bad from/to' });
    return send(res, 200, search(from, to, q.get('date') || TODAY(), q.get('cls') || 'SL'));
  }

  if (p === '/api/availability') {
    const from = +q.get('from'), to = +q.get('to');
    const tr = q.get('train');
    if (!tr || !(from >= 0 && to >= 0)) return send(res, 400, { error: 'bad params' });
    return send(res, 200, store.availability(tr, q.get('date') || TODAY(), q.get('cls') || 'SL', from, to));
  }

  if (p === '/api/live') {
    const now = simNow();
    return send(res, 200, {
      now: now.getTime(),
      shiftMin: simShiftMin(), speed: simSpeed,
      clock: hhmm(now.getHours() * 60 + now.getMinutes()),
      stations: ST.map((s, i) => ({ i, c: s.c, n: s.n, km: s.km })),
      corridorKm: ST[ST.length - 1].km,
      trains: TRAINS.map(t => ({ ...t, bookable: true })).map(t => {
        const lv = liveOf(t, now);
        const idxs = stopIdxs(t);
        const origin = idxs[0], dest = idxs[idxs.length - 1];
        const depart = sMin(t, origin, 'd'), arrive = sMin(t, dest, 'a');

        // Where it physically is, in corridor kilometres.
        let km = null, nextEtaMin = null;
        if (lv.state === 'run') {
          const a = lv.at ?? origin, b = lv.next ?? dest;
          const ta = (sMin(t, a, 'a') ?? sMin(t, a, 'd')) - depart;
          const tb = (sMin(t, b, 'a') ?? sMin(t, b, 'd')) - depart;
          const f = tb > ta ? Math.max(0, Math.min(1, (lv.eff - ta) / (tb - ta))) : 0;
          km = ST[a].km + (ST[b].km - ST[a].km) * f;
          nextEtaMin = Math.max(0, Math.round(tb - lv.eff));
        }
        return {
          no: t.no, name: t.name, dir: t.dir, bookable: t.bookable, core: !!t.core,
          src: t.src || null, dst: t.dst || null,
          state: lv.state, delay: lv.delay,
          prog: +(lv.prog || 0).toFixed(4),
          km: km == null ? null : +km.toFixed(1),
          at: lv.at ?? null, atName: lv.at == null ? null : ST[lv.at].n,
          next: lv.next ?? null, nextName: lv.next == null ? null : ST[lv.next].n,
          nextEtaMin,
          origin, originName: ST[origin].n, dest, destName: ST[dest].n,
          departs: depart == null ? null : hhmm(depart),
          arrives: arrive == null ? null : hhmm(arrive),
          stops: idxs.length,
          startsInMin: lv.state === 'run' ? null
            : (lv.startsIn ?? Math.round((((depart - (now.getHours() * 60 + now.getMinutes())) % 1440) + 1440) % 1440)),
        };
      }),
    });
  }

  // Station geography for the live map: coordinates + corridor km, same order
  // as /api/meta stations, so a train's km can be interpolated onto the line.
  // Demo time machine: shift the clock and/or change its speed.
  if (p === '/api/sim') {
    if (req.method === 'POST') {
      // the clock is shared by every visitor: a signed-in person may move it,
      // an anonymous cross-site POST may not
      const who = await whoIs(req);
      if (!who) return send(res, 401, { needsAuth: true, error: 'Sign in to move the demo clock.' });
      const b = await readBody(req);
      const cur = simNow().getTime();
      if (b.shiftMin != null) {
        const m = Math.max(0, Math.min(1439, Math.floor(+b.shiftMin || 0)));
        simAtAnchor = Date.now() + m * 60000;
      } else {
        simAtAnchor = cur;                       // freeze, then re-anchor
      }
      simAnchor = Date.now();
      if (b.speed != null) simSpeed = Math.max(1, Math.min(600, Math.floor(+b.speed) || 1));
    }
    return send(res, 200, { shiftMin: simShiftMin(), speed: simSpeed, now: simNow().getTime(),
      clock: hhmm(simNow().getHours() * 60 + simNow().getMinutes()) });
  }

  if (p === '/api/geo') {
    return send(res, 200, {
      stations: ST.map((s, i) => ({
        i, c: s.c, n: s.n, km: s.km, pf: s.pf,
        lat: GEO[i].lat, lng: GEO[i].lng,
      })),
      corridorKm: ST[ST.length - 1].km,
    });
  }

  // Availability heat for the calendar: one call covers the whole window.
  if (p === '/api/calendar') {
    const from = +q.get('from'), to = +q.get('to');
    const train = q.get('train'), cls = q.get('cls') || 'SL';
    const days = Math.max(1, Math.min(62, +q.get('days') || 61));
    if (!train || !(from >= 0 && to >= 0 && from !== to)) return send(res, 400, { error: 'bad params' });
    const start = q.get('start');                       // ISO date of day 0
    const base = start ? new Date(start + 'T00:00:00') : new Date();
    const out = {};
    const classes = cls === 'all' ? CLS.map(c => c.k) : [cls];
    // train=all sums every train serving the pair, so the calendar's heat is
    // the same number the seat-check page adds up - one world, one count.
    const tservs = TRAINS.filter(t => serves(t, from, to));
    const tlist = train === 'all' ? tservs.map(t => t.no) : [train];
    // On today's date a train that has already left your station sells
    // nothing — its berths must not inflate today's number.
    const nowM = (() => { const n = simNow(); return n.getHours() * 60 + n.getMinutes(); })();
    const goneToday = new Set(tservs
      .filter(t => { const dm = sMin(t, from, 'd'); return dm != null && ((dm % 1440) + 1440) % 1440 <= nowM; })
      .map(t => t.no));
    let total = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(base.getTime() + i * 864e5);
      const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      let free = 0, part = 0;
      for (const k of classes) for (const no of tlist) {
        // a cancelled run sells nothing that day — same rule the page applies
        if (train === 'all' && cancelledOn(no, iso)) continue;
        if (train === 'all' && iso === TODAY() && goneToday.has(no)) continue;
        const c = store.countsFor(no, iso, k, from, to);
        free += c.free; part += c.part;
        if (i === 0) total += c.free + c.part + c.taken + c.locked;
      }
      out[iso] = { free, part };
    }
    return send(res, 200, { train, cls, from, to, total, days: out });
  }

  // Waitlist verdicts for a whole journey in one call: every serving train
  // banded book / hop / odds / cx, odds computed only where they mean something.
  if (p === '/api/odds2') {
    const from = +q.get('from'), to = +q.get('to');
    if (!(from >= 0 && to >= 0 && from !== to)) return send(res, 400, { error: 'bad stations' });
    const date = q.get('date') || TODAY();
    const cls = q.get('cls') || 'SL';
    const quota = q.get('quota') || 'General';
    const wl = q.get('wl') ? Math.max(1, Math.min(200, +q.get('wl') || 1)) : null;
    const BAND = { book: 0, hop: 1, odds: 2, cx: 3 };
    // Today only sells trains that have not left yet; future dates keep all.
    const nowM2 = (() => { const n = simNow(); return n.getHours() * 60 + n.getMinutes(); })();
    const rows = TRAINS.filter(t => serves(t, from, to)).filter(t => {
      if (date !== TODAY()) return true;
      const dm = sMin(t, from, 'd');
      return dm == null || ((dm % 1440) + 1440) % 1440 > nowM2;
    }).map(t => {
      const cx = cancelledOn(t.no, date);
      const av = store.availability(t.no, date, cls, from, to);
      const o = oddsOf2(t.no, date, cls, { from, to, quota, wl });
      const band = cx ? 'cx' : av.counts.free > 0 ? 'book' : av.counts.part > 0 ? 'hop' : 'odds';
      return { no: t.no, name: t.name, dep: hhmm(sMin(t, from, 'd')), depMin: sMin(t, from, 'd'),
        counts: av.counts, price: av.price, band,
        cancelReason: cx ? cx.reason : null, odds: o };
    }).sort((a, b) => (BAND[a.band] - BAND[b.band])
      || (a.band === 'book' ? b.counts.free - a.counts.free
        : a.band === 'odds' ? b.odds.pct - a.odds.pct
        : (a.depMin % 1440) - (b.depMin % 1440)));
    return send(res, 200, { from, to, date, cls, quota, wl,
      fromName: ST[from].n, toName: ST[to].n, trains: rows });
  }

  // ------------------------------------------------ Fair Tatkal, live --
  // One round at a time, driven by buttons. The simulated population is
  // seeded per round; real signed-in visitors drop real chits, and a real
  // win points at a genuinely free berth the winner then holds and pays for
  // through the ordinary pipeline.
  if (p.startsWith('/api/tatkal')) {
    const TKN = '16021', TKC = 'SL', TKF = 0, TKT = 13, TKB = 40;
    const tkIso = () => {
      const d = new Date(Date.now() + 864e5);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    };
    // One round per verified identity. Two reviewers on the page at once
    // used to share a single global round and stomp each other; a stranger
    // could open or close it with an anonymous POST. Now a round belongs to
    // the email Supabase vouched for, and only that email can drive it.
    if (!global.__tk) global.__tk = { users: new Map(), month: new Map(), pays: new Map() };
    const G = global.__tk;
    const userOf = who => { let u = G.users.get(who);
      if (!u) { u = { round: null, history: [] }; G.users.set(who, u); } return u; };
    const peekUser = who => G.users.get(who) || { round: null, history: [] };
    const fnv = s => { let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      return h; };
    const mulb = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const simOf = seed => {
      const r = mulb(seed);
      const agents = [{ id: 'A', tries: 180 + Math.floor(r() * 80) },
        { id: 'B', tries: 110 + Math.floor(r() * 70) },
        { id: 'C', tries: 60 + Math.floor(r() * 60) }];
      const humans = 120 + Math.floor(r() * 30);
      const arrivals = [];
      agents.forEach(a => {
        a.atMs = 3 + Math.floor(r() * 40);
        a.accounts = 22 + Math.floor(r() * 30);
        // a script keeps time: gaps clustered tightly around one interval
        const base = 12 + Math.floor(r() * 9);
        a.gaps = [];
        for (let g = 0; g < 6; g++) a.gaps.push(base + Math.floor(r() * 3));
        a.signals = { atMs: a.atMs, tries: a.tries, accounts: a.accounts,
          payReuse: true, actions: 0, gaps: a.gaps };
        arrivals.push({ kind: 'agent', id: a.id, tries: a.tries, atMs: a.atMs });
      });
      const hpeople = [];
      for (let h = 0; h < humans; h++) {
        const atMs = 500 + Math.floor(r() * 40000);
        // a person browses first and their taps are anything but regular
        const gaps = [900 + Math.floor(r() * 5200), 1400 + Math.floor(r() * 9000),
          700 + Math.floor(r() * 3100), 2600 + Math.floor(r() * 11000)];
        hpeople.push({ id: 'h' + h,
          signals: { atMs, tries: 1, accounts: 1, payReuse: false,
            actions: 3 + Math.floor(r() * 9), gaps } });
        arrivals.push({ kind: 'human', id: 'h' + h, atMs });
      }
      return { agents, humans, hpeople, arrivals };
    };

    if (p === '/api/tatkal/open' && req.method === 'POST') {
      const who = await whoIs(req);
      if (!who) return send(res, 401, { needsAuth: true, error: 'Sign in to open a Tatkal window.' });
      const U = userOf(who);
      const id = (U.history.length + 1);
      const seed = fnv('tk|' + who + '|' + id + '|' + tkIso());
      U.round = { id, seed, openedAt: Date.now(), state: 'open', real: [], sim: simOf(seed), result: null };
      return send(res, 200, { ok: true, id });
    }
    if (p === '/api/tatkal/paysession' && req.method === 'POST') {
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
      const signedIn = await whoIs(req);
      if (!signedIn) return send(res, 401, { needsAuth: true,
        error: 'Sign in to enter the Tatkal window — entries are capped per person.' });
      const R = userOf(signedIn).round;
      if (!R || R.state !== 'open') return send(res, 409, { error: 'window is not open' });
      const who = signedIn;
      if (R.real.some(e => e.who === who)) return send(res, 409, { error: 'one entry per person per round' });
      if ((G.month.get(who) || 0) >= 4) return send(res, 409, { error: 'four Tatkal entries per month \u2014 all used' });
      if (!G.pays) G.pays = new Map();
      let sid = '';
      for (let i = 0; i < 18; i++) sid += '0123456789abcdef'[Math.floor(Math.random() * 16)];
      // the same six signals the farms are judged on, measured on a real
      // person: when they arrived, how much they did first, how regular their
      // taps were. Nothing here is asked for; it is all already happening.
      if (!R.hits) R.hits = new Map();
      R.hits.set(who, (R.hits.get(who) || 0) + 1);
      const cs = (b && typeof b.sig === 'object' && b.sig) || {};
      const sig = {
        atMs: Math.max(0, Date.now() - R.openedAt),
        tries: R.hits.get(who),
        accounts: 1,
        payReuse: false,
        actions: Math.max(0, Math.min(99, +cs.actions || 0)),
        gaps: Array.isArray(cs.gaps) ? cs.gaps.slice(0, 12).map(Number).filter(g => g > 0) : [],
      };
      G.pays.set(sid, { id: sid, who, name: String(b.name || 'Traveller').slice(0, 60),
        round: R.id, amount: 175, expiresAt: Date.now() + 300000, status: 'pending', sig });
      return send(res, 200, { ok: true, payId: sid, amount: 175, msLeft: 300000 });
    }

    if (p === '/api/tatkal/draw' && req.method === 'POST') {
      const who = await whoIs(req);
      if (!who) return send(res, 401, { needsAuth: true, error: 'Sign in to run the allotment.' });
      const U = userOf(who);
      const R = U.round;
      if (!R || R.state !== 'open') return send(res, 409, { error: 'no open window' });
      R.state = 'done'; R.closedAt = Date.now();
      // Sentinel runs on EVERY entrant, farms and people alike. A scorer that
      // only ever sees the entries you already suspect is a label, not a model.
      const scored = sentinel.scoreRound([
        ...R.sim.agents.map(a => ({ id: a.id, kind: 'bot', signals: a.signals })),
        ...(R.sim.hpeople || []).map(h => ({ id: h.id, kind: 'human', signals: h.signals })),
        ...R.real.map(e => ({ id: e.who, kind: 'real', name: e.name, signals: e.signals || {} })),
      ]);
      const byId = new Map(scored.map(x => [x.id, x]));
      R.scored = scored;

      // The identity check and the monthly cap already stand. Sentinel can only
      // take chits AWAY from an entry that behaves like a farm; it can never
      // hand one more, and it can never take a real person below one. Worst
      // case for a human who trips every signal is being counted as one person
      // entering once, which is what they are.
      const chitsFor = id => {
        const sc = byId.get(id);
        return Math.max(1, Math.min(4, sc ? sc.chits : 4));
      };
      const bowl = [];
      R.sim.agents.forEach(a => { const n = chitsFor(a.id);
        for (let c = 0; c < n; c++) bowl.push({ kind: 'bot', id: a.id }); });
      for (let h = 0; h < R.sim.humans; h++) bowl.push({ kind: 'human', id: 'h' + h });
      R.real.forEach((e, i) => bowl.push({ kind: 'real', id: e.who, name: e.name, ix: i }));
      const r = mulb(R.seed ^ 0x9e3779b9);
      for (let i = bowl.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));
        const t = bowl[i]; bowl[i] = bowl[j]; bowl[j] = t; }
      const winners = bowl.slice(0, Math.min(TKB, bowl.length));
      const realWinners = winners.filter(w => w.kind === 'real');
      const av = store.availability(TKN, tkIso(), TKC, TKF, TKT);
      // full-way berths first; on a sold-out day the winner gets the best
      // partly-free berth instead, priced for the stretch that is theirs
      const freeIdx = av.berths.filter(x => x.k === 'free').map(x => x.idx)
        .concat(av.berths.filter(x => x.k === 'part' && x.price != null)
          .sort((a2, b2) => b2.price - a2.price).map(x => x.idx));
      realWinners.forEach((w, i) => { w.berthIdx = freeIdx[i] != null ? freeIdx[i] : null; });
      // only a WIN consumes a monthly chit - losing must cost a human
      // nothing, while the per-round identity limit still starves bot farms
      realWinners.forEach(w => G.month.set(w.id, (G.month.get(w.id) || 0) + 1));
      const botChits = R.sim.agents.reduce((a2, a) => a2 + chitsFor(a.id), 0);
      R.result = {
        chits: bowl.length,
        sentinel: {
          model: sentinel.MODEL.version,
          capChits: R.sim.agents.length * 4,
          botChits,
          stripped: R.sim.agents.length * 4 - botChits,
          flagged: scored.filter(x => x.band !== 'clear').length,
          cleared: scored.filter(x => x.band === 'clear').length,
        },
        counts: { free: av.counts.free, part: av.counts.part },
        winners: { bots: winners.filter(w => w.kind === 'bot').length,
          humans: winners.filter(w => w.kind === 'human').length,
          real: realWinners.map(w => ({ who: w.id, name: w.name, berthIdx: w.berthIdx })) },
      };
      U.history.push({ id: R.id, chits: bowl.length, bots: R.result.winners.bots,
        humans: R.result.winners.humans + realWinners.length });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/tatkal/reset' && req.method === 'POST') {
      const who = await whoIs(req);
      if (!who) return send(res, 401, { needsAuth: true, error: 'Sign in to reset your window.' });
      userOf(who).round = null;
      return send(res, 200, { ok: true });
    }
    if (p === '/api/tatkal/explain') {
      const R = peekUser(q.get('who') || 'guest').round;
      if (!R || !R.result) return send(res, 200, { text: '' });
      const tries = R.sim.agents.reduce((a, x) => a + x.tries, 0);
      const bots = R.result.winners.bots;
      const people = 40 - bots;
      const text = await narrate('tk|' + R.id + '|' + R.seed,
        NARR_RULES + ' You are explaining the morning\u2019s Tatkal allotment to the traveller who just watched it run.',
        'Facts: ' + tries + ' automated booking attempts came from just 3 agent operations; the identity check and a '
        + 'limit of 4 paid entries per person per month reduced them to '
        + (R.result.sentinel ? R.result.sentinel.capChits : 12) + ' standing entries. '
        + (R.result.sentinel ? ('A behavioural scorer called Sentinel then read six published signals on every entrant '
          + '(arrival time, request volume, accounts per origin, payment reuse, how much they did in the app, and timing regularity) '
          + 'and weighted the farm entries down from ' + R.result.sentinel.capChits + ' to ' + R.result.sentinel.botChits
          + ', stripping ' + R.result.sentinel.stripped + '. No entrant was reduced below one entry. ') : '')
        + R.sim.humans + ' ordinary travellers entered. ' + R.result.chits + ' equal entries competed for 40 berths. '
        + 'Result: ' + people + ' berths went to real travellers and ' + bots + ' to bot entries. '
        + 'Entries that were not allotted were refunded instantly and in full. '
        + 'Explain what this shows about removing the 10am race. Do not use the words lottery, luck or draw.');
      return send(res, 200, { text, id: R.id });
    }

    if (p === '/api/tatkal/state') {
      const who = q.get('who') || 'guest';
      const U = peekUser(who);
      const R = U.round;
      if (!R) return send(res, 200, { phase: 'idle', history: U.history.slice(-5),
        monthUsed: G.month.get(who) || 0, train: TKN, date: tkIso(), berths: TKB });
      const el = Date.now() - R.openedAt;
      const arrived = R.sim.arrivals.filter(a => a.atMs <= el);
      const agentsIn = arrived.filter(a => a.kind === 'agent');
      const humansIn = arrived.filter(a => a.kind === 'human').length;
      const feed = [];
      agentsIn.forEach(a => feed.push('10:00:00.0' + a.atMs + '  tout bot-farm ' + a.id + ' (simulated) fired ' + a.tries + ' requests'));
      feed.push(humansIn + ' simulated ordinary travellers have booked so far');
      R.real.forEach(e => feed.push('chit from ' + e.name + ' (verified \u00b7 \u20b9175 locked \u00b7 ' + ((G.month.get(e.who) || 0)) + '/4 used this month)'));
      const totalTries = R.sim.agents.reduce((s2, a) => s2 + a.tries, 0);
      const me = R.real.find(e => e.who === who) || null;
      const myWin = R.result ? (R.result.winners.real.find(w => w.who === who) || null) : null;
      return send(res, 200, {
        phase: R.state, id: R.id, elapsedMs: el, train: TKN, cls: TKC, date: tkIso(), berths: TKB,
        monthUsed: G.month.get(who) || 0,
        customer: {
          entered: !!me, chitNo: me ? R.sim.humans + R.real.indexOf(me) + 1 : null,
          chitsInBowl: humansIn + agentsIn.length + R.real.length,
          won: !!myWin, berthIdx: myWin ? myWin.berthIdx : null,
          result: R.result ? { taken: TKB, toPeople: TKB - R.result.winners.bots,
            free: R.result.counts.free, part: R.result.counts.part } : null,
        },
        backend: {
          feed: feed.slice(-14),
          agents: R.sim.agents.map(a => ({ id: a.id, tries: a.tries, chits: 4 })),
          totalTries, humans: R.sim.humans, realChits: R.real.length,
          sentinel: (() => {
            const rows = R.scored || [];
            const find = id => rows.find(x => x.id === id) || null;
            const mine = find(who);
            return {
              model: sentinel.MODEL.version,
              ran: rows.length > 0,
              bands: sentinel.MODEL.bands,
              weights: sentinel.MODEL.weights,
              bias: sentinel.MODEL.bias,
              // one row per farm, with the arithmetic that produced the verdict
              farms: R.sim.agents.map(a => {
                const sc = find(a.id);
                return { id: a.id, tries: a.tries, accounts: a.accounts,
                  p: sc ? sc.p : null, band: sc ? sc.band : null,
                  chits: sc ? Math.max(1, Math.min(4, sc.chits)) : 4,
                  parts: sc ? sc.parts : [], why: sc ? sc.why : [] };
              }),
              // and the traveller's own, because a scorer you cannot see
              // pointed at yourself is not transparency
              me: mine ? { p: mine.p, band: mine.band, why: mine.why, parts: mine.parts } : null,
              summary: R.result ? R.result.sentinel : null,
            };
          })(),
          bowl: R.result ? R.result.chits : (R.sim.humans + 12 + R.real.length),
          seed: R.seed,
          result: R.result ? { bots: R.result.winners.bots,
            humans: R.result.winners.humans,
            real: R.result.winners.real.length } : null,
          audit: R.result ? [
            'window open ' + Math.round((R.closedAt - R.openedAt) / 1000) + 's \u00b7 ' + totalTries + ' bot requests + ' + R.sim.humans + ' simulated travellers + ' + R.real.length + ' real ' + (R.real.length === 1 ? 'person' : 'people') + ' on this site',
            'identity filter: ' + totalTries + ' bot requests trace back to just 3 verified persons',
            'monthly cap: 3 agents \u00d7 4 chits = 12 chits stand',
            'sentinel ' + R.result.sentinel.model + ': scored all ' + R.scored.length
              + ' entrants on 6 published signals · ' + R.result.sentinel.flagged
              + ' flagged, ' + R.result.sentinel.cleared + ' cleared',
            'behavioural weighting: ' + R.result.sentinel.capChits + ' farm chits → '
              + R.result.sentinel.botChits + ' · ' + R.result.sentinel.stripped
              + ' stripped · no entrant reduced below one',
            'entry rule: fare locked to enter \u00b7 the farms floated \u20b9' + (12 * 175) + ' across their 12 entries \u00b7 not allotted = refunded instantly',
            'allotment: seed ' + R.seed + ' \u00b7 ' + TKB + ' berths among ' + R.result.chits + ' equal entries \u00b7 replayable by anyone',
            'result: ' + R.result.winners.bots + ' bot berth' + (R.result.winners.bots === 1 ? '' : 's') + ' \u00b7 ' + (TKB - R.result.winners.bots) + ' traveller berths',
          ] : ['window is open \u2014 bookings are collecting', 'nothing is decided until allotment runs'],
        },
      });
    }
    return send(res, 404, { error: 'no such tatkal endpoint' });
  }

  // A sentence about a probability the maths already fixed. Only ever asked
  // for genuinely full trains, so the spend stays in fractions of a rupee.
  if (p === '/api/odds/explain') {
    const no = q.get('train'), date = q.get('date') || TODAY(), cls = q.get('cls') || 'SL';
    const from = +q.get('from'), to = +q.get('to');
    if (!no || !(from >= 0 && to >= 0 && from !== to)) return send(res, 400, { error: 'bad params' });
    const o = oddsOf2(no, date, cls, { from, to, quota: q.get('quota') || 'General' });
    const tr = trainByNo(no);
    const av = store.availability(no, date, cls, from, to);
    const text = await narrate('odds|' + no + '|' + date + '|' + cls + '|' + from + '|' + to,
      NARR_RULES + ' You are telling a traveller whether to wait on this waitlist or take a certain seat instead.',
      'Train ' + no + ' ' + ((tr && tr.name) || '') + ' from ' + ST[from].n + ' to ' + ST[to].n + ' on ' + date + '. '
      + 'Chance of a confirmed berth: ' + o.pct + ' percent. Chance of at least RAC, meaning they board: ' + o.pctRAC + ' percent. '
      + 'Waitlist type ' + o.type + '. About ' + o.clears + ' of the queue clears before charting. '
      + 'Reasons the demand is what it is: ' + (o.why.join('; ') || 'ordinary weekday demand') + '. '
      + 'On this same train ' + av.counts.free + ' berths are free the whole way right now and '
      + av.counts.part + ' more free up part of the way. '
      + 'Give the honest verdict, and if a certain seat exists say plainly that waiting is unnecessary.');
    return send(res, 200, { text, pct: o.pct, pctRAC: o.pctRAC });
  }

  if (p === '/api/counts') {
    const from = +q.get('from'), to = +q.get('to');
    if (!(from >= 0 && to >= 0 && from !== to)) return send(res, 400, { error: 'bad from/to' });
    const date = q.get('date') || TODAY();
    const counts = {};
    for (const t of TRAINS) {
      if (!serves(t, from, to)) continue;
      for (const c of CLS)
        counts[t.no + '|' + c.k] = store.availability(t.no, date, c.k, from, to).counts;
    }
    return send(res, 200, { counts });
  }

  if (p === '/api/hold' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad json' }); }
    // holding a berth takes it away from everyone else, so it needs a name
    // the server has checked - not one the request simply asserts
    const signedIn = await whoIs(req);
    if (!signedIn) return send(res, 401, { ok: false, needsAuth: true,
      error: 'Sign in to hold a berth \u2014 a hold takes it off the board for everyone else.' });

    // Everything below is the request being disbelieved. The client used to
    // be trusted on all of it, which is how a hold for 2019, a hold on
    // stations the train skips, and a hold with fees of zero all got through.
    const from = Number(b.from), to = Number(b.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
        || from >= ST.length || to >= ST.length || from === to)
      return send(res, 400, { ok: false, error: 'bad stations' });
    const tr = trainByNo(String(b.train || ''));
    if (!tr) return send(res, 404, { ok: false, error: 'unknown train' });
    if (!serves(tr, from, to))
      return send(res, 409, { ok: false, reason: 'not-served',
        error: 'This train does not stop at both of those stations.' });
    const date = String(b.date || TODAY());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { ok: false, error: 'bad date' });
    const dayMs = new Date(date + 'T00:00:00Z').getTime();
    const t0 = new Date(TODAY() + 'T00:00:00Z').getTime();
    // a day of grace either side covers timezone skew between phone and server
    if (!(dayMs >= t0 - 864e5 && dayMs <= t0 + 61 * 864e5))
      return send(res, 409, { ok: false, reason: 'bad-date',
        error: 'Bookings run from today to sixty days ahead.' });
    const cls = ['SL', '3A', '2A'].includes(b.cls) ? b.cls : 'SL';
    const cxh = cancelledOn(tr.no, date);
    if (cxh) return send(res, 409, { ok: false, error: 'This train is cancelled on that date \u2014 ' + cxh.reason + '.' });
    const berthIdxs = (Array.isArray(b.berthIdxs) ? b.berthIdxs : []).map(Number);
    if (!berthIdxs.length || berthIdxs.some(i => !Number.isInteger(i) || i < 0))
      return send(res, 400, { ok: false, error: 'bad berths' });
    const segsIn = Array.isArray(b.segs)
      ? b.segs.map(g => (g && g.to > g.from && g.from >= 0 && g.to <= 13) ? { from: +g.from, to: +g.to } : null)
      : undefined;
    const r = store.hold({
      train: tr.no, date, cls, from, to, berthIdxs,
      pax: Number.isInteger(+b.pax) ? +b.pax : berthIdxs.length,
      who: signedIn, segs: segsIn, hop: !!b.hop,
    });
    const code = r.ok ? 200 : (r.reason === 'too-many-open-holds' ? 429 : 409);
    return send(res, code, r);
  }

  const mHold = p.match(/^\/api\/hold\/([a-f0-9]+)$/);
  if (mHold) {
    // a Tatkal payment session answers the same protocol pay.html speaks,
    // minus the berths - the seat does not exist until allotment
    const tq = global.__tk && global.__tk.pays && global.__tk.pays.get(mHold[1]);
    if (tq) {
      if (req.method === 'DELETE') { tq.status = 'cancelled'; return send(res, 200, { ok: true }); }
      const msLeft = Math.max(0, tq.expiresAt - Date.now());
      return send(res, 200, {
        id: tq.id, status: tq.status === 'pending' && msLeft <= 0 ? 'expired' : tq.status,
        msLeft, amount: tq.amount, fees: 0, fullPrice: tq.amount,
        train: '16021 \u00b7 Tatkal entry', from: 0, to: 13, pax: 1,
        journeyKm: journeyKm(0, 13), berths: [], tatkal: true,
        pnr: tq.status === 'paid' ? 'TQ-ENTRY' : undefined,
      });
    }
    if (req.method === 'DELETE') return send(res, 200, store.release(mHold[1]));
    const h = store.getHold(mHold[1]);
    return h ? send(res, 200, h) : send(res, 404, { error: 'unknown hold' });
  }

  const mPay = p.match(/^\/api\/pay\/([a-f0-9]+)$/);
  if (mPay && req.method === 'POST') {
    const tq = global.__tk && global.__tk.pays && global.__tk.pays.get(mPay[1]);
    if (tq) {
      if (tq.status === 'paid') return send(res, 200, { ok: true, booking: { pnr: 'TQ-ENTRY', amount: tq.amount } });
      if (tq.status !== 'pending' || Date.now() > tq.expiresAt)
        return send(res, 410, { error: 'payment session expired \u2014 nothing was charged' });
      const G2 = global.__tk;
      const U2 = G2 && G2.users && G2.users.get(tq.who);
      const R = U2 && U2.round;
      if (!R || R.state !== 'open' || R.id !== tq.round)
        return send(res, 409, { error: 'the window closed before payment \u2014 nothing was charged' });
      tq.status = 'paid';
      if (!R.real.some(e => e.who === tq.who)) R.real.push({ who: tq.who, name: tq.name, at: Date.now(), signals: tq.sig || {} });
      return send(res, 200, { ok: true, booking: { pnr: 'TQ-ENTRY', amount: tq.amount } });
    }
    const h = store.getHold(mPay[1]);
    if (!h) return send(res, 404, { error: 'unknown hold' });
    if (h.msLeft <= 0) return send(res, 410, { error: 'expired' });
    const r = store.confirm(mPay[1]);
    return send(res, r.ok ? 200 : 409, r);
  }

  // QR is rendered server-side so the phone needs no library and no internet.
  if (p === '/api/qr') {
    const d = q.get('d') || '';
    if (!d || d.length > 512) return send(res, 400, { error: 'bad payload' });
    const svg = await QRCode.toString(d, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1,
      color: { dark: q.get('dark') || '#14161a', light: q.get('light') || '#ffffff' },
    });
    return send(res, 200, svg, 'image/svg+xml');
  }

  if (p === '/api/odds') {
    const no = q.get('train'), date = q.get('date') || TODAY(), cls = q.get('cls') || 'SL';
    const wl = Math.max(1, Math.min(200, +q.get('wl') || 10));
    if (!no) return send(res, 400, { error: 'train required' });
    return send(res, 200, { train: no, date, cls, wl, ...oddsOf(no, date, cls, wl) });
  }

  if (p === '/api/bookings') return send(res, 200, { bookings: store.allBookings() });

  const mPnr = p.match(/^\/api\/booking\/(\d+)$/);
  if (mPnr) {
    const bk = store.getBooking(mPnr[1]);
    return bk ? send(res, 200, bk) : send(res, 404, { error: 'unknown pnr' });
  }

  // Voice in: browser audio -> Saaras v3 transcript, language auto-detected.
  if (p === '/api/stt' && req.method === 'POST') {
    if (!SARVAM_KEY) return send(res, 200, { text: '', offline: true });
    let b;
    try { b = await readBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    if (!b.audio || typeof b.audio !== 'string' || b.audio.length > 900000) {
      return send(res, 400, { error: 'bad audio' });
    }
    try {
      const buf = Buffer.from(b.audio, 'base64');
      const fd = new FormData();
      // Chrome records 'audio/webm;codecs=opus' — Sarvam rejects parameterized
      // content types, so forward only the bare container type.
      fd.append('file', new Blob([buf], { type: String(b.mime || 'audio/webm').split(';')[0] }), 'voice.webm');
      fd.append('model', 'saaras:v3');
      fd.append('language_code', 'unknown');
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 25000);
      const r = await fetch('https://api.sarvam.ai/speech-to-text', {
        method: 'POST', signal: ac.signal,
        headers: { 'api-subscription-key': SARVAM_KEY }, body: fd,
      }).finally(() => clearTimeout(t));
      if (!r.ok) throw new Error('stt http ' + r.status);
      const j = await r.json();
      return send(res, 200, { text: (j.transcript || '').trim(), lang: j.language_code || null });
    } catch (e) {
      return send(res, 502, { text: '', error: 'stt failed' });
    }
  }

  // Spoken greeting for the mic button — generated once, then served instantly.
  if (p === '/api/greet') {
    if (!SARVAM_KEY) return send(res, 200, { text: GREET_TEXT, audio: '' });
    try {
      const audio = await ttsAudio(GREET_TEXT, 'hi-IN');
      return send(res, 200, { text: GREET_TEXT, audio, mime: 'audio/mpeg' });
    } catch (e) { return send(res, 200, { text: GREET_TEXT, audio: '' }); }
  }

  // Voice out: Bulbul v3 reads the answer back in the traveller's language.
  const TTS_LANGS = ['bn-IN','en-IN','gu-IN','hi-IN','kn-IN','ml-IN','mr-IN','od-IN','pa-IN','ta-IN','te-IN'];
  if (p === '/api/tts' && req.method === 'POST') {
    if (!SARVAM_KEY) return send(res, 200, { audio: '', offline: true });
    let b;
    try { b = await readBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const text = String(b.text || '').slice(0, 490);
    if (!text) return send(res, 400, { error: 'no text' });
    const lang = TTS_LANGS.includes(b.lang) ? b.lang : 'hi-IN';
    try {
      return send(res, 200, { audio: await ttsAudio(text, lang), mime: 'audio/mpeg' });
    } catch (e) {
      return send(res, 502, { audio: '', error: 'tts failed' });
    }
  }

  if (p === '/api/chat' && req.method === 'POST') {
    if (!SARVAM_KEY) {
      return send(res, 200, { offline: true,
        say: 'Saarthi is asleep \u2014 the server has no SARVAM_KEY yet. Add the key and restart, then I can chat in 22 Indian languages.' });
    }
    let b;
    try { b = await readBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const hist = (Array.isArray(b.messages) ? b.messages : []).slice(-10)
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 1200) }));
    if (!hist.length) return send(res, 400, { error: 'no messages' });
    try {
      // Few-shot pairs teach intent extraction far better than instructions,
      // especially for inflected Indian-language station names.
      const SHOTS = [
        { role: 'user', content: 'ನಾಳೆ ಮೈಸೂರಿನಿಂದ ಬೆಂಗಳೂರಿಗೆ ಸ್ಲೀಪರ್ ಇದೆಯಾ?' },
        { role: 'assistant', content: '{"say":"","action":{"type":"search","from":13,"to":5,"cls":"SL"}}' },
        { role: 'user', content: 'parso Bangalore se Mysore jana hai' },
        { role: 'assistant', content: JSON.stringify({ say: '', action: { type: 'search', from: 5, to: 13, cls: 'SL',
          date: (() => { const d = new Date(Date.now() + 2 * 864e5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })() } }) },
        { role: 'user', content: 'banglore se mandya jana hai aug 31 ko, kaunse trains hai?' },
        { role: 'assistant', content: '{"say":"","action":{"type":"search","from":5,"to":11,"cls":"SL","date":"2026-08-31"}}' },
        { role: 'user', content: 'kal Whitefield se Mandya 3AC me kitna hoga?' },
        { role: 'assistant', content: '{"say":"","action":{"type":"search","from":1,"to":11,"cls":"3A"}}' },
        { role: 'user', content: '\u0c87\u0cb5\u0ca4\u0ccd\u0ca4\u0cc1 \u0cac\u0c82\u0c97\u0cbe\u0cb0\u0caa\u0cc7\u0c9f\u0cc6\u0caf\u0cbf\u0c82\u0ca6 \u0cac\u0cc6\u0c82\u0c97\u0cb3\u0cc2\u0cb0\u0cbf\u0c97\u0cc6 \u0caf\u0cbe\u0cb5 \u0c9f\u0ccd\u0cb0\u0cc6\u0cd6\u0ca8\u0ccd \u0c87\u0ca6\u0cc6?' },
        { role: 'assistant', content: JSON.stringify({ say: '', action: { type: 'search', from: 0, to: 5, cls: 'SL',
          date: (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })() } }) },
        { role: 'user', content: 'kal Bangalore se Mysore jana hai' },
        { role: 'assistant', content: JSON.stringify({ say: '', action: { type: 'search', from: 5, to: 13, cls: 'SL',
          date: (() => { const d = new Date(Date.now() + 864e5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })() } }) },
        { role: 'user', content: 'aur 3AC mein kitna hai?' },
        { role: 'assistant', content: JSON.stringify({ say: '', action: { type: 'search', from: 5, to: 13, cls: '3A',
          date: (() => { const d = new Date(Date.now() + 864e5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })() } }) },
        { role: 'user', content: '\u0caf\u0cbe\u0cb5 \u0cb0\u0cc8\u0cb2\u0cc1\u0c97\u0cb3\u0cc1 \u0c95\u0ccd\u0caf\u0cbe\u0ca8\u0ccd\u0cb8\u0cb2\u0ccd \u0c86\u0c97\u0cbf\u0cb5\u0cc6 \u0ca8\u0ccb\u0ca1\u0cbf \u0cb9\u0cc7\u0cb3\u0cbf' },
        { role: 'assistant', content: '{"say":"","action":{"type":"cancellations"}}' },
        { role: 'user', content: 'mera ticket check karo, meri train theek hai na?' },
        { role: 'assistant', content: '{"say":"","action":{"type":"mybookings"}}' },
        { role: 'user', content: 'meri waiting WL 14 hai Bangalore se Mysore, confirm hogi kya?' },
        { role: 'assistant', content: '{"say":"","action":{"type":"odds","wl":14,"from":5,"to":13,"cls":"SL"}}' },
        { role: 'user', content: 'yeh amber wali seat sasti kyun hai?' },
        { role: 'assistant', content: '{"say":"Kyunki woh berth aapke route ke sirf ek hisse mein khaali hai — aap sirf us khaali stretch ka daam dete ho, poore safar ka nahi. Isliye woh green (poora raasta khaali) berth se sasti hai.","action":null}' },
      ];
      const users = hist.filter(m => m.role === 'user');
      const lastUser = users[users.length - 1];
      const asked = lastUser ? requestedLangOf(lastUser.content) : null;
      let sl = asked || (lastUser ? scriptLangOf(lastUser.content) : null);
      // A conversation keeps its language. 'Date 25th of August' typed in
      // Latin must not undo the Marathi they asked for two turns ago.
      if (!sl) {
        for (let i = users.length - 2; i >= 0; i--) {
          const prev = requestedLangOf(users[i].content) || scriptLangOf(users[i].content);
          if (prev) { sl = prev; break; }
        }
      }
      const langNote = sl
        ? ' NON-NEGOTIABLE: ' + (asked ? 'the traveller has ASKED for ' + sl[0] + ' \u2014 honour it. '
            : 'this conversation is being held in ' + sl[0] + '. ')
          + 'Every word of your "say" text MUST be in ' + sl[0] + ' (' + sl[1] + '), in its own script, for THIS and every later reply until they switch. Do not use any other language.'
        : '';
      const msgs1 = [{ role: 'system', content: SAARTHI_SYS() + langNote }, ...SHOTS, ...hist];
      let first;
      try { first = await sarvam(msgs1); }
      catch (e1) { first = await sarvam(msgs1); }   // Sarvam load spike: one retry
      // Long multi-turn prompts occasionally come back EMPTY. Retry once
      // without the few-shots (shorter prompt, same history) before giving up.
      if (!String(first || '').trim()) {
        try { first = await sarvam([{ role: 'system', content: SAARTHI_SYS() + langNote }, ...hist]); } catch (e2) {}
      }
      let plan = null;
      try { plan = JSON.parse((first.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { plan = null; }
      const act = plan && plan.action;
      if (act && act.type === 'cancellations') {
        const t0c = new Date(); t0c.setHours(0, 0, 0, 0);
        let dmsC = t0c.getTime() + 864e5;
        if (act.date && /^\d{4}-\d{2}-\d{2}$/.test(act.date)) {
          const p = new Date(act.date + 'T00:00:00').getTime();
          if (p >= t0c.getTime() && p <= t0c.getTime() + 60 * 864e5) dmsC = p;
        }
        const dC = new Date(dmsC);
        const isoC = dC.getFullYear() + '-' + String(dC.getMonth() + 1).padStart(2, '0') + '-' + String(dC.getDate()).padStart(2, '0');
        const humanC = dC.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        const f = (act.from >= 0 && act.from < ST.length) ? +act.from : null;
        const t2 = (act.to >= 0 && act.to < ST.length) ? +act.to : null;
        const scoped = f != null && t2 != null && f !== t2;
        const pool = scoped ? TRAINS.filter(x => serves(x, f, t2)) : TRAINS;
        const cx = pool.map(x => ({ x, c: cancelledOn(x.no, isoC) })).filter(o => o.c);
        const scopeTxt = scoped ? ' between ' + ST[f].n + ' and ' + ST[t2].n : ' on this corridor';
        let en;
        if (!cx.length) {
          en = 'Good news: no trains' + scopeTxt + ' are cancelled on ' + humanC + '. Everything runs.';
        } else {
          en = 'On ' + humanC + ', ' + cx.length + ' train' + (cx.length > 1 ? 's' : '') + scopeTxt + ' '
            + (cx.length > 1 ? 'are' : 'is') + ' cancelled: '
            + cx.slice(0, 6).map(o => o.x.name + ' (' + o.x.no + '), reason: ' + o.c.reason).join('; ')
            + (cx.length > 6 ? '; and ' + (cx.length - 6) + ' more.' : '.')
            + ' Star a train in the app and the bell warns you days before travel.';
        }
        let sayC = en;
        if (sl) { try { sayC = (await translateTo(en, sl[1])) || en; } catch (e) {} }
        return send(res, 200, { say: sayC, lang: sl ? sl[1] : null,
          link: scoped ? '/trains?from=' + f + '&to=' + t2 + '&cls=SL' : null });
      }

      if (act && act.type === 'odds' && +act.wl > 0) {
        const wl = Math.max(1, Math.min(200, Math.round(+act.wl)));
        const clsO = ['SL', '3A', '2A'].includes(act.cls) ? act.cls : 'SL';
        const t0o = new Date(); t0o.setHours(0, 0, 0, 0);
        let dmsO = t0o.getTime() + 864e5;
        if (act.date && /^\d{4}-\d{2}-\d{2}$/.test(act.date)) {
          const p2 = new Date(act.date + 'T00:00:00').getTime();
          if (p2 >= t0o.getTime() && p2 <= t0o.getTime() + 60 * 864e5) dmsO = p2;
        }
        const dO2 = new Date(dmsO);
        const isoO = dO2.getFullYear() + '-' + String(dO2.getMonth() + 1).padStart(2, '0') + '-' + String(dO2.getDate()).padStart(2, '0');
        const humanO = dO2.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        const f = (act.from >= 0 && act.from < ST.length) ? +act.from : null;
        const t3 = (act.to >= 0 && act.to < ST.length) ? +act.to : null;
        let en;
        let linkO = '/waitlist-odds';
        if (f != null && t3 != null && f !== t3) {
          const pool = TRAINS.filter(x => serves(x, f, t3) && !cancelledOn(x.no, isoO));
          const rows = pool.map(x => ({ x, o: oddsOf(x.no, isoO, clsO, wl),
            av: store.availability(x.no, isoO, clsO, f, t3).counts }))
            .sort((a, b) => b.o.pct - a.o.pct).slice(0, 2);
          if (!rows.length) en = 'No trains serve that pair on ' + humanO + '.';
          else en = 'For WL ' + wl + ' on ' + humanO + ' from ' + ST[f].n + ' to ' + ST[t3].n + ': '
            + rows.map(r => r.x.name + ' (' + r.x.no + ') confirms about ' + r.o.pct + '% of days, because around '
              + r.o.expCancel + ' berths free up before the chart').join('; ') + '. '
            + (rows[0].av.free > 0 ? 'Better: skip the waitlist \u2014 ' + rows[0].x.name + ' has ' + rows[0].av.free
              + ' berths free your whole way right now' + (rows[0].av.part ? ', and ' + rows[0].av.part + ' cheaper ones open en route' : '') + '.' : '');
          linkO = '/waitlist-odds?from=' + f + '&to=' + t3 + '&cls=' + clsO + '&wl=' + wl;
        } else {
          const o = oddsOf('16021', isoO, clsO, wl);
          en = 'WL ' + wl + ' in ' + clsO + ' confirms about ' + o.pct + '% of days (around ' + o.expCancel
            + ' berths usually free up before the chart). Tell me your two stations and I will check exact trains \u2014 and the berths that skip the waitlist entirely.';
        }
        let sayO = en;
        if (sl) { try { sayO = (await translateTo(en, sl[1])) || en; } catch (e) {} }
        return send(res, 200, { say: sayO, lang: sl ? sl[1] : null, link: linkO });
      }

      if (act && act.type === 'mybookings') {
        const bks = store.allBookings().slice(0, 5);
        let en;
        if (!bks.length) {
          en = 'You have no tickets on this device yet. Book one and I will keep an eye on it for cancellations.';
        } else {
          en = 'You have ' + bks.length + ' ticket' + (bks.length > 1 ? 's' : '') + '. '
            + bks.map(b => {
                const trB = TRAINS.find(x => x.no === b.train);
                const cxb = cancelledOn(b.train, b.date);
                const depB = trB ? hhmm(sMin(trB, b.from, 'd')) : '';
                return 'PNR ' + b.pnr + ': ' + (trB ? trB.name : 'train ' + b.train) + ' (' + b.train + ') on ' + b.date
                  + ', ' + ST[b.from].n + ' to ' + ST[b.to].n
                  + (depB ? ', departs ' + depB : '')
                  + ', berth ' + b.berths.join(' and ')
                  + (cxb ? '. WARNING: this train is CANCELLED that day, reason: ' + cxb.reason + '. Please pick another train'
                         : '. This train runs normally');
              }).join('. ') + '.';
        }
        let sayB = en;
        if (sl) { try { sayB = (await translateTo(en, sl[1])) || en; } catch (e) {} }
        return send(res, 200, { say: sayB, lang: sl ? sl[1] : null, link: '/my-bookings' });
      }

      if (act && act.type === 'search'
          && act.from >= 0 && act.from < ST.length
          && act.to >= 0 && act.to < ST.length && +act.from !== +act.to) {
        const cls = ['SL', '3A', '2A'].includes(act.cls) ? act.cls : 'SL';
        // 'Today' gets a live answer: remaining departures + the chart truth.
        const t0loc = new Date();
        const todayIso = t0loc.getFullYear() + '-' + String(t0loc.getMonth() + 1).padStart(2, '0') + '-' + String(t0loc.getDate()).padStart(2, '0');
        if (act.date === todayIso) {
          const now = simNow();
          const nowMin = now.getHours() * 60 + now.getMinutes();
          const items = TRAINS.filter(t => serves(t, +act.from, +act.to))
            .map(t => ({ t, depDay: (sMin(t, +act.from, 'd') ?? 0) % 1440 }))
            .sort((a, b) => a.depDay - b.depDay);
          const ahead = items.filter(x => x.depDay > nowMin).slice(0, 3);
          const gone = items.length - items.filter(x => x.depDay > nowMin).length;
          let en;
          if (!ahead.length) {
            en = 'All of today\u2019s trains from ' + ST[+act.from].n + ' to ' + ST[+act.to].n
              + ' have already left. Bookings are open for tomorrow \u2014 want me to look?';
          } else {
            en = 'Today, ' + ahead.length + ' more trains leave ' + ST[+act.from].n + ' for ' + ST[+act.to].n + ': '
              + ahead.map(x => x.t.name + ' (' + x.t.no + ') at ' + hhmm(x.depDay)).join('; ') + '.'
              + (gone ? ' ' + gone + ' already left today.' : '')
              + ' Today\u2019s chart is already prepared, so khaali cannot book today\u2019s run \u2014 booking opens from tomorrow.';
          }
          let sayT = en;
          if (sl) { try { sayT = (await translateTo(en, sl[1])) || en; } catch (e) {} }
          return send(res, 200, { say: sayT, lang: sl ? sl[1] : null, link: '/trains?from=' + (+act.from) + '&to=' + (+act.to) + '&cls=' + cls });
        }
        // Honour a requested date, clamped to the booking window (tomorrow..+60d).
        const t0 = new Date(); t0.setHours(0, 0, 0, 0);
        const minMs = t0.getTime(), maxMs = t0.getTime() + 60 * 864e5;
        let dms = minMs;
        if (act.date && /^\d{4}-\d{2}-\d{2}$/.test(act.date)) {
          const pms = new Date(act.date + 'T00:00:00').getTime();
          if (pms >= minMs && pms <= maxMs) dms = pms;
        }
        const dO = new Date(dms);
        const date = dO.getFullYear() + '-' + String(dO.getMonth() + 1).padStart(2, '0')
          + '-' + String(dO.getDate()).padStart(2, '0');
        const dayIdx = Math.round((dms - minMs) / 864e5);
        const r = search(+act.from, +act.to, date, cls);
        // Asking about today means trains that can still be caught — a train
        // that left an hour ago is not an answer.
        if (date === TODAY()) {
          const nm = (() => { const n = simNow(); return n.getHours() * 60 + n.getMinutes(); })();
          r.trains = r.trains.filter(t => t.depMin == null || ((t.depMin % 1440) + 1440) % 1440 > nm);
        }
        const brief = {
          from: r.fromName, to: r.toName, km: r.km, date, class: cls,
          noDirect: r.noDirect,
          trains: r.trains.slice(0, 5).map(t => ({
            no: t.no, name: t.name, dep: t.dep, arr: t.arr,
            freeWholeWay: t.counts.free, cheaperOpenEnRoute: t.counts.part,
            cancelled: t.cancelled ? t.cancelReason || 'cancelled this date' : false,
          })),
        };
        // Speed path: build the answer here, translate with Mayura (~0.6s)
        // instead of a second 105B round trip. Fall back to the model only
        // if translation fails.
        const human = dO.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        const alive = brief.trains.filter(t => !t.cancelled);
        const cxd = brief.trains.filter(t => t.cancelled);
        const dateWasNamed = !!(act.date && /^\d{4}-\d{2}-\d{2}$/.test(act.date));
        // A named time narrows the answer to departures within 90 minutes of
        // it. Cancelled trains inside the window are called out by name, and
        // an empty window answers with the nearest departures instead.
        let win = null;
        if (act.around && /^\d{1,2}:\d{2}$/.test(String(act.around))) {
          const [ah, am2] = String(act.around).split(':').map(Number);
          if (ah >= 0 && ah < 24 && am2 >= 0 && am2 < 60) {
            const tgt = ah * 60 + am2;
            const dist = t => t.depMin == null ? 1e9
              : Math.min(Math.abs((t.depMin % 1440) - tgt), 1440 - Math.abs((t.depMin % 1440) - tgt));
            const all = r.trains.map(t => ({ t, d: dist(t) })).sort((a, b) => a.d - b.d);
            win = { hh: hhmm(tgt), near: all.filter(x => x.d <= 90).map(x => x.t),
                    nearest: all.slice(0, 3).map(x => x.t) };
          }
        }
        let en;
        if (win) {
          const inW = win.near.filter(t => !t.cancelled);
          const cxW = win.near.filter(t => t.cancelled);
          if (inW.length) {
            en = inW.length + (inW.length === 1 ? ' train leaves' : ' trains leave') + ' around ' + win.hh
              + ' from ' + r.fromName + ' to ' + r.toName + ' on ' + human + ': '
              + inW.slice(0, 3).map(t => t.name + ' (' + t.no + ') at ' + t.dep + ' \u2014 '
                  + t.counts.free + ' berths free your whole way'
                  + (t.counts.part ? ', ' + t.counts.part + ' cheaper en route' : '')).join('; ') + '.'
              + (cxW.length ? ' Careful: ' + cxW.map(t => t.no + ' at ' + t.dep).join(', ')
                  + ' in that window is cancelled that day.' : '');
          } else {
            const nr = win.nearest.filter(t => !t.cancelled).slice(0, 2);
            en = 'No train leaves around ' + win.hh + ' from ' + r.fromName + ' to ' + r.toName + ' on ' + human + '.'
              + (cxW.length ? ' ' + cxW.map(t => t.name + ' (' + t.no + ') at ' + t.dep).join(', ')
                  + ' would have fit but is cancelled that day.' : '')
              + (nr.length ? ' The closest departures are ' + nr.map(t => t.name + ' (' + t.no + ') at '
                  + t.dep + ' with ' + t.counts.free + ' berths free').join(' and ') + '.' : '');
          }
        } else if (!alive.length) {
          en = 'No trains are available from ' + r.fromName + ' to ' + r.toName + ' on ' + human + '.'
            + (cxd.length ? ' ' + cxd.map(t => t.no).join(', ') + ' cancelled that day.' : '');
        } else {
          const b = alive[0], b2 = alive[1];
          en = 'On ' + human + ', ' + r.trains.length + ' trains run from ' + r.fromName + ' to ' + r.toName + '. '
            + b.name + ' (' + b.no + ') leaves at ' + b.dep + '. It has ' + b.freeWholeWay + ' berths that stay free for your full journey'
            + (b.cheaperOpenEnRoute ? ', and ' + b.cheaperOpenEnRoute + ' cheaper berths that become free along the way' : '') + '.'
            + (b2 ? ' ' + b2.name + ' at ' + b2.dep + ' also has ' + b2.freeWholeWay + ' free berths.' : '')
            + (cxd.length ? ' Careful: train ' + cxd.map(t => t.no).join(', ') + ' is cancelled that day.' : '');
        }
        if (!dateWasNamed && alive.length && !win) {
          en += ' I looked at ' + human + ', the first day you can book \u2014 tell me another date any time.';
        }
        let say = en;
        if (sl) {
          try { say = (await translateTo(en, sl[1])) || en; }
          catch (e) {
            try {
              const final = await sarvam([
                { role: 'system', content: SAARTHI_SYS() + langNote },
                ...hist,
                { role: 'user', content: 'SYSTEM: translate for the traveller, plain text: ' + en },
              ]);
              say = sayOf(final) || en;
            } catch (e2) {}
          }
        }
        return send(res, 200, {
          say, lang: sl ? sl[1] : null,
          link: '/trains?from=' + (+act.from) + '&to=' + (+act.to) + '&cls=' + cls + (dayIdx ? '&day=' + dayIdx : ''),
        });
      }
      let sayFinal = (plan && plan.say ? String(plan.say).trim() : '') || sayOf(first) || await retrySayFor(sl);
      // Hard guarantee: an explicitly requested language always wins, even if
      // the model ignored the pin — force-translate (auto-detected source).
      if (sl && sl[1] !== 'en-IN') {
        const got = scriptLangOf(sayFinal);
        if (!got || got[1] !== sl[1]) {
          try { sayFinal = (await translateTo(sayFinal, sl[1], 'auto')) || sayFinal; } catch (e) {}
        }
      }
      return send(res, 200, { say: sayFinal, lang: sl ? sl[1] : null });
    } catch (e) {
      console.error('saarthi chat error:', e);
      return send(res, 502, { say: 'Saarthi could not reach Sarvam right now \u2014 try again in a moment.', err: String(e && e.message || e) });
    }
  }

  if (p === '/api/reset' && req.method === 'POST') {
    // wipes every booking on the server: never from a browser, never anonymously.
    // x-admin-token is not in the CORS allow-list, so no other site can send it.
    const want = process.env.ADMIN_TOKEN || '';
    const got = String(req.headers['x-admin-token'] || '');
    if (!want || got !== want) return send(res, 403, { error: 'admin token required' });
    store.reset(); return send(res, 200, { ok: true });
  }
  if (p === '/api/stats') return send(res, 200, store.stats());

  if (p === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  return send(res, 404, { error: 'no such endpoint' });
}

// ------------------------------------------------------------------ static --
// The design prototype in the parent folder IS the app. public/ keeps only the
// payment page reached by QR (and the plain fallback client).
const PUB = path.join(DIR, 'public');
const PARENT = path.resolve(DIR, '..');

// Client-side routes. Each is a real URL the app can be opened or refreshed on,
// so they all have to return the app itself rather than a 404.
const APP_ROUTES = new Set([
  '/', '/index.html', '/trains', '/route-map', '/train',
  '/departures', '/berths', '/confirm', '/ticket', '/my-bookings', '/about', '/favorites', '/waitlist-odds', '/seat-hop', '/wallet', '/fair-tatkal',
]);

function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return send(res, 400, { error: 'bad path' }); }
  if (APP_ROUTES.has(rel.replace(/\/+$/, '') || '/')) {
    return sendFile(res, path.join(PARENT, 'Rail Booking Flow.dc.html'), () =>
      sendFile(res, path.join(PUB, 'index.html'), () => send(res, 404, 'Not found', 'text/plain')));
  }
  if (rel.startsWith('/pay/')) rel = '/pay.html';           // /pay/<holdId> from the QR
  if (rel === '/live-map') rel = '/map.html';               // real-geography live map
  const clean = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
  const inPub = path.join(PUB, clean);
  const inParent = path.join(PARENT, clean);
  if (!inPub.startsWith(PUB) || !inParent.startsWith(PARENT)) return send(res, 403, { error: 'nope' });
  sendFile(res, inPub, () => sendFile(res, inParent, () => send(res, 404, 'Not found', 'text/plain')));
}

function sendFile(res, file, onMiss) {
  fs.readFile(file, (err, buf) => {
    if (err) return onMiss();
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === '/favicon.ico') {
      return send(res, 200,
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        + '<rect width="64" height="64" rx="14" fill="#c13a26"/>'
        + '<text x="32" y="46" font-size="42" font-family="Georgia,serif" fill="#f4efe6" text-anchor="middle">k</text></svg>',
        'image/svg+xml');
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e && e.message || e) });
  }
}).listen(PORT, () => {   // dual-stack: ::1 and 127.0.0.1 both answer instantly
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('\n  khaali live — berth locking is server-side\n');
  console.log(`  this machine   http://localhost:${PORT}`);
  lan.forEach(a => console.log(`  phones on wifi http://${a}:${PORT}`));
  console.log(`\n  hold window    ${store.HOLD_MS / 60000} minutes`);
  console.log('  reset state    curl -X POST http://localhost:' + PORT + '/api/reset\n');
});
