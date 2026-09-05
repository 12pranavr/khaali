// ---------------------------------------------------------------------------
// The departures of a bus route, and what khaali believes is aboard each one.
//
// buses.mjs has routes: a headway, a run time, a first and a last. A headway is
// not something anybody can board. This turns it into DEPARTURES - the 07:15,
// the 07:45, the 08:15 - each with its own identity, its own ledger and its own
// answer, because the 07:15 being full says nothing about the 07:45.
//
// WHERE THE NUMBERS COME FROM, in the order khaali prefers them:
//
//   this-trip   a conductor has actually ticketed this departure through
//               /conduct. Simulated, but simulated ABOUT THIS BUS - which is
//               what makes the demo true rather than a slideshow.
//   model       nobody has, so khaali synthesises a plausible day-curve for it
//               and says out loud that this is its model.
//
// There is a third rung in the plan - history over completed trips of the same
// route and hour - and it is deliberately not here. One or two completed trips
// are records, not history, and khaali would rather say "insufficient
// completed-trip history" than average two mornings into a fact.
//
// NOTHING IN THIS FILE IS MEASURED. No operator is connected. Every event it
// generates carries sourceKind 'simulation', and constraint.publishedQuality
// floors the lot at `simulated` no matter who registers later.

import * as trip from './trip.mjs';
import * as conductor from './conductor.mjs';
import * as capacity from './capacity.mjs';

/**
 * What khaali assumes these vehicles hold. Declared, not measured - which is
 * why every one of them carries source 'demo' and reaches the planner as an
 * explicit capacity object rather than a bare number.
 */
export const FLEET = {
  KSRTC: { seatedCapacity: 50, allowedStandingCapacity: 0, source: 'demo' },
  BMTC: { seatedCapacity: 35, allowedStandingCapacity: 20, source: 'demo' },
};
export const capacityFor = op => trip.capacityOf(FLEET[op] || FLEET.BMTC);

/** Where the crowd peaks along a route: not at the ends, and not the middle. */
const PEAK_AT = 0.58;

/** Every departure of one route on one date, within a window. */
export function departuresOf(bus, serviceDate, fromMin = 0, toMin = 1440) {
  const out = [];
  for (let m = bus.first; m <= bus.last; m += bus.every) {
    if (m < fromMin || m > toMin) continue;
    out.push({
      depMin: m, arrMin: m + bus.runMin, bus,
      departure: trip.departure({
        operatorId: bus.op, tripId: bus.id, serviceDate,
        directionId: 0, patternId: bus.id + '/P0', scheduledStartTime: m,
      }),
    });
  }
  return out;
}

/**
 * The ledger. One array of conductor events per departure, and a note of
 * whether a person put them there or khaali did.
 */
const EVENTS = new Map();
const BASIS = new Map();

export function record(ev) {
  const id = ev.tripInstanceId;
  if (!EVENTS.has(id)) EVENTS.set(id, []);
  EVENTS.get(id).push(ev);
  BASIS.set(id, 'this-trip');
  return ev;
}
export const eventsOf = id => (EVENTS.get(id) || []).slice();
export const basisOf = id => BASIS.get(id) || 'model';
export const known = () => [...EVENTS.keys()];
export function forget(id) { EVENTS.delete(id); BASIS.delete(id); }
export function reset() { EVENTS.clear(); BASIS.clear(); }

/**
 * The curve khaali makes up when nobody has told it anything.
 *
 * It is built as real ticket spans rather than as a load array, so the same
 * arithmetic that reads a conductor's ledger reads this one - there is no
 * second code path where a modelled bus is counted differently from a ticketed
 * one. The cohorts carry stable ids (`model:...`) so a test can tell khaali's
 * invention apart from anybody's actual ticket.
 */
