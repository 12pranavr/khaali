// ---------------------------------------------------------------------------
// Whether a change is a change a person could actually make.
//
// khaali has never had this number. `busThenTrain` sets `ready = arrive + w` and
// then asks for trains departing at or after `ready`; `train+metro` plans the
// metro from `t.arr`; `train+bus` asks for the next bus from `t.arr`; and
// `/api/custom` carries the clock forward with `at = pick.arr`. Every one of
// them connects at ZERO SLACK, so khaali will happily offer a train that leaves
// the same minute the bus lands. Nobody can make that change, and being offered
// it is worse than being told there is nothing - because she books it.
//
// WHAT THIS DOES NOT DO. It removes connections that fall below a configured
// threshold. It does not promise that a connection above the threshold will
// succeed: the bus can still be late, and khaali does not watch buses. The
// honest claim is "khaali stops offering connections that fail its transfer
// checks", and nothing in this file says more than that.
//
// The equation, with every term named rather than rolled into one constant:
//
//     gap    = outbound departure - inbound arrival        (what she has)
//     access = walk x perWalkMin + stationEntry            (getting across)
//     wait   = gap - access                                (standing there)
//     need   = boarding + uncertainty                      (what she needs)
//
//     feasible  <=>  need <= wait <= maxWait
//
// `maxWait` is measured on the WAIT, after walking and station access - not on
// the whole gap. Those are different numbers, and conflating them would reject a
// long walk as though it were loitering.

/**
 * Configurable demo assumptions. Every one of these was typed by a person; none
 * is measured. They are the policy khaali applies, not a fact about Bengaluru,
 * and the module says so wherever they surface.
 */
export const BUFFER = {
  /** Getting from a bus bay onto a platform, when both are the same place. */
  stationEntry: 3,
  /** Being at the door before it closes, rather than as it does. */
  boarding: 5,
  /** khaali measures walks in minutes; it does not discount them. */
  perWalkMin: 1.0,
  /**
   * A leg whose timetable is declared rather than published (buses.mjs marks
   * these `source:'simulated'`) has a run time and a headway, not an arrival.
   * The extra is the price of that, and a missed connection there costs a whole
   * headway rather than a few minutes.
   */
  unpublished: 20,
  /**
   * How long khaali will ask anybody to stand on an inventory it is not holding
   * for them - and it is not one number, because the services are not one
   * service. A metro runs every four minutes: three quarters of an hour on that
   * platform means something went wrong with the plan. A corridor train runs
   * twice an hour at best: three quarters of an hour is an ordinary connection,
   * and rejecting it would throw away the useful answer to keep a tidy constant.
   */
  maxWait: { train: 90, metro: 30, bus: 45 },
  maxWaitMin: 45,
};

/** Same stop, published inbound: station access plus boarding. Eight minutes. */
export const SAME_STOP = BUFFER.stationEntry + BUFFER.boarding;

export const CODES = ['OK', 'TRANSFER_TOO_TIGHT', 'TRANSFER_TOO_LONG', 'NO_TIMES'];

/**
 * How to get from one vehicle to the next, at one place.
 *
 * A place-name is not an interchange. "Whitefield" covers a railway platform, a
 * bus bay on the road outside, and a metro entrance several hundred metres
 * away, and treating them as one point is how a plan ends up asking somebody to
 * be in two places at once. An edge is the specific pair.
 *
 * `quality` says where the walk came from: `measured` when khaali computed it
 * from two coordinates, `declared` when it is this file's own default.
 */
export function edge({ fromStopId = null, toStopId = null, walkMinutes = 0,
                       stationEntryMinutes = null, accessible = null,
                       source = 'declared', quality = 'declared' } = {}) {
  return {
    fromStopId, toStopId,
    walkMinutes: Math.max(0, Math.round(walkMinutes || 0)),
    stationEntryMinutes: stationEntryMinutes == null ? BUFFER.stationEntry : stationEntryMinutes,
    accessible, source, quality,
  };
}

/**
 * Whether the arriving service had a departure anybody published.
 *
 * Three cases, not two. A train runs to a timetable. A BMTC route has a real
 * run time and a real headway but no published departure - khaali derives the
 * boarding minute from a grid. And the KSRTC route has neither, because
 * Karnataka has never published it, so khaali declared the whole thing.
 */
export const scheduleKindOf = leg => (!leg ? 'fixed'
  : (leg.source === 'simulated' || leg.sourceKind === 'simulation') ? 'declared'
    : (leg.scheduleKind === 'frequency' || leg.departureDerived) ? 'frequency'
      : 'fixed');
const isUnpublished = leg => scheduleKindOf(leg) !== 'fixed';

/**
 * Minutes she needs on the platform, once she has walked there.
 *
 * The uncertainty allowance is sized to what a miss actually costs. Off a fixed
 * departure, nothing beyond boarding. Off a frequency service, about a headway -
 * that is how far the derived grid can be from the bus that turns up, and a
 * fourteen-minute route does not deserve the penalty a thirty-minute one does.
 * Off a service khaali declared outright, the full allowance.
 */
