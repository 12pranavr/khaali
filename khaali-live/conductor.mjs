// ---------------------------------------------------------------------------
// What the conductor saw, and what khaali is allowed to conclude from it.
//
// Nobody publishes bus occupancy. What does exist, on every bus in the country,
// is a person with a ticketing machine who knows exactly how many got on, where
// they are going, and roughly how many got off - because they watched. This
// module is that, as a ledger: tickets sold as spans, alightings recorded when
// somebody bothered, and a departure count from a stop when the conductor
// confirms one.
//
// EVERYTHING HERE IS SIMULATED. No operator is connected. The demo generates
// these events and the label never comes off them, because a modelled count
// that reads like a measured one is the single most dangerous thing khaali
// could ship.
//
// THREE NUMBERS, NEVER COLLAPSED INTO ONE
//
//   ticket spans   -> what the tickets say should happen
//   + alightings   -> what somebody actually watched happen
//   + a checkpoint -> the conductor's own total, which outranks both
//
// A ticket to stop 5 removes that passenger at 5 in the baseline. If the
// conductor records that nobody got off at 5, the reconciled count has to
// reflect what was watched, not what the ticket intended. They are labelled
// separately and never added together twice.
//
// THE CHECKPOINT RULE. A correction gives a total without saying who is in it.
// If three more scans arrive afterwards and khaali adds them, twenty becomes
// twenty-three out of nothing. So: every ticket and alighting event for a stop
// is processed before the conductor confirms that stop's departure count; the
// confirmation is that stop's final word, and it carries the sequence number it
// covers. An event that turns up afterwards for a closed checkpoint does not get
// quietly added - it marks the whole profile NEEDS_RECONCILIATION and khaali
// stops making recommendations from it.
//
// AND UNKNOWN DESTINATIONS STAY UNKNOWN. When a conductor's total is higher than
// the tickets account for, the surplus is real people whose destination khaali
// was never told. It does not invent one. They are carried as an uncertain
// cohort riding to the end of the pattern - which is the conservative direction,
// because it can only make a bus look fuller than it is, never emptier - and the
// assumption is disclosed in the profile rather than buried in the number.

import * as trip from './trip.mjs';

export const KINDS = ['bustrip', 'ticket', 'alight', 'onboard'];
export const STATUS = ['OK', 'DATA_INCONSISTENT', 'NEEDS_RECONCILIATION', 'NO_TRIP'];

/** The exit assumption khaali applies to people it was never told about. */
export const UNKNOWN_EXIT = 'rides to the end of the route';

let SEQ = 0;
/** Append order. Only ever increases, and only this module hands them out. */
export const nextSeq = () => ++SEQ;
export const seqAt = () => SEQ;
export const seenSeq = n => { if (Number(n) > SEQ) SEQ = Number(n); };

const bad = (m, code = 'CONDUCTOR') => { const e = new Error(m); e.code = code; throw e; };

/**
 * One event. `id` is the caller's, and it is what makes a retry a no-op: the
 * same id twice is the same event, not two boardings.
 */
export function event(e = {}) {
  if (!KINDS.includes(e.kind)) bad('unknown event kind: ' + e.kind);
  if (!e.id) bad('every event needs an id, or a retry becomes a second boarding');
  if (!e.tripInstanceId) bad('an event belongs to a departure, not a route');
  const out = { kind: e.kind, id: String(e.id), tripInstanceId: String(e.tripInstanceId),
    seq: e.seq != null ? Number(e.seq) : nextSeq(),
    at: e.at || Date.now(), sourceKind: e.sourceKind || 'simulation' };
  seenSeq(out.seq);
  if (e.kind === 'bustrip') {
    out.stopCount = Number(e.stopCount);
    if (!Number.isInteger(out.stopCount) || out.stopCount < 2) bad('a pattern has at least two stops');
    out.capacity = trip.capacityOf(e.capacity || {});
    out.stopSequence = 0;
    out.names = Array.isArray(e.names) ? e.names.slice(0, out.stopCount) : null;
    return out;
  }
  out.stopSequence = Number(e.stopSequence);
  if (!Number.isInteger(out.stopSequence) || out.stopSequence < 0) bad('stopSequence must be a stop index');
  if (e.kind === 'ticket') {
    out.span = trip.span({ fromStopSequence: out.stopSequence,
      toStopSequence: e.toStopSequence, pax: e.pax == null ? 1 : e.pax, id: out.id, kind: 'ticket' });
    return out;
  }
  // alight and onboard are both counts at a stop; a count is never negative and
  // zero is a real observation, not a missing one
  out.count = Number(e.count);
  if (!Number.isInteger(out.count) || out.count < 0) bad('a count is a whole number of people, got ' + e.count);
  if (e.kind === 'onboard') out.coversEventsThroughSeq = e.coversEventsThroughSeq != null
    ? Number(e.coversEventsThroughSeq) : out.seq;
  return out;
}

