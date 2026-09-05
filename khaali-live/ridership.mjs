// ---------------------------------------------------------------------------
// Who is aboard each stretch, and who wanted to be.
//
// The other half of the picture, and deliberately in a different file from the
// traffic: a crowded bus and a jammed road are different facts with different
// answers, and a single "badness" number would hide which one khaali is
// reacting to.
//
// FOUR COMPONENTS, DISJOINT BY CONSTRUCTION
//
//   recorded   what a conductor actually ticketed, up to the last checkpoint
//   claimed    khaali's own outstanding intentions, not yet boarded
//   simulated  people the demo invents, only BEYOND what is recorded
//   the party  the person being planned for, counted once, in the check
//
// The overlap that would ruin it is the third double-counting the first: a
// simulated passenger who has since become a recorded boarding. So the
// simulation is silenced at every stop the ledger has already closed, and the
// components carry ids (`sim:`, `claim:`, ledger ids) so a test can prove they
// are disjoint rather than take it on trust.
//
// ATTEMPTED IS NOT ACCEPTED. Ten people at a stop with room for four is four
// boardings and six left behind, not a fifty-seat bus carrying fifty-six. The
// unserved demand is kept, because it is the thing that makes the NEXT
// departure worth looking at.

import * as trip from './trip.mjs';
import * as scenario from './scenario.mjs';
import * as demonet from './demonet.mjs';
import * as load from './load.mjs';

export const SOURCE = 'simulated passenger demand - no operator is connected';

/** How many want to board at a stop, before anyone asks whether they can. */
function attemptedAt(dep, route, k) {
  const st = scenario.state();
  const mid = demonet.seqOf(route, 'MID');
  // a service that never touches the origin runs entirely on the far side of
  // the interchange, so it answers to the downstream demand knob
  const after = (mid >= 0 && k >= mid) || demonet.seqOf(route, 'ORIGIN') < 0;
  const knob = after ? st.demandAfterInterchange : st.demandBeforeBoarding;
  /* A surge clears. Turning the knob up used to multiply EVERY departure of
     every route equally, so the answer went straight from "take the 10:00" to
     "no journey exists" - which is not what a crowd does. A queue that fills
     the 10:00 leaves the 10:20 emptier, and that is the whole reason the next
     departure is worth looking at. */
  const since = Math.max(0, (dep.scheduledDeparture || 0) - st.demoTime);
  const decay = 1 / (1 + since / 25);
  const mult = 1 + (knob - 1) * decay;
  // a shape, not noise: busy at the ends of the run, busiest at the interchange
  const n = route.stops.length;
  const shape = k === 0 ? 0.55 : (mid >= 0 && k === mid) ? 1.0 : k >= n - 2 ? 0.15 : 0.5;
  const cap = demonet.capacityOf(route).boardingCapacity;
  const own = 0.7 + scenario.rand('board', dep.tripInstanceId, k) * 0.6;
  return Math.max(0, Math.round(cap * 0.30 * shape * mult * own));
}

/** Where the people boarding at k are going, as whole cohorts. */
function destinationsFor(dep, route, k, pax) {
  const n = route.stops.length;
  if (pax <= 0 || k >= n - 1) return [];
  const out = [];
  let left = pax;
  for (let j = k + 1; j < n && left > 0; j++) {
    const last = j === n - 1;
    const share = last ? 1 : (0.25 + scenario.rand('dest', dep.tripInstanceId, k, j) * 0.35);
    const take = last ? left : Math.min(left, Math.round(pax * share));
    if (take > 0) { out.push({ to: j, pax: take }); left -= take; }
  }
  return out;
}

/**
 * What khaali believes about one departure, stretch by stretch.
 *
 * `recordedThrough` is the last stop sequence a conductor has closed. At or
 * before it the ledger is the truth and the simulation says nothing; beyond it
 * the simulation is all there is, and it says so.
 */
