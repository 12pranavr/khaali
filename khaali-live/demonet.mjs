// ---------------------------------------------------------------------------
// A small network khaali can reason about completely.
//
// Every service here is INVENTED. Karnataka publishes no bus departures and no
// road speeds, so a demo that waits for them demonstrates nothing; what it can
// do is state the invention plainly and then reason honestly from it. Every
// departure carries sourceKind 'simulation' and a synthetic trip id, and
// nothing in khaali will call these verified operator services.
//
// The coordinates are real, because the demo has to be reachable from an
// ordinary search on the site rather than living behind its own button.
//
// THE SHAPE, and why it is this shape:
//
//   ORIGIN ----------------- MID ----------------- DEST
//   Hope Farm          K R Puram             Hebbala
//              bus A straight through
//              bus B, a different departure
//                             bus C, from here
//                             metro M, from a stop 5 minutes' walk away
//
// A through bus and a change, competing. The through bus needs no walking and
// no second boarding, which is a real advantage; the change wins only when what
// happens on the road after MID is bad enough to pay for them. That is the
// judgement the planner has to make, and it must be able to come out either way.
//
// STOPS ARE NOT AREAS. "K R Puram" is a bus stand and a metro entrance several
// hundred metres apart, and they are two stops here with a walk between them,
// because treating them as one point is how a plan asks somebody to be in two
// places at once.

import * as scenario from './scenario.mjs';

export const DEMO = true;
export const LABEL = 'Demo timetable. These departures are simulated - no operator publishes them.';

export const STOPS = [
  { id: 'ORIGIN', n: 'Hope Farm', kind: 'bus', lat: 12.98273, lng: 77.75223 },
  { id: 'S1', n: 'Garudachar Palya', kind: 'bus', lat: 12.99150, lng: 77.71600 },
  { id: 'MID', n: 'K R Puram Bus Stand', kind: 'bus', lat: 13.00780, lng: 77.67800 },
  { id: 'MID_M', n: 'K R Puram Metro', kind: 'metro', lat: 13.00560, lng: 77.67560 },
  { id: 'S3', n: 'Banaswadi', kind: 'bus', lat: 13.01400, lng: 77.63300 },
  { id: 'DEST_M', n: 'Hebbala Metro', kind: 'metro', lat: 13.04270, lng: 77.59400 },
  { id: 'DEST', n: 'Hebbala', kind: 'bus', lat: 13.04127, lng: 77.58942 },
];
export const stopOf = id => STOPS.find(s => s.id === id) || null;
export const idx = id => STOPS.findIndex(s => s.id === id);

/**
 * Walking connections, stated rather than derived from a straight line.
 * `stationEntryMinutes` is the bit that is not walking - getting through a
 * gate, down to a platform - and it is zero for a bus stop on a pavement.
 */
export const WALKS = [
  { from: 'MID', to: 'MID_M', minutes: 5, stationEntryMinutes: 2, accessible: true },
  { from: 'MID_M', to: 'MID', minutes: 5, stationEntryMinutes: 0, accessible: true },
  { from: 'DEST_M', to: 'DEST', minutes: 5, stationEntryMinutes: 0, accessible: true },
  { from: 'DEST', to: 'DEST_M', minutes: 5, stationEntryMinutes: 2, accessible: true },
];
export function walkBetween(from, to) {
  if (from === to) return { from, to, minutes: 0, stationEntryMinutes: 0, accessible: true };
  const w = WALKS.find(x => x.from === from && x.to === to);
  if (!w) return null;
  const extra = Math.max(0, scenario.state().walkExtraMin);
  return { ...w, minutes: w.minutes + extra, extraFromScenario: extra };
}

/**
 * The services. `base` is the running time of each stretch with an empty road;
 * `road` says whether that stretch is on a road at all, which decides whether
 * traffic may touch it. A metro tunnel does not have a jam in it.
 */
