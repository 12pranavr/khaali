// The part that understands sentences - and is not allowed to make anything up.
//
// A language model does three jobs here and no others:
//   1. turn "I need to be at Majestic by nine, not much walking" into a
//      structured request the routing engine can run;
//   2. turn the allocator's codes and verified numbers into one plain
//      sentence;
//   3. answer "why are you sending me through Whitefield?" from the journey
//      facts it is handed.
//
// It never decides a route, a price, a probability, or how full a train is.
// Every structured thing it returns is validated before it is used, and every
// job has a deterministic fallback so the product works with no key at all -
// a little more woodenly, but correctly.
//
// The model is injected as a function `llm(messages, opts) -> text`, so the
// server decides which provider does which job and the tests use none.

import { ST } from './data.mjs';
import { STOPS } from './metro.mjs';
import { MODES, ALL_MODES } from './journey.mjs';
import { sentence, PROFILES } from './allocate.mjs';

// ------------------------------------------------------------------ places --
/** Everything a person might name, and what khaali calls it. */
export function places() {
  const out = [];
  ST.forEach(s => out.push({ kind: 'rail', id: s.c, name: s.n, words: [s.n.toLowerCase(), s.c.toLowerCase()] }));
  STOPS.forEach(m => out.push({ kind: 'metro', id: m.id, name: m.n, words: [m.n.toLowerCase(), m.id.toLowerCase()] }));
  return out;
}
/** What people actually say, against what the data calls it. Metro wins for a
    city destination, rail for a corridor town: that is where each one is. */
export const ALIASES = {
  majestic: ['metro', 'KGWA'], 'kempegowda': ['metro', 'KGWA'], 'city railway station': ['rail', 'SBC'],
  'ksr': ['rail', 'SBC'], 'bengaluru city': ['rail', 'SBC'], 'bangalore city': ['rail', 'SBC'],
  bangarpet: ['rail', 'BWT'], bangarapet: ['rail', 'BWT'], bangarpete: ['rail', 'BWT'],
  whitefield: ['rail', 'WFD'], 'kr puram': ['rail', 'KJM'], 'k r puram': ['rail', 'KJM'], krpuram: ['rail', 'KJM'],
  'kr pura': ['metro', 'KRAM'], indiranagar: ['metro', 'IDN'], 'mg road': ['metro', 'MAGR'], 'm g road': ['metro', 'MAGR'],
  'cubbon park': ['metro', 'CBPK'], 'vidhana soudha': ['metro', 'VDSA'], trinity: ['metro', 'TTY'],
  halasuru: ['metro', 'HLRU'], ulsoor: ['metro', 'HLRU'], baiyappanahalli: ['metro', 'BYPH'], byappanahalli: ['metro', 'BYPH'],
  hoodi: ['metro', 'DKIA'], kundalahalli: ['metro', 'KDNH'], itpl: ['metro', 'ITPL'], 'hope farm': ['metro', 'UWVL'],
  hopefarm: ['metro', 'UWVL'], kadugodi: ['metro', 'WHTM'], mysuru: ['rail', 'MYS'], mysore: ['rail', 'MYS'],
  mandya: ['rail', 'MYA'], maddur: ['rail', 'MAD'], kengeri: ['rail', 'KGI'], cantonment: ['rail', 'BNC'], cantt: ['rail', 'BNC'],
};

const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const squash = t => norm(t).replace(/ /g, '');

/** A place from a phrase, or null. Aliases first, then names, then prefixes. */
export function resolvePlace(text) {
  const q = norm(text);
  if (!q) return null;
  const P = places();
  const hit = ([k, id]) => { const p = P.find(x => x.kind === k && x.id === id); return p ? { kind: p.kind, id: p.id, name: p.name } : null; };
  const qs = squash(q);
  if (ALIASES[q]) return hit(ALIASES[q]);
  const AK = Object.keys(ALIASES).sort((x, y) => y.length - x.length);
  for (const a of AK) if (squash(a) === qs) return hit(ALIASES[a]);
  for (const a of AK) if (q.includes(a) || qs.includes(squash(a))) return hit(ALIASES[a]);
  const exact = P.find(p => p.words.includes(q) || p.words.some(w => squash(w) === qs));
  if (exact) return { kind: exact.kind, id: exact.id, name: exact.name };
  const pre = P.find(p => p.words.some(w => w.startsWith(q) || q.startsWith(w) || squash(w).startsWith(qs)));
  if (pre && qs.length >= 4) return { kind: pre.kind, id: pre.id, name: pre.name };
  const inside = P.find(p => p.words.some(w => w.length > 4 && (q.includes(w) || qs.includes(squash(w)))));
  return inside ? { kind: inside.kind, id: inside.id, name: inside.name } : null;
}

