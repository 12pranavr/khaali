// ---------------------------------------------------------------------------
// Where the network stops, and how many people are about to find that out.
//
// khaali already computes the one thing nobody else on the journey knows: that
// the last stretch has no bus on it. `mile()` in journey.mjs decides it, shows
// it to one passenger, and throws it away. A driver two kilometres from that
// station has no idea eleven people are about to walk out of it with nowhere
// to go.
//
// This counts them. A declaration is one booked journey whose last stretch is
// private; a hotspot is a place and a half hour with enough of them in it.
//
// Two rules the numbers here are held to.
//
// The range is two COUNTS, never a percentage. The floor is the people with no
// bus at all - they have no alternative and they will need somebody. The
// ceiling adds the people who could take a slower bus and might not. So
// "18 to 25" means twenty-five booked, eighteen with nothing else to take, and
// every digit of it can be defended. khaali has no history of who actually
// turned up, and until it does it will not pretend to: the count is exact and
// the turn-up is unknown, in those words.
//
// And a hotspot is never a person. Below FLOOR it is not published at all,
// because two people at a stop at 08:40 is not a statistic, it is two people.

/** Half an hour. Long enough that a driver can act on it, short enough that
    the answer is still true when they arrive. */
export const WINDOW_MIN = 30;

/** Fewer than this and the map says nothing. A count this small describes
    individuals, and a driver cannot act on it anyway. */
export const FLOOR = 3;

/** How long a declaration is worth counting for. A journey booked for a window
    that has passed is not demand, it is history. */
export const KEEP_MIN = 90;

export const NEED = ['no-bus', 'slower-bus'];

/** The half-hour a minute falls in, as the minute it starts. */
export function windowOf(minute) {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440;
  return m - (m % WINDOW_MIN);
}

/** Two words for a window, the way a driver would say it. */
export function windowText(start) {
  const hh = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  return hh(start) + '–' + hh(start + WINDOW_MIN);
}

/**
 * One booked journey that ends in a private last mile.
 *
 * `need` is decided by the server from the two ends, never by the phone - see
 * needFor() below. `seed` marks a record put there to make the demo look
 * alive, and it is carried all the way to the page so a seeded row can say so.
 */
export function declare({ id, who, at, lat, lng, when, km, pax = 1, need, date, seed = false },
                        now = Date.now()) {
  if (!id || !at || !NEED.includes(need)) return { ok: false, reason: 'incomplete' };
  if (!(when >= 0 && when < 2880)) return { ok: false, reason: 'bad-window' };
  const n = Math.max(1, Math.min(6, Math.floor(pax) || 1));
  return { ok: true, record: {
    id, who: who || null, at: String(at).slice(0, 80),
    lat: lat != null ? +lat : null, lng: lng != null ? +lng : null,
    when: Math.floor(when), window: windowOf(when),
    km: km != null ? +km : null, pax: n, need, date: date || null,
    seed: !!seed, atMs: now,
  } };
}

/**
 * Does this stretch have a bus, or does it have nothing?
 *
 * The same question `mile()` asks, asked again on the server so that a phone
 * cannot decide which side of the count it lands on. `directBus` is handed in
 * rather than imported so this module stays pure and the tests do not need
 * four megabytes of BMTC data to run.
 */
export function needFor({ lat, lng, toLat, toLng, when = 0 }, directBus) {
  if (typeof directBus !== 'function') return 'no-bus';
  if (lat == null || lng == null || toLat == null || toLng == null) return 'no-bus';
  let found = [];
  try {
    found = directBus({ fromLat: lat, fromLng: lng, toLat, toLng, after: when, within: 0.7, limit: 1 }) || [];
  } catch (e) { found = []; }
  return found.length ? 'slower-bus' : 'no-bus';
}

const km = (a, b) => {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

/**
 * The map: every place and half hour with enough people in it to publish.
 *
 * `nowMin` is the minute of the day the driver is asking at. Windows already
 * past are dropped - a driver cannot serve them - and windows further out than
 * KEEP_MIN are not shown either, because a driver cannot act on them yet and
 * a count that far ahead has had no chance to be wrong.
 */
export function hotspots(records, { nowMin = 0, near = null, floor = FLOOR, limit = 20 } = {}) {
  const bucket = new Map();
  for (const r of records || []) {
    if (!r || !NEED.includes(r.need)) continue;
    const ahead = ((r.window - windowOf(nowMin)) % 1440 + 1440) % 1440;
    if (ahead > KEEP_MIN) continue;                 // too far out to act on
    const key = r.at + '|' + r.window;
    let b = bucket.get(key);
    if (!b) {
      b = { at: r.at, window: r.window, windowText: windowText(r.window),
        lat: r.lat, lng: r.lng, floor: 0, ceiling: 0, seeded: 0, ahead };
      bucket.set(key, b);
    }
    b.ceiling += r.pax;
    if (r.need === 'no-bus') b.floor += r.pax;
    if (r.seed) b.seeded += r.pax;
    if (b.lat == null && r.lat != null) { b.lat = r.lat; b.lng = r.lng; }
  }

  const out = [];
  for (const b of bucket.values()) {
    // Below the floor a hotspot describes people rather than demand.
    if (b.ceiling < floor) continue;
    const away = near ? km(near, b) : null;
    out.push({
      ...b,
      away: away == null ? null : Math.round(away * 10) / 10,
      seed: b.seeded > 0 && b.seeded === b.ceiling,
      partSeed: b.seeded > 0 && b.seeded < b.ceiling,
      // The count is counted. Whether they turn up is not known, and khaali
      // has no history to guess with - so it says so rather than inventing a
      // number. capacity.mjs's ladder, same words.
      quality: 'exact',
      turnout: 'unknown',
      word: b.ceiling >= 20 ? 'HIGH' : b.ceiling >= 8 ? 'MEDIUM' : 'LOW',
      says: b.floor === b.ceiling
        ? (b.ceiling + ' booked, none of them with a bus to take')
        : (b.ceiling + ' booked, ' + b.floor + ' of them with no bus at all'),
    });
  }

  // soonest first, then the biggest, then nearest - a driver reads down
  out.sort((x, y) => x.ahead - y.ahead || y.ceiling - x.ceiling
    || ((x.away == null ? 1e9 : x.away) - (y.away == null ? 1e9 : y.away)));
  return out.slice(0, Math.max(1, limit));
}

/** Drop what is too old to matter, so the log a page reads stays small. */
export function prune(records, nowMin = 0) {
  return (records || []).filter(r => {
    const ahead = ((r.window - windowOf(nowMin)) % 1440 + 1440) % 1440;
    return ahead <= KEEP_MIN;
  });
}