export const ROUTES = [
  {
    id: 'A', mode: 'bus', name: 'Bus A', operator: 'DEMO',
    stops: ['ORIGIN', 'S1', 'MID', 'S3', 'DEST'],
    base: [9, 11, 10, 10],                    // 20 min to MID, 20 min onward
    road: [true, true, true, true],
    first: 540, last: 780, every: 20,         // 09:00 to 13:00, every 20
    seats: 32, standing: 18,
    fareStages: [8, 8, 7, 7],
  },
  {
    id: 'B', mode: 'bus', name: 'Bus B', operator: 'DEMO',
    stops: ['ORIGIN', 'S1', 'MID', 'S3', 'DEST'],
    base: [10, 12, 10, 10],
    road: [true, true, true, true],
    first: 550, last: 790, every: 20,         // offset from A by ten minutes
    seats: 32, standing: 18,
    fareStages: [8, 8, 7, 7],
  },
  {
    id: 'C', mode: 'bus', name: 'Bus C', operator: 'DEMO',
    stops: ['MID', 'S3', 'DEST'],
    base: [10, 10],
    road: [true, true],
    first: 545, last: 800, every: 15,
    seats: 28, standing: 14,
    fareStages: [7, 7],
  },
  {
    id: 'M', mode: 'metro', name: 'Metro M', operator: 'DEMO',
    stops: ['MID_M', 'DEST_M'],
    base: [15],
    road: [false],                            // a jam on the road is not a jam here
    first: 542, last: 820, every: 6,
    seats: 50, standing: 250,
    fareStages: [25],
  },
];
export const routeOf = id => ROUTES.find(r => r.id === id) || null;

/** Where a stop sits in a route's pattern, or -1. A route that visits a stop
    twice would need this to return a list; none here does, and the shape says so. */
export const seqOf = (route, stopId) => route.stops.indexOf(stopId);

export const capacityOf = r => ({
  seatedCapacity: r.seats, allowedStandingCapacity: r.standing,
  boardingCapacity: r.seats + r.standing,
  source: 'demo timetable', updatedAt: null,
});

/**
 * Every departure of every route on the demo day, as trip INSTANCES. A headway
 * is not something anybody can board; these are.
 */
export function departures(routeId, { from = 0, to = 1440 } = {}) {
  const r = routeOf(routeId);
  if (!r) return [];
  const st = scenario.state();
  const out = [];
  for (let m = r.first; m <= r.last; m += r.every) {
    if (m < from || m > to) continue;
    /* A late vehicle is a different fact from a slow road. Bus A's control
       moves its departure, because that is what a late bus is.

       The metro's control deliberately does NOT move its departure: shifting a
       six-minute headway by thirty minutes leaves the same set of times on the
       clock, so the control did nothing at all. A disrupted metro is a trip
       that takes longer, and roadsim carries that as a service delay - kept
       apart from road delay, because there is no traffic in a tunnel. */
    const shift = (routeId === 'A' ? st.busADelayMin : 0);
    const id = 'DEMO|' + routeId + '|' + m;
    out.push({
      tripInstanceId: id, routeId, mode: r.mode, name: r.name,
      serviceDate: 'demo', scheduledDeparture: m,
      departureTime: m + shift, delayMinutes: shift,
      capacity: capacityOf(r), sourceKind: scenario.SOURCE_KIND,
      cancelled: scenario.isCancelled(id),
      every: r.every, stops: r.stops.slice(),
    });
  }
  return out;
}

/** Every departure of every route, which the panel and the tests both want. */
export function allDepartures(opts) {
  return ROUTES.flatMap(r => departures(r.id, opts));
}

/** Is this journey one the demo network can answer at all? */
export const REACH_KM = 1.2;
export function nearestStop(lat, lng, within = REACH_KM) {
  let best = null;
  STOPS.forEach(s => {
    const d = haversine(lat, lng, s.lat, s.lng);
    if (d <= within && (!best || d < best.km)) best = { stop: s, km: Math.round(d * 100) / 100 };
  });
  return best;
}
function haversine(a1, b1, a2, b2) {
  const R = 6371, p = Math.PI / 180;
  const dLat = (a2 - a1) * p, dLng = (b2 - b1) * p;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(a1 * p) * Math.cos(a2 * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