// ------------------------------------------------------------- the schema --
/**
 * The only shape a request may take. Anything the model returns is squeezed
 * through this; what does not fit is dropped, not executed.
 */
export function validateIntent(o) {
  const errors = [];
  const r = { origin: null, destination: null, timeConstraint: null, leaveAfter: null, modes: [...MODES],
    preferences: {}, maxChanges: null, needs: [], profile: null };
  if (!o || typeof o !== 'object') return { ok: false, errors: ['not an object'], request: r };
  const txt = v => (v && typeof v === 'object') ? v.text : v;
  if (txt(o.origin)) r.origin = { text: String(txt(o.origin)).slice(0, 80) };
  if (txt(o.destination)) r.destination = { text: String(txt(o.destination)).slice(0, 80) };
  if (o.timeConstraint && typeof o.timeConstraint === 'object') {
    const t = String(o.timeConstraint.type || '').toUpperCase();
    const v = String(o.timeConstraint.value || '');
    if ((t === 'ARRIVE_BY' || t === 'LEAVE_AFTER') && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) r.timeConstraint = { type: t, value: v };
    else errors.push('timeConstraint ignored');
  }
  if (Array.isArray(o.modes)) {
    // A sentence may ASK for a car. It may not be given one by a model that
    // decided a car would be nice: only a named mode gets through, and the
    // default (r.modes) is still the network.
    const m = o.modes.map(x => String(x).toLowerCase()).filter(x => ALL_MODES.includes(x));
    if (m.length) r.modes = m; else errors.push('modes ignored');
  }
  if (o.preferences && typeof o.preferences === 'object') {
    for (const k of ['minimizeWalking', 'minimizeTransfers', 'minimizeCost', 'minimizeTime', 'avoidCrowding', 'wantSeat'])
      if (typeof o.preferences[k] === 'boolean') r.preferences[k] = o.preferences[k];
  }
  if (typeof o.leaveAfter === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.leaveAfter)) r.leaveAfter = o.leaveAfter;
  if (Number.isInteger(o.maxTransfers) && o.maxTransfers >= 0 && o.maxTransfers <= 3) r.maxChanges = o.maxTransfers;
  if (Number.isInteger(o.maxChanges) && o.maxChanges >= 0 && o.maxChanges <= 3) r.maxChanges = o.maxChanges;
  if (o.accessibility && typeof o.accessibility === 'object' && o.accessibility.stepFree === true) r.needs.push('step-free');
  if (Array.isArray(o.needs) && o.needs.includes('step-free')) r.needs.push('step-free');
  r.needs = [...new Set(r.needs)];
  if (typeof o.profile === 'string' && PROFILES.includes(o.profile)) r.profile = o.profile;
  return { ok: true, errors, request: r };
}

/** Preferences into a ranking profile. The passenger's words, the allocator's dial. */
export function profileFor(p = {}, fallback = 'balanced') {
  if (p.minimizeCost) return 'cheapest';
  if (p.minimizeTime && !p.wantSeat && !p.avoidCrowding) return 'fastest';
  if (p.minimizeWalking || p.minimizeTransfers || p.wantSeat || p.avoidCrowding) return 'comfortable';
  return fallback;
}

