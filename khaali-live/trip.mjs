// ---------------------------------------------------------------------------
// Which departure, and which stretch of it.
//
// Two mistakes this module exists to make impossible.
//
// THE FIRST is calling a route a departure. "500D has room" is not a fact about
// anything a person can board. The 08:10 has room and the 08:40 is full, and a
// planner that averages them will put somebody on the full one and be right on
// average. Everything downstream - claims, forecasts, scans, bookings - is keyed
// on a trip INSTANCE, and a route id is never enough to make one.
//
// THE SECOND is the bitmask. engine.mjs represents a rail journey as a 13-bit
// mask and ORs them together, which is correct there and wrong here twice over.
// A 43-stop bus pattern has 42 stretches, and `1 << 42` is not what anybody
// wants it to be - JavaScript's bitwise operators truncate to 32 bits, so the
// forty-third stretch silently becomes the eleventh. And OR loses the count: two
// people riding the same stretch are two people, not one bit. Spans here are
// (fromStopSequence, toStopSequence) pairs, counted by loop and weighted by how
// many are travelling on them.
//
// Stops are addressed BY SEQUENCE, never by id. A loop route visits the same
// stop twice, and a stop id cannot say which of the two she means.

/** The fields that make one departure a different departure from another. */
export const ID_FIELDS = ['operatorId', 'tripId', 'serviceDate',
  'directionId', 'patternId', 'scheduledStartTime'];

/**
 * Beyond this many stretches a mask cannot hold the pattern. The number is not
 * a policy - it is where `1 << n` stops meaning `2^n` in this language.
 */
export const MASK_BITS = 31;
export const maskable = stretchCount => stretchCount <= MASK_BITS;

const bad = (m) => { const e = new Error(m); e.code = 'TRIP_IDENTITY'; throw e; };

/**
 * The identity of one departure.
 *
 * `vehicleId` is deliberately NOT in it. Swapping a 55-seat bus for a 35-seat
 * one changes what the service can carry; it does not make it a different
 * service, and a passenger holding a pass for the 08:10 still holds it. Capacity
 * is a property of the vehicle and travels with `capacityOf`, not with the id.
 */
export function departure(d = {}) {
  ID_FIELDS.forEach(f => {
    if (d[f] === undefined || d[f] === null || d[f] === '') bad('departure is missing ' + f);
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.serviceDate)))
    bad('serviceDate must be an ISO date, got ' + d.serviceDate);
  const out = {};
  ID_FIELDS.forEach(f => { out[f] = d[f]; });
  out.vehicleId = d.vehicleId == null ? null : String(d.vehicleId);
  out.id = instanceId(out);
  return out;
}

const esc = v => String(v).replace(/([\\|])/g, '\\$1');

/** A stable string key. Order is fixed by ID_FIELDS so it never depends on
    the order somebody happened to type the object literal in. */
export function instanceId(d) {
  return ID_FIELDS.map(f => {
    if (d[f] === undefined || d[f] === null || d[f] === '') bad('cannot key a departure without ' + f);
    return esc(d[f]);
  }).join('|');
}

export const sameDeparture = (a, b) => instanceId(a) === instanceId(b);

/** A different bus on the same run. The service, and every claim against it,
    is unchanged; only what it can carry moves. */
export function withVehicle(d, vehicleId) {
  const out = { ...d, vehicleId: vehicleId == null ? null : String(vehicleId) };
  out.id = instanceId(out);
  return out;
}

// ---------------------------------------------------------------------------
// Time. A trip that leaves at 23:40 and runs ninety minutes does not arrive at
// minute 10 of the same morning, four hundred minutes before it left - which is
// the bug journey.mjs had to fix in trainsBetween and is worth not repeating.
// Stop times are OFFSETS from the scheduled start, monotone and free to pass
// 1440, and only the display layer wraps them.

const DAY0 = Date.UTC(2000, 0, 1) / 86400000;
/** Days since a fixed epoch, so two service dates can be compared as numbers. */
export function dayNumber(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) bad('not an ISO date: ' + iso);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 - DAY0;
}

/** One absolute minute, comparable across service dates. */
export function absoluteMinute(d, offsetMin = 0) {
  return dayNumber(d.serviceDate) * 1440 + Number(d.scheduledStartTime) + Number(offsetMin || 0);
}

