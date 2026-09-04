// A hired vehicle, for the miles the network does not cover.
//
// khaali deleted an "auto" mode once, and the reason still stands: a planner
// that has BMTC's whole timetable and answers the last five kilometres with
// "take an auto" has not done its job. So a hired ride here is not a shrug. It
// is a named vehicle, a measured distance, a fare range from a published
// tariff, and a booking that goes on the ticket - and it is only ever reached
// AFTER a walk and a named bus have both been tried, and only when the
// passenger asked for it.
//
// Two kinds, deliberately generic: a car and a bike. khaali has no agreement
// with any ride-hailing company and will not imply one by naming it.
//
// Nothing here talks to a language model. This file is arithmetic.

import * as _road from './road.mjs';
import * as _traffic from './traffic.mjs';

/**
 * Vehicles for hire.
 *
 * There is no speed here any more. A car does not have a speed; a ROAD has a
 * speed, and road.mjs measures it from two hundred thousand timed bus segments.
 * What a car has is an advantage over the bus that measured the road, because
 * it does not stop forty times - and a bike has a further advantage, because it
 * filters through what a car queues in. Those two ratios are the only thing
 * this file claims, and it says so out loud.
 */
export const HIRE = {
  car: {
    kind: 'car', name: 'Car', seats: 4, waitMin: 5,
    // a car makes no stops, so it beats the bus that measured the road
    roadFactor: 1.35,
    base: 50, perKm: 16, spread: 0.18, stepFree: true,
    source: 'published four-wheeler city tariff',
    speedSource: 'BMTC-measured road speed, x1.35 for a vehicle that does not stop',
  },
  bike: {
    kind: 'bike', name: 'Bike', seats: 1, waitMin: 3,
    // ...and a two-wheeler filters through the queue the car sits in
    roadFactor: 1.75,
    base: 25, perKm: 8, spread: 0.20, stepFree: false,
    source: 'published two-wheeler city tariff',
    speedSource: 'BMTC-measured road speed, x1.75 for a two-wheeler that filters',
  },
};

/** Nothing outside khaali's own measurements: a hired vehicle never travels
    faster than this however empty the road model says the city is. */
export const MAX_KMH = 60;

export const KINDS = Object.keys(HIRE);
export const isHire = m => m === 'car' || m === 'bike';

/** How far khaali will put somebody in a hired vehicle at all. Past this it
    says no, the way it says no today: a two-hour taxi is not a journey plan. */
export const HIRE_MAX_KM = 50;

const round5 = x => Math.round(x / 5) * 5;

/**
 * What the ride costs - as a RANGE, because khaali does not know.
 *
 * A hired fare moves with the traffic, the hour and whoever is surging today.
 * A single figure would be the first number khaali ever invented and passed off
 * as a fact. A range labelled `estimated` is the true thing to say.
 */
export function fareFor(kind, km) {
  const h = HIRE[kind];
  if (!h || !(km >= 0)) return null;
  const mid = h.base + h.perKm * km;
  return {
    min: Math.max(h.base, round5(mid * (1 - h.spread))),
    max: round5(mid * (1 + h.spread)),
    mid: round5(mid),
    estimated: true,
    source: h.source,
  };
}

/**
 * How fast this vehicle goes over THIS road at THIS hour - measured where
 * khaali has measured, declared where it has not, and saying which.
 */
export function speedFor(kind, { at = null, from = null, to = null } = {}) {
  const h = HIRE[kind];
  if (!h) return null;
  const road = (from && to)
    ? _road.speedBetween(from.lat, from.lng, to.lat, to.lng)
    : { kmh: _road.field().cityKmh, quality: 'unknown', source: 'no route given; the city median' };
  const timed = at != null ? _traffic.apply(road, at) : { ...road, factor: 1 };
  const kmh = Math.min(MAX_KMH, Math.round(timed.kmh * h.roadFactor * 10) / 10);
  return { kmh, roadKmh: road.kmh, factor: timed.factor != null ? timed.factor : 1,
    quality: timed.quality, source: h.speedSource + ' · ' + timed.source };
}

/**
 * How long the ride takes, including waiting for it to turn up. With no place
 * and no hour it falls back to the city median road, which is still a measured
 * number rather than one somebody typed.
 */
export function minutesFor(kind, km, opts = {}) {
  const h = HIRE[kind];
  if (!h) return null;
  const s = speedFor(kind, opts);
  return h.waitMin + Math.max(1, Math.round(km / s.kmh * 60));
}

/**
 * Which vehicle to offer, of the ones she turned on. A bike is cheaper and
 * quicker through traffic, so it wins when it is allowed; a car is the answer
 * when she is not travelling alone, needs a ramp, or the bike is not offered.
 */
export function allowed(kinds = [], { pax = 1, needs = [] } = {}) {
  const stepFree = (needs || []).includes('step-free');
  return (kinds || []).filter(k => {
    const h = HIRE[k];
    if (!h) return false;
    if (pax > h.seats) return false;              // a bike carries one person
    if (stepFree && !h.stepFree) return false;    // and it is never step-free
    return true;
  });
}

/**
 * One of them, when only one is wanted. Prefer the bike because it is cheaper -
 * but note that the planner offers BOTH where both are allowed, and lets the
 * ranking profile choose: somebody who picked Comfortable wants the car, and
 * an allocator that never sees a car cannot give her one.
 */
export function pick(kinds = [], opts = {}) {
  const ok = allowed(kinds, opts);
  if (!ok.length) return null;
  return ok.includes('bike') ? 'bike' : ok[0];
}

/**
 * A leg shaped like every other leg in khaali, so the map, the cards, the
 * allocator and the ticket need no special case to read it.
 */