/**
 * Order, and only one of each.
 *
 * By (stopSequence, seq, id) so a shuffled feed produces the same profile as a
 * sorted one - which matters because a journal replay is not the order things
 * were entered in. The first event with a given id wins; the rest are retries.
 */
export function ordered(events) {
  const seen = new Set(), out = [];
  (events || []).forEach(e => { if (!seen.has(e.id)) { seen.add(e.id); out.push(e); } });
  return out.sort((a, b) => (a.stopSequence - b.stopSequence)
    || (a.seq - b.seq) || String(a.id).localeCompare(String(b.id)));
}

/**
 * The profile of one departure: how many are aboard on each stretch, what that
 * rests on, and whether khaali may use it at all.
 *
 *   exit[i]    = confirmed[i] != null ? confirmed[i] : expected[i]
 *   onboard[i] = onboard[i-1] + board[i] - exit[i]
 *
 * with a checkpoint at i overriding onboard[i] outright, because the person on
 * the bus counting heads outranks the tickets.
 */
export function profile(events, { tripInstanceId = null } = {}) {
  const evs = ordered((events || []).filter(e =>
    !tripInstanceId || e.tripInstanceId === tripInstanceId));
  const head = evs.find(e => e.kind === 'bustrip');
  if (!head) {
    return { status: 'NO_TRIP', codes: ['NO_TRIP'], usable: false, quality: 'unknown',
      says: 'khaali has no record of this departure running at all.' };
  }
  const stops = head.stopCount, n = trip.stretchCount(stops);
  const codes = [];

  const tickets = evs.filter(e => e.kind === 'ticket').map(e => e.span);
  const board = trip.boardings(tickets, stops);
  const expected = trip.alightings(tickets, stops);

  const confirmed = new Array(stops).fill(null);
  evs.filter(e => e.kind === 'alight').forEach(e => { confirmed[e.stopSequence] = e.count; });

  const checkpoint = new Array(stops).fill(null);
  evs.filter(e => e.kind === 'onboard').forEach(e => {
    checkpoint[e.stopSequence] = { count: e.count, covers: e.coversEventsThroughSeq, id: e.id };
  });

  // an event that arrived after its stop's checkpoint closed is not extra
  // ridership - it is a disagreement, and khaali says so instead of adding it
  let reconcile = null;
  evs.forEach(e => {
    if (e.kind === 'onboard' || e.kind === 'bustrip') return;
    // any checkpoint at or beyond this event's stop should have counted it; if
    // the event's sequence is past what that checkpoint covers, it did not
    for (let j = e.stopSequence; j < stops && !reconcile; j++) {
      const cp = checkpoint[j];
      if (cp && e.seq > cp.covers) {
        reconcile = { stopSequence: j, eventStop: e.stopSequence, eventId: e.id,
          seq: e.seq, covers: cp.covers };
      }
    }
  });

  const onboard = new Array(stops).fill(0);
  const uncertain = new Array(stops).fill(0);
  const exit = new Array(stops).fill(0);
  let inconsistent = null, running = 0, carried = 0;
  for (let i = 0; i < stops; i++) {
    exit[i] = confirmed[i] != null ? confirmed[i] : expected[i];
    // people khaali was never told about leave when the route does
    if (i === stops - 1) exit[i] += carried;
    let v = running + board[i] - exit[i];
    if (v < 0) {
      // shown as zero, and unusable. A clamped number is not evidence the data
      // was valid - it is the reason to stop trusting this departure.
      inconsistent = inconsistent || { stopSequence: i, raw: v };
      v = 0;
    }
    if (checkpoint[i]) {
      const surplus = checkpoint[i].count - v;
      if (surplus > 0) { uncertain[i] = surplus; carried += surplus; }
      v = checkpoint[i].count;
    }
    onboard[i] = v;
    running = v;
  }

  // the stretch after stop i carries whoever was aboard when it left stop i
  const stretch = new Array(n).fill(0);
  for (let k = 0; k < n; k++) stretch[k] = onboard[k];

  if (inconsistent) codes.push('DATA_INCONSISTENT');
  if (reconcile) codes.push('NEEDS_RECONCILIATION');
  const status = inconsistent ? 'DATA_INCONSISTENT' : reconcile ? 'NEEDS_RECONCILIATION' : 'OK';

  const sourceKinds = new Set(evs.map(e => e.sourceKind || 'simulation'));
  const quality = sourceKinds.size === 1 && sourceKinds.has('production') ? 'counted' : 'simulated';
  const carriedTotal = uncertain.reduce((a, b) => a + b, 0);

  return {
    tripInstanceId: head.tripInstanceId,
    stopCount: stops, stretchCount: n, names: head.names,
    capacity: head.capacity,
    board, expectedExit: expected, confirmedExit: confirmed,
    exit, onboard, stretch, uncertain,
    checkpoints: checkpoint.map((c, i) => c && { stopSequence: i, ...c }).filter(Boolean),
    status, codes,
    usable: status === 'OK',
    inconsistentAt: inconsistent, reconcileAt: reconcile,
    quality,
    // when this picture was taken, so a planner can refuse to plan on an old one
    generatedAt: evs.reduce((a, e) => Math.max(a, e.at || 0), 0) || null,
    uncertainTotal: carriedTotal,
    exitAssumption: carriedTotal ? UNKNOWN_EXIT : null,
    eventCount: evs.length,
    says: saysOf(status, quality, carriedTotal, inconsistent, reconcile),
  };
}