// ---------------------------------------------------- reading it ourselves --
const HOUR = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)?\b/i;
function clockOf(m) {
  if (!m) return null;
  let h = parseInt(m[1], 10); const mm = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (h > 23 || mm > 59) return null;
  if (ap.startsWith('p') && h < 12) h += 12;
  if (ap.startsWith('a') && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 6) h += 12;         // "by 6" is evening for most people; "by 9" is morning
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
const WORD_TIMES = { noon: '12:00', midday: '12:00', morning: '09:00', evening: '18:00', night: '21:00', tonight: '21:00', afternoon: '15:00' };

/**
 * A sentence read without a model. It will not understand everything, and it
 * says what it did not understand; that is better than guessing.
 */
/* A full stop is a boundary, and losing it cost khaali a journey it could
   read. norm() flattens every punctuation mark to a space, so "I am from
   Hebbal. What should I do?" became one long clause and the origin came out
   as "hebbal what should" - which resolves to nothing, so a request with a
   destination, an origin and a deadline was answered "I do not have that one
   to hand". Sentence enders become the comma the grammar already stops at. */
const clauses = t => String(t || '').toLowerCase()
  .replace(/[.?!;\n]+/g, ' , ').replace(/[^a-z0-9, ]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

export function parseLocally(text) {
  // "I need to go from X to Y": the wanting and the going are not places
  const t = (' ' + clauses(text) + ' ')
    .replace(/ (?:need|want|have|would like|like|going|trying|planning|got) to (?:go|get|travel|head|come)(?= )/g, ' ')
    .replace(/ (?:i|we) (?:need|want|have|would like|like|must|should) to (?=[a-z])/g, ' ')
    .replace(/ to (?:go|get|travel|head|come)(?= )/g, ' ')
    .replace(/\s+/g, ' ');
  const o = { origin: null, destination: null, timeConstraint: null, modes: null, preferences: {}, maxTransfers: null, accessibility: {} };
  // places
  const STOPW = '(?= to | by | before | after | at | and | i | with | without | today | tomorrow | around | leaving | leave | reach | only | no | not |,|$)';
  /* How people actually say where they are. khaali listened for "from" and
     "leaving" only, so "I stay near Devanahalli" named no origin at all and a
     complete request came back as "sorry, I did not follow that". */
  const HERE = 'from|starting at|starting from|leaving|stay near|stay at|stay in'
    + '|staying near|staying at|staying in|live near|live at|live in|living near'
    + '|living at|living in|i am near|i am at|i am in|i m at|i m near|i m in'
    + '|currently at|currently near|based in|based at';
  const from = t.match(new RegExp(' (?:' + HERE + ') (?:the )?([a-z0-9 ]+?)' + STOPW));
  // "to go to X", "to reach X", "get to X" - the verb is not the place
  const to = t.match(new RegExp(' (?:to|reach|reaching|get to|going to|be at|be in|arrive at|arrive in|towards) (?:go to |get to |reach |be at |be in |the )?([a-z0-9 ]+?)' + STOPW.replace('$', ' from |$')));
  const verbs = /^(go|get|reach|be|travel|come|arrive|head)$/;
  if (from) o.origin = { text: from[1].trim() };
  if (to && !verbs.test(to[1].trim()) && !/^\d/.test(to[1].trim())) o.destination = { text: to[1].trim() };
  if (o.origin && o.destination && o.origin.text === o.destination.text) o.origin = null;
  // time
  /* "I should be there around 12" is an arrival, not a departure - and the
     word "around" belongs to both, so the deadline is read first and the
     departure is not allowed to re-read the same words. */
  const by = t.match(/(?:by|before|latest|reach by|reach around|be there by|be there around|be there at|there by|there around|should be there at)\s+(?:about\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|noon|midday|evening|morning|night|tonight|afternoon)/);
  const after = t.match(/(?:after|from|leave after|leaving after|leaving at|leave at|start at|starting at|around)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\b/);
  const clock = w => WORD_TIMES[w] || clockOf(w.match(HOUR));
  if (by) { const v = clock(by[1].trim()); if (v) o.timeConstraint = { type: 'ARRIVE_BY', value: v }; }
  // the same clock may not be both her deadline and her departure
  const overlaps = by && after && after.index >= by.index
    && after.index < by.index + by[0].length;
  if (after && !overlaps) { const v = clock(after[1].trim()); if (v) { if (o.timeConstraint) o.leaveAfter = v; else o.timeConstraint = { type: 'LEAVE_AFTER', value: v }; } }
  /* "tomorrow morning" names an hour without naming a number, and khaali read
     no hour at all - so a morning journey was planned from one minute past
     midnight, which is nobody's morning. */
  if (!after) {
    const part = t.match(/ (?:tomorrow|today|this|in the|by) (morning|afternoon|evening|night|tonight)\b/)
      || t.match(/ (morning|afternoon|evening|night|tonight) (?:tomorrow|today)\b/);
    const v = part && WORD_TIMES[part[1]];
    if (v && !(o.timeConstraint && o.timeConstraint.type === 'ARRIVE_BY')) {
      if (o.timeConstraint) o.leaveAfter = v;
      else o.timeConstraint = { type: 'LEAVE_AFTER', value: v };
    }
  }
  // modes
  const has = w => t.includes(' ' + w + ' ') || t.includes(' ' + w + 's ');
  const only = t.match(/ (?:only|just) (?:the |a )?(train|bus|metro)/) || t.match(/ (train|bus|metro)(?:es|s)? only /);
  if (only) o.modes = [only[1]];
  else {
    const no = [];
    for (const m of MODES) if (t.match(new RegExp(' (?:no|not|without|avoid|skip|hate|dont want|don t want|do not want) (?:the |a |any )?' + m + '(?:es|s)? '))) no.push(m);
    if (no.length) o.modes = MODES.filter(m => !no.includes(m));
    else if (t.match(/ (?:dont mind|don t mind|do not mind|ok with|fine with|happy with) (?:a |the )?bus/)) o.modes = [...MODES];
  }
  // She may say she will hire something. khaali never decides that for her, so
  // this is the only way a car or a bike enters a request from a sentence.
  const wantsCar = t.match(/ (?:cab|taxi|car|uber|ola|auto|four wheeler|4 wheeler) /);
  const wantsBike = t.match(/ (?:bike|scooter|two wheeler|2 wheeler|rapido|pillion) /);
  if (wantsCar || wantsBike) {
    const set = new Set(o.modes || MODES);
    if (wantsCar) set.add('car');
    if (wantsBike) set.add('bike');
    o.modes = [...set];
  }
  // preferences
  if (t.match(/ (?:not much|less|little|no|minimal|minimum|hate|avoid|cant|can t|cannot) (?:long )?walk/)) o.preferences.minimizeWalking = true;
  if (t.match(/ (?:cheap|cheapest|lowest fare|least money|save money|budget) /) || has('cheapest')) o.preferences.minimizeCost = true;
  if (t.match(/ (?:fast|fastest|quick|quickest|soonest|asap|hurry) /)) o.preferences.minimizeTime = true;
  if (t.match(/ (?:seat|sit|sitting|sit down) /)) o.preferences.wantSeat = true;
  if (t.match(/ (?:crowd|crowded|rush|packed|less busy|not busy|quiet) /)) o.preferences.avoidCrowding = true;
  const tr = t.match(/ (?:at most|max|maximum|no more than|only) (one|1|two|2|zero|0|no) (?:change|transfer|connection)/) || t.match(/ (one|1|single|no|zero|0) (?:change|transfer|connection)s? (?:only|max|at most)?/);
  if (tr) { const w = tr[1]; o.maxTransfers = /^(no|zero|0)$/.test(w) ? 0 : /^(one|1|single)$/.test(w) ? 1 : 2; }
  if (t.match(/ (?:direct|no changes|without changing|without a change) /)) o.maxTransfers = 0;
  if (t.match(/ (?:wheelchair|lift|elevator|ramp|step free|step-free|stepfree|grandmother|grandfather|grandma|grandpa|elderly|crutch|stroller|pram) /)) o.accessibility.stepFree = true;
  return o;
}

/**
 * "Majestic to Nagasandra, and Nagasandra to Kodigehalli" is three places, not
 * two - and khaali used to read the whole tail as ONE destination, then report
 * that it could not find a place with a comma in the middle of it. The stops in
 * order, or null when the sentence names no chain.
 */
export function hopsOf(text) {
  const t = ' ' + clauses(text) + ' ';
  const stops = [];
  const push = s => {
    s = String(s || '').trim().replace(/^(?:the|a) /, '');
    if (!s || /^\d+$/.test(s)) return;
    // the join between two hops is named twice - once as an end, once as a
    // start - and it is one place
    if (!stops.length || squash(stops[stops.length - 1]) !== squash(s)) stops.push(s);
  };
  const END = '(?=$|,| and | then | so | after | before | by | at | around | today | tomorrow )';
  const PAIR = new RegExp('(?:^|[ ,])from ([a-z0-9 ]+?) to ([a-z0-9 ]+?)' + END, 'g');
  let m, last = 0;
  while ((m = PAIR.exec(t))) { push(m[1]); push(m[2]); last = PAIR.lastIndex; }
  // "...to X, then to Y" - one origin, a chain of destinations
  const THEN = new RegExp('(?:,| and|) *then to ([a-z0-9 ]+?)' + END, 'g');
  THEN.lastIndex = last;
  while ((m = THEN.exec(t))) push(m[1]);
  return stops.length >= 3 ? stops : null;
}

/** The model stuffed a chain into one field: "Nagasandra, then to Kodigehalli". */
export function splitEnds(text) {
  return String(text || '').split(/\s*,?\s*(?:and\s+)?then\s+to\s+|\s*,\s*then\s+/i)
    .map(s => s.trim()).filter(Boolean);
}

/**
 * A journey read from the sentence alone, with no model in the room.
 *
 * The chat path had no such floor: when the model answered with no action -
 * which it does when the origin arrives in a later sentence than the
 * destination, a shape none of its examples show - khaali replied that it did
 * not have that one to hand, about a request naming a origin, a destination
 * and a deadline. A sentence khaali can read is planned, not deflected.
 */
export function planFromText(text) {
  const local = parseLocally(text);
  const hops = hopsOf(text);
  const from = hops ? hops[0] : (local.origin && local.origin.text);
  const to = hops ? hops[hops.length - 1] : (local.destination && local.destination.text);
  if (!from || !to || squash(from) === squash(to)) return null;
  const act = { type: 'plan', from, to, source: 'read-from-the-sentence' };
  const via = hops ? hops.slice(1, -1) : [];
  if (via.length) act.via = via;
  const tc = local.timeConstraint;
  if (tc && tc.type === 'ARRIVE_BY') act.by = tc.value;
  if (tc && tc.type === 'LEAVE_AFTER') act.after = tc.value;
  if (local.leaveAfter) act.after = local.leaveAfter;
  if (local.modes) act.modes = local.modes;
  if (/\btomorrow\b/i.test(String(text || ''))) act.day = 'tomorrow';
  return act;
}

// --------------------------------------------------------------- the model --
const INTENT_SYSTEM = `You convert a traveller's sentence about a journey in Bengaluru into JSON. Reply with JSON only.
Schema: {"origin":{"text":string}|null,"destination":{"text":string}|null,
"timeConstraint":{"type":"ARRIVE_BY"|"LEAVE_AFTER","value":"HH:MM"}|null,
"modes":["train","metro","bus"] (only the modes the person allows; all three if unstated),
"preferences":{"minimizeWalking":bool,"minimizeTransfers":bool,"minimizeCost":bool,"minimizeTime":bool,"avoidCrowding":bool,"wantSeat":bool},
"maxTransfers":int|null,"accessibility":{"stepFree":bool}}
Rules: use 24-hour HH:MM. "by nine" in the morning context is 09:00. Never invent a place, a time or a mode the person did not say. Leave fields null when unstated. Place text is the person's own words, not a station code.`;

/** Local read first; the model, when there is one, may only fill what the
    local read left empty or correct a place name. The result is validated. */
export async function parseIntent(text, { llm = null, geocode = null } = {}) {
  const raw = String(text || '').slice(0, 400);
  const local = parseLocally(raw);
  let fromModel = null, provider = 'local';
  // the model and the map are asked at the same time: the grammar already
  // knows which places to look up, and neither should wait for the other
  const early = {};
  const lookups = [];
  if (geocode) for (const side of ['from', 'to']) {
    const txt = side === 'from' ? (local.origin && local.origin.text) : (local.destination && local.destination.text);
    if (txt && !resolvePlace(txt)) lookups.push(geocode(txt).then(g => { early[side] = g; }).catch(() => {}));
  }
  const modelP = llm ? llm([{ role: 'system', content: INTENT_SYSTEM }, { role: 'user', content: raw }], { json: true, maxTokens: 300, temperature: 0 })
    .then(out => { const m = String(out || '').match(/\{[\s\S]*\}/); if (m) { fromModel = JSON.parse(m[0]); provider = 'model'; } })
    .catch(() => { fromModel = null; }) : Promise.resolve();
  await Promise.all([modelP, ...lookups]);
  // merge: the model fills gaps; the local read is never overwritten on time or modes it found
  const merged = { ...(fromModel || {}) };
  if (local.origin) merged.origin = local.origin; else if (!merged.origin) merged.origin = null;
  if (local.destination) merged.destination = local.destination;
  if (local.timeConstraint) merged.timeConstraint = local.timeConstraint;
  if (local.leaveAfter) merged.leaveAfter = local.leaveAfter;
  if (local.modes) merged.modes = local.modes;
  // "Shivajinagar bus station" names a place, not a preference: a model that
  // reads it as "bus only" is overruled when the grammar found no restriction
  else if (/\b(bus|metro|railway|train) (station|stand|stop)\b/i.test(raw)) delete merged.modes;
  merged.preferences = { ...(merged.preferences || {}), ...local.preferences };
  if (local.maxTransfers != null) merged.maxTransfers = local.maxTransfers;
  if (local.accessibility.stepFree) merged.accessibility = { stepFree: true };
  const v = validateIntent(merged);
  const r = v.request;
  const resolved = {
    from: r.origin ? resolvePlace(r.origin.text) : null,
    to: r.destination ? resolvePlace(r.destination.text) : null,
  };
  // anywhere else: a point on the map, joined to the nearest station later
  if (geocode) {
    for (const side of ['from', 'to']) {
      const txt = side === 'from' ? (r.origin && r.origin.text) : (r.destination && r.destination.text);
      if (!txt || resolved[side]) continue;
      try {
        const g = early[side] !== undefined ? early[side] : await geocode(txt);
        if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng)) resolved[side] = { kind: 'place', id: g.lat.toFixed(5) + ',' + g.lng.toFixed(5), name: g.name || txt, lat: g.lat, lng: g.lng };
      } catch { /* unresolved stays unresolved */ }
    }
  }
  const unresolved = [];
  if (r.origin && !resolved.from) unresolved.push('origin: ' + r.origin.text);
  if (r.destination && !resolved.to) unresolved.push('destination: ' + r.destination.text);
  if (!r.destination) unresolved.push('destination');
  r.profile = r.profile || profileFor(r.preferences);
  return { ok: true, request: r, resolved, unresolved, provider, understood: describe(r, resolved) };
}

