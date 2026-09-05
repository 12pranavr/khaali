// ---------------------------------------------------------------------------
// Choosing the right vehicle for each stretch.
//
// Not "rank the routes and colour in the crowding afterwards". This builds whole
// door-to-door journeys out of individual DEPARTURES, costs each stretch with
// the traffic that stretch will actually meet, checks whether this party can
// board and whether the load stays inside policy the whole way they are aboard,
// checks whether each change is one a person could make, throws away everything
// that fails, and only then compares what is left.
//
// The order matters and it is the whole design: generate, validate, REMOVE the
// infeasible, rank, answer. A journey that cannot be made must not be ranked
// low - it must be absent, or the scorer will eventually prefer it for having
// fewer changes.
//
// NO HIDDEN "METRO IS BETTER" RULE. The score is written down below and every
// weight is configurable. A through bus needs no walking and no second
// boarding, which are real advantages; a change wins only when what happens on
// the road pays for them. Both outcomes are reachable, and the tests turn one
// knob and watch it flip.
//
// WHAT KHAALI IS ALLOWED TO SAY. Every number here is simulated. The disclosure
// travels with the answer rather than sitting in a footer, and the reason codes
// are produced by the checks, so the sentence cannot describe a check that
// never ran.

import * as demonet from './demonet.mjs';
import * as roadsim from './roadsim.mjs';
import * as ridership from './ridership.mjs';
import * as transfer from './transfer.mjs';
import * as scenario from './scenario.mjs';

/** Two transfers, three boardings. A walk between services is not a boarding. */
export const MAX_BOARDINGS = 3;
export const HORIZON_MIN = 180;

/**
 * The policy, written down. `extraWalkingPenalty` is a PREFERENCE, not time -
 * walking minutes are already inside totalMinutes, and this says how much more
 * than their clock value she dislikes them.
 */
export const POLICIES = {
  balanced: { crowdingWeight: 0.6, transferPenalty: 6, extraWalkingPenalty: 0.5,
    fareWeight: 0.15, benefitThresholdMin: 5 },
  fastest: { crowdingWeight: 0.1, transferPenalty: 2, extraWalkingPenalty: 0.1,
    fareWeight: 0.0, benefitThresholdMin: 2 },
  comfortable: { crowdingWeight: 1.6, transferPenalty: 10, extraWalkingPenalty: 1.2,
    fareWeight: 0.1, benefitThresholdMin: 8 },
};
export const policyFor = p => POLICIES[p] || POLICIES.balanced;

export const KINDS = ['RECOMMEND_DIRECT', 'RECOMMEND_TRANSFER', 'RECOMMEND_BUS_TRANSFER',
  'RECOMMEND_MODE_CHANGE', 'NO_FEASIBLE_JOURNEY'];

export const REASON_CODES = ['LOWER_PREDICTED_TRAVEL_TIME', 'AVOIDS_CROWDED_DOWNSTREAM_STRETCH',
  'AVOIDS_ROAD_DELAY', 'TRANSFER_FEASIBLE', 'NO_TRANSFER_NEEDED', 'FEWER_TRANSFERS',
  'LESS_WALKING', 'LOWER_FARE', 'ONLY_FEASIBLE_JOURNEY', 'BENEFIT_BELOW_THRESHOLD'];

export const REJECTIONS = ['ALREADY_DEPARTED', 'NO_WALKING_CONNECTION', 'BOARDING_NOT_FEASIBLE',
  'SPAN_OVER_PLANNING_LIMIT', 'BUS_CAPACITY_UNKNOWN', 'TRANSFER_TOO_TIGHT',
  'TRANSFER_TOO_LONG', 'BEYOND_HORIZON', 'CANCELLED', 'TOO_MANY_BOARDINGS',
  'DOES_NOT_REACH'];

export const DISCLOSURE = 'Demo recommendation: passenger demand, traffic and service times '
  + 'are simulated. No seat is reserved on a bus or a metro.';

// ---------------------------------------------------------------------------

