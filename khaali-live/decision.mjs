// ---------------------------------------------------------------------------
// What khaali decided, and on what evidence.
//
// /api/plan used to return a ranking and a word: `reasons: ['FASTEST']`. That is
// a score, not a decision. It cannot tell you whether the train's accommodation
// was checked, whether any bus departure was considered, or why the one on the
// card was chosen over the one thirty minutes earlier - and a page cannot
// explain what the server never wrote down.
//
// Three outcomes, and only three:
//
//   KEEP_ROUTE              the rail leg can carry this party over its own span,
//                           so there is nothing to replace. This is the correct
//                           answer most of the time and khaali must not force a
//                           split to look clever.
//   SWAP_PREFIX             the rail leg cannot, and a bus departure to a
//                           rejoining station passes every check.
//   NO_FEASIBLE_CONNECTION  the rail leg cannot, and nothing passes.
//
// THE CHECK RUNS ON THE RAIL LEG, NOT ON THE JOURNEY'S ENDPOINTS. Bangarpet to
// Hebbala is a train to Bengaluru Cantt and then a bus; the span that can be
// full is Bangarpet to Cantt, and Hebbala is nowhere near a corridor station.
// An earlier version gated the whole thing on `fromKind === 'rail' && toKind ===
// 'rail'`, which meant that on every journey ending at a place - which is most
// of them - none of this ran at all.
//
// Reasons are produced by the checks, never written by the page. The passenger
// sentence is generated FROM them, so it cannot drift away from what happened.

export const KINDS = ['KEEP_ROUTE', 'SWAP_PREFIX', 'NO_FEASIBLE_CONNECTION'];

export const REASONS = [
  'DIRECT_TRAIN_BOOKABLE',
  'DIRECT_TRAIN_UNSELLABLE',
  'PREFIX_REPLACEMENT_FEASIBLE',
  'EARLIER_BUS_MISSES_TRANSFER',
  'BUS_SPAN_OVER_PLANNING_LIMIT',
  'BUS_DATA_UNVERIFIED',
  'NO_FEASIBLE_BUS_DEPARTURE',
  'NO_BOUNDARY_WITH_ONWARD_ROOM',
  'RAIL_INVENTORY_UNREADABLE',
  'NO_RAIL_LEG',
];

/** What split.mjs said, in the vocabulary the passenger explanation speaks. */
const FROM_SPLIT = {
  OK: 'PREFIX_REPLACEMENT_FEASIBLE',
  NO_TRIGGER: 'RAIL_INVENTORY_UNREADABLE',
  NO_PINNED_ONWARD: 'NO_BOUNDARY_WITH_ONWARD_ROOM',
  BOUNDARY_NOT_REACHABLE: 'NO_FEASIBLE_BUS_DEPARTURE',
  NO_DEPARTURE_WITH_ROOM: 'NO_FEASIBLE_BUS_DEPARTURE',
  BOARDING_NOT_FEASIBLE: 'BUS_SPAN_OVER_PLANNING_LIMIT',
  SPAN_OVER_PLANNING_LIMIT: 'BUS_SPAN_OVER_PLANNING_LIMIT',
  TRANSFER_TOO_TIGHT: 'EARLIER_BUS_MISSES_TRANSFER',
  TRANSFER_TOO_LONG: 'EARLIER_BUS_MISSES_TRANSFER',
  ONWARD_NOT_BOOKABLE: 'NO_BOUNDARY_WITH_ONWARD_ROOM',
  NO_CLEAR_BENEFIT: 'NO_FEASIBLE_BUS_DEPARTURE',
  BUS_DATA_INCONSISTENT: 'BUS_DATA_UNVERIFIED',
  BUS_RECONCILIATION_REQUIRED: 'BUS_DATA_UNVERIFIED',
  BUS_CAPACITY_UNKNOWN: 'BUS_DATA_UNVERIFIED',
  BUS_DATA_STALE: 'BUS_DATA_UNVERIFIED',
};

/**
 * A journey's identity, so a booking never names one by its position in an
 * array. Two searches a second apart must key the same journey the same way,
 * and re-ranking must not silently move what a `chainId` refers to.
 */