function saysOf(status, quality, carried, inconsistent, reconcile) {
  if (status === 'DATA_INCONSISTENT')
    return 'More people got off at stop ' + inconsistent.stopSequence
      + ' than khaali ever counted aboard, so it cannot say how full this bus is.';
  if (status === 'NEEDS_RECONCILIATION')
    return 'A ticket for stop ' + reconcile.eventStop + ' arrived after the conductor had '
      + 'already confirmed stop ' + reconcile.stopSequence + ', so the two do not agree yet.';
  const base = quality === 'counted'
    ? 'Counted from the conductor’s own ticketing.'
    : 'From khaali’s demo conductor. No operator is connected, and no number here was measured.';
  return carried
    ? base + ' ' + carried + ' aboard were never ticketed through khaali, so it assumes each of them '
      + UNKNOWN_EXIT + '.'
    : base;
}

/**
 * The worst stretch of the ones she would actually ride.
 *
 * Not the stop she boards at. She gets on at stop 2 of 43, at the empty end of
 * the route, and the number that matters is the one through town.
 */
export function overSpan(prof, fromStopSequence, toStopSequence) {
  if (!prof || !prof.usable) return null;
  const w = trip.worstOver(prof.stretch, fromStopSequence, toStopSequence);
  if (!w) return null;
  const cap = prof.capacity && prof.capacity.boardingCapacity;
  return { ...w, capacity: cap,
    occupancy: cap ? w.value / cap : null,
    quality: prof.quality,
    uncertain: prof.uncertainTotal };
}
