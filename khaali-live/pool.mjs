// ---------------------------------------------------------------------------
// Three people from the same station going the same way, in one vehicle.
//
// The gap closes two ways. gap.mjs closes it by asking more drivers to come.
// This closes it without asking anybody: forty people needing forty vehicles
// and forty people needing twenty-six are the same demand and a different
// shortage. It is the cheaper lever and it should be pulled first.
//
// THE GUARANTEE, which is the whole ethical content of the feature:
//
//   Nobody ever pays more for being pooled. If the split would leave any rider
//   above what they would have paid alone, splitFare returns null and the pool
//   does not happen. Not "rarely". Not "on average". Never - and it is checked
//   per rider, on the fare khaali actually quoted them, over two hundred
//   generated pairs in the tests.
//
// Sharing a vehicle with a stranger is something a person agrees to or does
// not, so `pool` defaults to false and silence is not consent. An offer whose
// passenger did not tick it is never a merge candidate, however well it fits.
//
// AND THE DESTINATIONS STAY WHERE THEY WERE. Pooling needs to know where
// people are going; the public demand map deliberately does not publish that.
// So this works on OFFERS - which already carry a destination, to one driver,
// at the moment they accept - and nothing it computes ever reaches the map. A
// map of where people leave from is a demand forecast. A map of where they are
// going is a much worse object, and the reason it does not exist is that this
// module was not allowed to create it.

import { windowOf } from './demand.mjs';
import { HIRE, fareFor, allowed } from './hire.mjs';

/** A car, by construction. Four seats is the ceiling on a pool. */
export const POOL_MAX = 3;
export const POOL_SEATS = HIRE.car.seats;

/** Same place, not merely the same name for it. */
export const ORIGIN_KM = 0.4;

/** How far apart two destinations may point, in degrees of bearing. */
export const SPREAD_DEG = 30;

/** And how much further the shared trip may run than the longer of the two
    solo ones. Bearing alone would let a two-kilometre drop pool with a
    twenty-kilometre one: same direction, wildly different journey. */
export const DETOUR_MAX = 1.25;

const R = 6371, rad = Math.PI / 180;