export function chainId(c) {
  if (!c) return null;
  const legs = (c.legs || []).map(l =>
    [l.mode, l.id || l.name || '', l.from || '', l.to || '', l.depMin, l.arrMin].join('~')).join('/');
  return 'ch_' + hash(c.kind + '|' + c.dep + '|' + c.arr + '|' + c.fare + '|' + legs);
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** The rail leg whose span could be unsellable - the one worth checking. */
export function railLegOf(chain) {
  if (!chain || !chain.legs) return null;
  const rails = chain.legs.filter(l => l.mode === 'train' && l.fromIdx != null && l.toIdx != null);
  if (!rails.length) return null;
  // the longest one: if a journey somehow has two, the one that can be full is
  // the one she is on for longest, and V1 does not split a second rail leg
  return rails.reduce((p, l) => (Math.abs(l.toIdx - l.fromIdx) > Math.abs(p.toIdx - p.fromIdx)) ? l : p);
}

export const trainInstanceId = (no, serviceDate) => 'IR|' + no + '|' + serviceDate;

/**
 * The decision.
 *
 * `countsFor` and `findSplit` are injected so this module imports no planner and
 * no store, and so a test can move one input at a time and watch the decision
 * move with it.
 */
export function decide({ chain, pax = 1, date, after = 0, now = Date.now(),
                         countsFor, findSplit = null, ledger = null } = {}) {
  const answer = chain ? { chainId: chainId(chain), kind: chain.kind } : null;
  const leg = railLegOf(chain);
  if (!leg) {
    return { kind: 'KEEP_ROUTE', railCheck: null, chosenBusDeparture: null,
      reasons: ['NO_RAIL_LEG'], answer,
      says: 'There is no train on this way, so there is no berth allocation to check.' };
  }

  const railCheck = {
    trainInstanceId: trainInstanceId(leg.id, date),
    trainNo: String(leg.id), serviceDate: date,
    fromSequence: leg.fromIdx, toSequence: leg.toIdx,
    fromName: leg.from, toName: leg.to,
    partySize: pax, anySeats: null, outcome: null,
  };

  // anySeats, not free. `free` is berths clear the whole way, which is seat
  // hop's question; if khaali can sell the span by packing partial berths then
  // it can sell it, and there is nothing here to replace.
  let anySeats = null;
  try {
    const k = countsFor(String(leg.id), date, 'SL', leg.fromIdx, leg.toIdx);
    anySeats = (k == null || k.anySeats == null) ? null : k.anySeats;
  } catch { anySeats = null; }
  railCheck.anySeats = anySeats;

  if (anySeats == null) {
    railCheck.outcome = 'UNREADABLE';
    return { kind: 'NO_FEASIBLE_CONNECTION', railCheck, chosenBusDeparture: null,
      reasons: ['RAIL_INVENTORY_UNREADABLE'], answer,
      says: 'khaali could not read what is left on this train, so it will not move anybody off it.' };
  }
  if (anySeats >= pax) {
    railCheck.outcome = 'SELLABLE';
    return { kind: 'KEEP_ROUTE', railCheck, chosenBusDeparture: null,
      reasons: ['DIRECT_TRAIN_BOOKABLE'], answer,
      says: sellableSays(anySeats, pax, leg) };
  }

  railCheck.outcome = 'UNSELLABLE';
  const reasons = ['DIRECT_TRAIN_UNSELLABLE'];
  if (!findSplit) {
    return { kind: 'NO_FEASIBLE_CONNECTION', railCheck, chosenBusDeparture: null,
      reasons: reasons.concat(['NO_FEASIBLE_BUS_DEPARTURE']), answer,
      says: unsellableSays(anySeats, pax, leg) + ' khaali has no replacement to offer for it.' };
  }

  const sp = findSplit({ fromIdx: leg.fromIdx, toIdx: leg.toIdx, date, pax, after, now, ledger });
  const mapped = FROM_SPLIT[sp && sp.code] || 'NO_FEASIBLE_BUS_DEPARTURE';

  if (sp && sp.ok) {
    const s = sp.split, bus = s.replacement;
    return {
      kind: 'SWAP_PREFIX', railCheck, split: sp,
      chosenBusDeparture: {
        tripInstanceId: bus.tripInstanceId,
        route: bus.id, name: bus.name,
        boardingStopSequence: bus.fromStopSequence,
        alightingStopSequence: bus.toStopSequence,
        departureTime: bus.depMin, arrivalEstimate: bus.arrMin,
        boardingFeasible: true, spanWithinPlanningLimit: true, transferFeasible: true,
        transferWaitMinutes: s.transfer.wait,
        evidenceLabel: s.busConstraint.evidence.label,
        evidenceBasis: bus.basis,
        rejoinAt: s.onward.stopId, onwardTrain: s.onward.train,
      },
      reasons: reasons.concat(rejectionReasons(sp), ['PREFIX_REPLACEMENT_FEASIBLE']),
      answer,
      says: unsellableSays(anySeats, pax, leg),
    };
  }
  return { kind: 'NO_FEASIBLE_CONNECTION', railCheck, chosenBusDeparture: null, split: sp,
    reasons: reasons.concat(rejectionReasons(sp), [mapped]).filter(uniq), answer,
    says: unsellableSays(anySeats, pax, leg) + ' Nothing khaali checked could replace it.' };
}

const uniq = (v, i, a) => a.indexOf(v) === i;

/** Why the departures khaali did not choose were not chosen. Drawn from the
    trace, so a rejection can never be narrated into existence by the page. */
function rejectionReasons(sp) {
  const out = [];
  ((sp && sp.tried) || []).forEach(t => {
    const r = FROM_SPLIT[t.code];
    if (r && r !== 'PREFIX_REPLACEMENT_FEASIBLE' && !out.includes(r)) out.push(r);
  });
  return out;
}

const nOf = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function sellableSays(n, pax, leg) {
  return 'This train has ' + nOf(n, 'place', 'places') + ' khaali can sell between '
    + leg.from + ' and ' + leg.to + ', which covers your party of ' + pax
    + ', so there is no reason to replace any of it.';
}
function unsellableSays(n, pax, leg) {
  return 'This train has ' + (n === 0 ? 'nothing' : 'only ' + nOf(n, 'place', 'places'))
    + ' khaali can sell between ' + leg.from + ' and ' + leg.to + ', and you need ' + pax + '.';
}

/**
 * The passenger sentence, generated FROM the reasons rather than beside them.
 * Nothing here recomputes availability; if a line is not in the decision it is
 * not said.
 */
export function lines(d) {
  if (!d) return [];
  const has = r => d.reasons.includes(r);
  const out = [d.says];
  if (has('EARLIER_BUS_MISSES_TRANSFER'))
    out.push('An earlier bus departure was rejected because the change onto the train does not work.');
  if (has('BUS_SPAN_OVER_PLANNING_LIMIT'))
    out.push('A bus departure was rejected because it fills past what khaali will plan into '
      + 'before you would be getting off.');
  if (has('BUS_DATA_UNVERIFIED'))
    out.push('A bus departure was set aside because khaali could not determine its planning room. '
      + 'That is not the same as it being full.');
  if (d.kind === 'SWAP_PREFIX' && d.chosenBusDeparture) {
    const b = d.chosenBusDeparture;
    out.push('The ' + b.name + ' leaving at ' + hhmm(b.departureTime)
      + ' passes both capacity checks and connects with ' + nOf(b.transferWaitMinutes, 'minute', 'minutes')
      + ' to spare.');
    out.push('Bus room is ' + b.evidenceLabel + '. No bus seat is reserved.');
  }
  if (has('NO_BOUNDARY_WITH_ONWARD_ROOM'))
    out.push('There is no station on the way where khaali could sell you the rest of the journey either.');
  return out;
}

const hhmm = (m) => {
  if (m == null) return '--:--';
  const d = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(d / 60)).padStart(2, '0') + ':' + String(d % 60).padStart(2, '0');
};