// ---------------------------------------------------------------------------
// Spans.
//
// A pattern of N stops has N-1 stretches. Stretch k is the run between stop k
// and stop k+1. A ticket from stop 2 to stop 5 occupies stretches 2, 3 and 4 -
// it does NOT occupy stretch 5, because she is off the bus by then. Getting that
// off by one is how a bus reads full one stop past where anybody is sitting.

export function span({ fromStopSequence, toStopSequence, pax = 1, id = null, kind = 'ticket' } = {}) {
  const f = Number(fromStopSequence), t = Number(toStopSequence), p = Number(pax);
  if (!Number.isInteger(f) || !Number.isInteger(t)) bad('stop sequences must be integers');
  if (f < 0) bad('a stop sequence starts at zero, got ' + f);
  if (t <= f) bad('a span must go forward along the pattern, got ' + f + ' to ' + t);
  if (!Number.isInteger(p) || p < 1) bad('a span carries at least one person, got ' + pax);
  return { fromStopSequence: f, toStopSequence: t, pax: p, id, kind };
}

export const stretchCount = stopCount => Math.max(0, Number(stopCount) - 1);

/** Whether a span is aboard for stretch k. */
export const covers = (sp, k) => k >= sp.fromStopSequence && k < sp.toStopSequence;

const fits = (sp, stopCount) => sp.toStopSequence <= stopCount - 1;

/**
 * How many people are aboard on each stretch.
 *
 * By loop and pax-weighted, which is the whole point: two tickets with identical
 * spans contribute two, a ticket for a party of three contributes three, and a
 * pattern longer than 32 stops counts the same as a short one. `spans.reduce(OR)`
 * would have answered one, one, and wrong.
 */
export function loadBySpan(spans, stopCount) {
  const n = stretchCount(stopCount);
  const out = new Array(n).fill(0);
  (spans || []).forEach(sp => {
    if (!fits(sp, stopCount)) bad('span ends past stop ' + (stopCount - 1) + ': ' + sp.toStopSequence);
    for (let k = sp.fromStopSequence; k < sp.toStopSequence && k < n; k++) out[k] += sp.pax;
  });
  return out;
}

/** The worst stretch of the ones she actually rides - not the one she boards at.
    Boarding at stop 2 of 43 says nothing about stop 20. Returns null when the
    ridden span has no stretch in it. */
export function worstOver(load, fromStopSequence, toStopSequence) {
  let worst = null;
  for (let k = fromStopSequence; k < toStopSequence && k < load.length; k++) {
    if (k < 0) continue;
    if (worst == null || load[k] > load[worst]) worst = k;
  }
  return worst == null ? null : { stretch: worst, value: load[worst] };
}

/** Who gets on and who gets off, by stop. The checkpoint arithmetic in
    conductor.mjs is built on these, so they are counted once here. */
export function boardings(spans, stopCount) {
  const out = new Array(Number(stopCount)).fill(0);
  (spans || []).forEach(sp => { out[sp.fromStopSequence] += sp.pax; });
  return out;
}
export function alightings(spans, stopCount) {
  const out = new Array(Number(stopCount)).fill(0);
  (spans || []).forEach(sp => { out[sp.toStopSequence] += sp.pax; });
  return out;
}

/**
 * What the vehicle can take, said explicitly rather than defaulted.
 *
 * A convenient number quietly labelled verified is how a bus ends up "known" to
 * hold fifty. Missing capacity is null and the caller has to say so out loud;
 * it is never a reason to call a departure full, and never a reason to call it
 * empty either.
 */
export function capacityOf({ seatedCapacity = null, allowedStandingCapacity = null,
                             boardingCapacity = null, source = null, updatedAt = null } = {}) {
  const seated = seatedCapacity == null ? null : Number(seatedCapacity);
  const standing = allowedStandingCapacity == null ? null : Number(allowedStandingCapacity);
  const board = boardingCapacity != null ? Number(boardingCapacity)
    : (seated == null ? null : seated + (standing || 0));
  return { seatedCapacity: seated, allowedStandingCapacity: standing,
    boardingCapacity: board, source, updatedAt,
    known: board != null && source != null };
}
