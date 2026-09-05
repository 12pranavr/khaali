// ---------------------------------------------------------------------------
// What khaali has promised somebody, and what it is therefore not free to
// promise again.
//
// A claim is khaali's own recorded intention: this party said they would board
// that departure over those stops. It is NOT a prediction that they will board,
// and it is not a seat. Buses are not booked; they are boarded. What the ledger
// protects is the planning room - if khaali has already pointed four people at
// the 08:10, it must not go on telling everybody else the 08:10 is empty.
//
// THE DOUBLE COUNT IS THE WHOLE PROBLEM. A passenger must be counted once per
// calculation and never once as a claim and again as a boarding. So the two
// sides are disjoint by construction:
//
//   the unboarded part of a claim   -> lives here, counted as future demand
//   the boarded part                -> lives in the conductor ledger, as a
//                                      ticket, and this file stops counting it
//
// A party of four with two scanned keeps a claim for TWO. Not four, which would
// double them, and not zero, which would lose the two still on the pavement.
// board() moves the quantity across in one synchronous step, so no reader ever
// observes claim 4 with onboard 2, or claim 2 with onboard 0.
//
// AND A BOOKING MUST NOT SEE ITSELF. Revalidating an existing booking asks the
// same question a second time, and without excludeClaimId khaali would tell her
// that her own booking had made the bus unavailable.

import * as trip from './trip.mjs';
import * as conductor from './conductor.mjs';

/**
 * Whether a claim in this state counts against the room khaali has left to
 * promise. This table is the module.
 */
export const COUNTS = {
  pending: true,      // held for payment, until the hold expires
  confirmed: true,    // paid, not yet aboard
  boarded: false,     // represented in the conductor ledger instead
  expired: false,
  cancelled: false,
  moved: false,       // it counts on the departure she actually accepted
  noshow: false,
};
export const STATES = Object.keys(COUNTS);

/** Why khaali would not put this party on this departure. Two of these mean
    "no room"; the rest mean "khaali cannot tell", which is a different
    sentence and must never be rendered as a full bus. */
export const CODES = ['OK', 'BOARDING_NOT_FEASIBLE', 'SPAN_OVER_PLANNING_LIMIT',
  'BUS_DATA_INCONSISTENT', 'BUS_RECONCILIATION_REQUIRED', 'BUS_CAPACITY_UNKNOWN',
  'BUS_DATA_STALE', 'NO_PROFILE'];

/** The codes that mean khaali could not work it out, rather than no room. */
export const UNDETERMINED = new Set(['BUS_DATA_INCONSISTENT', 'BUS_RECONCILIATION_REQUIRED',
  'BUS_CAPACITY_UNKNOWN', 'BUS_DATA_STALE', 'NO_PROFILE']);

/** How much of the vehicle khaali will plan into. One means "up to what it can
    carry" - a conservative planning check, not a prediction that she would be
    turned away at the door. */
export const PLANNING_FRACTION = 1.0;
/** Beyond this, the profile it was computed from is too old to plan on. */
export const STALE_MS = 15 * 60 * 1000;

const bad = m => { const e = new Error(m); e.code = 'CLAIMS'; throw e; };

export function ledger() { return { byId: new Map(), busy: false }; }

const live = (c, now) => {
  if (c.status === 'pending' && c.holdExpiresAt != null && now >= c.holdExpiresAt) return false;
  return COUNTS[c.status] === true;
};

/** The unboarded quantity - the only part this file is entitled to count. */
export const remaining = c => Math.max(0, c.pax - c.boarded);

/**
 * The spans khaali has already promised on one departure.
 * `excludeClaimId` is not an optimisation; without it a revalidation blames a
 * booking for its own existence.
 */
export function claimSpans(L, tripInstanceId, now = Date.now(), { excludeClaimId = null } = {}) {
  const out = [];
  for (const c of L.byId.values()) {
    if (c.tripInstanceId !== tripInstanceId) continue;
    if (excludeClaimId && c.id === excludeClaimId) continue;
    if (!live(c, now)) continue;
    const n = remaining(c);
    if (n > 0) out.push(trip.span({ fromStopSequence: c.fromStopSequence,
      toStopSequence: c.toStopSequence, pax: n, id: c.id, kind: 'claim' }));
  }
  return out;
}

