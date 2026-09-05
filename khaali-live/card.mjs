// ---------------------------------------------------------------------------
// What the card says, built from what was actually decided.
//
// The card used to lead with "TRAIN KEPT - this train has 43 places khaali can
// sell, so there is no reason to replace any of it". That is a true sentence
// about one leg's inventory and it is not an explanation of a journey. It
// answers "may khaali keep this train", which is khaali's question, not hers.
// Hers are:
//
//   What do I take?   Where do I change?   Why this one?
//   When do I arrive, walking and waiting included?
//   What is known, what is predicted, and what is not promised?
//
// TWO PLANNERS ANSWER HERE AND THEY KNOW DIFFERENT AMOUNTS.
//
//   EVALUATED          the multimodal planner built whole journeys out of
//                      individual departures, costed the traffic, checked the
//                      capacity and the connections, and compared what
//                      survived. There is a named alternative and a real
//                      difference to quote.
//   AVAILABILITY_ONLY  only the rail check ran. khaali knows the train can
//                      carry her; it has NOT evaluated the bus departure's
//                      demand or the traffic on its road. The card must say
//                      that instead of borrowing the language of a comparison
//                      that never happened.
//   NOT_EVALUATED      neither. A route was found, and that is all.
//
// The renderer invents nothing. Every bracket in the card is filled from a
// field here, and a field that was never computed is absent rather than
// plausible.

export const STATUS = ['EVALUATED', 'AVAILABILITY_ONLY', 'NOT_EVALUATED'];

const MODE_WORD = { train: 'train', metro: 'metro', bus: 'bus', walk: 'walk',
  car: 'car', bike: 'bike', auto: 'auto' };

const hhmm = (m) => {
  if (m == null) return '--:--';
  const d = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(d / 60), mm = String(d % 60).padStart(2, '0');
  const ap = h < 12 ? 'am' : 'pm';
  return (h % 12 === 0 ? 12 : h % 12) + ':' + mm + ' ' + ap;
};
const mins = n => n + ' ' + (n === 1 ? 'minute' : 'minutes');

/**
 * Every minute between leaving and arriving, named.
 *
 * The card showed a 1h 50m journey whose visible legs added to 95 minutes -
 * fifteen minutes that were real waiting and simply had no row. A gap on a
 * timetable is not a rounding error; it is standing on a platform, and it is
 * the passenger's time.
 */
export function timing(legs, searchAt = null) {
  const rides = legs.filter(l => l.mode !== 'walk');
  const walks = legs.filter(l => l.mode === 'walk');
  const first = legs[0], last = legs[legs.length - 1];
  const rideMinutes = rides.reduce((a, l) => a + span(l), 0);
  const walkingMinutes = walks.reduce((a, l) => a + span(l), 0);
  let transferWaitMinutes = 0;
  const gaps = [];
  for (let i = 1; i < legs.length; i++) {
    const g = (legs[i].depMin != null && legs[i - 1].arrMin != null)
      ? legs[i].depMin - legs[i - 1].arrMin : 0;
    if (g > 0) { transferWaitMinutes += g; gaps.push({ before: i, minutes: g }); }
  }
  const initialWaitMinutes = (searchAt != null && first && first.depMin != null)
    ? Math.max(0, first.depMin - searchAt) : 0;
  const doorToDoor = (last && last.arrMin != null && first && first.depMin != null)
    ? last.arrMin - first.depMin : 0;
  const totalMinutes = doorToDoor + initialWaitMinutes;
  return {
    initialWaitMinutes, rideMinutes, walkingMinutes, transferWaitMinutes,
    doorToDoorMinutes: doorToDoor, totalMinutes, gaps,
    // the card asserts this rather than hoping: if it is false, something is
    // being hidden from her and the card says so instead of drawing it
    reconciles: rideMinutes + walkingMinutes + transferWaitMinutes === doorToDoor,
  };
}
const span = l => (l.minutes != null ? l.minutes
  : l.min != null ? l.min
    : (l.arrMin != null && l.depMin != null) ? (l.arrMin - l.depMin) : 0);

