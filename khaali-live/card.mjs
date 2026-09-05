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
                        scenario = null, bookingStatus = 'NONE',
                        alternative = null, selectedChainId = null,
                        role = null } = {}) {
  if (!chain || !chain.legs || !chain.legs.length) return null;
  const legs = chain.legs;
  const t = timing(legs, searchAt);
  const evaluated = !!(mp && mp.answer && mp.decision);
  const railCheck = railDecision && railDecision.railCheck;
  const status = evaluated ? 'EVALUATED'
    : (railCheck && railCheck.outcome) ? 'AVAILABILITY_ONLY' : 'NOT_EVALUATED';

  const cmp = evaluated ? comparisonOf(mp) : null;
  return {
    /* The card's identity and standing, at the top where a consumer looks
       first: which chain this is, how much was actually established about it,
       and whether it is the winner or an alternative. The role is the
       caller's to assign - only the caller knows the ranking - and absent
       when the caller did not say. */
    chainId: chain.chainId || selectedChainId || null,
    evaluationStatus: status,
    recommendationStatus: role === 'RECOMMENDED' ? 'RECOMMENDED'
      : role === 'ALTERNATIVE' ? 'ALTERNATIVE' : null,
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
      /* The selection, explained: one benefit sentence and at most three
         reasons, each carrying the choice, the alternative it beat and the
         evidence that separated them. Every one comes from the planner's own
         trace; when the backend produced no comparison there is no rationale,
         and the card says NOT COMPARED instead of manufacturing one. */
      rationale: evaluated ? {
        benefit: benefitFor(cmp, t, legs, mp),
        choices: (mp.decision.choices || []).slice(0, 3),
      } : null,
      /* This card against ONE named alternative from the same search - the
         per-card comparison, computed rather than copied from a page-level
         panel that may have been about something else. Null whenever the
         differences could not actually be established. */
      optionComparison: (!evaluated && alternative && alternative.chain)
        ? optionComparisonOf(chain, alternative.chain, {
          selectedChainId,
          alternativeChainId: alternative.chainId || null })
        : null,
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
      /* One source line per mode actually ridden, so a mixed journey never
         wears one mode's evidence as if it covered the rest. Null when the
         journey has no leg of that mode - no leg, no source claim. */
      trainInventorySource: legs.some(l => l.mode === 'train')
        ? 'khaali’s own demo reservation inventory, counted per stretch' : null,
      busDemandSource: legs.some(l => l.mode === 'bus')
        ? (evaluated ? 'simulated conductor and demand model'
          : legs.some(l => l.mode === 'bus' && l.cap && l.cap.quality === 'counted')
            ? 'khaali ticket scans - a floor, not an occupancy'
            : 'khaali’s simulated demand model - no operator is connected') : null,
      metroDemandSource: legs.some(l => l.mode === 'metro')
        ? (legs.some(l => l.mode === 'metro' && l.cap && l.cap.quality === 'simulated')
          ? 'simulated demand model on the demo network'
          : 'BMRCL weekday hourly station entries; onboard crowding is not measured') : null,
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

/** 110 -> "1 hour 50 minutes". A card is read aloud, not parsed. */
const fmtDur = (m) => {
  const n = Math.abs(Math.round(m));
  if (n < 60) return mins(n);
  const h = Math.floor(n / 60), r = n % 60;
  return h + (h === 1 ? ' hour' : ' hours') + (r ? (' ' + mins(r)) : '');
};

/**
 * This card against ONE named alternative from the same search.
 *
 * The page used to carry a panel at the top claiming the pick was cheaper and
 * less crowded while the card underneath said demand was never evaluated - two
 * evaluators, one screen, contradicting each other. This is the fix, not a
 * relocation: the numbers are computed HERE, from the two journeys as planned
 * for this exact search - same origin, destination, party and constraints -
 * and only differences that were actually established become sentences. Time,
 * fare and transfers are hard numbers off the itineraries. Bus load is the
 * simulated demand model and says so. Road traffic was not evaluated on this
 * path, so no sentence claims it.
 */
/* What each mode's load percentage is actually a percentage OF. Only figures
   sharing a basis may be numerically compared; there are deliberately no
   cross-basis pairs today - adding one requires defining the common measure. */
const CROWD_BASIS = { train: 'berth-inventory', bus: 'onboard-load', metro: 'station-entries' };
const COMPARABLE_PAIRS = new Set();   // 'basisA|basisB', both directions, when ever defined

export function optionComparisonOf(chain, alt, { selectedChainId = null,
                                                 alternativeChainId = null } = {}) {
  if (!chain || !alt || !alt.legs) return null;
  const namesOf = c => (c.legs || []).filter(l => l.mode !== 'walk')
    .map(l => l.name || l.line || MODE_WORD[l.mode] || l.mode);
  const selNames = namesOf(chain), altNames = namesOf(alt);
  if (!selNames.length || !altNames.length) return null;
  const dest = chain.legs[chain.legs.length - 1].to;
  /* Two departures of one service wear the same name, and "take the MEMU
     instead of the MEMU" is not a sentence anybody can act on - when the names
     collide, each side carries its departure time. */
  let selectedLabel = selNames.join(' then ');
  let alternativeLabel = altNames.join(' then ');
  if (selectedLabel === alternativeLabel) {
    const depOf = c => { const r = (c.legs || []).find(l => l.mode !== 'walk');
      return r ? (r.dep || (r.depMin != null ? hhmm(r.depMin) : null)) : null; };
    const a = depOf(chain), b = depOf(alt);
    if (a) selectedLabel += ' (' + a + ')';
    if (b) alternativeLabel += ' (' + b + ')';
  }

  /* ARRIVAL, not duration. A train that leaves 25 minutes earlier and takes
     ten minutes longer gets her there first, and the duration arithmetic was
     calling that "arrives 10 minutes later" - wrong in exactly the way a
     passenger would catch. Both chains share one search clock, so their
     arrival minutes compare directly. */
  const timeDifferenceMinutes = (chain.arr != null && alt.arr != null)
    ? alt.arr - chain.arr
    : ((chain.totalMin != null && alt.totalMin != null)
      ? alt.totalMin - chain.totalMin : null);       // positive: this one arrives earlier
  const fareDifference = (chain.fare != null && alt.fare != null)
    ? chain.fare - alt.fare : null;                  // negative: this one is cheaper
  const transferDifference = (chain.changes != null && alt.changes != null)
    ? chain.changes - alt.changes : null;            // negative: fewer changes

  const differences = [];
  if (timeDifferenceMinutes > 0) differences.push('arrives ' + fmtDur(timeDifferenceMinutes) + ' earlier');
  else if (timeDifferenceMinutes < 0) differences.push('arrives ' + fmtDur(timeDifferenceMinutes) + ' later');
  if (fareDifference < 0) differences.push('₹' + (-fareDifference) + ' cheaper');
  else if (fareDifference > 0) differences.push('₹' + fareDifference + ' more');
  if (transferDifference < 0) differences.push(-transferDifference === 1
    ? 'one fewer transfer' : (-transferDifference) + ' fewer transfers');
  else if (transferDifference > 0) differences.push(transferDifference === 1
    ? 'one more transfer' : transferDifference + ' more transfers');

  /* Crowding, when both sides carry a measured or modelled load. Without this
     the recommended train could only say "arrives 10 minutes later" - true,
     and missing the entire reason it was recommended, which was the quieter
     ride. Compared only when both numbers exist, and stated as the two
     percentages so the reader sees the claim's size, not just its direction. */
  const worstOcc = c => {
    const L = (c.legs || []).filter(l => l.mode !== 'walk' && l.cap && l.cap.occupancy != null);
    return L.length ? L.reduce((p, l) => l.cap.occupancy > p.cap.occupancy ? l : p) : null;
  };
  const selW = worstOcc(chain), altW = worstOcc(alt);
  /* Two load percentages are only a comparison when they measure the same
     thing. A train's number is booked berth inventory, a bus's is projected
     onboard load, the metro's is hourly ENTRIES at a station - a percentage of
     that station's own busiest hour, which says nothing about who is inside a
     carriage. "38% vs 81%" across those bases is arithmetic on apples and
     stations. When the bases differ, the evidence is described on each side
     separately and no "less crowded" verdict is issued. */
  const basisOf = l => CROWD_BASIS[l.mode] || l.mode;
  const crowdSideOf = l => l ? { mode: l.mode, basis: basisOf(l),
    occupancy: l.cap.occupancy, quality: l.cap.quality || 'simulated' } : null;
  const crowdingComparable = !!(selW && altW && (basisOf(selW) === basisOf(altW)
    || COMPARABLE_PAIRS.has(basisOf(selW) + '|' + basisOf(altW))));
  let crowdingDifference = null;
  if (crowdingComparable) {
    const d = altW.cap.occupancy - selW.cap.occupancy;   // positive: this one is calmer
    if (Math.abs(d) >= 0.08) {
      crowdingDifference = Math.round(d * 100);
      const a = Math.round(selW.cap.occupancy * 100), b = Math.round(altW.cap.occupancy * 100);
      if (d > 0) differences.push('less crowded: ' + a + '% at its busiest against ' + b + '%');
      else differences.push('more crowded: ' + a + '% at its busiest against ' + b + '%');
    }
  }
  const crowdingComparison = (selW || altW) ? {
    selected: crowdSideOf(selW), alternative: crowdSideOf(altW),
    comparable: crowdingComparable,
    note: crowdingComparable ? null
      : 'These figures measure different things and are not compared.',
  } : null;
  if (!differences.length) return null;              // nothing established, nothing said

  // ONE sentence on the card: the comparison named once, what was won, and
  // what it cost. The itemised differences live behind See comparison only -
  // a sentence and three bullets saying the same thing is the case argued
  // twice, and the second telling adds doubt rather than weight.
  const gains = [], costs = [];
  if (timeDifferenceMinutes > 0) gains.push('arrives '
    + fmtDur(timeDifferenceMinutes) + ' earlier');
  else if (timeDifferenceMinutes < 0) costs.push('arrives ' + fmtDur(timeDifferenceMinutes) + ' later');
  if (fareDifference < 0) gains.push('costs ₹' + (-fareDifference) + ' less');
  else if (fareDifference > 0) costs.push('costs ₹' + fareDifference + ' more');
  if (transferDifference < 0) gains.push(-transferDifference === 1
    ? 'avoids a transfer' : ('avoids ' + (-transferDifference) + ' transfers'));
  else if (transferDifference > 0) costs.push('adds ' + (transferDifference === 1
    ? 'a transfer' : transferDifference + ' transfers'));
  if (crowdingDifference != null && selW && altW) {
    const a = Math.round(selW.cap.occupancy * 100), b = Math.round(altW.cap.occupancy * 100);
    if (crowdingDifference > 0) gains.push('is less crowded (' + a
      + '% at its busiest against ' + b + '%)');
    else costs.push('is more crowded (' + a + '% at its busiest against ' + b + '%)');
  }
  const list = a => a.length === 1 ? a[0]
    : a.slice(0, -1).join(', ') + (a.length > 2 ? ',' : '') + ' and ' + a[a.length - 1];
  // a journey with nothing to brag about states its costs plainly - "holds
  // its own" is only true when there is nothing on the other side either
  const summaryReason = 'Compared with ' + alternativeLabel + ', this journey '
    + (gains.length
      ? (list(gains) + (costs.length ? (', though it ' + list(costs)) : ''))
      : (costs.length ? list(costs) : 'holds its own'))
    + '.';

  /* The load on the ride she would actually be on - said in the vocabulary of
     the vehicle that carries it. This used to say "Predicted bus load" about a
     TRAIN, whose berth occupancy khaali counts exactly from its own inventory,
     and told an all-train journey that no bus seat was reserved. Any origin to
     any destination means any mix of vehicles, and each number must say what
     it is and where it came from, or the card is only right on one corridor. */
  const capped = (chain.legs || []).filter(l => l.mode !== 'walk'
    && l.cap && l.cap.occupancy != null);
  const worst = capped.length
    ? capped.reduce((p, l) => l.cap.occupancy > p.cap.occupancy ? l : p) : null;
  const SRC = {
    exact: 'counted from khaali’s own berth inventory',
    mixed: 'counted from khaali’s own berth inventory',
    counted: 'counted from ticketing',
    estimated: 'worked out from the timetable',
    predicted: 'from BMRCL’s hourly station entries',
    simulated: 'khaali’s simulated demand model',
  };
  const LOAD_WORD = { train: 'Train occupancy', metro: 'Metro station crowding', bus: 'Predicted bus load' };
  /* The sentence must say what its percentage is a percentage OF. The metro
     figure is hourly ENTRIES at a station against that station's own peak - it
     was reading "at the busiest point of your ride", which is onboard language
     for a number that has never seen the inside of a carriage. */
  const demandEvidence = worst ? {
    mode: worst.mode, basis: CROWD_BASIS[worst.mode] || worst.mode,
    occupancy: worst.cap.occupancy, quality: worst.cap.quality || 'simulated',
    says: (LOAD_WORD[worst.mode] || 'Load') + ': '
      + Math.round(worst.cap.occupancy * 100)
      + (worst.mode === 'metro'
        ? '% of that station’s busiest hour — '
          + (SRC[worst.cap.quality] || 'khaali’s model')
          + '. Onboard crowding is unknown.'
        : '% at the busiest point of your ride — '
          + (SRC[worst.cap.quality] || 'khaali’s model') + '.'),
  } : null;

  // the disclosure owns exactly what this journey leaves unknown, no more
  const rideModes = new Set((chain.legs || []).filter(l => l.mode !== 'walk').map(l => l.mode));
  const unreserved = ['bus', 'metro'].filter(m => rideModes.has(m));
  const onRoad = rideModes.has('bus') || rideModes.has('car')
    || rideModes.has('auto') || rideModes.has('bike');
  const anySimulated = capped.some(l => l.cap.quality === 'simulated');
  const caveats = [];
  if (anySimulated) caveats.push('some loads here are simulated');
  if (onRoad) caveats.push('road traffic is not evaluated');
  const disclosure = [
    caveats.length ? (caveats.join('; ').charAt(0).toUpperCase() + caveats.join('; ').slice(1) + '.') : '',
    unreserved.length
      ? ('No seat is reserved on ' + (unreserved.length === 2 ? 'the bus or the metro'
        : 'the ' + unreserved[0]) + '.')
      : (rideModes.has('train') ? 'Berth counts are khaali’s own inventory.' : ''),
  ].filter(Boolean).join(' ');

  const single = chain.changes === 0 && selNames.length === 1;
  const altSingle = alt.changes === 0 && altNames.length === 1;
  /* Machine-readable mirror of the established differences - each code exists
     only because its number does, so a consumer can never cite a claim the
     ledger did not make. */
  const reasonCodes = [];
  if (timeDifferenceMinutes > 0) reasonCodes.push('ARRIVES_EARLIER');
  else if (timeDifferenceMinutes < 0) reasonCodes.push('ARRIVES_LATER');
  if (fareDifference < 0) reasonCodes.push('CHEAPER');
  else if (fareDifference > 0) reasonCodes.push('COSTS_MORE');
  if (transferDifference < 0) reasonCodes.push('FEWER_TRANSFERS');
  else if (transferDifference > 0) reasonCodes.push('MORE_TRANSFERS');
  if (crowdingDifference != null) reasonCodes.push(crowdingDifference > 0
    ? 'LESS_CROWDED' : 'MORE_CROWDED');
  return {
    selectedChainId, alternativeChainId,
    selectedLabel, alternativeLabel,
    /* Infeasible candidates are removed before ranking and never enter the
       chains list, so an alternative drawn from it was plannable for this
       exact search - the invariant this field states rather than assumes. */
    alternativeFeasible: true,
    selectedArrival: chain.arr != null ? hhmm(chain.arr) : (chain.arrText || null),
    alternativeArrival: alt.arr != null ? hhmm(alt.arr) : (alt.arrText || null),
    arrivalDifferenceMinutes: timeDifferenceMinutes,
    selectedFare: chain.fare != null ? chain.fare : null,
    alternativeFare: alt.fare != null ? alt.fare : null,
    selectedTransfers: chain.changes != null ? chain.changes : null,
    alternativeTransfers: alt.changes != null ? alt.changes : null,
    fareBasis: 'per person',
    reasonCodes,
    // "Stay on" is for keeping one vehicle rather than breaking the journey
    // up; between two single vehicles - this train or that train - it is a
    // plain choice, and the verb is Take
    headline: ((single && !altSingle) ? ('Stay on ' + selectedLabel + ' instead of taking ')
      : ('Take ' + selectedLabel + ' instead of '))
      + alternativeLabel + '.',
    summaryReason,
    differences,
    timeDifferenceMinutes, fareDifference, transferDifference,
    crowdingDifference, crowdingComparable, crowdingComparison,
    demandEvidence,
    trafficEvidence: onRoad ? 'not evaluated' : 'no road legs',
    disclosure,
    thisArrive: chain.arrText || null, thisTotalMinutes: chain.totalMin,
    alternativeArrive: alt.arrText || null, alternativeTotalMinutes: alt.totalMin,
    howEstimated: 'Times, fares and transfers computed from the two journeys as planned '
      + 'for this exact search - same origin, destination, party size and constraints. '
      + (demandEvidence ? ('The load figure is ' + (SRC[demandEvidence.quality] || 'khaali’s model') + '. ') : '')
      + (onRoad ? 'Road traffic was not evaluated on this route.'
        : 'No stretch of this journey runs on a road.'),
  };
}

/**
 * YOUR BENEFIT, in one sentence - and the trade-off when that is what it is.
 *
 * "Arrive 20 minutes earlier than the bus arriving 11:18, with 10 minutes of
 * walking and one change. It costs ₹11 more." A slower-but-calmer winner says
 * so instead: a benefit sentence that only knows how to brag would have to lie
 * about that journey.
 */
function benefitFor(cmp, t, legs, mp) {
  if (!cmp) return null;
  const arriveAt = mp && mp.answer ? mp.answer.arrivalTime : null;
  const transfers = Math.max(0, legs.filter(l => l.mode !== 'walk').length - 1);
  const changeWord = transfers === 0 ? 'no changes'
    : transfers === 1 ? 'one change' : transfers + ' changes';
  const rival = 'the ' + cmp.alternativeLabel.replace(', arriving', ' arriving');
  let head;
  if (cmp.timeDifferenceMinutes) {
    head = 'Arrive' + (arriveAt ? (' at ' + arriveAt) : '') + ' - '
      + mins(cmp.timeDifferenceMinutes) + ' earlier than ' + rival + ' -';
  } else if (cmp.crowdingDifferenceMinutes) {
    // the honest trade-off: it did not win on the clock
    head = 'Spend ' + mins(cmp.crowdingDifferenceMinutes)
      + ' less on stretches predicted to be crowded than ' + rival + ',';
  } else {
    head = 'The only journey that passed every check,';
  }
  let s = head + ' with ' + mins(t.walkingMinutes) + ' of walking and ' + changeWord + '.';
  if (cmp.fareDifference != null && cmp.fareDifference !== 0) {
    s += cmp.fareDifference > 0
      ? (' It costs ₹' + cmp.fareDifference + ' more.')
      : (' It saves ₹' + (-cmp.fareDifference) + '.');
  }
  return s;
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