/** Every departure that could carry her from one stop toward another. */
function boardable(fromStop, notBefore, { limit = 6 } = {}) {
  const out = [];
  demonet.ROUTES.forEach(r => {
    const seq = demonet.seqOf(r, fromStop);
    if (seq < 0 || seq >= r.stops.length - 1) return;
    demonet.departures(r.id, { from: 0, to: 1440 }).forEach(dep => {
      if (dep.cancelled) return;
      const at = roadsim.reachesAt(dep, seq);
      if (at < notBefore) return;
      if (at > notBefore + HORIZON_MIN) return;
      out.push({ dep, seq, reachesAt: at });
    });
  });
  return out.sort((a, b) => a.reachesAt - b.reachesAt).slice(0, limit);
}

/** Stops she could be standing at, having got off here. */
function onwardStops(stopId) {
  const out = [{ to: stopId, walk: { minutes: 0, stationEntryMinutes: 0 } }];
  demonet.WALKS.filter(w => w.from === stopId).forEach(w =>
    out.push({ to: w.to, walk: demonet.walkBetween(stopId, w.to) }));
  return out;
}

/**
 * Whole journeys, with everything that could sink one already checked.
 * `trace` collects every rejection with its reason, because a planner that
 * cannot say what it threw away cannot be believed about what it kept.
 */