export const km = (a, b) => {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

/** Which way, from here, in degrees clockwise from north. */
export const bearing = (from, to) => {
  const y = Math.sin((to.lng - from.lng) * rad) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad)
    - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos((to.lng - from.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
};

const apart = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const endsOf = o => ({
  from: { lat: o.fromLat, lng: o.fromLng },
  to: { lat: o.toLat, lng: o.toLng },
});

/**
 * Could these two ride together? Says why not, so the reason can be tested
 * rather than inferred from a false.
 */
export function compatible(a, b) {
  if (!a || !b || a === b) return { ok: false, why: 'same' };
  if (a.status !== 'offered' || b.status !== 'offered') return { ok: false, why: 'taken' };
  // Silence is not consent. Neither is a default.
  if (a.pool !== true || b.pool !== true) return { ok: false, why: 'consent' };
  if ((a.riders || [1]).length + (b.riders || [1]).length > POOL_MAX) return { ok: false, why: 'too-many' };

  const A = endsOf(a), B = endsOf(b);
  if (A.from.lat == null || B.from.lat == null || A.to.lat == null || B.to.lat == null)
    return { ok: false, why: 'no-ends' };
  if (a.from !== b.from) return { ok: false, why: 'origin' };
  if (km(A.from, B.from) > ORIGIN_KM) return { ok: false, why: 'origin' };
  if (windowOf(a.pickupMin) !== windowOf(b.pickupMin)) return { ok: false, why: 'window' };

  const pax = (a.pax || 1) + (b.pax || 1);
  if (pax > POOL_SEATS) return { ok: false, why: 'seats' };
  // The existing gate, not a second copy of it - a pool is a car, and hire.mjs
  // is where what a car can and cannot carry is decided.
  const needs = [].concat(a.needs || [], b.needs || []);
  if (!allowed(['car'], { pax, needs }).length) return { ok: false, why: 'needs' };

  if (apart(bearing(A.from, A.to), bearing(B.from, B.to)) > SPREAD_DEG)
    return { ok: false, why: 'direction' };

  // Same direction is not the same journey. The shared trip must not run much
  // further than the longer of the two on its own.
  const solo = Math.max(km(A.from, A.to), km(B.from, B.to));
  const shared = pooledKm([a, b]);
  if (shared > solo * DETOUR_MAX) return { ok: false, why: 'detour' };

  return { ok: true, km: Math.round(shared * 10) / 10, pax };
}

/**
 * How far the shared vehicle actually travels: out to the nearest drop, then
 * on to the next. Nearest-first, which for two or three drops in one direction
 * is the shortest order there is.
 */
export function pooledKm(offers) {
  const list = (offers || []).filter(o => o && o.toLat != null);
  if (!list.length) return 0;
  const from = { lat: list[0].fromLat, lng: list[0].fromLng };
  const drops = list.map(o => ({ lat: o.toLat, lng: o.toLng }));
  let at = from, total = 0;
  const left = drops.slice();
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (km(at, left[i]) < km(at, left[best])) best = i;
    total += km(at, left[best]); at = left.splice(best, 1)[0];
  }
  return total;
}

const round5 = x => Math.round(x / 5) * 5;

/**
 * What each rider pays, and the promise underneath it.
 *
 * The shared trip is priced ONCE, from the published tariff, for the route
 * that actually happens. Each rider's share is their own distance over the
 * total, so somebody dropped first pays for the shorter ride they took.
 *
 * The rounding puts the remainder on the largest share, so the parts sum to
 * the whole exactly and nobody is charged an invented rupee to make the
 * arithmetic close.
 *
 * And then the guarantee: if any rider comes out above what khaali quoted them
 * alone, this returns null and the pool does not happen. That check is the
 * reason the feature is allowed to exist.
 */
export function splitFare(riders, pooled) {
  const list = (riders || []).filter(r => r && r.km > 0);
  if (!list.length || !pooled) return null;
  const total = list.reduce((n, r) => n + r.km, 0);
  if (!(total > 0)) return null;

  const parts = list.map(r => ({ id: r.id, km: r.km, share: r.km / total,
    min: round5(pooled.min * (r.km / total)), max: round5(pooled.max * (r.km / total)) }));

  // the rounding remainder goes to the biggest share, so the parts add up
  const big = parts.reduce((a, b) => (b.share > a.share ? b : a), parts[0]);
  big.min += pooled.min - parts.reduce((n, p) => n + p.min, 0);
  big.max += pooled.max - parts.reduce((n, p) => n + p.max, 0);

  for (const p of parts) {
    const solo = list.find(r => r.id === p.id);
    const alone = solo.fare || fareFor('car', solo.km);
    if (!alone) return null;
    // Never, not rarely and not on average.
    if (p.min > alone.min || p.max > alone.max) return null;
    if (p.min < 0 || p.max < p.min) return null;
    p.aloneMin = alone.min; p.aloneMax = alone.max;
    p.saves = alone.max - p.max;
  }
  return parts;
}

/**
 * Which offers should ride together. Greedy and first-come: the oldest offer
 * anchors a group and later ones join it if they fit, which means a passenger
 * who has been waiting is never displaced by a better match arriving.
 */
export function group(offers, { max = POOL_MAX } = {}) {
  const live = (offers || []).filter(o => o && o.status === 'offered' && o.pool === true)
    .sort((a, b) => a.offeredAt - b.offeredAt);
  const used = new Set();
  const out = [];
  for (const a of live) {
    if (used.has(a.id)) continue;
    const set = [a];
    for (const b of live) {
      if (b === a || used.has(b.id) || set.length >= max) continue;
      if (!set.every(x => compatible(x, b).ok)) continue;
      set.push(b);
    }
    if (set.length < 2) continue;
    set.forEach(x => used.add(x.id));
    out.push(set);
  }
  return out;
}