/** "Take the train to Bengaluru Cantt, then a bus to Hebbala." */
export function headline(legs) {
  const rides = legs.filter(l => l.mode !== 'walk');
  if (!rides.length) return 'Walk the whole way.';
  const nameOf = l => l.name || l.line || MODE_WORD[l.mode] || l.mode;
  const article = l => (l.name || l.line) ? 'the ' : (l.mode === 'metro' ? 'the ' : 'a ');
  if (rides.length === 1) {
    const r = rides[0];
    return 'Stay on ' + article(r) + nameOf(r) + ' the whole way to ' + r.to + '.';
  }
  const parts = rides.map((r, i) => (i === 0 ? 'Take ' : 'then ')
    + article(r) + nameOf(r) + ' to ' + r.to);
  return parts.join(', ') + '.';
}

/**
 * The steps, as things she does rather than as a coloured bar.
 *
 * Each is an ACTION with its clock: "BOARD BUS A · 10:00 am", "TAKE METRO M ·
 * 10:38 am" - never "YOU CHANGE", which names the category instead of the
 * thing. A ride says when it ARRIVES, because the arrival at an interchange is
 * the number the next step hangs off. The wait is said once, on the step where
 * she actually stands in it. Headways and how the minute was derived move into
 * `serviceDetail`, for the comparison panel - on the main card the selected
 * departure matters more than the pattern behind it.
 */
export function steps(legs, { railCheck = null } = {}) {
  const out = [];
  legs.forEach((l, i) => {
    const prev = i > 0 ? legs[i - 1] : null;
    const wait = (prev && l.depMin != null && prev.arrMin != null)
      ? Math.max(0, l.depMin - prev.arrMin) : 0;
    const n = out.length + 1;
    if (l.mode === 'walk') {
      const isLast = i === legs.length - 1;
      out.push({ n, kind: 'WALK',
        action: 'WALK TO ' + (isLast ? 'YOUR DESTINATION' : String(l.to).toUpperCase()),
        title: 'Walk to ' + l.to,
        timeLabel: (l.depMin != null && l.arrMin != null)
          ? (hhmm(l.depMin) + '–' + hhmm(l.arrMin)) : '',
        route: l.from + ' → ' + l.to,
        lines: ['Walk for ' + mins(span(l)) + '.'],
        from: l.from, to: l.to, minutes: span(l),
        waitBefore: wait || null });
      return;
    }
    const isFirstRide = !legs.slice(0, i).some(x => x.mode !== 'walk');
    const name = l.name || l.line || MODE_WORD[l.mode];
    const availability = availabilityOf(l, isFirstRide ? railCheck : null);
    const lines = [];
    if (wait > 0) lines.push('Wait about ' + mins(wait)
      + (prev && prev.mode === 'walk' ? ' after your walk.' : '.'));
    lines.push('Ride for ' + mins(span(l)) + '.');
    if (availability && availability.says) lines.push(availability.says + '.');
    if (l.arrMin != null) lines.push('Arrive at ' + hhmm(l.arrMin) + '.');
    out.push({
      n, kind: isFirstRide ? 'BOARD' : 'CHANGE',
      action: (isFirstRide ? 'BOARD ' : 'TAKE ') + String(name).toUpperCase(),
      title: (isFirstRide ? 'Board the ' : 'Change to the ') + name,
      timeLabel: hhmm(l.depMin),
      route: l.from + ' → ' + l.to,
      lines,
      service: l.name || l.line || null, serviceId: l.id || null,
      tripInstanceId: l.tripInstanceId || null,
      mode: l.mode, from: l.from, to: l.to,
      departs: hhmm(l.depMin), arrives: hhmm(l.arrMin),
      depMin: l.depMin, arrMin: l.arrMin, minutes: span(l),
      waitBefore: wait || null,
      scheduleKind: l.scheduleKind || (l.every ? 'frequency' : 'timetable'),
      every: l.every || null,
      serviceDetail: (l.every ? ('Runs about every ' + l.every + ' minutes. ') : '')
        + ((l.scheduleKind === 'frequency' || l.departureDerived)
          ? 'The departure time is khaali’s estimate from the gap, not a published minute.'
          : 'Runs to a published timetable.'),
      availability,
    });
  });
  if (legs.length && legs[legs.length - 1].arrMin != null) {
    out.push({ n: out.length + 1, kind: 'ARRIVE', action: 'YOUR ARRIVAL',
      title: 'You are there', timeLabel: hhmm(legs[legs.length - 1].arrMin),
      route: '', lines: [] });
  }
  return out;
}

