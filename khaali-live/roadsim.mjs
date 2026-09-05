// ---------------------------------------------------------------------------
// How long the road actually takes, stretch by stretch.
//
// A jam and a crowd are different facts and this file only knows about one of
// them. A bus can be nearly empty and forty minutes late because the road ahead
// is solid; it can be packed and moving freely. Merging the two into a single
// "how bad is this bus" number loses the distinction the passenger cares about,
// because the answers differ: you wait for the next one if it is crowded, and
// you get off the road entirely if it is jammed.
//
// TIME MATTERS, AND IT IS THE TIME THE BUS REACHES THE STRETCH. A bus leaving at
// ten o'clock meets the eleven o'clock traffic on its last stretch, not the ten
// o'clock traffic. Costing every stretch at the search time is how a planner
// decides a two-hour journey is fine because the first ten minutes were.
//
// And it applies to ROADS. A metro stretch has no road delay; if that service
// runs late it is because the service is late, which is a separate control and
// a separate number.

import * as scenario from './scenario.mjs';
import * as demonet from './demonet.mjs';

export const SOURCE = 'simulated road delay - khaali measures no traffic';

/** The stretch after the interchange is the one the demo is about. */
const AFTER_MID = (route, k) => {
  const mid = demonet.seqOf(route, 'MID');
  return mid >= 0 && k >= mid;
};

/**
 * Minutes a service runs late on one of its own stretches, for reasons that are
 * nothing to do with the road: a signal fault, a held train. Kept in its own
 * function and its own field so a card can never report a tunnel as congested.
 */
export function serviceDelayFor(route, k) {
  if (route.road && route.road[k]) return 0;      // roads answer to traffic, not this
  const st = scenario.state();
  const knob = route.mode === 'metro' ? st.metroDelayMin : 0;
  if (knob <= 0) return 0;
  const stretches = route.road.filter(r => !r).length || 1;
  return Math.max(0, Math.round(knob / stretches));
}

/**
 * Minutes of delay on one stretch of one route, for a bus reaching it at a
 * given minute. Deterministic: the same stretch at the same minute under the
 * same seed is always the same number.
 */
export function delayFor(route, k, atMinute) {
  if (!route.road || !route.road[k]) return 0;          // not a road, no jam
  const st = scenario.state();
  const after = AFTER_MID(route, k);
  const knob = after ? st.downstreamRoadDelayMin : st.upstreamRoadDelayMin;
  if (knob <= 0) return 0;
  /* The knob is minutes of delay across the whole side of the interchange, not
     per stretch - "thirty minutes of traffic between K R Puram and Hebbala".
     Applying it per stretch made a four-stop route twice as bad as a two-stop
     one over the same ground, which is a fact about the timetable's stop
     spacing rather than about the road. */
  const side = route.road.map((isRoad, i) => (isRoad && AFTER_MID(route, i) === after)
    ? route.base[i] : 0);
  const total = side.reduce((a, b) => a + b, 0) || 1;
  const share = side[k] / total;
  // the shoulders of the window are easier, and a stretch keeps its character
  const hour = Math.floor(((atMinute % 1440) + 1440) % 1440 / 60);
  const peak = hour >= 8 && hour <= 11 ? 1 : hour >= 17 && hour <= 20 ? 0.9 : 0.45;
  const own = 0.85 + scenario.rand('road', route.id, k) * 0.3;
  return Math.max(0, Math.round(knob * share * peak * own));
}

/**
 * Run the vehicle along its pattern, costing each stretch at the minute it is
 * actually reached. Returns every term separately so a caller can say which
 * part of a long journey was road and which was timetable.
 */
export function runAcross(dep, fromSeq, toSeq) {
  const route = demonet.routeOf(dep.routeId);
  const lo = Math.min(fromSeq, toSeq), hi = Math.max(fromSeq, toSeq);
  const legs = [];
  // walk the pattern from its start so the clock at `lo` is the real one
  let t = dep.departureTime;
  for (let k = 0; k < route.base.length; k++) {
    const base = route.base[k];
    const delay = delayFor(route, k, t);
    const service = serviceDelayFor(route, k);
    const predicted = base + delay + service;
    if (k >= lo && k < hi) legs.push({
      fromStopSequence: k, toStopSequence: k + 1,
      fromStop: route.stops[k], toStop: route.stops[k + 1],
      baseTravelMinutes: base, trafficDelayMinutes: delay,
      serviceDelayMinutes: service,
      predictedTravelMinutes: predicted,
      isRoad: !!route.road[k],
      startMinute: t, endMinute: t + predicted,
      fareContribution: route.fareStages[k] || 0,
      evidence: { sourceKind: scenario.SOURCE_KIND, basis: SOURCE, revision: scenario.state().revision },
    });
    t += predicted;
  }
  const base = legs.reduce((a, l) => a + l.baseTravelMinutes, 0);
  const delay = legs.reduce((a, l) => a + l.trafficDelayMinutes, 0);
  const service = legs.reduce((a, l) => a + l.serviceDelayMinutes, 0);
  const fare = legs.reduce((a, l) => a + l.fareContribution, 0);
  return {
    legs, baseMinutes: base, delayMinutes: delay, serviceDelayMinutes: service,
    predictedMinutes: base + delay + service,
    boardMinute: legs.length ? legs[0].startMinute : null,
    arriveMinute: legs.length ? legs[legs.length - 1].endMinute : null,
    fare,
    // what khaali is prepared to say it does NOT know about that arrival. A
    // delayed road is a less certain arrival, and transfer.mjs spends this
    // rather than a whole headway, because she is already aboard by then.
    uncertaintyMinutes: Math.max(2, Math.round(3 + (delay + service) * 0.18)),
  };
}

/** When this departure reaches a stop, having met the traffic on the way. */
export function reachesAt(dep, seq) {
  if (seq === 0) return dep.departureTime;
  const r = runAcross(dep, 0, seq);
  return r.arriveMinute;
}
