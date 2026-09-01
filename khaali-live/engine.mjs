// Pure booking logic. No I/O, no state — the server and the client both use it.
//
// A berth is a resource occupied over an interval of the run. With 14 stations
// there are 13 legs, so occupancy is a 13-bit mask and every availability
// question is one bitwise AND.
import { ST, CLS, TRAINS } from './data.mjs';

export const SEGMENTS = ST.length - 1;               // 13
export const FULL_MASK = (1 << SEGMENTS) - 1;

export const stationByCode = code => ST.findIndex(s => s.c === code);
export const trainByNo = no => TRAINS.find(t => t.no === no);
export const classByKey = k => CLS.find(c => c.k === k);

// ---------------------------------------------------------------- timetable --
export const toMin = s => parseInt(s.slice(0, 2)) * 60 + parseInt(s.slice(3, 5));

export function stopIdxs(tr) {
  return Object.keys(tr.stops).map(Number).sort((a, b) => (tr.dir === 1 ? a - b : b - a));
}

export function sMin(tr, i, kind) {
  const s = tr.stops[i];
  if (!s) return null;
  const v = kind === 'd' ? (s[1] || s[0]) : (s[0] || s[1]);
  return v == null ? null : toMin(v) + s[2] * 1440;
}

/** Does this train run from a to b, in that order? */
export function serves(tr, a, b) {
  return !!(tr.stops[a] && tr.stops[b] && (tr.dir === 1 ? a < b : a > b));
}

export function plat(tr, i) {
  return ((parseInt(tr.no) * 31 + i * 17) % ST[i].pf) + 1;
}

export function fare(clsKey, km) {
  const C = classByKey(clsKey);
  return Math.round((C.base + C.rate * km) / 5) * 5;
}

export function journeyKm(from, to) {
  return Math.abs(ST[to].km - ST[from].km);
}

/** Kilometres of one leg (station i to i+1). */
export const legKm = i => ST[i + 1].km - ST[i].km;

/** How far along YOUR journey this berth is actually yours. */
export function coveredKm(occMask, from, to) {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  let km = 0;
  for (let i = lo; i < hi; i++) if (!(occMask & (1 << i))) km += legKm(i);
  return km;
}

/**
 * What a berth costs for this journey.
 * A berth you only hold for part of the way is charged for that part only,
 * pro-rated by distance — so it is always cheaper than a free-the-whole-way one.
 */
export function priceFor(occMask, from, to, clsKey) {
  const full = fare(clsKey, journeyKm(from, to));
  const jkm = journeyKm(from, to);
  if (!jkm) return full;
  const km = coveredKm(occMask, from, to);
  if (km >= jkm) return full;
  return Math.max(5, Math.round((full * km) / jkm / 5) * 5);
}

export function hhmm(m) {
  const x = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(x / 60), mm = String(x % 60).padStart(2, '0');
  const ap = h < 12 ? 'AM' : 'PM';
  return String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0') + ':' + mm + ' ' + ap;
}

// ------------------------------------------------------------------- masks --
/** Bits for the legs a journey actually occupies. Direction-independent. */
export function journeyMask(from, to) {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  let m = 0;
  for (let i = lo; i < hi; i++) m |= (1 << i);
  return m;
}

export function spanMask(s, e) {
  let m = 0;
  for (let i = s; i < e; i++) m |= (1 << i);
  return m;
}