export function leg(kind, from, to, startMin, km, hhmm, dayMin) {
  const h = HIRE[kind];
  if (!h) return null;
  // the road she is actually on, at the hour she is actually on it
  const speed = speedFor(kind, { at: startMin, from, to });
  const min = h.waitMin + Math.max(1, Math.round(km / speed.kmh * 60));
  const f = fareFor(kind, km);
  return {
    mode: kind, name: h.name, from: from.name, to: to.name,
    km: Math.round(km * 10) / 10, min,
    depMin: startMin, arrMin: startMin + min,
    dep: hhmm(dayMin(startMin)), arr: hhmm(dayMin(startMin + min)),
    fare: f.mid, fareMin: f.min, fareMax: f.max, fareEstimated: true,
    wait: h.waitMin, seats: h.seats,
    kmh: speed.kmh, roadKmh: speed.roadKmh, trafficFactor: speed.factor,
    speedQuality: speed.quality, speedSource: speed.source,
    fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng,
    // A hired seat is hers by definition. It must speak the same vocabulary
    // every other leg speaks - 'yes' at rank 3 - or the chain's worst-seat
    // arithmetic reads a car as though she were standing in it.
    seat: { word: 'yes', rank: 3, why: 'a hired ' + kind + ' is yours for the ride' },
    source: 'estimated',
  };
}

// ------------------------------------------------------------- the ride --
//
// A ride is booked, not scanned. A trip pass covers the bus and the metro
// because those have a door with a gate on it; a hired car has no gate, so it
// gets its own booking with a reference the driver can be told.

/**
 * Book the ride. The caller prices it from THIS module's tariff, never from
 * anything a phone sent - the same posture a berth hold takes with its body.
 */
export function newRide({ id, who, date, kind, from, to, km, holder, pickupMin }, now = Date.now()) {
  if (!id || !who || !date) return { ok: false, reason: 'incomplete' };
  const h = HIRE[kind];
  if (!h) return { ok: false, reason: 'bad-kind' };
  if (!(km > 0)) return { ok: false, reason: 'no-distance' };
  if (km > HIRE_MAX_KM) return { ok: false, reason: 'too-far' };
  const fare = fareFor(kind, km);
  return { ok: true, ride: {
    id, who, date, kind, name: h.name, holder: holder || null,
    from: String(from || '').slice(0, 80), to: String(to || '').slice(0, 80),
    km: Math.round(km * 10) / 10, min: minutesFor(kind, km),
    fare, seats: h.seats, waitMin: h.waitMin,
    pickupMin: pickupMin != null ? pickupMin : null,
    // a reference a driver could be read out, not a plate khaali invented
    code: id.slice(0, 6).toUpperCase(),
    status: 'booked', simulated: true, bookedAt: now, rides: [],
  } };
}

/**
 * Where the ride has got to, at a minute of the day.
 *
 * Derived, not stored: a booking plus a clock is enough to say whether the
 * driver is still coming or she is already in the car, and a stored status
 * would only be a second thing to keep in step with the first.
 *
 * Every stage of this is SIMULATED and says so. khaali runs no cars, so there
 * is no driver moving and no position to report - what it can honestly say is
 * where the ride SHOULD be by now, against the booking she holds.
 */
export const STAGES = ['booked', 'assigned', 'arriving', 'riding', 'arrived', 'cancelled'];

export function statusOf(r, minute = null, { today = null } = {}) {
  if (!r) return null;
  const base = { simulated: true, source: 'derived from the booking and the clock; khaali runs no cars' };
  if (r.status === 'cancelled') return { ...base, stage: 'cancelled', label: 'Cancelled', progress: 0 };
  if (today && r.date !== today) {
    const future = r.date > today;
    return { ...base, stage: 'booked', progress: 0,
      label: future ? 'Booked for ' + r.date : 'Travelled on ' + r.date, notToday: true };
  }
  const start = r.pickupMin != null ? r.pickupMin : null;
  if (start == null || minute == null) return { ...base, stage: 'booked', label: 'Booked', progress: 0 };
  const wait = r.waitMin || 4, ride = r.min || 1;
  const d = minute - start;                       // minutes until (negative) or since pickup
  if (d < -20) return { ...base, stage: 'booked', progress: 0,
    label: 'Booked · a ' + r.kind + ' is held for ' + hhmmOf(start) };
  if (d < -wait) return { ...base, stage: 'assigned', progress: 0,
    label: 'A ' + r.kind + ' is assigned · leaves at ' + hhmmOf(start) };
  if (d < 0) return { ...base, stage: 'arriving', progress: 0,
    label: 'Arriving at ' + r.from + ' in about ' + Math.max(1, -d) + ' min' };
  if (d < ride) return { ...base, stage: 'riding', progress: Math.round(d / ride * 100),
    label: 'On the way to ' + r.to + ' · about ' + Math.max(1, ride - d) + ' min left' };
  return { ...base, stage: 'arrived', progress: 100, label: 'Arrived at ' + r.to };
}

const hhmmOf = m => {
  const x = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
};

export function cancelRide(r, now = Date.now()) {
  if (!r) return { ok: false, reason: 'missing' };
  if (r.status === 'cancelled') return { ok: true, already: true };
  r.status = 'cancelled'; r.cancelledAt = now;
  return { ok: true };
}

/** What a phone is allowed to see. */
export function publicOf(r) {
  if (!r) return null;
  return { id: r.id, kind: r.kind, name: r.name, holder: r.holder, date: r.date,
    from: r.from, to: r.to, km: r.km, min: r.min, fare: r.fare, seats: r.seats,
    waitMin: r.waitMin, pickupMin: r.pickupMin, code: r.code,
    status: r.status, simulated: true, bookedAt: r.bookedAt };
}
