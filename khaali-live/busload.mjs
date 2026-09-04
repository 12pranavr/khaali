// ---------------------------------------------------------------------------
// How full a bus is, and how khaali came to think so.
//
// Four rungs, best first. Every one of them says which it is, all the way to
// the screen, because the whole difference between this and a pretty picture is
// whether a reader can tell a count from a guess.
//
//   counted    somebody issued or scanned a ticket. khaali's own conductor page
//              already records exactly this: a tap is a person boarding, on a
//              named route, between two named stops, at a known minute.
//   declared   an operator told khaali. Nobody has; the seam is below and empty.
//   modelled   khaali's demo model. A declared shape, reproducible, and marked
//              as a simulation everywhere it appears.
//   unknown    no route, no taps, no model that fits. Grey.
//
// THE RULE THAT MAKES THE FIRST RUNG SAFE, and it is the whole reason this file
// is shaped the way it is:
//
//   A COUNT IS A FLOOR, NEVER AN OCCUPANCY.
//
// Three khaali passengers tapping on does not mean the bus is a third full, or
// a tenth full, or anything at all about the forty people who were already
// aboard when it arrived. It supports exactly one statement - "at least three
// people got on here" - and that is a LOWER BOUND.
//
// So on a counted rung there is no `load` in the returned object at all. Not a
// small number, not a cautious number: null. `unit` says 'people'. The band can
// only be raised by a count and never lowered, and never into green, because
// green is a claim that a stretch is clear and a floor cannot support a claim.
// A reader who wanted to render a percentage from a counted rung would find
// there is no percentage in it to render.
//
// The other thing this file is careful about: the demo model is NOT
// capacity.busLoadAt, which is a straight ramp on boarding position. That ramp
// says every bus on every route is fullest at its last stop, identically, at
// three in the morning and at nine. Colouring a map with it would look like a
// measurement and be an artifact of a multiplication, which is the one thing
// the owner asked this not to be.

import { VEHICLE } from './capacity.mjs';
import * as load from './load.mjs';

export const RUNGS = ['counted', 'declared', 'modelled', 'unknown'];

/**
 * Below this a count is not published, and the object carries no number at all
 * - not even `floor: 2`. Two taps on a stretch describes two people. The same
 * constant and the same argument as demand.FLOOR.
 */
export const FLOOR = 3;

/** How long a tap still says something about the bus that is there now. */
export const WINDOW_MIN = 30;

/**
 * The demo model, in one table so it can be argued with in one place.
 *
 * Every number here was typed by a person. None of it is a measurement and the
 * output says so on every reading it produces.
 */
export const MODEL = {
  // Where along the route a bus is fullest. Not the last stop - a radial route
  // fills on the way in and empties at the end of it, and the ramp khaali used
  // to use had every bus at its worst as it pulled into the terminus.
  peakAt: 0.58,
  spreadAlong: 0.42,
  // The day, on its own curve. Deliberately NOT traffic.CURVE, which is a road
  // SPEED multiplier - reusing it would say a bus is empty at three in the
  // morning because the road is fast, which is a coincidence and not a
  // mechanism.
  hour: [0.06, 0.04, 0.03, 0.04, 0.10, 0.26, 0.52, 0.78, 0.94, 0.88, 0.66, 0.55,
    0.52, 0.54, 0.58, 0.66, 0.78, 0.92, 0.95, 0.82, 0.62, 0.42, 0.24, 0.12],
  // Which way the city is going. Mornings run in, evenings run out.
  tide: 0.22,
  // How much one route differs from the next, from its own name rather than
  // from a random number generator - so the same route reads the same on every
  // machine and the map does not shimmer between two identical requests.
  spread: 0.15,
  ceiling: 0.97,
};

const clamp01 = x => Math.max(0, Math.min(1, x));

/** FNV-1a. A hash, not a seed: no state, no ordering, same answer everywhere. */
export function hashOf(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967295;
}

/**
 * Taps, arranged so a segment can ask about itself.
 *
 * Pure: it is handed the rides rather than reading the journal, the way
 * demand.needFor is handed directBus. `rides` is
 * `[{ route, from, to, at, who }]` - which is exactly the shape a passride
 * journal record joined to its pass leg already has.
 */
export function indexScans(rides, { now = Date.now(), windowMin = WINDOW_MIN } = {}) {
  const since = now - windowMin * 60000;
  const by = new Map();
  for (const r of rides || []) {
    if (!r || !r.route || !r.from || r.at == null || r.at < since) continue;
    const key = r.route + '|' + r.from + '|' + (r.to || '');
    let e = by.get(key);
    if (!e) { e = { route: r.route, from: r.from, to: r.to || null, taps: 0, who: new Set() }; by.set(key, e); }
    e.taps++;
    if (r.who) e.who.add(r.who);
  }
  // people, not records: one person re-scanning is one person
  for (const e of by.values()) e.people = e.who.size || e.taps;
  return { by, now, windowMin };
}