export function modelEvents(d, { loadAt = capacity.busLoadAt } = {}) {
  const bus = d.bus, id = d.departure.id;
  const stops = bus.nStops, n = trip.stretchCount(stops);
  const cap = capacityFor(bus.op);
  const evs = [conductor.event({ kind: 'bustrip', id: 'model:' + id + ':head',
    tripInstanceId: id, stopCount: stops, capacity: FLEET[bus.op] || FLEET.BMTC,
    at: 0, seq: 0, sourceKind: 'simulation' })];

  const f = Math.max(0, Math.min(1.15, Number(loadAt(d.depMin)) || 0));
  const peak = Math.round(f * cap.boardingCapacity);
  if (peak <= 0) return evs;

  // a hump: nobody aboard at the first stop, fullest a little past the middle,
  // empty at the last
  const want = [];
  for (let k = 0; k < n; k++) {
    const x = n === 1 ? 0 : k / (n - 1);
    const w = x <= PEAK_AT ? (x / PEAK_AT) : (1 - (x - PEAK_AT) / (1 - PEAK_AT));
    want.push(Math.max(0, Math.round(peak * w)));
  }

  // turn the curve into spans exactly, by opening a cohort where it rises and
  // closing one where it falls
  const open = [];
  let seq = 1, made = 0, on = 0;
  for (let k = 0; k < n; k++) {
    const delta = want[k] - on;
    if (delta > 0) { open.push({ from: k, pax: delta }); on += delta; }
    else if (delta < 0) {
      let owe = -delta;
      while (owe > 0 && open.length) {
        const c = open[0];
        const take = Math.min(owe, c.pax);
        evs.push(conductor.event({ kind: 'ticket', id: 'model:' + id + ':' + (++made),
          tripInstanceId: id, stopSequence: c.from, toStopSequence: k, pax: take,
          at: 0, seq: ++seq, sourceKind: 'simulation' }));
        c.pax -= take; owe -= take; on -= take;
        if (c.pax === 0) open.shift();
      }
    }
  }
  open.forEach(c => {
    if (c.pax > 0) evs.push(conductor.event({ kind: 'ticket', id: 'model:' + id + ':' + (++made),
      tripInstanceId: id, stopSequence: c.from, toStopSequence: stops - 1, pax: c.pax,
      at: 0, seq: ++seq, sourceKind: 'simulation' }));
  });
  return evs;
}

const CACHE = new Map();

/**
 * What khaali believes about one departure, with the basis attached. A ledger
 * a person filled in wins; otherwise the model, saying so.
 */
export function profileFor(d, opts = {}) {
  const id = d.departure.id;
  const mine = EVENTS.get(id);
  if (mine && mine.length) {
    const p = conductor.profile(mine, { tripInstanceId: id });
    return { ...p, basis: 'this-trip', generatedAt: opts.now == null ? Date.now() : opts.now };
  }
  if (!CACHE.has(id)) CACHE.set(id, conductor.profile(modelEvents(d, opts), { tripInstanceId: id }));
  const p = CACHE.get(id);
  // the model has no age of its own; it is as current as the question
  return { ...p, basis: 'model', generatedAt: opts.now == null ? Date.now() : opts.now };
}

/**
 * Candidate bus departures for one stretch, as split.mjs wants them.
 *
 * `fromStopSequence` and `toStopSequence` are where along the PATTERN she rides,
 * which is not the same as which stations the bus connects. boardIdx is the one
 * number buses.mjs exists for.
 */
export function candidates(bus, serviceDate, after, { toStopSequence = null, now = null,
                                                      limit = 4, loadAt } = {}) {
  const from = bus.boardIdx || 0;
  const to = toStopSequence == null ? bus.nStops - 1 : toStopSequence;
  return departuresOf(bus, serviceDate, after, after + 240).slice(0, limit).map(d => ({
    tripInstanceId: d.departure.id,
    departure: d.departure,
    id: bus.id, name: bus.op + ' ' + bus.id,
    depMin: d.depMin, arrMin: d.arrMin,
    source: bus.source,                 // 'simulated' for KSRTC: the buffer knows
    fromStopSequence: from, toStopSequence: to,
    walkMinutes: 0,
    profile: profileFor(d, { now, loadAt }),
    basis: basisOf(d.departure.id),
  }));
}