/** What we understood, as words, so she can see it before we act on it. */
export function describe(r, resolved) {
  const bits = [];
  if (resolved.from) bits.push('from ' + resolved.from.name + (resolved.from.kind === 'place' ? ' (on the map)' : ''));
  if (resolved.to) bits.push('to ' + resolved.to.name + (resolved.to.kind === 'place' ? ' (on the map)' : ''));
  if (r.leaveAfter) bits.push('leave after ' + r.leaveAfter);
  if (r.timeConstraint) bits.push((r.timeConstraint.type === 'ARRIVE_BY' ? 'reach by ' : 'leave after ') + r.timeConstraint.value);
  if (r.modes.length < MODES.length) bits.push(r.modes.join(' or ') + ' only');
  const p = r.preferences;
  if (p.minimizeWalking) bits.push('less walking');
  if (p.wantSeat) bits.push('a seat');
  if (p.avoidCrowding) bits.push('avoid crowds');
  if (p.minimizeCost) bits.push('cheapest');
  if (p.minimizeTime) bits.push('fastest');
  if (r.maxChanges != null) bits.push(r.maxChanges === 0 ? 'no changes' : 'at most ' + r.maxChanges + ' change' + (r.maxChanges === 1 ? '' : 's'));
  if (r.needs.includes('step-free')) bits.push('a lift or ramp');
  return bits.join(' · ');
}