export function requiredFor(inLeg) {
  /* When the arriving leg carries its own uncertainty, spend that instead of
     the heuristic. The headway rule is about not knowing WHEN THE BUS LEAVES,
     and once she is aboard that question is settled - what is left is how far
     the predicted arrival could be out, which a model that costed the traffic
     can state directly. Using a whole headway there would refuse connections
     nobody would think twice about. */
  const own = Number(inLeg && inLeg.uncertaintyMinutes);
  if (Number.isFinite(own) && own >= 0) return BUFFER.boarding + Math.round(own);
  const kind = scheduleKindOf(inLeg);
  if (kind === 'fixed') return BUFFER.boarding;
  const head = Number(inLeg && inLeg.every) || 0;
  const allow = (kind === 'frequency' && head > 0)
    ? Math.min(head, BUFFER.unpublished) : BUFFER.unpublished;
  return BUFFER.boarding + allow;
}

/** Minutes spent getting from one vehicle to the other. */
export function accessFor(edgeOrWalk) {
  const e = (edgeOrWalk && typeof edgeOrWalk === 'object') ? edgeOrWalk : edge({ walkMinutes: edgeOrWalk || 0 });
  return Math.ceil(e.walkMinutes * BUFFER.perWalkMin) + e.stationEntryMinutes;
}

/** The wait khaali will tolerate onto a given kind of service. */
export function maxWaitFor(outLeg) {
  const m = outLeg && (outLeg.mode || outLeg.kind);
  return (m && BUFFER.maxWait[m] != null) ? BUFFER.maxWait[m] : BUFFER.maxWaitMin;
}

const arrOf = leg => leg && (leg.arrMin != null ? leg.arrMin : leg.arrivalEstimate);
const depOf = leg => leg && (leg.depMin != null ? leg.depMin : leg.departureTime);

/**
 * The band of onward departure times that work, so a caller can ask its own
 * enumerator for exactly those rather than generating journeys it will throw
 * away. This is the wiring surface: `trainsBetween(a, b, w.earliest)` and then
 * drop anything past `w.latest`.
 */
export function windowFor(inLeg, edgeOrWalk = 0, outMode = null) {
  const arr = arrOf(inLeg);
  const access = accessFor(edgeOrWalk);
  const need = requiredFor(inLeg);
  const wait = maxWaitFor(outMode ? { mode: outMode } : null);
  if (!(arr >= 0)) return { ok: false, code: 'NO_TIMES', earliest: null, latest: null, access, need };
  return { ok: true, access, need, maxWait: wait,
    earliest: arr + access + need, latest: arr + access + wait,
    unpublished: isUnpublished(inLeg) };
}

/**
 * The whole arithmetic, shown rather than summarised - a caller that wants to
 * explain a refusal needs the terms, not just the verdict.
 */
export function slackOf(inLeg, outLeg, edgeOrWalk = 0) {
  const inArr = arrOf(inLeg), outDep = depOf(outLeg);
  const access = accessFor(edgeOrWalk);
  const need = requiredFor(inLeg);
  const maxWait = maxWaitFor(outLeg);
  if (!(inArr >= 0) || !(outDep >= 0)) {
    return { ok: false, code: 'NO_TIMES', gap: null, access, wait: null, need, maxWait,
      says: 'khaali does not have both times for this change.' };
  }
  const gap = outDep - inArr;
  const wait = gap - access;
  return { gap, access, wait, need, maxWait,
    unpublished: isUnpublished(inLeg),
    ok: wait >= need && wait <= maxWait };
}

/** The verdict, with the sentence khaali may say about it. */
export function feasible(inLeg, outLeg, edgeOrWalk = 0) {
  const s = slackOf(inLeg, outLeg, edgeOrWalk);
  if (s.code === 'NO_TIMES') return s;
  const mins = n => n + ' minute' + (n === 1 ? '' : 's');
  if (s.wait < s.need) {
    return { ...s, ok: false, code: 'TRANSFER_TOO_TIGHT',
      says: s.wait < 0
        ? 'The onward service leaves before this one arrives.'
        : (mins(s.wait) + ' between them, and khaali wants ' + s.need
          + (s.unpublished
            ? ' - this leg runs to a declared headway rather than a published '
              + 'timetable, so a missed connection costs a whole one.'
            : '.')) };
  }
  if (s.wait > s.maxWait) {
    return { ...s, ok: false, code: 'TRANSFER_TOO_LONG',
      says: mins(s.wait) + ' waiting, which is longer than khaali will ask '
        + 'anybody to stand on an inventory it cannot hold for them.' };
  }
  return { ...s, ok: true, code: 'OK',
    says: mins(s.wait) + ' between them'
      + (s.access ? (', after ' + s.access + ' getting across') : '') + '.' };
}

/**
 * The earliest outbound that works, from a list already in departure order.
 * Returns the whole verdict beside it, because a caller offering a fallback has
 * to be able to say why the earlier ones did not do.
 */
export function firstFeasible(inLeg, outLegs, edgeOrWalk = 0) {
  const tried = [];
  for (const out of outLegs || []) {
    const f = feasible(inLeg, out, edgeOrWalk);
    tried.push({ out, code: f.code, wait: f.wait });
    if (f.ok) return { ok: true, out, verdict: f, tried };
  }
  return { ok: false, out: null,
    verdict: { code: tried.length ? tried[tried.length - 1].code : 'NO_TIMES' },
    tried };
}
