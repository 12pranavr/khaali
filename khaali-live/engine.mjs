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
  const dow = new Date(Date.now() + (dayIdx + 1) * 864e5).getDay();
  let df = dow === 0 || dow === 6 ? 1.02 + rnd() * 0.33
    : dow === 5 ? 0.88 + rnd() * 0.4
    : 0.5 + rnd() * 0.45;
  if (rnd() < 0.14) df = Math.min(1.35, df + 0.38);
  const longBias = (df - 0.55) / 0.8 * 0.8;
  const freeN = Math.max(0, Math.round(C.free * (2.1 - df)));
  // Busy day = fewer untouched berths of every kind, so the count someone can
  // actually book falls as demand rises.
  const vacN = Math.max(3, Math.round(C.vac * Math.max(0.3, 2.9 - 2.0 * df) * (1 + (parseInt(tr.no) % 7) * 0.03)));
  const blockers = [
    [0, 13], [0, 11], [0, 9], [5, 13], [5, 11],
    [6, 12], [4, 9], [2, 13], [8, 13], [3, 12],
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