/**
 * What khaali knows about getting on this particular vehicle - and the
 * difference between holding something and predicting something.
 */
function availabilityOf(l, railCheck) {
  if (l.mode === 'train') {
    if (railCheck && railCheck.anySeats != null) {
      return { kind: 'RESERVABLE', held: false,
        says: 'Train accommodation available for your party',
        detail: railCheck.anySeats + ' places khaali can sell over this stretch',
        basis: 'berth inventory khaali allocates itself' };
    }
    return { kind: 'RESERVABLE', held: false, says: 'Train accommodation not checked', basis: null };
  }
  const room = l.room && l.room.ok != null
    ? (l.room.ok ? 'Boarding room predicted for your party' : 'Not enough predicted boarding room')
    : null;
  const load = (l.cap && l.cap.occupancy != null)
    ? Math.round(l.cap.occupancy * 100) + '% full at its busiest on your stretch' : null;
  return { kind: 'UNRESERVED', held: false,
    says: room || (load ? 'Predicted load: ' + load : 'Boarding room not evaluated'),
    detail: room && load ? load : null,
    note: 'Pass included; no seat reserved.',
    basis: l.sourceKind === 'simulation' || l.source === 'simulated'
      ? 'simulated demand' : (l.cap && l.cap.quality) || null };
}

/**
 * The whole contract. `mp` is the multimodal planner's result when it ran;
 * `railDecision` is the berth check. Which one is present decides the status,
 * and the status decides what the card is allowed to say.
 */
export function build({ chain, mp = null, railDecision = null, searchAt = null,
                        scenario = null, bookingStatus = 'NONE' } = {}) {
  if (!chain || !chain.legs || !chain.legs.length) return null;
  const legs = chain.legs;
  const t = timing(legs, searchAt);
  const evaluated = !!(mp && mp.answer && mp.decision);
  const railCheck = railDecision && railDecision.railCheck;
  const status = evaluated ? 'EVALUATED'
    : (railCheck && railCheck.outcome) ? 'AVAILABILITY_ONLY' : 'NOT_EVALUATED';

  const cmp = evaluated ? comparisonOf(mp) : null;
  return {
    recommendation: {
      status,
      /* "Recommended" is a comparative word and it is only earned by a
         comparison. When only the berth check ran, the card offers a route it
         found, and says so in those words. */
      titleChip: evaluated ? 'YOUR RECOMMENDED JOURNEY'
        : status === 'AVAILABILITY_ONLY' ? 'A ROUTE KHAALI FOUND — NOT COMPARED'
          : 'A ROUTE — NOT EVALUATED',
      headline: headline(legs),
      mainReason: evaluated ? (mainReasonFor(mp.decision, cmp, legs)
        || summaryFor(status, mp, railCheck, cmp))
        : summaryFor(status, mp, railCheck, cmp),
      summaryReason: summaryFor(status, mp, railCheck, cmp),
      selectedChainId: (mp && mp.decision && mp.decision.selectedChainId) || chain.chainId || null,
      decisionKind: (mp && mp.decision && mp.decision.kind)
        || (railDecision && railDecision.kind) || null,
      comparison: cmp,
      // the honest gap, said out loud rather than papered over
      notEvaluated: evaluated ? [] : notEvaluatedFor(legs, railCheck),
    },
    journey: {
      departureTime: hhmm(legs[0].depMin), arrivalTime: hhmm(legs[legs.length - 1].arrMin),
      departMinute: legs[0].depMin, arriveMinute: legs[legs.length - 1].arrMin,
      ...t,
      transferCount: Math.max(0, legs.filter(l => l.mode !== 'walk').length - 1),
      fare: chain.fare == null ? null : chain.fare,
      steps: steps(legs, { railCheck }),
    },
    evidence: {
      demandSource: evaluated ? 'simulated conductor and demand model'
        : (legs.some(l => l.mode === 'bus') ? 'not evaluated for this departure' : null),
      trafficSource: evaluated ? 'simulated road delay, per stretch and per minute'
        : 'not evaluated for this journey',
      timetableSource: legs.some(l => l.scheduleKind === 'frequency' || l.departureDerived)
        ? 'published route and headway; the boarding minute is khaali’s estimate'
        : 'published timetable',
      simulated: !!(chain.simulated || evaluated),
      scenarioId: scenario ? scenario.scenarioId : null,
      revision: scenario ? scenario.revision : null,
      label: evaluated && mp.disclosure ? mp.disclosure : null,
    },
    booking: bookingFor(legs, bookingStatus),
  };
}

