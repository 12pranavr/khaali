// ---------------------------------------------------------------------------
// A driver says they will be somewhere.
//
// demand.mjs counts the people who will walk out of Whitefield at 08:40 with
// nowhere to go. This counts the other side: drivers who have said, in advance,
// that they expect to be around that place in that half hour. Between the two
// there is a number worth having, and until now khaali had only one of them.
//
// A COMMITMENT IS NOT AN OFFER, and the difference is the whole design.
//
//   An offer is one journey somebody paid for. It is addressed to whoever takes
//   it first and it BINDS the driver who accepts - they said they would come,
//   and a passenger is waiting on that.
//
//   A commitment is a driver's statement about a place and a half hour. It is
//   addressed to nobody. It binds nothing. A driver who said yes to Whitefield
//   may take a ride in Hebbal instead and khaali will not stop them, will not
//   penalise them, and will not tell anybody they were expected.
//
// So a commitment never touches dispatch.accept and never blocks a ride. What
// it does is let khaali say "six drivers expect to be here" instead of nothing,
// and - once enough of them have closed - how many of the last fifty who said
// that actually were.
//
//                 ┌── withdrawn   they said no before the window ended
//   live ─────────┼── kept        seen near it, or served a ride from it
//                 ├── missed      shared their position, never near, served nothing
//                 └── lapsed      shared nothing and served nothing
//
// `lapsed` is the one that keeps this honest, and it exists because of a
// mistake that is easy to make and hard to see. A driver who declines to share
// their position and happens not to get a ride has told khaali nothing about
// whether they turned up. Counting that as a miss would manufacture a low
// kept-rate out of a privacy choice - it would make the number worse for
// exactly the drivers who exercised the option, and it would make the option
// look like it costs them something. So `lapsed` is in neither the numerator
// nor the denominator. It is reported on its own: khaali could not see.
//
// Every transition guards on `outcome === null` and returns { ok:false, reason }
// rather than overwriting - the discipline dispatch.accept and tatkal.settle
// both run on.

// The one import, and it is arithmetic: the same half-hour grid demand.mjs
// buckets people into. A commitment to 08:37 would be a commitment to nothing.
import { windowOf, KEEP_MIN } from './demand.mjs';

/** A driver may only commit to a window khaali is willing to publish demand
    for. Deliberately KEEP_MIN: no promising into the dark, and no window with
    drivers in it that has no people in it. */
export const AHEAD_MAX = KEEP_MIN;

export const OUTCOMES = ['kept', 'missed', 'withdrawn', 'lapsed'];
export const RUNGS = ['said-yes', 'moving-toward', 'nearby', 'available', 'served'];

/** Past this a position tells you where somebody was, not where they are. It
    expires BEFORE the sweep deletes it, so a stale fix can never hold a rung
    up in the half minute between the window ending and the record closing. */
export const FIX_STALE_MS = 10 * 60 * 1000;

/** Near enough to serve the place. */
export const NEAR_KM = 1.5;

/** Closer than when they said yes, by enough that it cannot be the rounding.
    Positions are kept to three decimals - about 110 m - so anything under
    ~0.25 km would fire on noise. */
export const MOVE_KM = 0.3;

/** How coarse a position is allowed to be stored. Three decimals, ~110 m. */
export const FIX_DP = 3;

const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