/**
 * Whether this party fits, and if not, which of the two ways it does not.
 *
 *   boardingFeasible        - can they get on at their own stop
 *   spanWithinPlanningLimit - does the projected load stay inside policy the
 *                             whole way they are aboard
 *
 * Both are required and they fail differently. A bus that fills up after she
 * boards does not stop her riding, so the span check is a planning rule rather
 * than a claim about the door.
 *
 * `extra` carries demand components the caller has modelled separately - the
 * synthetic stream of passengers nobody has told khaali about yet. It is passed
 * in rather than derived here, so the components stay disjoint and countable.
 */
export function roomOver(L, { profile, tripInstanceId, fromStopSequence, toStopSequence,
                              pax = 1, now = Date.now(), excludeClaimId = null,
                              extra = [], staleMs = STALE_MS } = {}) {
  const no = (code, says) => ({ ok: false, code, says, undetermined: UNDETERMINED.has(code) });
  if (!profile) return no('NO_PROFILE', 'khaali has no record of this departure running.');
  if (profile.status === 'DATA_INCONSISTENT')
    return no('BUS_DATA_INCONSISTENT', 'khaali cannot work out how full this bus is, so it will not put you on it.');
  if (profile.status === 'NEEDS_RECONCILIATION')
    return no('BUS_RECONCILIATION_REQUIRED', 'This departure’s ticketing and its conductor do not agree yet.');
  const cap = profile.capacity && profile.capacity.boardingCapacity;
  if (!cap || !profile.capacity.known)
    return no('BUS_CAPACITY_UNKNOWN', 'Nobody has told khaali what this bus can carry.');
  if (profile.generatedAt != null && (now - profile.generatedAt) > staleMs)
    return no('BUS_DATA_STALE', 'khaali’s picture of this departure is too old to plan on.');

  const stops = profile.stopCount;
  const mine = trip.span({ fromStopSequence, toStopSequence, pax });
  const promised = claimSpans(L, tripInstanceId, now, { excludeClaimId });
  const extraSpans = (extra || []).map(s => trip.span(s));
  // three components, added once each: who is aboard now, who khaali has
  // promised, and who it has modelled but not yet heard from
  const known = profile.stretch;
  const projected = trip.loadBySpan(promised.concat(extraSpans), stops);
  const ceiling = Math.floor(cap * PLANNING_FRACTION);

  const at = k => known[k] + projected[k];
  const board = at(fromStopSequence) + pax;
  if (board > cap) {
    return { ...no('BOARDING_NOT_FEASIBLE',
      'This departure is already carrying as many as it can by the time it reaches your stop.'),
      onboardAt: at(fromStopSequence), capacity: cap, need: pax };
  }
  let worst = null;
  for (let k = mine.fromStopSequence; k < mine.toStopSequence && k < known.length; k++) {
    const v = at(k) + pax;
    if (worst == null || v > worst.value) worst = { stretch: k, value: v };
  }
  if (worst && worst.value > ceiling) {
    return { ...no('SPAN_OVER_PLANNING_LIMIT',
      'It fills past what khaali will plan into before you would be getting off.'),
      worst, capacity: cap, ceiling };
  }
  return { ok: true, code: 'OK', undetermined: false,
    capacity: cap, ceiling, worst, onboardAt: at(fromStopSequence),
    headroom: ceiling - (worst ? worst.value : at(fromStopSequence) + pax),
    quality: profile.quality,
    says: 'Room for ' + pax + ' the whole way you are aboard, on '
      + (profile.quality === 'simulated' ? 'khaali’s simulated conductor events.' : 'counted ticketing.') };
}

/**
 * Take the room, or say why not - with no `await` between the two, because the
 * check and the take are one decision. Interleaving is not the risk here;
 * admission control is. Two requests that each find room for the last seat must
 * not both get it.
 */
export function reserve(L, req) {
  if (L.busy) bad('the claim ledger was re-entered; the check and the take must be one step');
  L.busy = true;
  try {
    const room = roomOver(L, req);
    if (!room.ok) return { ok: false, ...room };
    const now = req.now == null ? Date.now() : req.now;
    const id = req.id || ('cl_' + Math.random().toString(36).slice(2, 10));
    if (L.byId.has(id)) bad('claim id already used: ' + id);
    const c = {
      id, who: req.who || null,
      tripInstanceId: req.tripInstanceId,
      fromStopSequence: req.fromStopSequence, toStopSequence: req.toStopSequence,
      pax: req.pax == null ? 1 : req.pax, boarded: 0,
      status: 'pending', createdAt: now,
      holdExpiresAt: req.holdExpiresAt == null ? null : req.holdExpiresAt,
      movedTo: null, endedWhy: null,
    };
    trip.span(c);                       // the same validation every span gets
    L.byId.set(id, c);
    return { ok: true, claim: c, room };
  } finally { L.busy = false; }
}