export function predict(dep, { recordedSpans = [], recordedThrough = -1,
                               claimSpans = [], party = null } = {}) {
  const route = demonet.routeOf(dep.routeId);
  const n = route.stops.length;
  const cap = demonet.capacityOf(route);
  const spans = [];
  const attempted = new Array(n).fill(0);
  const accepted = new Array(n).fill(0);
  const unserved = new Array(n).fill(0);
  const components = { recorded: 0, claimed: 0, simulated: 0 };

  // the ledger first, exactly as recorded
  recordedSpans.forEach(sp => {
    spans.push({ ...sp, kind: 'recorded' });
    components.recorded += sp.pax;
    accepted[sp.fromStopSequence] += sp.pax;
  });
  // khaali's own outstanding promises, once each
  claimSpans.forEach(sp => {
    spans.push({ ...sp, kind: 'claim', id: 'claim:' + (sp.id || '') });
    components.claimed += sp.pax;
  });

  // ...then invention, and only where nothing was recorded
  let onboard = 0;
  const stretch = new Array(n - 1).fill(0);
  const alightAt = new Array(n).fill(0);
  spans.forEach(sp => { alightAt[sp.toStopSequence] += sp.pax; });

  for (let k = 0; k < n; k++) {
    onboard -= alightAt[k];
    if (onboard < 0) onboard = 0;
    if (k > recordedThrough && k < n - 1) {
      const want = attemptedAt(dep, route, k);
      attempted[k] = want;
      const room = Math.max(0, cap.boardingCapacity - onboard - accepted[k]);
      const take = Math.min(want, room);
      unserved[k] = want - take;
      destinationsFor(dep, route, k, take).forEach((d, i) => {
        const sp = trip.span({ fromStopSequence: k, toStopSequence: d.to, pax: d.pax,
          id: 'sim:' + dep.tripInstanceId + ':' + k + ':' + i, kind: 'simulated' });
        spans.push(sp);
        alightAt[d.to] += d.pax;
        components.simulated += d.pax;
      });
      accepted[k] += take;
    } else if (k <= recordedThrough) {
      attempted[k] = accepted[k];             // what happened is what was attempted
    }
    onboard += accepted[k];
    if (k < n - 1) stretch[k] = onboard;
  }

  // the same numbers by the other route, so a disagreement is caught here and
  // not three files away
  const bySpan = trip.loadBySpan(spans, n);

  const bands = stretch.map(v => load.bandOf(cap.boardingCapacity ? v / cap.boardingCapacity : null,
    'simulated', dep.mode === 'metro' ? 'metro' : 'bus'));

  return {
    tripInstanceId: dep.tripInstanceId, mode: dep.mode, stopCount: n,
    capacity: cap, stretch, bySpan, attempted, accepted, unserved,
    spans, components, recordedThrough,
    crowding: stretch.map((v, k) => ({
      fromStopSequence: k, toStopSequence: k + 1,
      predictedPassengers: v, boardingCapacity: cap.boardingCapacity,
      occupancy: cap.boardingCapacity ? v / cap.boardingCapacity : null,
      crowdingBand: bands[k].band, word: bands[k].word,
    })),
    evidence: { sourceKind: scenario.SOURCE_KIND, basis: SOURCE,
      revision: scenario.state().revision, quality: 'simulated' },
    party: party || null,
  };
}

/**
 * Can this party get on where they mean to, and does the load stay inside
 * policy the whole way they are aboard? Two questions, two answers, because a
 * bus that fills after she boards does not stop her riding.
 */
export const PLANNING_CEILING = 1.0;

export function roomFor(pred, fromSeq, toSeq, pax = 1) {
  const cap = pred.capacity.boardingCapacity;
  if (!cap) return { ok: false, code: 'BUS_CAPACITY_UNKNOWN', undetermined: true,
    says: 'Nobody has told khaali what this vehicle can carry.' };
  const atBoarding = pred.stretch[fromSeq];
  if (atBoarding == null) return { ok: false, code: 'BOARDING_NOT_FEASIBLE', undetermined: false,
    says: 'That stop is not on this service.' };
  if (atBoarding + pax > cap) {
    return { ok: false, code: 'BOARDING_NOT_FEASIBLE', undetermined: false,
      onboardAt: atBoarding, capacity: cap, need: pax,
      says: 'This departure is predicted to be at capacity by the time it reaches your stop.' };
  }
  let worst = null;
  for (let k = fromSeq; k < toSeq && k < pred.stretch.length; k++) {
    const v = pred.stretch[k] + pax;
    if (worst == null || v > worst.value) worst = { stretch: k, value: v };
  }
  const ceiling = Math.floor(cap * PLANNING_CEILING);
  if (worst && worst.value > ceiling) {
    return { ok: false, code: 'SPAN_OVER_PLANNING_LIMIT', undetermined: false,
      worst, capacity: cap, ceiling,
      says: 'It is predicted to fill past what khaali will plan into before you would get off.' };
  }
  return { ok: true, code: 'OK', undetermined: false, capacity: cap, worst,
    headroom: ceiling - (worst ? worst.value : atBoarding + pax),
    says: 'Predicted room for ' + pax + ' the whole way you are aboard.' };
}

/** Minutes of the ride spent on a stretch khaali would call crowded. */
export function crowdedMinutes(pred, runLegs, fromSeq, toSeq) {
  let mins = 0;
  runLegs.forEach(l => {
    const c = pred.crowding[l.fromStopSequence];
    if (!c) return;
    if (l.fromStopSequence < fromSeq || l.fromStopSequence >= toSeq) return;
    if (c.crowdingBand === 'orange' || c.crowdingBand === 'red') mins += l.predictedTravelMinutes;
  });
  return mins;
}