export const km = (a, b) => {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

/** Which three-hour band of the day a minute falls in. The unit reliability is
    measured in: fine enough that a morning is not averaged with a midnight,
    coarse enough that no cell is one person's Tuesday. */
export const BAND_HOURS = 3;
export const bandOf = m => Math.floor((((Math.floor(m) % 1440) + 1440) % 1440) / 60 / BAND_HOURS);

/**
 * A driver says yes.
 *
 * `share` is their answer to a separate question - whether khaali may use a
 * rounded position while this window is on. Saying no is free: they still
 * count as having said yes, and their commitment closes as `lapsed` rather
 * than as a miss.
 */
export function declare({ id, driver, at, lat, lng, window, ahead = 0, share = false,
                          date = null, seed = false, hotLat = null, hotLng = null },
                        now = Date.now()) {
  if (!id || !driver || !at) return { ok: false, reason: 'incomplete' };
  if (!(window >= 0 && window < 1440)) return { ok: false, reason: 'bad-window' };
  if (ahead > AHEAD_MAX) return { ok: false, reason: 'too-far-ahead' };
  const spot = (hotLat != null && hotLng != null) ? { lat: +hotLat, lng: +hotLng } : null;
  const from = (lat != null && lng != null) ? { lat: +lat, lng: +lng } : null;
  return { ok: true, record: {
    id, driver: String(driver).slice(0, 40), at: String(at).slice(0, 80),
    window: Math.floor(window), band: bandOf(window), date: date || null,
    share: !!share, seed: !!seed,
    // How far away they were when they said it. One number, not a place - it
    // is the other half of 'moving toward', and a path cannot be rebuilt from
    // two distances.
    km0: (spot && from) ? Math.round(km(from, spot) * 10) / 10 : null,
    hotLat: spot ? spot.lat : null, hotLng: spot ? spot.lng : null,
    fix: null, kmNow: null, wasNear: false,
    outcome: null, saidAt: now, closedAt: null,
  } };
}

/**
 * Has the half hour they promised been and gone?
 *
 * Measured window to window, not minute to minute, so a driver who said they
 * would be there for 08:30-09:00 is still committed AT 08:40 rather than being
 * closed the instant the clock passed the first minute of their own window.
 */
export function over(c, nowMin) {
  if (!c) return false;
  const ahead = ((c.window - windowOf(nowMin)) % 1440 + 1440) % 1440;
  return ahead > AHEAD_MAX;              // wrapped past it rather than waiting for it
}

/**
 * A rounded position, while the window is on.
 *
 * Rounded HERE, on the server, not wherever the phone felt like rounding it -
 * the same posture /api/lastmile takes when it decides which side of the count
 * a journey falls on rather than letting the phone pick.
 *
 * Only the latest one is kept. There is no array and there never will be: see
 * the note on sos.mjs in the header of the endpoint.
 */
export function here(c, { lat, lng } = {}, now = Date.now()) {
  if (!c) return { ok: false, reason: 'missing' };
  if (c.outcome) return { ok: false, reason: c.outcome };
  if (!c.share) return { ok: false, reason: 'no-consent' };
  if (!isFinite(+lat) || !isFinite(+lng)) return { ok: false, reason: 'no-position' };
  c.fix = { lat: round(+lat, FIX_DP), lng: round(+lng, FIX_DP), at: now };
  const spot = (c.hotLat != null) ? { lat: c.hotLat, lng: c.hotLng } : null;
  c.kmNow = spot ? Math.round(km(c.fix, spot) * 10) / 10 : null;
  // A boolean, not a place. It is how a kept commitment stays kept after the
  // position has been deleted.
  if (c.kmNow != null && c.kmNow <= NEAR_KM) c.wasNear = true;
  return { ok: true, km: c.kmNow, near: c.wasNear };
}

/** They said no after all. */
export function withdraw(c, now = Date.now()) {
  if (!c) return { ok: false, reason: 'missing' };
  if (c.outcome) return { ok: false, reason: c.outcome };
  c.outcome = 'withdrawn'; c.closedAt = now; c.fix = null;
  return { ok: true, outcome: c.outcome };
}

/**
 * The window is over and this is what happened.
 *
 * Nulls the fix in its own body rather than at the call sites, so that every
 * path which ends a commitment discards the position - including paths added
 * later by somebody who has not read this comment.
 */
export function close(c, outcome, now = Date.now()) {
  if (!c) return { ok: false, reason: 'missing' };
  if (c.outcome) return { ok: false, reason: c.outcome };
  if (!OUTCOMES.includes(outcome)) return { ok: false, reason: 'bad-outcome' };
  c.outcome = outcome; c.closedAt = now; c.fix = null;
  return { ok: true, outcome };
}

/**
 * What became of every window that has ended. Pure - it decides, the caller
 * writes it down.
 *
 * `served` says whether this driver actually took a ride from this place in
 * this window; that is the strongest evidence there is and it outranks
 * everything, including a driver who never shared a position.
 */
export function sweep(list, nowMin, now = Date.now(), served = () => false) {
  const out = [];
  for (const c of list || []) {
    if (!c || c.outcome || !over(c, nowMin)) continue;
    const outcome = (c.wasNear || served(c)) ? 'kept' : c.share ? 'missed' : 'lapsed';
    out.push({ id: c.id, outcome, at: now });
  }
  return out;
}

/**
 * How far along this commitment is - and which of these khaali actually knows.
 *
 * Two of the five rungs never touch a position at all, deliberately.
 * `said-yes` is the record. `available` is whether this driver is holding an
 * accepted ride, which is khaali's own state and exact - a driver standing on
 * the pavement outside the station with a passenger already in the car is
 * `nearby` and is NOT available, and reading that off GPS would have got it
 * exactly backwards.
 */
export function rungOf(c, { now = Date.now(), holding = false, served = false } = {}) {
  if (!c) return null;
  if (served) return { rung: 'served', quality: 'exact', why: 'took a ride from here' };
  const fresh = c.fix && (now - c.fix.at) < FIX_STALE_MS;
  if (fresh && c.kmNow != null && c.kmNow <= NEAR_KM) {
    return holding
      ? { rung: 'nearby', quality: 'estimated', why: 'near, and already on a ride' }
      : { rung: 'available', quality: 'exact', why: 'near, and holding no ride' };
  }
  if (fresh && c.kmNow != null && c.km0 != null && (c.km0 - c.kmNow) >= MOVE_KM)
    return { rung: 'moving-toward', quality: 'estimated', why: 'closer than when they said yes' };
  return { rung: 'said-yes', quality: 'exact', why: 'they said so' };
}

/**
 * What is kept once the window is over: an anonymous outcome.
 *
 * No driver id, no position, and no minute finer than a three-hour band. The
 * history khaali keeps is a table of what happened at places at times of day,
 * which is all the arithmetic needs and is not a record of anybody.
 */
export function forget(c) {
  if (!c || !c.outcome) return null;
  return { at: c.at, band: c.band, outcome: c.outcome, seed: !!c.seed, closedAt: c.closedAt };
}

/** What a driver may see about a commitment - theirs or anybody's. Never a
    position, never another driver's id. */
export function publicOf(c, { forDriver = null } = {}) {
  if (!c) return null;
  return {
    id: c.id, at: c.at, window: c.window, band: c.band,
    mine: !!(forDriver && c.driver === forDriver),
    sharing: !!c.share, outcome: c.outcome,
    saidAt: c.saidAt,
  };
}