const EXPLAIN_SYSTEM = `You are khaali, a Bengaluru public-transport planner. You will be given VERIFIED FACTS about a recommended journey as JSON. Write ONE or TWO plain sentences, at most 40 words, for an ordinary traveller, explaining why this way was recommended. Use only the numbers and facts given. Never add a number, a place, a time or a reason that is not in the facts. No markdown, no exclamation marks, no preamble. If capacityConfidence is LOW, say crowding is partly unknown.`;

/** One sentence from the allocator's codes. The model may phrase; it may not add. */
export async function explain(reason, { llm = null } = {}) {
  const fallback = sentence(reason);
  if (!llm || !reason) return { text: fallback, provider: 'template' };
  try {
    const facts = { reasons: reason.reasons, ...reason.facts, impact: reason.impact };
    const out = await llm([{ role: 'system', content: EXPLAIN_SYSTEM }, { role: 'user', content: JSON.stringify(facts) }], { maxTokens: 120, temperature: 0.3 });
    const text = String(out || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length > 400 || leaks(text, facts)) return { text: fallback, provider: 'template' };
    // A model may say the same thing more warmly. It may not say LESS: a hired
    // vehicle on the journey costs her money khaali only estimated, and a
    // sentence that quietly leaves the car out is not an explanation.
    const saysRide = reason.reasons.includes('RIDE_BECAUSE_NOTHING_RUNS')
      || reason.reasons.includes('RIDE_IS_FASTER_THAN_THE_NETWORK');
    if (saysRide && !/\b(car|bike|hired?|ride)\b/i.test(text))
      return { text: fallback, provider: 'template' };
    return { text, provider: 'model' };
  } catch { return { text: fallback, provider: 'template' }; }
}