export function popcount(x) {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

/**
 * How a berth relates to one journey.
 *  free    nobody is on it for any leg you travel
 *  part    somebody is on it for some of your legs
 *  taken   somebody is on it for all of your legs
 */
export function berthState(occMask, from, to) {
  const j = journeyMask(from, to);
  const hit = occMask & j;
  if (hit === 0) return { k: 'free' };
  if (hit === j) return { k: 'taken' };

  // Which station does it change hands at, in the traveller's direction?
  const up = from < to;
  const lo = Math.min(from, to), hi = Math.max(from, to);
  let firstBusy = -1, lastBusy = -1;
  for (let i = lo; i < hi; i++) {
    if (hit & (1 << i)) { if (firstBusy < 0) firstBusy = i; lastBusy = i; }
  }
  if (up) {
    return firstBusy === lo
      ? { k: 'part', at: lastBusy + 1, mode: 'from' }
      : { k: 'part', at: firstBusy, mode: 'until' };
  }
  return lastBusy === hi - 1
    ? { k: 'part', at: firstBusy, mode: 'from' }
    : { k: 'part', at: lastBusy + 1, mode: 'until' };
}

// ------------------------------------------------------------ berth layout --
export function berthLayout(clsKey) {
  const C = classByKey(clsKey);
  const types = clsKey === '2A'
    ? ['LB', 'UB', 'LB', 'UB', 'SLB', 'SUB']
    : ['LB', 'MB', 'UB', 'LB', 'MB', 'UB', 'SLB', 'SUB'];
  const per = types.length;
  const out = [];
  C.coaches.forEach((cid, ci) => {
    for (let i = 0; i < C.per; i++) {
      out.push({
        idx: ci * C.per + i, no: i + 1, coach: cid,
        type: types[i % per], bay: Math.floor(i / per) + 1,
        side: (i % per) >= per - 2,
      });
    }
  });
  return out;
}

// ------------------------------------------------- deterministic seed data --
function rng(s) {
  let a = s >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Pre-existing bookings for a train/class/day, ported verbatim from the
 * prototype so the live server tells the same story.
 * Returns one occupancy mask per berth.
 */
export function seedOccupancy(clsKey, trainNo, dayIdx = 0, seed = 7) {
  const C = classByKey(clsKey);
  const tr = trainByNo(trainNo) || TRAINS[0];
  const n = C.coaches.length * C.per;
  const rnd = rng(seed * 7919 + dayIdx * 613 + parseInt(tr.no) * 17 + clsKey.length * 101);

  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  // Demand has a weekly pulse: weekends run hot, Fridays fill, weekdays vary,
  // and the odd random date spikes like a festival. Deterministic per date.
  const dow = new Date(Date.now() + dayIdx * 864e5).getDay();
  let df = dow === 0 || dow === 6 ? 1.02 + rnd() * 0.33
    : dow === 5 ? 0.88 + rnd() * 0.4
    : 0.5 + rnd() * 0.45;
  if (rnd() < 0.14) df = Math.min(1.35, df + 0.38);
  const longBias = (df - 0.55) / 0.8 * 0.8;
  // A hot date sells out full-way in every class - AC included - so the
  // waitlist page has genuine red cases. Quieter days scale down as before.
  const freeN = df > 1.15 ? 0 : Math.max(0, Math.floor(C.free * (2.1 - df)));
  // Busy day = fewer untouched berths of every kind, so the count someone can
  // actually book falls as demand rises.
  // No floor here: a genuinely hot date is allowed to sell out full-way, so
  // the waitlist page has real work to do. Quiet days still leave plenty.
  const vacN = Math.round(C.vac * Math.max(0, 2.55 - 2.0 * df) * (1 + (parseInt(tr.no) % 7) * 0.03));
  const blockers = [
    [0, 13], [0, 11], [0, 9], [5, 13], [5, 11],
    [6, 12], [4, 9], [2, 13], [8, 13], [3, 12],
    [0, 7], [7, 13], [9, 13], [0, 10],
  ];

  const spans = new Array(n);
  let p = 0;
  for (let i = 0; i < freeN && p < n; i++) spans[order[p++]] = null;
  for (let i = 0; i < vacN && p < n; i++) spans[order[p++]] = [0, 5];
  while (p < n) {
    let bi = Math.floor(rnd() * blockers.length);
    if (rnd() < longBias) bi = rnd() < 0.5 ? 0 : 7;   // busy day: end-to-end riders
    spans[order[p]] = blockers[bi]; p++;
  }

  // The hero case: 16021 sleeper coach S4 is mostly people who get off at SBC.
  // Day one only — every other date lives by the demand model alone.
  if (clsKey === 'SL' && trainNo === '16021' && dayIdx <= 0) {
    const plan = [];
    for (let i = 0; i < 52; i++) plan.push([0, 5]);
    for (let i = 0; i < 16; i++) plan.push([0, 13]);
    for (let i = 0; i < 3; i++) plan.push([5, 13]);
    plan.push(null);
    const r2 = rng(4242 + seed);
    for (let i = plan.length - 1; i > 0; i--) {
      const j = Math.floor(r2() * (i + 1));
      [plan[i], plan[j]] = [plan[j], plan[i]];
    }
    const s4 = C.coaches.indexOf('S4');
    let q = 0;
    for (let i = 0; i < C.per; i++) spans[s4 * C.per + i] = plan[q++];
  }

  return spans.map(sp => (sp ? spanMask(sp[0], sp[1]) : 0));
}

// ------------------------------------------------------------- disruptions --
export const CX_REASONS = ['Track maintenance block', 'Operational reasons', 'Rake unavailable', 'Signalling work'];

/**
 * Is this train cancelled on this date? Deterministic (FNV-1a over no|date),
 * ~8% of services per day, so a 5-train route loses a train or two some days
 * — the exact surprise this feature exists to warn about. 16021 always runs.
 */
export function cancelledOn(no, dateISO) {
  if (no === '16021') return null;
  let h = 2166136261 >>> 0;
  const s = no + '|' + dateISO;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  if (h % 100 >= 8) return null;
  return { reason: CX_REASONS[h % CX_REASONS.length] };
}

// ---------------------------------------------------------- waitlist odds --
/**
 * Will WL <n> confirm? Deterministic: a seeded demand factor for the
 * train/class/date gives an expected number of pre-chart cancellations
 * (longer lead time = more churn); a logistic on the WL position turns
 * that into a percentage. Same numbers everywhere, explainable to anyone.
 */
export function oddsOf(no, dateISO, clsKey, wl) {
  const C = classByKey(clsKey);
  const cap = C.coaches.length * C.per;
  let h = 2166136261 >>> 0;
  const str = no + '|' + dateISO + '|' + clsKey;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const df = 0.55 + (h % 1000) / 1000 * 0.8;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((new Date(dateISO + 'T00:00:00').getTime() - t0.getTime()) / 864e5));
  const churnWindow = Math.min(1.6, 0.55 + days / 18);
  const expCancel = Math.max(2, Math.round(cap * 0.06 * churnWindow * (1.55 - df)));
  const spread = expCancel * 0.45 + 1.5;
  const p = 1 / (1 + Math.exp((wl - expCancel) / spread));
  return { pct: Math.max(2, Math.min(98, Math.round(p * 100))), expCancel, days, cap };
}

// ------------------------------------------------- waitlist odds, take two --
// Every input here is a fact with a name, so any number on the page can be
// read out loud: this train's demand seed, the day of the week, a festival
// window, a cancelled parallel train, how you joined the queue. No model in
// the loop - the LLM only words the verdict, it never touches the number.

/** Corridor demand calendar for the demo year. dm = extra demand pressure. */
export const FESTIVALS = [
  { from: '2026-08-26', to: '2026-08-30', why: 'Raksha Bandhan long weekend', dm: 0.22 },
  { from: '2026-09-12', to: '2026-09-15', why: 'Ganesh Chaturthi', dm: 0.28 },
  { from: '2026-10-09', to: '2026-10-21', why: 'Mysuru Dasara season', dm: 0.45 },
  { from: '2026-11-05', to: '2026-11-10', why: 'Deepavali', dm: 0.40 },
  { from: '2026-12-24', to: '2027-01-02', why: 'Christmas\u2013New Year', dm: 0.30 },
];

/** Waitlist type is geometry: origin boarding = GNWL, mid-route = RLWL,
    Tatkal quota = TQWL. Derived, never asked. */
export function wlTypeOf(no, from, quota) {
  if (quota === 'Tatkal') return 'TQWL';
  const tr = trainByNo(no);
  if (!tr) return 'GNWL';
  return from === stopIdxs(tr)[0] ? 'GNWL' : 'RLWL';
}

/**
 * Will a waitlist position clear on this train, class and date?
 * Returns three honest numbers: pct (confirmed berth), pctRAC (at least a
 * shared seat - you board), and wlNow (the queue you would join if you booked
 * this minute), plus the named reasons behind them.
 */
export function oddsOf2(no, dateISO, clsKey, opts = {}) {
  const { from = 0, to = 13, quota = 'General', wl = null, now = null } = opts;
  const C = classByKey(clsKey);
  const cap = C.coaches.length * C.per;
  const why = [];

  // seeded per-train/class/date heat, same FNV recipe the occupancy uses
  let h = 2166136261 >>> 0;
  const str = no + '|' + dateISO + '|' + clsKey;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const df = 0.55 + (h % 1000) / 1000 * 0.8;          // 0.55 quiet .. 1.35 hot

  const d = new Date(dateISO + 'T00:00:00');
  const dow = d.getDay();
  let dm = 1;
  if (dow === 5) { dm += 0.15; why.push('Friday rush'); }
  else if (dow === 0) { dm += 0.18; why.push('Sunday return traffic'); }
  else if (dow === 6) { dm += 0.08; why.push('Saturday'); }
  if (d.getDate() >= 28 && (dow === 5 || dow === 6)) { dm += 0.06; why.push('month-end weekend'); }
  const fest = FESTIVALS.find(f => dateISO >= f.from && dateISO <= f.to);
  if (fest) { dm += fest.dm; why.push(fest.why); }

  // a cancelled parallel train shoves its passengers onto this one
  let sisters = 0;
  for (const t2 of TRAINS) {
    if (t2.no !== no && serves(t2, from, to) && cancelledOn(t2.no, dateISO)) sisters++;
  }
  if (sisters) {
    dm += 0.08 * Math.min(3, sisters);
    why.push(sisters + ' parallel train' + (sisters > 1 ? 's' : '') + ' cancelled that day');
  }

  // the caller's clock, so a shifted demo clock moves the odds with the map
  const t0 = now ? new Date(now.getTime()) : new Date(); t0.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((d.getTime() - t0.getTime()) / 864e5));

  // churn: booked berths that free up before charting. Longer lead = more
  // plans change; a hot date holds its bookings.
  const heat = df * dm;
  const churn = 0.04 + 0.10 * Math.min(1, days / 45);
  const expCancel = Math.max(1, Math.round(cap * churn * Math.max(0.25, 1.9 - heat)));

  const type = wlTypeOf(no, from, quota);
  const mult = type === 'GNWL' ? 1 : type === 'RLWL' ? 0.45 : 0.3;
  const clears = Math.max(1, expCancel * mult);
  if (type === 'RLWL') why.push('boarding mid-route \u2014 RLWL clears about half as fast');
  if (type === 'TQWL') why.push('Tatkal waitlist clears last of all');
  if (days <= 2) why.push('little time left for plans to change');
  else if (days >= 30) why.push(days + ' days out \u2014 plenty of churn ahead');

  // the queue you would join right now: hot trains near departure run deep
  const wlNow = Math.max(1, Math.round(
    cap * 0.12 * Math.max(0, heat - 0.75) * (1 - Math.min(1, days / 60)) + 1 + (h % 5)));
  const pos = wl != null ? Math.max(1, wl) : wlNow;

  const spread = clears * 0.35 + 1.2;
  const pC = 1 / (1 + Math.exp((pos - clears) / spread));
  // RAC is the certainty tier: side berths absorb the queue after the
  // confirmations, so "do I board at all" clears far deeper than "full berth"
  const racSlots = clsKey === 'SL' ? C.coaches.length * 7
    : clsKey === '3A' ? C.coaches.length * 4 : C.coaches.length * 2;
  const racReach = clears + racSlots * (type === 'GNWL' ? 1 : 0.6);
  const pR = 1 / (1 + Math.exp((pos - racReach) / (spread + racSlots * 0.15)));

  const pct = Math.max(2, Math.min(98, Math.round(pC * 100)));
  return {
    type, wlNow, pos, days, cap,
    expCancel, clears: Math.round(clears), racSlots,
    pct,
    pctRAC: Math.max(pct, Math.min(99, Math.round(pR * 100))),
    heat: +heat.toFixed(2),
    why,
  };
}