export const get = (L, id) => L.byId.get(id) || null;

export function confirm(L, id, now = Date.now()) {
  const c = L.byId.get(id) || bad('no such claim: ' + id);
  if (c.status === 'pending' && c.holdExpiresAt != null && now >= c.holdExpiresAt) {
    c.status = 'expired'; c.endedWhy = 'the hold ran out before payment';
    return { ok: false, code: 'HOLD_EXPIRED', claim: c };
  }
  if (c.status !== 'pending') return { ok: false, code: 'NOT_PENDING', claim: c };
  c.status = 'confirmed';
  return { ok: true, claim: c };
}

/**
 * Somebody got on. This is the one visible step: the quantity leaves the claim
 * and arrives in the conductor ledger together, so nothing in between can read
 * a party of four as six people or as two.
 *
 * `emit` is where the ticket event goes. It is called inside the same step, and
 * the event id is derived from the claim so a replayed scan is a no-op there
 * exactly as it is here.
 */
export function board(L, id, n = 1, { now = Date.now(), emit = null, stopSequence = null } = {}) {
  const c = L.byId.get(id) || bad('no such claim: ' + id);
  if (c.status === 'pending') return { ok: false, code: 'PASS_PENDING_PAYMENT', claim: c };
  if (c.status !== 'confirmed') return { ok: false, code: 'NOT_BOARDABLE', claim: c };
  const left = remaining(c);
  if (n < 1 || n > left) return { ok: false, code: 'QUANTITY_UNAVAILABLE', claim: c, remaining: left };
  const from = stopSequence == null ? c.fromStopSequence : stopSequence;
  if (from < c.fromStopSequence || from >= c.toStopSequence)
    return { ok: false, code: 'OUTSIDE_PERMITTED_SPAN', claim: c };
  const ev = emit ? conductor.event({
    kind: 'ticket', id: 'claim:' + c.id + ':' + c.boarded, tripInstanceId: c.tripInstanceId,
    stopSequence: from, toStopSequence: c.toStopSequence, pax: n, at: now }) : null;
  c.boarded += n;                       // the two sides move together, no await
  if (remaining(c) === 0) c.status = 'boarded';
  if (ev) emit(ev);
  return { ok: true, claim: c, remaining: remaining(c), event: ev };
}

export function release(L, id, why = 'cancelled', now = Date.now()) {
  const c = L.byId.get(id) || bad('no such claim: ' + id);
  if (c.status === 'boarded') return { ok: false, code: 'ALREADY_BOARDED', claim: c };
  c.status = why === 'expired' ? 'expired' : why === 'noshow' ? 'noshow' : 'cancelled';
  c.endedWhy = why; c.endedAt = now;
  return { ok: true, claim: c };
}

/**
 * She accepted a later departure. The unboarded quantity moves, so nobody is
 * counted against two buses at once, and the old claim stops counting here
 * rather than being deleted - the record of what was promised is the point.
 */
export function move(L, id, req) {
  const c = L.byId.get(id) || bad('no such claim: ' + id);
  const left = remaining(c);
  if (left < 1) return { ok: false, code: 'NOTHING_TO_MOVE', claim: c };
  const r = reserve(L, { ...req, pax: left, who: c.who });
  if (!r.ok) return r;
  c.status = 'moved'; c.movedTo = r.claim.id; c.endedWhy = 'accepted a later departure';
  return { ok: true, from: c, claim: r.claim };
}

/** Holds do not outlive themselves. Called on a timer and before any read that
    has to be right. */
export function expire(L, now = Date.now()) {
  let n = 0;
  for (const c of L.byId.values()) {
    if (c.status === 'pending' && c.holdExpiresAt != null && now >= c.holdExpiresAt) {
      c.status = 'expired'; c.endedWhy = 'the hold ran out before payment'; c.endedAt = now; n++;
    }
  }
  return n;
}

/** What khaali is currently holding on one departure, for a page to show. */
export function outstanding(L, tripInstanceId, now = Date.now()) {
  let people = 0, parties = 0;
  for (const c of L.byId.values()) {
    if (c.tripInstanceId !== tripInstanceId || !live(c, now)) continue;
    people += remaining(c); parties++;
  }
  return { people, parties };
}
