// ---------------------------------------------------------------------------
// The ride somebody accepts.
//
// A passenger books the last mile. The offer goes out to whoever is looking at
// the driver page; one of them takes it. Until that moment khaali does not know
// which driver it will be, and it does not choose - it publishes, and the first
// hand on it wins.
//
//   offered ──► accepted ──► arrived ──► done
//      │            │
//      ├─ expired   └─ cancelled
//      └─ cancelled
//
// Accepting is a compare-and-set on `offered`, and every transition below
// refuses to fire from the wrong state rather than overwriting it. That is the
// same discipline tatkal.mjs's settle() uses, and it is what makes the races
// here safe: two drivers tapping at once, a page that retries on a flaky
// signal, an expiry sweep landing on the same millisecond as an accept. The
// second one through always finds the door shut and is told what happened
// instead of being told nothing.
//
// khaali owns no vehicle and employs no driver. What it does here is carry the
// offer and record who took it. Every ride is marked simulated, because it is.

export const STATES = ['offered', 'accepted', 'arriving', 'arrived', 'done', 'cancelled', 'expired'];

/** How long an offer stands before nobody wanted it. */
export const OFFER_MS = 5 * 60 * 1000;

export function newOffer({ id, who, holder, from, to, fromLat, fromLng, toLat, toLng,
                           km, fareMin, fareMax, kinds, pax = 1, pnr = null },
                         now = Date.now()) {
  if (!id || !who || !from || !to) return { ok: false, reason: 'incomplete' };
  if (!(km > 0)) return { ok: false, reason: 'no-distance' };
  return { ok: true, offer: {
    id, who, holder: holder || null, pnr,
    from: String(from).slice(0, 80), to: String(to).slice(0, 80),
    fromLat: fromLat != null ? +fromLat : null, fromLng: fromLng != null ? +fromLng : null,
    toLat: toLat != null ? +toLat : null, toLng: toLng != null ? +toLng : null,
    km: Math.round(km * 10) / 10,
    fareMin: fareMin != null ? Math.round(fareMin) : null,
    fareMax: fareMax != null ? Math.round(fareMax) : null,
    // what a driver could turn up in. khaali does not pick one.
    kinds: Array.isArray(kinds) && kinds.length ? kinds.slice(0, 3) : ['bike', 'auto', 'car'],
    pax: Math.max(1, Math.min(6, Math.floor(pax) || 1)),
    status: 'offered', driver: null,
    offeredAt: now, expiresAt: now + OFFER_MS,
    acceptedAt: null, arrivedAt: null, doneAt: null, endedWhy: null,
  } };
}

/**
 * A driver takes it.
 *
 * The whole race lives in one comparison. Whoever reaches `status === 'offered'`
 * first gets it; everybody after is told `taken` and which driver has it, which
 * is more use to them than a bare failure - they can stop waiting and look at
 * the next one.
 */
export function accept(o, driver, now = Date.now()) {
  if (!o) return { ok: false, reason: 'missing' };
  if (!driver) return { ok: false, reason: 'no-driver' };
  if (o.status === 'offered' && now >= o.expiresAt) {
    o.status = 'expired'; o.endedWhy = 'nobody took it';
    return { ok: false, reason: 'expired' };
  }
  if (o.status !== 'offered') {
    return { ok: false, reason: o.status === 'accepted' ? 'taken' : o.status,
      driver: o.driver, status: o.status };
  }
  o.status = 'accepted'; o.driver = String(driver).slice(0, 40); o.acceptedAt = now;
  return { ok: true, status: o.status, driver: o.driver };
}

/** The driver is at the pickup. Only the driver who took it may say so. */
export function arrived(o, driver, now = Date.now()) {
  if (!o) return { ok: false, reason: 'missing' };
  if (o.status !== 'accepted' && o.status !== 'arriving') return { ok: false, reason: o.status };
  if (o.driver && driver && o.driver !== driver) return { ok: false, reason: 'not-yours' };
  o.status = 'arrived'; o.arrivedAt = now;
  return { ok: true, status: o.status };
}

/** They got there. */
export function done(o, driver, now = Date.now()) {
  if (!o) return { ok: false, reason: 'missing' };
  if (o.status !== 'accepted' && o.status !== 'arriving' && o.status !== 'arrived')
    return { ok: false, reason: o.status };
  if (o.driver && driver && o.driver !== driver) return { ok: false, reason: 'not-yours' };
  o.status = 'done'; o.doneAt = now;
  return { ok: true, status: o.status };
}

/** Either side can call it off, until somebody has arrived for it. */
export function cancel(o, why = 'cancelled', now = Date.now()) {
  if (!o) return { ok: false, reason: 'missing' };
  if (o.status === 'done' || o.status === 'cancelled' || o.status === 'expired')
    return { ok: false, reason: o.status };
  o.status = 'cancelled'; o.endedWhy = why; o.doneAt = now;
  return { ok: true, status: o.status };
}

/** Nobody came. Only an offer still waiting can lapse; one already taken is
    somebody's job now and the clock has no say in it. */
export function expire(o, now = Date.now()) {
  if (!o) return { ok: false, reason: 'missing' };
  if (o.status !== 'offered') return { ok: false, reason: o.status };
  if (now < o.expiresAt) return { ok: false, reason: 'live' };
  o.status = 'expired'; o.endedWhy = 'nobody took it'; o.doneAt = now;
  return { ok: true, status: o.status };
}

/**
 * What a driver may see.
 *
 * The owner's call is that a driver reads the name and where they are going
 * before deciding, the way a demo ride app does. Everything here is therefore
 * deliberate rather than accidental: the pickup, the destination, the holder's
 * name, the distance and the fare range - and no phone number, ever, on either
 * side. The reference code is what a driver and a passenger say to each other.
 */
export function publicOf(o, { forDriver = null } = {}) {
  if (!o) return null;
  const mine = !!(forDriver && o.driver === forDriver);
  return {
    id: o.id, code: o.id.slice(0, 6).toUpperCase(),
    from: o.from, to: o.to, km: o.km, pax: o.pax,
    fareMin: o.fareMin, fareMax: o.fareMax, kinds: o.kinds,
    holder: o.holder, status: o.status,
    mine, taken: o.status !== 'offered',
    offeredAt: o.offeredAt, expiresAt: o.expiresAt,
    msLeft: Math.max(0, o.expiresAt - Date.now()),
    endedWhy: o.endedWhy || null,
    // khaali runs no vehicles. It carried this offer; it did not fulfil it.
    simulated: true,
  };
}