// -------------------------------------------------------------- live train --
const DELAY = [0, 4, 11, 0, 7, 0];

export function liveOf(tr, now = new Date()) {
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const delay = DELAY[TRAINS.indexOf(tr)] || 0;
  const idxs = stopIdxs(tr);
  const base = sMin(tr, idxs[0], 'd');
  const last = sMin(tr, idxs[idxs.length - 1], 'a');
  const runLen = last - base;
  // Demo frequency service: each train repeats its corridor leg on a cycle a
  // little over twice its run time, anchored at the real timetable slot (the
  // true departure is always one of its runs). Keeps roughly half the fleet
  // moving at any hour without inventing duplicate trains. Simulated, and
  // labelled as such everywhere.
  const cycle = Math.max(runLen * 2 + ((parseInt(tr.no, 10) || 7) % 37), runLen + 30);
  const eff = (((nowMin - base - delay) % cycle) + cycle) % cycle;

  if (eff > runLen) {
    return { state: 'idle', delay, prog: 0, at: null, next: idxs[0],
      eff, cycle, startsIn: Math.ceil(cycle - eff) };
  }

  const visited = ST.map(() => false);
  let at = idxs[0], next = idxs[0];
  for (const i of idxs) {
    const a = sMin(tr, i, 'a') ?? sMin(tr, i, 'd');
    if (a - base <= eff) { visited[i] = true; at = i; } else { next = i; break; }
  }
  return { state: 'run', delay, prog: runLen ? eff / runLen : 0, at, next, visited, eff, runLen };
}