/** A number in the sentence that is in none of the facts is an invention. */
function leaks(text, facts) {
  const allowed = new Set();
  const walk = v => { if (typeof v === 'number') allowed.add(String(Math.abs(Math.round(v)))); else if (v && typeof v === 'object') Object.values(v).forEach(walk); else if (typeof v === 'string') (v.match(/\d+/g) || []).forEach(x => allowed.add(String(parseInt(x, 10)))); };
  walk(facts);
  const nums = (text.match(/\d+/g) || []).map(x => String(parseInt(x, 10)));
  return nums.some(n => !allowed.has(n) && !['1', '2'].includes(n));
}

const ASK_SYSTEM = `You are khaali, a Bengaluru public-transport planner. Answer the traveller's question about their recommended journey in at most three plain sentences, using ONLY the JOURNEY FACTS given as JSON. If the facts do not contain the answer, say you do not have that information. Never invent a time, fare, train, bus, station, or crowding figure. No markdown.`;

/** A question about the journey, answered from the journey. */
export async function ask(question, { chain = null, reason = null, alternatives = [], llm = null } = {}) {
  const q = String(question || '').slice(0, 300);
  const facts = summary(chain, reason, alternatives);
  if (!llm) return { text: answerLocally(q, facts), provider: 'template' };
  try {
    const out = await llm([{ role: 'system', content: ASK_SYSTEM },
      { role: 'user', content: 'JOURNEY FACTS: ' + JSON.stringify(facts) + '\n\nQUESTION: ' + q }], { maxTokens: 220, temperature: 0.3 });
    const text = String(out || '').trim();
    if (!text || leaks(text, facts)) return { text: answerLocally(q, facts), provider: 'template' };
    return { text, provider: 'model' };
  } catch { return { text: answerLocally(q, facts), provider: 'template' }; }
}