function comparisonOf(mp) {
  const d = mp.decision;
  if (!d.comparisonChainId) return null;
  const alt = (mp.others || []).find(o => o.chainId === d.comparisonChainId)
    || (mp.trace && (mp.trace.scores || []).find(s => s.chainId === d.comparisonChainId));
  const r = c => d.reasons.find(x => x.code === c);
  const faster = r('LOWER_PREDICTED_TRAVEL_TIME');
  const road = r('AVOIDS_ROAD_DELAY');
  const crowd = r('AVOIDS_CROWDED_DOWNSTREAM_STRETCH');
  const below = r('BENEFIT_BELOW_THRESHOLD');
  const altArrive = alt ? (alt.arrivalTime
    || (alt.arriveMinute != null ? hhmm(alt.arriveMinute) : null)) : null;
  const altTotal = alt ? (alt.totalMinutes != null ? alt.totalMinutes
    : (alt.arriveMinute != null && mp.demoTime != null
      ? alt.arriveMinute - mp.demoTime : null)) : null;
  const whatChanges = [];
  if (faster) whatChanges.push('Arrives ' + mins(faster.differenceMinutes) + ' earlier.');
  if (road) whatChanges.push('Avoids ' + mins(road.differenceMinutes) + ' of simulated road delay.');
  if (crowd) whatChanges.push('Avoids ' + mins(crowd.differenceMinutes)
    + ' on stretches predicted to be crowded.');
  const fareDiff = alt && alt.fare != null && mp.answer.totalFare != null
    ? mp.answer.totalFare - alt.fare : null;
  if (fareDiff != null && fareDiff !== 0) whatChanges.push(fareDiff > 0
    ? ('Costs ₹' + fareDiff + ' more.') : ('Saves ₹' + (-fareDiff) + '.'));
  if (below) whatChanges.push('The best change gained only ' + below.gain
    + ' against a threshold of ' + below.threshold + ', so it was not taken.');
  const rideNames = (mp.answer.legs || []).filter(l => l.mode !== 'walk')
    .map(l => l.name || l.mode);
  return {
    alternativeChainId: d.comparisonChainId,
    // name it by when it gets there. "bus" on its own is not an alternative
    // anybody can weigh, and the trace rows carry a minute rather than a clock
    alternativeLabel: alt ? ((alt.modes || []).join(' then ')
      + (altArrive ? (', arriving ' + altArrive) : ''))
      : 'the next best journey',
    // the panel behind "See comparison": both journeys side by side, what
    // separates them, and where the numbers came from
    thisLabel: rideNames.join(' → '),
    thisArrive: mp.answer.arrivalTime, thisTotalMinutes: mp.answer.totalMinutes,
    alternativeArrive: altArrive, alternativeTotalMinutes: altTotal,
    whatChanges,
    howEstimated: 'Departure-level ticket simulation, projected boarding demand at every '
      + 'stop, and per-stretch simulated road delay at the minute each stretch is reached. '
      + 'Scenario ' + mp.scenarioId + ', revision ' + mp.revision
      + ' — the same inputs always give the same answer.',
    timeDifferenceMinutes: faster ? faster.differenceMinutes : (below ? 0 : null),
    roadDelayDifferenceMinutes: road ? road.differenceMinutes : null,
    crowdingDifferenceMinutes: crowd ? crowd.differenceMinutes : null,
    fareDifference: fareDiff,
    reasons: d.reasons,
    question: questionFor(d, faster, road, crowd, below),
    answer: answerFor(d, mp, faster, road, crowd, below),
  };
}

/**
 * ONE reason, and only what actually contributed.
 *
 * The card was making its case three times - the summary said "20 minutes
 * earlier", the reasons box said it again, the comparison said it a third
 * time, each with slightly different furniture. The main card gets a single
 * sentence naming the result and the loser, plus the one contributing factor
 * when there was one; everything else lives behind "See comparison".
 */
