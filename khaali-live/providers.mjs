// ---------------------------------------------------------------------------
// Where another operator would plug in, and the reason none has.
//
// khaali prices the last mile from published tariffs and carries the offer to
// whoever is looking at its own demand page. It is not connected to ONDC, to
// Ola, to Uber, to Rapido or to Namma Yatri, and PROVIDERS below is empty on
// purpose.
//
// WHAT A REAL INTEGRATION WOULD NEED, so that nobody reads this file as though
// it were nearly done: that operator's official API, credentials and a
// commercial partnership; their booking flow, which is theirs and not this
// one; their live pricing and availability, which they publish to partners and
// not to anybody who asks; and the permissions that apply to each of those,
// including whatever their terms say about showing their prices next to
// somebody else's. khaali has none of it.
//
// What this file IS: the shape such an adapter would have to fit, so the
// journey, demand, supply and allocation code above it never has to be
// rewritten when one arrives. It is a seam, and it is empty, and the test for
// this design is that the whole system works with nothing registered against
// it - which it does, because everything khaali shows is its own.
//
// FOUR RULES, and the seam stops being honest the moment one is dropped.
//
//   1. Every number a provider returns keeps that provider's name and their
//      own `quality` from capacity.QUALITY on it. khaali never relabels
//      somebody else's estimate as its own measurement.
//
//   2. An empty result means NULL, not zero. "khaali does not know what other
//      operators have out there" and "there are none" are different sentences
//      and the second one is a lie. capacity.mjs:15, same rule as everywhere.
//
//   3. Provider counts never join `said`, `supplyFloor` or `expected`. Those
//      are counts of people who used khaali. A third party's fleet number
//      mixed into them would make the gap unfalsifiable.
//
//   4. No provider writes to DEMAND, OFFERS, COMMITS or the journal. It
//      answers questions; it does not get to change what khaali knows.

import { QUALITY } from './capacity.mjs';

/**
 * @typedef {Object} Provider
 * @property {string}   id            short, stable, lowercase
 * @property {string}   name          what a passenger would recognise
 * @property {string}   source        one line naming where their numbers come from
 * @property {(q:{lat:number,lng:number,when:number,radiusKm:number}) =>
 *            Promise<{count:number, quality:string, source:string, at:number}|null>} availabilityAt
 * @property {(q:{fromLat,fromLng,toLat,toLng,km,pax}) =>
 *            Promise<{min:number, max:number, currency:string, quality:string, source:string}|null>} quote
 * @property {(offer:object) =>
 *            Promise<{accepted:true, ref:string, source:string}|{accepted:false, reason:string}>} offer
 * @property {(ref:string) => Promise<{stage:string, source:string}|null>} status
 */

/** Deliberately empty. See the head of this file. */
export const PROVIDERS = [];

const NEEDED = ['availabilityAt', 'quote', 'offer', 'status'];

/**
 * Add an adapter. Refuses a partial one outright: half a provider is worse
 * than none, because the half that is missing is discovered by a passenger.
 */
export function register(p) {
  if (!p || !p.id || !p.name || !p.source) return { ok: false, reason: 'incomplete' };
  const missing = NEEDED.filter(k => typeof p[k] !== 'function');
  if (missing.length) return { ok: false, reason: 'missing:' + missing.join(',') };
  if (PROVIDERS.some(x => x.id === p.id)) return { ok: false, reason: 'already' };
  PROVIDERS.push(p);
  return { ok: true, id: p.id };
}

export function forget(id) {
  const i = PROVIDERS.findIndex(p => p.id === id);
  if (i < 0) return { ok: false, reason: 'missing' };
  PROVIDERS.splice(i, 1);
  return { ok: true };
}

const ok = (r) => r && QUALITY.includes(r.quality);

/**
 * What other operators say they have near a place. `[]` means khaali did not
 * ask anybody, because there is nobody to ask - which is NOT the same as zero
 * and must never be rendered as one.
 */
export async function availability(q) {
  if (!PROVIDERS.length) return [];
  const out = await Promise.all(PROVIDERS.map(async p => {
    // A provider that is down, slow or wrong is a provider khaali does not
    // hear from. It is never a reason to show a number khaali made up.
    try {
      const r = await p.availabilityAt(q);
      return ok(r) ? { provider: p.id, name: p.name, count: r.count,
        quality: r.quality, source: r.source || p.source, at: r.at || Date.now() } : null;
    } catch { return null; }
  }));
  return out.filter(Boolean);
}

/** What they would charge. Same rules: their name on it, or it is not shown. */
export async function quotes(q) {
  if (!PROVIDERS.length) return [];
  const out = await Promise.all(PROVIDERS.map(async p => {
    try {
      const r = await p.quote(q);
      return ok(r) ? { provider: p.id, name: p.name, min: r.min, max: r.max,
        currency: r.currency || 'INR', quality: r.quality, source: r.source || p.source } : null;
    } catch { return null; }
  }));
  return out.filter(Boolean);
}

/** What khaali says about all this, in one sentence, wherever it comes up. */
export const NONE_CONNECTED = 'No other operator is connected to khaali. Everything here is '
  + 'khaali’s own record and its own published-tariff estimate.';
