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

/** Vehicles for hire. Speeds are city speeds, not free-flow: a car crossing
    Bengaluru at 22 km/h is the honest figure, and it is what stops a hired
    ride quietly beating a train on time. */
export const HIRE = {
  car: {
    kind: 'car', name: 'Car', seats: 4, kmh: 22, waitMin: 5,
    base: 50, perKm: 16, spread: 0.18, stepFree: true,
    source: 'published four-wheeler city tariff',
  },
  bike: {
    kind: 'bike', name: 'Bike', seats: 1, kmh: 26, waitMin: 3,
    base: 25, perKm: 8, spread: 0.20, stepFree: false,
    source: 'published two-wheeler city tariff',
  },
};

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

/** How long the ride takes, including waiting for it to turn up. */
export function minutesFor(kind, km) {
  const h = HIRE[kind];
  if (!h) return null;
  return h.waitMin + Math.max(1, Math.round(km / h.kmh * 60));
}

/**
 * Which vehicle to offer, of the ones she turned on. A bike is cheaper and
 * quicker through traffic, so it wins when it is allowed; a car is the answer
 * when she is not travelling alone, needs a ramp, or the bike is not offered.
 */
export function pick(kinds = [], { pax = 1, needs = [] } = {}) {
  const stepFree = (needs || []).includes('step-free');
  const ok = (kinds || []).filter(k => {
    const h = HIRE[k];
    if (!h) return false;
    if (pax > h.seats) return false;              // a bike carries one person
    if (stepFree && !h.stepFree) return false;    // and it is never step-free
    return true;
  });
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
  const min = minutesFor(kind, km);
  const f = fareFor(kind, km);
  return {
    mode: kind, name: h.name, from: from.name, to: to.name,
    km: Math.round(km * 10) / 10, min,
    depMin: startMin, arrMin: startMin + min,
    dep: hhmm(dayMin(startMin)), arr: hhmm(dayMin(startMin + min)),
    fare: f.mid, fareMin: f.min, fareMax: f.max, fareEstimated: true,
    wait: h.waitMin, seats: h.seats,
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