const scanFor = (index, seg) => {
  if (!index || !index.by || !seg) return null;
  return index.by.get(seg.routeName + '|' + seg.fromStop + '|' + (seg.toStop || ''))
    || index.by.get(seg.routeName + '|' + seg.fromStop + '|')
    || null;
};

/**
 * The demo model's own number for one segment at one minute.
 *
 * Four declared terms, no randomness, no state. Change any one of the route,
 * the position along it, the hour or the direction and the answer moves - which
 * is the property a test asserts, because a model that has quietly collapsed to
 * a constant is exactly what the old boarding ramp was.
 */
export function modelLoad({ routeId, segIdx = 0, nSegs = 1, minute = 0, dir = 0 } = {}) {
  const along = nSegs > 1 ? segIdx / (nSegs - 1) : 0.5;
  // a hump along the route rather than a ramp to the end of it
  const shape = Math.exp(-((along - MODEL.peakAt) ** 2) / (2 * MODEL.spreadAlong ** 2));
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440;
  const h = m / 60;
  const lo = MODEL.hour[Math.floor(h) % 24], hi = MODEL.hour[(Math.floor(h) + 1) % 24];
  const hour = lo + (hi - lo) * (h - Math.floor(h));
  // inbound is heavy in the morning and light in the evening; outbound the
  // other way about. `dir` is 0 or 1 and is why direction has to be an argument.
  const morning = m < 12 * 60;
  const tide = 1 + ((dir === 0) === morning ? MODEL.tide : -MODEL.tide);
  const jitter = (hashOf(routeId) - 0.5) * 2 * MODEL.spread;
  return clamp01(Math.min(MODEL.ceiling, shape * hour * tide + jitter));
}

/**
 * What khaali thinks is on this bus, and on which rung it thinks it.
 *
 * `seg` is { routeId, routeName, segIdx, nSegs, dir, fromStop, toStop }.
 * `scans` is an indexScans() result, `feed` an operator adapter or null.
 * Everything is injected; this module reads no file and imports no data.
 */
export function reading(seg, { scans = null, feed = null, minute = 0, weekday = true } = {}) {
  const base = { load: null, floor: null, ceiling: null, unit: 'fraction',
    atLeast: false, demo: false, rung: 'unknown', quality: 'unknown',
    band: load.bandOf(null, 'unknown', 'bus'), source: '', says: '' };
  if (!seg || !seg.routeId) return { ...base, source: 'no route here' };

  // ---- an operator told khaali. Nobody has; providers.mjs explains why. ----
  if (feed && typeof feed.loadFor === 'function') {
    let r = null;
    try { r = feed.loadFor(seg, minute); } catch { r = null; }
    if (r && r.load != null) {
      const b = load.bandOf(clamp01(r.load), 'exact', 'bus');
      return { ...base, load: b.load, unit: 'fraction', rung: 'declared', quality: 'exact',
        band: b, source: r.source || 'reported by the operator',
        says: 'The operator reports this stretch around ' + Math.round(b.load * 100) + '% full.' };
    }
  }

  // ---- somebody counted people through a door ----
  const hit = scanFor(scans, seg);
  if (hit && hit.people >= FLOOR) {
    const n = hit.people;
    // The only arithmetic a count supports: a lower bound on the fraction. It
    // may raise the band and can never lower it, and never into green.
    const b = load.bandAtLeast(load.bandOf(null, 'unknown', 'bus'),
      n / VEHICLE.bus.crush, 'counted', 'bus');
    return { ...base,
      // deliberately null. There is no percentage in a counted rung to render.
      load: null, floor: n, unit: 'people',
      atLeast: b.atLeast, rung: 'counted', quality: 'counted', band: b,
      source: n + ' tickets scanned on this stretch in the last '
        + (scans.windowMin || WINDOW_MIN) + ' minutes',
      says: 'At least ' + n + ' people boarded here in the last half hour. khaali '
        + 'counted its own tickets; it does not know who else is aboard.' };
  }

  // ---- khaali's demo model ----
  const l = modelLoad({ routeId: seg.routeId, segIdx: seg.segIdx, nSegs: seg.nSegs,
    minute, dir: seg.dir });
  const b = load.bandOf(weekday ? l : l * 0.7, 'simulated', 'bus');
  return { ...base, load: b.load, unit: 'fraction', rung: 'modelled',
    quality: 'simulated', demo: true, band: b,
    source: 'khaali’s demo load model for this route, hour and direction',
    says: 'khaali’s demo model puts this stretch around '
      + Math.round(b.load * 100) + '% full at this hour. Nobody has weighed it.' };
}

/** One line about a reading, in the words the map uses. */
export function says(r) { return r ? r.says : ''; }