/** The facts a question may be answered from. Nothing else exists. */
export function summary(chain, reason, alternatives = []) {
  const leg = l => ({ mode: l.mode, name: l.name || l.line || null, from: l.from, to: l.to, dep: l.dep || null, arr: l.arr || null,
    minutes: l.min, seat: l.seat ? l.seat.word : null, seatWhy: l.seat ? l.seat.why : null,
    km: l.km || null, fare: l.fare != null ? l.fare : null,
    howFull: l.mode === 'walk' ? 'n/a' : l.cap && l.cap.occupancy != null ? Math.round(l.cap.occupancy * 100) + '%' : 'unknown',
    capacityQuality: l.cap ? l.cap.quality : 'unknown', simulated: l.source === 'simulated' });
  return {
    recommended: chain ? { leaves: chain.depText, arrives: chain.arrText, totalMinutes: chain.totalMin, fare: chain.fare,
      changes: chain.changes, modes: chain.modes, seat: chain.seat && chain.seat.word, legs: chain.legs.map(leg) } : null,
    why: reason ? { reasons: reason.reasons, ...reason.facts } : null,
    otherWays: alternatives.slice(0, 5).map(c => ({ leaves: c.depText, arrives: c.arrText, totalMinutes: c.totalMin, fare: c.fare,
      changes: c.changes, modes: c.modes, seat: c.seat && c.seat.word })),
  };
}