export function candidates({ fromStop, toStop, at, pax = 1, ledgers = {} }) {
  const found = [], trace = [];
  const note = (o) => { trace.push(o); return null; };

  const walk = (here, ready, legs, boardings, seen) => {
    if (boardings > MAX_BOARDINGS) return note({ code: 'TOO_MANY_BOARDINGS', at: here });
    if (here === toStop) { found.push(assemble(legs, at, pax)); return null; }
    if (boardings === MAX_BOARDINGS) return null;

    onwardStops(here).forEach(({ to: stand, walk: w }) => {
      if (!w) return note({ code: 'NO_WALKING_CONNECTION', from: here, to: stand });
      const legsW = w.minutes > 0
        ? legs.concat([{ mode: 'walk', fromStop: here, toStop: stand, minutes: w.minutes,
          depMin: ready, arrMin: ready + w.minutes }])
        : legs;
      const standReady = ready + (w.minutes || 0);

      /* Walking the last few hundred metres IS arriving. The recursion only
         continued through a boarding, so a journey that ended by walking from
         the metro to the bus stop across the road was built and then dropped -
         which silently removed every metro option from the comparison, because
         the metro does not stop at a bus stop. */
      if (stand === toStop && stand !== here) { found.push(assemble(legsW, at, pax)); return; }

      boardable(stand, standReady).forEach(({ dep, seq }) => {
        const key = dep.tripInstanceId;
        if (seen.has(key)) return;
        const route = demonet.routeOf(dep.routeId);
        const last = legs.filter(l => l.mode !== 'walk').slice(-1)[0];

        // the change itself, before anything else is computed about it
        if (last) {
          const edge = transfer.edge({ fromStopId: last.toStop, toStopId: stand,
            walkMinutes: w.minutes || 0,
            stationEntryMinutes: w.stationEntryMinutes == null ? 0 : w.stationEntryMinutes });
          const inLeg = { arrMin: last.arrMin, uncertaintyMinutes: last.uncertaintyMinutes,
            every: last.every, scheduleKind: 'frequency' };
          const v = transfer.feasible(inLeg, { depMin: roadsim.reachesAt(dep, seq), mode: dep.mode }, edge);
          if (!v.ok) return note({ code: v.code, trip: key, from: last.toStop, to: stand,
            wait: v.wait, need: v.need, says: v.says });
        }

        // ...then every stop of this service she could get off at
        for (let j = seq + 1; j < route.stops.length; j++) {
          const run = roadsim.runAcross(dep, seq, j);
          if (run.arriveMinute > at + HORIZON_MIN) { note({ code: 'BEYOND_HORIZON', trip: key }); continue; }
          const pred = ridership.predict(dep, {
            recordedSpans: (ledgers[key] && ledgers[key].spans) || [],
            recordedThrough: (ledgers[key] && ledgers[key].recordedThrough) != null
              ? ledgers[key].recordedThrough : -1,
            claimSpans: (ledgers[key] && ledgers[key].claims) || [],
          });
          const room = ridership.roomFor(pred, seq, j, pax);
          if (!room.ok) { note({ code: room.code, trip: key, fromStopSequence: seq,
            toStopSequence: j, says: room.says }); continue; }

          const leg = {
            mode: dep.mode, tripInstanceId: key, routeId: dep.routeId, name: dep.name,
            fromStop: route.stops[seq], toStop: route.stops[j],
            fromStopSequence: seq, toStopSequence: j,
            depMin: run.boardMinute, arrMin: run.arriveMinute,
            minutes: run.predictedMinutes,
            baseMinutes: run.baseMinutes, delayMinutes: run.delayMinutes,
            serviceDelayMinutes: run.serviceDelayMinutes,
            uncertaintyMinutes: run.uncertaintyMinutes,
            every: dep.every, scheduleKind: 'frequency', sourceKind: dep.sourceKind,
            fare: run.fare, stretches: run.legs,
            crowding: run.legs.map(l => pred.crowding[l.fromStopSequence]).filter(Boolean),
            crowdedMinutes: ridership.crowdedMinutes(pred, run.legs, seq, j),
            room, prediction: pred,
            waitBefore: run.boardMinute - standReady,
          };
          walk(route.stops[j], run.arriveMinute, legsW.concat([leg]), boardings + 1,
            new Set([...seen, key]));
        }
      });
    });
    return null;
  };

  walk(fromStop, at, [], 0, new Set());
  if (!found.length) trace.push({ code: 'DOES_NOT_REACH', from: fromStop, to: toStop });
  return { candidates: dedupe(found), trace };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(c => {
    const k = c.legs.filter(l => l.mode !== 'walk').map(l => l.tripInstanceId + ':'
      + l.fromStopSequence + '-' + l.toStopSequence).join('>');
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

/** Door to door, with every term named. */
function assemble(legs, searchAt, pax) {
  const rides = legs.filter(l => l.mode !== 'walk');
  const walks = legs.filter(l => l.mode === 'walk');
  const dep = rides.length ? rides[0].depMin : searchAt;
  const arr = legs.length ? legs[legs.length - 1].arrMin : searchAt;
  const initialWait = rides.length ? Math.max(0, rides[0].depMin - searchAt
    - walks.filter(w => w.depMin < rides[0].depMin).reduce((a, w) => a + w.minutes, 0)) : 0;
  const transferWait = rides.slice(1).reduce((a, l) => a + Math.max(0, l.waitBefore || 0), 0);
  const walkingMinutes = walks.reduce((a, w) => a + w.minutes, 0);
  const rideMinutes = rides.reduce((a, l) => a + l.minutes, 0);
  return {
    legs, rides, walks,
    departMinute: dep, arriveMinute: arr,
    totalMinutes: arr - searchAt,
    initialWaitMinutes: initialWait,
    transferWaitMinutes: transferWait,
    walkingMinutes, rideMinutes,
    transferCount: Math.max(0, rides.length - 1),
    fare: rides.reduce((a, l) => a + (l.fare || 0), 0),
    crowdedRideMinutes: rides.reduce((a, l) => a + (l.crowdedMinutes || 0), 0),
    roadDelayMinutes: rides.reduce((a, l) => a + (l.delayMinutes || 0), 0),
    serviceDelayMinutes: rides.reduce((a, l) => a + (l.serviceDelayMinutes || 0), 0),
    modes: [...new Set(rides.map(l => l.mode))],
    pax,
  };
}

/** The score, with each term kept so a card can show the arithmetic. */
export function score(c, policy) {
  const w = policyFor(policy);
  const terms = {
    time: c.totalMinutes,
    crowding: w.crowdingWeight * c.crowdedRideMinutes,
    transfers: w.transferPenalty * c.transferCount,
    walking: w.extraWalkingPenalty * c.walkingMinutes,
    fare: w.fareWeight * c.fare,
  };
  return { total: Object.values(terms).reduce((a, b) => a + b, 0), terms, weights: w };
}

// ---------------------------------------------------------------------------

/**
 * The answer, and why it beat the thing it beat.
 *
 * A recommendation with no named comparison is not an explanation - "best" is
 * a claim about a set nobody was shown. Every winner here carries the candidate
 * it displaced and the terms that separated them.
 */
export function plan({ fromStop, toStop, at, pax = 1, policy = 'balanced', ledgers = {} }) {
  const stamp = scenario.stamp();
  const { candidates: cands, trace } = candidates({ fromStop, toStop, at, pax, ledgers });
  if (!cands.length) {
    return { ...stamp, decision: { kind: 'NO_FEASIBLE_JOURNEY', reasons: [],
      selectedChainId: null, comparisonChainId: null },
      answer: null, others: [],
      trace: { considered: 0, rejections: trace, scores: [] },
      disclosure: DISCLOSURE };
  }
  const w = policyFor(policy);
  const scored = cands.map(c => ({ c, id: idOf(c), s: score(c, policy) }))
    .sort((a, b) => a.s.total - b.s.total);

  // A change has to earn its walk and its second boarding. If the best journey
  // has more boardings than the best direct one and is not better by the
  // configured margin, the direct one wins and khaali says why.
  let winner = scored[0];
  const direct = scored.find(x => x.c.transferCount === 0);
  let belowThreshold = null;
  if (direct && winner.c.transferCount > direct.c.transferCount) {
    const gain = direct.s.total - winner.s.total;
    if (gain < w.benefitThresholdMin) {
      belowThreshold = { gain: Math.round(gain * 10) / 10, threshold: w.benefitThresholdMin };
      winner = direct;
    }
  }
  /* The comparison has to be a DIFFERENT ANSWER, not the next row down.
     Ranked purely by score the runner-up was the same bus and the same metro
     six minutes later, and "six minutes earlier than itself" explains nothing.
     The alternative worth naming is the best journey that differs in what it
     asks her to do: a different number of changes, or different modes. */
  const shape = c => c.transferCount + '|' + c.modes.slice().sort().join('+');
  const rival = scored.find(x => x !== winner && shape(x.c) !== shape(winner.c))
    || scored.find(x => x !== winner) || null;
  const reasons = reasonsFor(winner, rival, belowThreshold, scored.length);
  const choices = choicesFor(winner, scored, trace);

  return {
    ...stamp,
    decision: {
      kind: kindOf(winner),
      selectedChainId: winner.id,
      comparisonChainId: rival ? rival.id : null,
      reasons,
      choices,
      policy, weights: w,
    },
    answer: {
      chainId: winner.id, legs: publicLegs(winner.c),
      arrivalTime: hhmm(winner.c.arriveMinute), arriveMinute: winner.c.arriveMinute,
      totalMinutes: winner.c.totalMinutes, totalFare: winner.c.fare,
      transferCount: winner.c.transferCount,
      walkingMinutes: winner.c.walkingMinutes,
      initialWaitMinutes: winner.c.initialWaitMinutes,
      transferWaitMinutes: winner.c.transferWaitMinutes,
      crowdedRideMinutes: winner.c.crowdedRideMinutes,
      roadDelayMinutes: winner.c.roadDelayMinutes,
      serviceDelayMinutes: winner.c.serviceDelayMinutes,
      explanation: explain(reasons, winner, rival),
      evidenceLabel: DISCLOSURE,
    },
    others: scored.filter(x => x !== winner).slice(0, 4).map(x => ({
      chainId: x.id, arrivalTime: hhmm(x.c.arriveMinute), totalMinutes: x.c.totalMinutes,
      transferCount: x.c.transferCount, fare: x.c.fare, modes: x.c.modes,
      score: Math.round(x.s.total * 10) / 10,
    })),
    trace: {
      considered: cands.length,
      scores: scored.map(x => ({ chainId: x.id, modes: x.c.modes,
        arriveMinute: x.c.arriveMinute, transfers: x.c.transferCount,
        total: Math.round(x.s.total * 10) / 10,
        terms: Object.fromEntries(Object.entries(x.s.terms)
          .map(([k, v]) => [k, Math.round(v * 10) / 10])) })),
      rejections: trace,
    },
    disclosure: DISCLOSURE,
  };
}

/** DEMO|A|600 -> 600, 'A'. A synthetic id carries its own departure minute. */
const depOfTrip = id => { const p = String(id || '').split('|'); return p.length > 2 ? +p[2] : null; };
const routeOfTrip = id => { const p = String(id || '').split('|'); return p.length > 1 ? p[1] : null; };

/**
 * Why each choice inside the winning journey went the way it did - built from
 * the rejections and the scores, never written afterwards to sound convincing.
 *
 * A journey is three decisions wearing one card: which vehicle for the first
 * stretch, whether and where to leave it, and which onward departure to aim
 * for. Each of those had real alternatives that were really rejected, and the
 * evidence is in the trace: the earlier bus that was predicted full, the
 * 10:32 metro that leaves before her walk lands, the through option that eats
 * the road delay. If the trace holds no alternative for a choice, that choice
 * gets no sentence - khaali does not narrate a comparison it never made.
 */
function choicesFor(winner, scored, rejections) {
  const c = winner.c, rides = c.rides;
  if (!rides.length) return [];
  const first = rides[0];
  const rName = id => (demonet.routeOf(id) || {}).name || id;
  const found = [];

  // WHY THIS FIRST DEPARTURE - only when an earlier one was rejected for room
  const fullEarlier = rejections.filter(t => t.trip
    && ['BOARDING_NOT_FEASIBLE', 'SPAN_OVER_PLANNING_LIMIT'].includes(t.code)
    && routeOfTrip(t.trip) === first.routeId
    && depOfTrip(t.trip) != null && depOfTrip(t.trip) < first.depMin)
    .sort((a, b) => depOfTrip(b.trip) - depOfTrip(a.trip))[0];
  if (fullEarlier) {
    const altAt = hhmm(depOfTrip(fullEarlier.trip));
    found.push({ about: 'FIRST_LEG', priority: 1,
      question: 'Why the ' + hhmm(first.depMin) + ' ' + first.name + '?',
      choice: first.name + ' at ' + hhmm(first.depMin),
      alternative: rName(routeOfTrip(fullEarlier.trip)) + ' at ' + altAt,
      evidence: fullEarlier.code === 'BOARDING_NOT_FEASIBLE'
        ? 'the earlier departure is predicted to be at capacity by your stop'
        : 'the earlier departure is predicted to fill past the planning limit on your stretch',
      benefit: 'you are pointed at a departure with predicted room, not at one going past full',
      says: 'The ' + altAt + ' is predicted to have insufficient boarding room for your party; '
        + 'this departure passes the check.' });
  }

  if (c.transferCount > 0) {
    const onward = rides[1];
    const dest = rides[rides.length - 1].toStop;

    // WHY LEAVE THE VEHICLE HERE - against actually staying on it
    const through = scored.filter(x => x !== winner && x.c.transferCount === 0)
      .sort((a, b) => a.s.total - b.s.total)[0];
    if (through) {
      const roadDiff = through.c.roadDelayMinutes - c.roadDelayMinutes;
      const arrDiff = through.c.arriveMinute - c.arriveMinute;
      const crowdDiff = through.c.crowdedRideMinutes - c.crowdedRideMinutes;
      const bits = [];
      if (roadDiff >= 5) bits.push('the road past ' + nameOf(first.toStop) + ' carries '
        + roadDiff + ' minutes of simulated delay that this change avoids');
      if (crowdDiff >= 3) bits.push('staying on rides ' + crowdDiff
        + ' more minutes on stretches predicted to be crowded');
      if (arrDiff > 0) bits.push('leaving here arrives ' + arrDiff + ' minutes sooner');
      if (bits.length) found.push({ about: 'INTERCHANGE', priority: 1,
        question: 'Why change at ' + nameOf(first.toStop) + '?',
        choice: 'leave the ' + first.name + ' at ' + nameOf(first.toStop),
        alternative: 'staying aboard to ' + nameOf(dest) + ', arriving ' + hhmm(through.c.arriveMinute),
        evidence: bits[0],
        benefit: arrDiff > 0 ? ('arrive ' + arrDiff + ' minutes sooner') : 'a shorter, easier run',
        says: bits[0].charAt(0).toUpperCase() + bits[0].slice(1)
          + (bits.length > 1 ? ('; ' + bits.slice(1).join('; ')) : '') + '.' });
    }

    // WHY THIS ONWARD SERVICE - against another service from the same change
    const altMode = scored.filter(x => x !== winner && x.c.rides.length > 1
      && x.c.rides[0].routeId === first.routeId
      && x.c.rides[1] && x.c.rides[1].routeId !== onward.routeId)
      .sort((a, b) => a.s.total - b.s.total)[0];
    if (altMode) {
      const rivalRide = altMode.c.rides[1];
      const arrDiff = altMode.c.arriveMinute - c.arriveMinute;
      if (arrDiff > 0) found.push({ about: 'ONWARD_MODE', priority: 3,
        question: 'Why the ' + onward.name + ' and not the ' + rivalRide.name + '?',
        choice: onward.name + ' at ' + hhmm(onward.depMin),
        alternative: rivalRide.name + ' from the same interchange, arriving ' + hhmm(altMode.c.arriveMinute),
        evidence: 'it reaches ' + nameOf(dest) + ' ' + arrDiff + ' minutes later',
        benefit: 'the earlier arrival',
        says: 'From the same interchange the ' + rivalRide.name + ' gets in at '
          + hhmm(altMode.c.arriveMinute) + '; the ' + onward.name + ' gets in at '
          + hhmm(c.arriveMinute) + '.' });
    }

    // WHY THIS ONWARD DEPARTURE - against the one that leaves before she can
    const missed = rejections.filter(t => t.trip && t.code === 'TRANSFER_TOO_TIGHT'
      && routeOfTrip(t.trip) === onward.routeId
      && depOfTrip(t.trip) != null && depOfTrip(t.trip) < onward.depMin
      && depOfTrip(t.trip) >= (first.arrMin || 0) - 5)
      .sort((a, b) => depOfTrip(b.trip) - depOfTrip(a.trip))[0];
    if (missed) {
      const missedAt = hhmm(depOfTrip(missed.trip));
      found.push({ about: 'ONWARD_DEPARTURE', priority: 2,
        question: 'Why the ' + hhmm(onward.depMin) + ' departure?',
        choice: onward.name + ' at ' + hhmm(onward.depMin),
        alternative: 'the ' + missedAt,
        evidence: 'the ' + missedAt + ' leaves before you can reach it after the walk',
        benefit: 'a connection you can actually make',
        says: 'The ' + missedAt + ' leaves before you can reach the platform; the '
          + hhmm(onward.depMin) + ' connects'
          + (onward.waitBefore > 0 ? (' with ' + onward.waitBefore + ' minutes in hand') : '') + '.' });
    }
  } else {
    // WHY STAY ABOARD - against the best change on the table
    const bestTr = scored.filter(x => x.c.transferCount > 0)
      .sort((a, b) => a.s.total - b.s.total)[0];
    if (bestTr) {
      const arrDiff = bestTr.c.arriveMinute - c.arriveMinute;
      found.push({ about: 'STAY', priority: 1,
        question: 'Why not change?',
        choice: 'stay aboard the ' + first.name,
        alternative: bestTr.c.rides.map(r => r.name).join(' then ')
          + ', arriving ' + hhmm(bestTr.c.arriveMinute),
        evidence: arrDiff >= 0
          ? ('the best change arrives ' + (arrDiff === 0 ? 'no sooner' : arrDiff + ' minutes later'))
          : ('the change arrives ' + (-arrDiff) + ' minutes sooner but not by enough to pay for '
            + 'the walk and second boarding'),
        benefit: 'nothing to gain from a walk and a second boarding',
        says: 'The best change on the table (' + bestTr.c.rides.map(r => r.name).join(' then ')
          + ') arrives at ' + hhmm(bestTr.c.arriveMinute) + ' against ' + hhmm(c.arriveMinute)
          + ' staying aboard.' });
    }
  }
  // at most three, the crux first, then in journey order
  return found.sort((a, b) => a.priority - b.priority).slice(0, 3)
    .sort((a, b) => ['FIRST_LEG', 'INTERCHANGE', 'STAY', 'ONWARD_DEPARTURE', 'ONWARD_MODE']
      .indexOf(a.about) - ['FIRST_LEG', 'INTERCHANGE', 'STAY', 'ONWARD_DEPARTURE', 'ONWARD_MODE']
      .indexOf(b.about));
}

function kindOf(x) {
  const c = x.c;
  if (c.transferCount === 0) return 'RECOMMEND_DIRECT';
  const modes = c.modes;
  if (modes.length > 1) return 'RECOMMEND_MODE_CHANGE';
  if (modes[0] === 'bus') return 'RECOMMEND_BUS_TRANSFER';
  return 'RECOMMEND_TRANSFER';
}

function reasonsFor(win, rival, belowThreshold, n) {
  const out = [];
  if (belowThreshold) out.push({ code: 'BENEFIT_BELOW_THRESHOLD', ...belowThreshold });
  if (!rival) { out.push({ code: 'ONLY_FEASIBLE_JOURNEY' }); return out; }
  const a = win.c, b = rival.c;
  if (a.arriveMinute < b.arriveMinute) out.push({ code: 'LOWER_PREDICTED_TRAVEL_TIME',
    differenceMinutes: b.arriveMinute - a.arriveMinute });
  if (a.transferCount === 0 && b.transferCount > 0) out.push({ code: 'NO_TRANSFER_NEEDED' });
  else if (a.transferCount < b.transferCount) out.push({ code: 'FEWER_TRANSFERS',
    difference: b.transferCount - a.transferCount });
  if (b.roadDelayMinutes - a.roadDelayMinutes >= 5) out.push({ code: 'AVOIDS_ROAD_DELAY',
    differenceMinutes: b.roadDelayMinutes - a.roadDelayMinutes });
  if (b.crowdedRideMinutes - a.crowdedRideMinutes >= 3) {
    const worst = b.rides.map(l => ({ l, c: (l.crowding || [])
      .reduce((p, x) => (!p || (x && x.occupancy > p.occupancy)) ? x : p, null) }))
      .filter(x => x.c).sort((x, y) => y.c.occupancy - x.c.occupancy)[0];
    out.push({ code: 'AVOIDS_CROWDED_DOWNSTREAM_STRETCH',
      differenceMinutes: b.crowdedRideMinutes - a.crowdedRideMinutes,
      affectedTripInstanceId: worst ? worst.l.tripInstanceId : null,
      fromStopSequence: worst ? worst.c.fromStopSequence : null,
      toStopSequence: worst ? worst.c.toStopSequence : null });
  }
  if (a.transferCount > 0) {
    const first = a.rides[1];
    const w = a.walks.reduce((s, x) => s + x.minutes, 0);
    out.push({ code: 'TRANSFER_FEASIBLE', walkingMinutes: w,
      connectionAllowanceMinutes: first ? Math.max(0, first.waitBefore) : 0 });
  }
  if (a.walkingMinutes + 3 < b.walkingMinutes) out.push({ code: 'LESS_WALKING',
    differenceMinutes: b.walkingMinutes - a.walkingMinutes });
  if (a.fare + 5 < b.fare) out.push({ code: 'LOWER_FARE', difference: b.fare - a.fare });
  return out;
}

/** The sentence, built from the codes. Nothing is said that is not in them. */
export function explain(reasons, win, rival) {
  const has = c => reasons.find(r => r.code === c);
  const a = win.c;
  const parts = [];
  const first = a.rides[0];
  parts.push('Take the ' + first.name + ' from ' + nameOf(first.fromStop) + ' at ' + hhmm(first.depMin) + '.');
  if (a.transferCount > 0) {
    const next = a.rides[1];
    parts.push('Change at ' + nameOf(first.toStop) + ' for the ' + next.name + ' at ' + hhmm(next.depMin) + '.');
  }
  const crowded = has('AVOIDS_CROWDED_DOWNSTREAM_STRETCH');
  const road = has('AVOIDS_ROAD_DELAY');
  if (crowded && road) parts.push('Staying on is predicted to be both busier and '
    + road.differenceMinutes + ' minutes slower on the road.');
  else if (road) parts.push('It avoids ' + road.differenceMinutes
    + ' minutes of simulated road delay on the stretch after ' + nameOf(first.toStop) + '.');
  else if (crowded) parts.push('It avoids ' + crowded.differenceMinutes
    + ' minutes on a stretch predicted to be crowded.');
  const t = has('TRANSFER_FEASIBLE');
  if (t) parts.push('The change is a ' + t.walkingMinutes + ' minute walk with '
    + t.connectionAllowanceMinutes + ' minutes in hand.');
  const faster = has('LOWER_PREDICTED_TRAVEL_TIME');
  if (faster && rival) parts.push('Predicted arrival ' + hhmm(a.arriveMinute) + ', which is '
    + faster.differenceMinutes + ' minutes earlier than ' + describe(rival.c) + '.');
  else if (rival) parts.push('Predicted arrival ' + hhmm(a.arriveMinute) + ', against '
    + hhmm(rival.c.arriveMinute) + ' for ' + describe(rival.c) + '.');
  if (has('NO_TRANSFER_NEEDED')) parts.push('Changing would not have got you there sooner.');
  if (has('BENEFIT_BELOW_THRESHOLD')) {
    const b = has('BENEFIT_BELOW_THRESHOLD');
    parts.push('A change was available but gained only ' + b.gain
      + ' against a threshold of ' + b.threshold + ', which is not worth a walk and a second boarding.');
  }
  return parts.join(' ');
}
/** Name the alternative by its departure, not just its route - "the Bus A"
    twice over is not a comparison anybody can check. */
const describe = c => (c.transferCount === 0
  ? ('the ' + c.rides[0].name + ' of ' + hhmm(c.rides[0].depMin) + ' all the way')
  : (c.rides.map(r => r.name + ' ' + hhmm(r.depMin)).join(' then ')));

function publicLegs(c) {
  return c.legs.map(l => l.mode === 'walk'
    ? { mode: 'walk', from: nameOf(l.fromStop), to: nameOf(l.toStop), minutes: l.minutes,
      dep: hhmm(l.depMin), arr: hhmm(l.arrMin), depMin: l.depMin, arrMin: l.arrMin }
    : { mode: l.mode, name: l.name, tripInstanceId: l.tripInstanceId, routeId: l.routeId,
      from: nameOf(l.fromStop), to: nameOf(l.toStop),
      fromStopSequence: l.fromStopSequence, toStopSequence: l.toStopSequence,
      dep: hhmm(l.depMin), arr: hhmm(l.arrMin), depMin: l.depMin, arrMin: l.arrMin,
      minutes: l.minutes, baseMinutes: l.baseMinutes, delayMinutes: l.delayMinutes,
      serviceDelayMinutes: l.serviceDelayMinutes,
      waitBefore: l.waitBefore, fare: l.fare, every: l.every,
      scheduleKind: 'frequency', departureDerived: true, sourceKind: l.sourceKind,
      crowding: l.crowding, crowdedMinutes: l.crowdedMinutes,
      room: { ok: l.room.ok, headroom: l.room.headroom, capacity: l.room.capacity } });
}
const nameOf = id => (demonet.stopOf(id) || {}).n || id;

export function idOf(c) {
  const s = c.legs.map(l => (l.mode === 'walk' ? 'w' : l.tripInstanceId)
    + ':' + (l.fromStop || '') + '-' + (l.toStop || '') + ':' + l.depMin).join('>');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'mp_' + (h >>> 0).toString(36);
}

export const hhmm = (m) => {
  if (m == null) return '--:--';
  const d = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(d / 60)).padStart(2, '0') + ':' + String(d % 60).padStart(2, '0');
};