function mainReasonFor(d, cmp, legs) {
  if (!cmp) return null;
  const dest = legs.length ? legs[legs.length - 1].to : 'your destination';
  const rides = legs.filter(l => l.mode !== 'walk');
  // "the bus arriving 11:18" reads like a sentence; "bus, arriving 11:18" reads
  // like a database row
  const rival = 'the ' + cmp.alternativeLabel.replace(', arriving', ' arriving');
  let s;
  if (d.kind === 'RECOMMEND_DIRECT') {
    s = cmp.timeDifferenceMinutes
      ? ('Staying aboard arrives ' + mins(cmp.timeDifferenceMinutes) + ' before '
        + rival + ' - changing adds walking and waiting it never earns back.')
      : ('Staying aboard beats changing: the alternatives add walking and waiting '
        + 'without arriving sooner.');
  } else {
    const at = rides.length ? rides[0].to : 'the interchange';
    s = 'Changing at ' + at + ' gets you to ' + dest
      + (cmp.timeDifferenceMinutes != null
        ? (' ' + mins(cmp.timeDifferenceMinutes) + ' earlier than ' + rival)
        : (' sooner than ' + rival))
      + ', even after walking and waiting.';
  }
  if (cmp.roadDelayDifferenceMinutes) {
    s += ' Simulated traffic adds ' + mins(cmp.roadDelayDifferenceMinutes)
      + ' to the road ahead.';
  } else if (cmp.crowdingDifferenceMinutes) {
    s += ' It also avoids ' + mins(cmp.crowdingDifferenceMinutes)
      + ' on stretches predicted to be crowded.';
  }
  return s;
}

function questionFor(d, faster, road, crowd, below) {
  if (d.kind === 'RECOMMEND_DIRECT') return 'Why not change?';
  if (d.kind === 'RECOMMEND_MODE_CHANGE') return 'Why change mode here?';
  if (d.kind === 'RECOMMEND_BUS_TRANSFER') return 'Why change buses?';
  return 'Why this combination?';
}

function answerFor(d, mp, faster, road, crowd, below) {
  const bits = [];
  if (below) bits.push('A change was available but gained only ' + below.gain
    + ' against a threshold of ' + below.threshold + ', so the walk and the second boarding '
    + 'were not worth it.');
  if (road) bits.push('Staying on adds ' + mins(road.differenceMinutes)
    + ' of simulated road delay.');
  if (crowd) bits.push('It avoids ' + mins(crowd.differenceMinutes)
    + ' on stretches predicted to be crowded.');
  if (faster) bits.push('After walking and waiting, this reaches the destination '
    + mins(faster.differenceMinutes) + ' earlier.');
  if (!bits.length) bits.push('It was the only journey that passed every check.');
  return bits.join(' ');
}

function summaryFor(status, mp, railCheck, cmp) {
  if (status === 'EVALUATED') return mp.answer.explanation;
  if (status === 'AVAILABILITY_ONLY') {
    return 'Train accommodation is available for your party. khaali has not evaluated '
      + 'demand or traffic for the onward services on this route, so this is a route '
      + 'that works rather than a comparison of departures.';
  }
  return 'Route found. khaali has not evaluated demand or traffic on it.';
}

/** Said plainly, because a missing check is a fact about the answer. */
function notEvaluatedFor(legs, railCheck) {
  const out = [];
  if (legs.some(l => l.mode === 'bus')) out.push('Bus demand for the specific departure');
  if (legs.some(l => l.mode === 'bus')) out.push('Road traffic on the bus stretches');
  if (legs.filter(l => l.mode !== 'walk').length > 1) out.push('A comparison against other departures');
  return out;
}

function bookingFor(legs, status) {
  const reservable = legs.some(l => l.mode === 'train');
  if (status === 'CONFIRMED') return { status, actionLabel: 'Booking confirmed', enabled: false };
  if (status === 'HELD') return { status, actionLabel: 'Pay and confirm', enabled: true };
  return {
    status: 'NONE',
    // it creates a hold and a pending pass; saying "book" claims a state the
    // click does not reach
    actionLabel: reservable ? 'Hold train accommodation and continue' : 'Choose this journey',
    enabled: true,
    note: reservable
      ? 'This holds a berth and starts a pass. Nothing is confirmed until payment.'
      : 'Nothing on this journey is reservable; khaali issues a pass to board.',
  };
}