function answerLocally(q, f) {
  const r = f.recommended;
  if (!r) return 'Plan a journey first, then ask me about it.';
  const t = norm(q);
  if (/why|reason/.test(t)) return sentence({ reasons: f.why ? f.why.reasons : [], facts: f.why || {} });
  if (/seat|sit|stand/.test(t)) {
    const legs = r.legs.filter(l => l.seat).map(l => (l.name || l.mode) + ': ' + l.seat + (l.seatWhy ? ' (' + l.seatWhy + ')' : ''));
    return legs.length ? legs.join('. ') + '.' : 'khaali does not know about seats on this journey.';
  }
  if (/crowd|full|busy|rush/.test(t)) return r.legs.filter(l => l.mode !== 'walk').map(l => (l.name || l.mode) + ' is about ' + l.howFull + ' full (' + l.capacityQuality + ')').join('. ') + '.';
  if (/cost|fare|price|rupee|money|cheap/.test(t)) return 'This way costs ₹' + r.fare + (f.otherWays.length ? '. The cheapest other way is ₹' + Math.min(...f.otherWays.map(o => o.fare)) + '.' : '.');
  if (/when|time|leave|arriv|reach|long/.test(t)) return 'You leave at ' + r.leaves + ' and arrive at ' + r.arrives + ', ' + r.totalMinutes + ' minutes in all with ' + (r.changes === 0 ? 'no changes' : r.changes + ' change' + (r.changes === 1 ? '' : 's')) + '.';
  if (/change|transfer|whitefield|via|through/.test(t)) return r.legs.filter(l => l.mode !== 'walk').map(l => (l.name || l.mode) + ' from ' + l.from + ' to ' + l.to).join(', then ') + '.';
  return 'You leave at ' + r.leaves + ' by ' + r.modes.join(' and ') + ', arriving ' + r.arrives + ' for ₹' + r.fare + '. Ask me about the seat, the crowding, the cost, or why this way.';
}

/**
 * Does this sentence claim a fact khaali did not produce?
 *
 * leaks() above guards an answer that HAS facts behind it: a number in the
 * sentence that is in none of the facts is an invention. This guards the other
 * case - a free reply with no action, and so no facts at all. Deliberately
 * narrow: a fare, a clock time, or a route/train number. Ordinary numbers -
 * "two changes", "ten minutes' walk" - are fine and are not what this is for.
 * What it stops is the model answering a timetable question out of its memory.
 */
export function invents(text) {
  const t = String(text || '');
  if (/₹\s?\d|\brs\.?\s?\d|\brupees?\b/i.test(t)) return true;                  // a fare
  if (/\b\d{1,2}[:.]\d{2}\s?(am|pm)?\b/i.test(t)) return true;                  // a departure time
  if (/\b\d{4,5}\b/.test(t)) return true;                                       // a train number
  if (/\b(?:bus|route)\s+(?:no\.?\s*)?[0-9]{1,3}[A-Za-z]?\b/i.test(t)) return true;   // "bus 500D"
  if (/\b[A-Za-z]{2,5}-[0-9][0-9A-Za-z]{0,3}\b/.test(t)) return true;           // "KBS-1K"
  if (/\b[0-9]{2,3}-[A-Za-z]\b/.test(t)) return true;                           // "304-Z"
  return false;
}

/** What khaali says instead of guessing. */
export const CANNOT_SAY = {
  'en-IN': 'I do not have that one to hand — ask me to plan the journey and I will look it up properly.',
  'hi-IN': 'यह मेरे पास अभी नहीं है — मुझे यात्रा प्लान करने को कहिए, मैं ठीक से देखकर बताता हूँ।',
  'kn-IN': 'ಅದು ಈಗ ನನ್ನ ಬಳಿ ಇಲ್ಲ — ಪ್ರಯಾಣ ಯೋಜಿಸಲು ಹೇಳಿ, ನಾನು ಸರಿಯಾಗಿ ನೋಡಿ ಹೇಳುತ್ತೇನೆ.',
};