// ----------------------------------------------------------------- packing --
/**
 * Minimum-berth packing. Sort bookings by boarding leg, drop each onto the
 * first berth already vacated by then. Optimal for intervals: berths used
 * equals the busiest single leg.
 */
export function packPlan(masks) {
  const items = [];
  masks.forEach((m, i) => {
    if (!m) return;
    let s = -1, e = -1;
    for (let b = 0; b < SEGMENTS; b++) {
      if (m & (1 << b)) { if (s < 0) s = b; e = b + 1; }
    }
    items.push({ i, s, e, m });
  });
  items.sort((a, b) => a.s - b.s || a.e - b.e);

  const endAt = [], groups = [];
  for (const x of items) {
    let k = -1;
    for (let j = 0; j < endAt.length; j++) if (endAt[j] <= x.s) { k = j; break; }
    if (k < 0) { k = endAt.length; endAt.push(0); groups.push([]); }
    endAt[k] = x.e;
    groups[k].push({ s: x.s, e: x.e, from: x.i });
  }

  let peak = 0;
  for (let b = 0; b < SEGMENTS; b++) {
    let n = 0;
    for (const x of items) if (x.m & (1 << b)) n++;
    if (n > peak) peak = n;
  }

  return {
    total: masks.length, booked: items.length, used: groups.length,
    freed: masks.length - groups.length, peak, groups,
  };
}
