// The journey after the train.
//
// A ticket to Whitefield leaves a person on a platform 1.7 km from the metro
// station that shares its name - and 150 m from a different one, Kadugodi Tree
// Park, that does not. Nobody tells them. This module is the telling: which
// exit, how far, which metro stop, how long to the next train, how full it will
// be, and what it costs. Everything here comes from BMRCL's own data (see
// metro.mjs); the one thing it will not do is pretend to know where a metro
// train is right now, because nobody publishes that.
//
// The city part of the journey is a PASS, not a seat. A bus is not something
// you book; it is something you have the right to board, and the next one
// comes. So the pass is issued once, covers the day, and is scanned by whoever
// is at the door. Missing a bus is not an event; it is a longer wait.

import { ST } from './data.mjs';
import { GEO } from './geo.mjs';
import { toMin, hhmm } from './engine.mjs';
import { LINE, STOPS, HEADWAYS, FARE, ENTRANCES, STREET_TO_PLATFORM_MIN } from './metro.mjs';
import { BUSES, BUS_FARE_PER_KM, BUS_MIN_FARE } from './buses.mjs';
import { TRAINS } from './data.mjs';
import { serves, sMin, fare as railFare } from './engine.mjs';
import * as hire from './hire.mjs';
import * as transfer from './transfer.mjs';

export const WALK_KMH = 4.5;
/** The network: things that run whether or not she is on them. Every default
    in khaali is this list, and that is deliberate. */
export const MODES = ['train', 'metro', 'bus'];
/** Hired vehicles. Never a default - she has to ask for one. */
export const HIRE_MODES = [...hire.KINDS];
/** Everything a request is ALLOWED to name, which is not what it gets. */
export const ALL_MODES = [...MODES, ...HIRE_MODES];

/**
 * Will she get a seat, and why.
 *
 * This is the whole idea. A bus boarded at stop 3 of 37 has empty seats; the
 * same bus at stop 30 has none, and nobody tells you which one you are getting
 * on. It is in the timetable already - it just has never been read out. The
 * same question, asked of a train, is the berth count khaali was built on; of
 * a metro, it is that station's own busiest hour.
 *
 * `at` is 0..1 - how far into the service you board. `load` is 0..1 for a
 * metro, where boarding position means nothing and the hour means everything.
 */
export function seatOdds({ mode, at = null, load = null, free = null }) {
  if (mode === 'bus') {
    if (at == null) return { word: 'unknown', why: 'khaali does not know where on the route you board.' };
    if (at <= 0.1) return { word: 'yes', rank: 3,
      why: 'you board where the bus starts, so the seats are still empty' };
    if (at <= 0.25) return { word: 'likely', rank: 2,
      why: 'you board near the start of the route' };
    if (at <= 0.6) return { word: 'maybe', rank: 1,
      why: 'you board part-way along, so it depends on the day' };
    return { word: 'standing', rank: 0, why: 'you board late on the route, when it is usually full' };
  }
  if (mode === 'train') {
    if (free == null) return { word: 'unknown', why: 'berths are counted at booking.' };
    if (free >= 40) return { word: 'yes', rank: 3, why: free + ' berths are free on your stretch' };
    if (free > 0) return { word: 'likely', rank: 2, why: 'only ' + free + ' berths left on your stretch' };
    return { word: 'standing', rank: 0, why: 'no berth free for your stretch' };
  }
  if (mode === 'metro') {
    if (load == null) return { word: 'unknown', why: '' };
    if (load >= 0.75) return { word: 'standing', rank: 0, why: 'the busiest hour at this station' };
    if (load >= 0.4) return { word: 'maybe', rank: 1, why: 'a busy hour at this station' };
    return { word: 'likely', rank: 2, why: 'a quiet hour at this station' };
  }
  return { word: 'unknown', why: '' };
}

/** Buses between two points, with where you board and what that means. */
export function busesBetween(fromLat, fromLng, toLat, toLng, within = 1.2) {
  return BUSES.filter(b =>
    km({ lat: fromLat, lng: fromLng }, { lat: b.fromLat, lng: b.fromLng }) <= within &&
    km({ lat: toLat, lng: toLng }, { lat: b.toLat, lng: b.toLng }) <= within)
    .map(b => ({ ...b,
      walkToStopKm: Math.round(km({ lat: fromLat, lng: fromLng }, { lat: b.fromLat, lng: b.fromLng }) * 100) / 100,
      seat: seatOdds({ mode: 'bus', at: b.nStops ? b.boardIdx / b.nStops : null }) }));
}

/** The next bus, from its own first/last and how often it runs. */
export function nextBus(b, minute) {
  const m = ((minute % 1440) + 1440) % 1440;
  if (m < b.first) return { ok: true, wait: b.first - m, every: b.every, board: b.first };
  if (m > b.last) return { ok: false, reason: 'no-service', first: b.first, last: b.last };
  const wait = Math.ceil(b.every / 2);
  return { ok: true, wait, every: b.every, board: m + wait };
}
export const RAIL_STATION = 'WFD';
export const PASS_MODES = ['metro', 'bmtc'];

/** Kilometres between two points on the earth. */
export function km(a, b) {
  const r = Math.PI / 180, R = 6371;
  const dla = (b.lat - a.lat) * r, dln = (b.lng - a.lng) * r;
  const s = Math.sin(dla / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dln / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** The metro stop a train passenger actually walks to - nearest, not namesake. */
export function boardStop(railCode = RAIL_STATION) {
  const i = ST.findIndex(s => s.c === railCode);
  if (i < 0) return null;
  const rail = GEO[i];
  let best = null;
  STOPS.forEach((s, idx) => {
    const d = km(rail, s);
    if (!best || d < best.km) best = { idx, stop: s, km: Math.round(d * 100) / 100 };
  });
  best.walkMin = Math.max(1, Math.round(best.km / WALK_KMH * 60));
  // the station the ticket names, and how far it really is - the difference
  // is the whole reason this module exists
  const same = STOPS.findIndex(s => /Whitefield/.test(s.n));
  best.namesakeKm = same >= 0 ? Math.round(km(rail, STOPS[same]) * 100) / 100 : null;
  return best;
}

/** Minutes between trains from Whitefield at this minute of the day, or null
    outside service hours. Bands are BMRCL's own; between them there is no gap
    in service, so the nearer band speaks. */
export function headwayAt(minute) {
  const m = ((minute % 1440) + 1440) % 1440;
  for (const b of HEADWAYS) {
    if (m >= toMin(b.s) && m < toMin(b.e)) return b.m;
  }
  const first = toMin(HEADWAYS[0].s), last = toMin(HEADWAYS[HEADWAYS.length - 1].e);
  if (m < first || m >= last) return null;
  return HEADWAYS.reduce((p, b) => Math.abs(toMin(b.s) - m) < Math.abs(toMin(p.s) - m) ? b : p).m;
}

/** How long the next train is, at most, from a given minute at a given stop.
    Frequency service has no timetable to promise, so the answer is the
    headway - "every 8 minutes" - and the wait it implies, not a false 09:07. */
export function nextMetro(minute, stopIdx = 0) {
  const offset = STOPS[stopIdx] ? STOPS[stopIdx].min : 0;
  const depart = minute - offset;                     // when it left Whitefield
  const h = headwayAt(depart);
  if (h == null) return { ok: false, reason: 'no-service', first: HEADWAYS[0].s, last: HEADWAYS[HEADWAYS.length - 1].e };
  return { ok: true, every: h, waitMax: h, waitTypical: Math.ceil(h / 2) };
}

/** The ride itself, between two stop indexes, boarding at a minute. */
export function metroLeg(fromIdx, toIdx, boardMin) {
  const a = STOPS[fromIdx], b = STOPS[toIdx];
  if (!a || !b || toIdx <= fromIdx) return null;
  const run = Math.round((b.min - a.min) * 10) / 10;
  return { from: a, to: b, stops: toIdx - fromIdx, runMin: run,
    board: boardMin, alight: Math.round(boardMin + run) };
}

/** Crowding at a station at an hour, against that station's own busiest hour.
    Whitefield at 9am and Majestic at 6pm are both "crush"; the number says why. */
export function crowdAt(stopId, hour) {
  const s = STOPS.find(x => x.id === stopId);
  if (!s) return null;
  const h = ((hour % 24) + 24) % 24;
  const peak = Math.max(...s.crowd, 1);
  const n = s.crowd[h] || 0, level = n / peak;
  return { entriesPerHour: n, peakPerHour: peak, level: Math.round(level * 100) / 100,
    word: level >= 0.75 ? 'crush' : level >= 0.4 ? 'busy' : 'quiet',
    peakHour: s.crowd.indexOf(peak) };
}

/** Which street entrance to use. A lift when the need says so, else the first. */
export function entranceFor(stopId, needs = []) {
  const list = ENTRANCES[stopId] || [];
  const stepFree = needs.some(n => ['disabled', 'senior', 'expecting', 'step-free'].includes(n));
  const pick = stepFree ? (list.find(e => e.lift) || list[0]) : list[0];
  return pick ? { ...pick, stepFree, minToPlatform: STREET_TO_PLATFORM_MIN[stopId] || 2 } : null;
}

/**
 * The plan: from the moment the train stops at Whitefield to the moment she
 * steps off at Majestic. `arriveAt` is a minute of the day. Returns legs a
 * ticket can print, and a `line` a person can read in one breath.
 */
export const stopIdx = id => STOPS.findIndex(s => s.id === id);

/**
 * `arriveAt` is the minute she is free to start: a train's arrival, or simply
 * now. With no `from`, she is stepping off a train at Whitefield railway and
 * the walk to the nearest metro is part of the plan. With a `from` metro stop
 * she is already at the metro, and there is no walk. `to` is any stop down
 * the line; Majestic if unsaid.
 */
export function plan({ arriveAt, needs = [], from = null, to = null, toIdx = null } = {}) {
  if (!isFinite(arriveAt)) return { ok: false, reason: 'no-arrival' };
  const b = boardStop();
  const fromIdx = from != null ? stopIdx(from) : b.idx;
  const endIdx = toIdx != null ? toIdx : (to != null ? stopIdx(to) : STOPS.length - 1);
  if (fromIdx < 0 || endIdx < 0) return { ok: false, reason: 'unknown-stop' };
  if (endIdx <= fromIdx) return { ok: false, reason: 'wrong-way',
    line: 'This line only runs ' + STOPS[0].n + ' toward ' + STOPS[STOPS.length - 1].n + ' in khaali for now.' };
  const walking = from == null;
  const startStop = STOPS[fromIdx];
  const hour = Math.floor((((arriveAt % 1440) + 1440) % 1440) / 60);
  const ent = entranceFor(startStop.id, needs);
  const walkMin = walking ? b.walkMin + (ent ? ent.minToPlatform : 2) : (ent ? ent.minToPlatform : 2);
  const atPlatform = arriveAt + walkMin;
  const nm = nextMetro(atPlatform, fromIdx);
  if (!nm.ok) return { ok: false, reason: 'no-service', first: nm.first, last: nm.last,
    line: 'No metro from ' + startStop.n + ' at this hour. First train ' + nm.first + ', last ' + nm.last + '.' };
  const boardMin = atPlatform + nm.waitTypical;
  const ride = metroLeg(fromIdx, endIdx, boardMin);
  const alightCrowd = crowdAt(ride.to.id, Math.floor((ride.alight % 1440) / 60));
  const boardCrowd = crowdAt(startStop.id, hour);
  const peak = (hour >= 8 && hour < 12) || (hour >= 16 && hour < 21);
  const legs = [];
  if (walking) legs.push({ mode: 'walk', from: ST[ST.findIndex(s => s.c === RAIL_STATION)].n, to: b.stop.n,
    km: b.km, min: walkMin, entrance: ent, source: 'measured' });
  legs.push({ mode: 'metro', line: LINE.name, color: LINE.color, from: ride.from.n, fromKn: ride.from.kn,
    fromId: ride.from.id, toId: ride.to.id,
    to: ride.to.n, toKn: ride.to.kn, stops: ride.stops, runMin: ride.runMin,
    // every other leg says how long it takes in `min`; the metro said it only
    // in `runMin`, so anything drawing legs to scale drew this one as nothing
    min: Math.round(ride.runMin),
    every: nm.every, waitMax: nm.waitMax, board: hhmm(boardMin % 1440), alight: hhmm(ride.alight % 1440),
    crowdBoard: boardCrowd, crowdAlight: alightCrowd, source: 'timetable' });
  return {
    ok: true, legs,
    arrive: ride.alight, arriveText: hhmm(ride.alight % 1440),
    fare: { qr: FARE.qr, smartcard: peak ? FARE.smartcard.peak : FARE.smartcard.offpeak, peak },
    totalMin: ride.alight - arriveAt,
    namesake: walking ? { km: b.namesakeKm, name: STOPS.find(s => /Whitefield/.test(s.n)).n } : null,
    line: explain({ b, ent, walkMin, nm, ride, alightCrowd, walking, startStop }),
  };
}

/** One breath. */
export function explain({ b, ent, walkMin, nm, ride, alightCrowd, walking = true, startStop = null }) {
  const bits = [
    walking
      ? 'Off the train, ' + (ent ? ent.n + ' of ' : '') + b.stop.n
        + ' is ' + Math.round(b.km * 1000) + ' m — about ' + walkMin + ' min on foot'
        + (ent && ent.stepFree ? ', with a lift' : '')
      : (ent ? ent.n + ' of ' : '') + (startStop ? startStop.n : ride.from.n)
        + (ent && ent.stepFree ? ', with a lift' : ''),
    LINE.name + ' every ' + nm.every + ' min',
    ride.stops + ' stops to ' + ride.to.n.replace(/^.*, /, '') + ', about ' + Math.round(ride.runMin) + ' min',
    'there by ' + hhmm(ride.alight % 1440),
  ];
  if (alightCrowd && alightCrowd.word === 'crush')
    bits.push(ride.to.n.replace(/^.*, /, '') + ' will be at its busiest');
  return bits.join(' · ') + '.';
}

// ------------------------------------------------------------- the pass --

/** A day's right to ride. Issued once, scanned at the door, never "booked". */
export function newPass({ id, who, date, holder, covers = PASS_MODES }, now = Date.now()) {
  if (!id || !who || !date) return { ok: false, reason: 'incomplete' };
  const modes = covers.filter(m => PASS_MODES.includes(m));
  if (!modes.length) return { ok: false, reason: 'no-modes' };
  return { ok: true, pass: {
    id, who, date, holder: holder || null, covers: modes, kind: 'day',
    fare: FARE.qr, status: 'valid', issuedAt: now, rides: [],
  } };
}

/**
 * What the bus and metro legs of a trip pass cost. The phone says which legs it
 * is asking for; every fare comes from khaali's own tables and khaali's own
 * coordinates, never from the caller - the same posture the berth hold takes.
 * A leg khaali cannot find is refused, not estimated.
 *
 * A bus khaali knows is not BMTC is not refused either: it is left OFF the
 * pass and reported, because a KSRTC seat is bought at the counter and no gate
 * on that bus will ever scan this.
 */
export function priceTripLegs(legs) {
  if (!Array.isArray(legs) || !legs.length) return { ok: false, error: 'A trip pass needs at least one bus or metro leg.' };
  if (legs.length > 6) return { ok: false, error: 'That is more legs than one trip has.' };
  const out = [], skipped = [];
  for (const l of legs) {
    const mode = l && l.mode;
    const from = String((l && l.from) || '').slice(0, 80), to = String((l && l.to) || '').slice(0, 80);
    if (mode === 'metro') {
      const i = stopIdx(String((l && l.fromId) || '')), j = stopIdx(String((l && l.toId) || ''));
      if (i < 0 || j < 0 || i === j) return { ok: false, error: 'khaali does not know that metro leg.' };
      out.push({ mode: 'metro', name: LINE.name, from: STOPS[i].n, to: STOPS[j].n, fare: FARE.qr });
    } else if (mode === 'bus') {
      const known = BUSES.find(b => b.id === String((l && l.id) || ''));
      if (known && known.op !== 'BMTC') {
        // "KSRTC KSRTC BNG-BLR" is nobody's idea of a bus name
        const label = known.id.startsWith(known.op) ? known.id : known.op + ' ' + known.id;
        skipped.push({ mode: 'bus', name: label, from: known.from, to: known.to, why: 'not-bmtc' });
        continue;
      }
      // First the route itself: a number and two indices into its own pattern
      // are exact, and the stops and the fare are read straight off BMTC's
      // data. Names are the fallback, for a leg that has lost its indices.
      const found = (!known && _bmtc)
        ? _bmtc.legFound({ route: l.id, boardIdx: l.boardIdx, nStops: l.nStops, stops: l.stops })
        : null;
      if (found) {
        out.push({ mode: 'bus', name: String((l && l.name) || ('BMTC ' + found.route)).slice(0, 40),
          route: found.route, from: found.from.name, to: found.to.name, km: found.km, fare: found.fare });
        continue;
      }
      const a = known ? { name: known.from, lat: known.fromLat, lng: known.fromLng }
        : (_bmtc ? _bmtc.stopNamed(from) : null);
      const b2 = known ? { name: known.to, lat: known.toLat, lng: known.toLng }
        : (_bmtc ? _bmtc.stopNamed(to) : null);
      if (!a || !b2) return { ok: false, error: 'khaali does not know that bus stop, so it will not price the ride.' };
      out.push({ mode: 'bus', name: String((l && l.name) || 'BMTC').slice(0, 40),
        route: known ? known.id : (l.id || null),
        from: a.name, to: b2.name, fare: busFare({ fromLat: a.lat, fromLng: a.lng, toLat: b2.lat, toLng: b2.lng }) });
    } else if (hire.isHire(mode)) {
      // A pass is scanned at a door. A hired car has no door to scan, so it is
      // not on the pass - it is booked separately and rides on the same ticket.
      skipped.push({ mode, name: hire.HIRE[mode].name, from, to, why: 'booked-separately' });
      continue;
    } else return { ok: false, error: 'A trip pass covers the bus and the metro. The train is on the ticket.' };
  }
  if (!out.length) {
    const ride = skipped.find(x => x.why === 'booked-separately');
    return { ok: false, skipped,
      error: ride
        ? 'Nothing on this journey is a BMTC bus or a metro ride. The ' + ride.name.toLowerCase()
          + ' is booked on its own, not on a pass.'
        : 'Nothing on this journey is a BMTC bus or a metro ride, so there is no pass to sell. Buy the '
          + (skipped[0] ? skipped[0].name : 'other') + ' seat at the counter.' };
  }
  return { ok: true, legs: out, skipped };
}

/**
 * A ticket for ONE trip, not a day. It names the rides she is buying - this
 * bus, from this stop to that one - and it is spent when she has taken them.
 *
 * What it is NOT is a number of rides. She is not buying "two rides"; she is
 * buying Kempegowda Bus Station to CBI on the KIA-9. If she misses the 1:00 she
 * takes the 1:30 on the same ticket, because the ticket was never about a
 * departure. It is about getting there, once.
 *
 * So each leg is carried separately and crossed off separately, and the pass
 * ends when the last one is. That is the difference a person can hold in their
 * head: a day pass is a right to ride, a trip pass is this journey and no other.
 *
 * `legs` must already be priced by the caller from khaali's own tables. This
 * function does not price anything, because it cannot check a fare it is told.
 */
export const COVER_OF = { bus: 'bmtc', metro: 'metro' };

/**
 * How long a trip pass lives.
 *
 * It used to be the calendar date it was issued for, which is wrong for the
 * journey that leaves at 11:55 pm: its bus is at 00:20, on a date the pass has
 * never heard of, and the gate refuses a ticket she is standing in front of.
 * Twenty-four hours from the moment it is cut covers any journey khaali will
 * plan, and ends at a definite instant that the money behind it can share.
 */
export const PASS_MS = 86400000;

export function newTripPass({ id, who, date, holder, legs }, now = Date.now()) {
  if (!id || !who || !date) return { ok: false, reason: 'incomplete' };
  if (!Array.isArray(legs) || !legs.length) return { ok: false, reason: 'no-legs' };
  const covers = [];
  for (const l of legs) {
    const c = COVER_OF[l && l.mode];
    if (!c) return { ok: false, reason: 'bad-leg' };
    if (!(l.fare >= 0)) return { ok: false, reason: 'unpriced-leg' };
    if (!covers.includes(c)) covers.push(c);
  }
  const fare = legs.reduce((n, l) => n + l.fare, 0);
  return { ok: true, pass: {
    id, who, date, holder: holder || null, covers, kind: 'trip',
    legs: legs.map((l, i) => ({ n: i + 1, mode: l.mode, cover: COVER_OF[l.mode],
      name: l.name || null, route: l.route || null, from: l.from, to: l.to,
      km: l.km != null ? l.km : null, fare: l.fare, ridden: null })),
    fare, status: 'valid', issuedAt: now, expiresAt: now + PASS_MS,
    // the block set aside against this pass, filled in by whoever cuts it
    payId: null, rides: [],
  } };
}

/** The next leg of a trip pass that this door can cross off, or null. */
export function nextLeg(p, mode) {
  if (!p || p.kind !== 'trip' || !Array.isArray(p.legs)) return null;
  return p.legs.find(l => l.cover === mode && !l.ridden) || null;
}

/** The conductor's or the gate's tap. Marks a ride; refuses the wrong day,
    a cancelled pass, or a mode it never covered. A pass is never "used up" -
    that is the difference between a pass and a ticket. */
export function scan(p, { by, mode, where } = {}, now = Date.now()) {
  if (!p) return { ok: false, reason: 'missing' };
  if (p.status !== 'valid') return { ok: false, reason: p.status };
  if (!PASS_MODES.includes(mode)) return { ok: false, reason: 'bad-mode' };
  if (!p.covers.includes(mode)) return { ok: false, reason: 'not-covered' };
  // A trip pass runs on its own clock: twenty-four hours from when it was cut,
  // so a journey that crosses midnight is still holding a ticket the gate will
  // take. A day pass is still a day, because that is what a day pass is.
  if (p.expiresAt != null) {
    if (now >= p.expiresAt) return { ok: false, reason: 'expired', validOn: p.date };
  } else {
    const day = new Date(now);
    const iso = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
    if (iso !== p.date) return { ok: false, reason: 'wrong-day', validOn: p.date };
  }
  // On a trip pass the door is crossing off a NAMED ride - this bus, these two
  // stops - and there is only one of it. Which bus she is on does not matter,
  // and neither does the hour: the 1:30 is the same ticket as the 1:00 she
  // missed. What matters is that she does not ride it twice.
  //
  // The double tap is answered first. A conductor pressing twice has not used
  // the ride up and must not be told the ride is behind her - on a trip pass
  // that reading would be a refusal, which is the one thing a second tap on the
  // same door must never produce.
  const last = p.rides[p.rides.length - 1];
  if (last && last.mode === mode && last.where === (where || null) && now - last.at < 60000)
    return { ok: true, ride: last, repeat: true,
      leg: (p.legs && last.leg != null) ? p.legs[last.leg - 1] : null };
  const leg = p.kind === 'trip' ? nextLeg(p, mode) : null;
  if (p.kind === 'trip' && !leg) return { ok: false, reason: 'leg-done' };
  const ride = { n: p.rides.length + 1, mode, by: by || null, where: where || null, at: now,
    leg: leg ? leg.n : null };
  applyRide(p, ride);
  return { ok: true, ride, leg: leg || null, spent: p.status === 'used' };
}

/**
 * Record a ride on the pass it belongs to.
 *
 * Both the door and the journal come through here. They used to disagree:
 * `scan` crossed the leg off and spent the pass, while replay pushed the ride
 * and did neither - so a restart handed back a pass whose legs were all
 * rideable again. Harmless while a pass was free; a fare taken twice now that
 * one is not. One function, so they cannot drift again.
 */
export function applyRide(p, ride) {
  if (!p || !ride) return { ok: false, reason: 'missing' };
  if (!p.rides.some(r => r.n === ride.n)) p.rides.push(ride);
  const leg = (p.kind === 'trip' && ride.leg != null && p.legs) ? p.legs[ride.leg - 1] : null;
  if (leg && !leg.ridden) leg.ridden = ride.at;
  // the journey is over when its last leg is behind her
  if (p.kind === 'trip' && p.legs && p.legs.every(l => l.ridden) && p.status === 'valid')
    p.status = 'used';
  return { ok: true, leg: leg || null };
}

export function cancelPass(p, now = Date.now()) {
  if (!p) return { ok: false, reason: 'missing' };
  if (p.status !== 'valid') return { ok: false, reason: p.status };
  p.status = 'cancelled'; p.cancelledAt = now;
  return { ok: true };
}

/**
 * The twenty-four hours are up.
 *
 * One way, and only from 'valid': a pass that was ridden stays ridden and a
 * pass that was cancelled stays cancelled, so the reason it ended is never
 * overwritten by the reason it would have ended anyway. There is no renewal -
 * a trip pass is that journey, and this one has gone.
 */
export function expirePass(p, now = Date.now()) {
  if (!p) return { ok: false, reason: 'missing' };
  if (p.status !== 'valid') return { ok: false, reason: p.status };
  p.status = 'expired'; p.expiredAt = now;
  return { ok: true };
}

/** Is this pass past its twenty-four hours? A day pass never is: it is judged
    by its date, at the door. */
export function passOver(p, now = Date.now()) {
  return !!(p && p.expiresAt != null && now >= p.expiresAt);
}

/** What a phone, or a conductor's phone, is allowed to see. */
export function publicOf(p) {
  if (!p) return null;
  return { id: p.id, date: p.date, holder: p.holder, covers: p.covers, fare: p.fare,
    kind: p.kind || 'day', legs: p.legs || null,
    status: p.status, issuedAt: p.issuedAt, expiresAt: p.expiresAt || null,
    block: p.block || null, rides: p.rides.length,
    legsLeft: p.kind === 'trip' ? p.legs.filter(l => !l.ridden).length : null,
    last: p.rides.length ? p.rides[p.rides.length - 1] : null };
}


// ------------------------------------------------------- whole journeys --
//
// Nobody wants "a train". They want to be at Majestic by nine, sitting down if
// possible. On this corridor there is more than one way to do that, and the
// fastest is not always the one a person would pick: the bus from Bangarpet
// takes longer than the train and you get a seat, because it starts there.
//
// So this returns SEVERAL ways, each with what it costs in time, in money and
// in standing up, and lets the person choose. Nothing new is added to the
// network - it is the same trains, the same buses, the same metro that run
// today, combined the way somebody who knew the city would combine them.

const railIdx = code => ST.findIndex(s => s.c === code);
const dayMin = m => ((m % 1440) + 1440) % 1440;

/** A corridor station within `within` km of a point, or null. */
export function railNear(lat, lng, within = 1.0) {
  let best = null;
  ST.forEach((st, i) => {
    const d = km({ lat, lng }, GEO[i]);
    if (d <= within && (!best || d < best.km)) best = { i, st, km: Math.round(d * 100) / 100 };
  });
  return best;
}

/** Trains from one corridor station to another, leaving after a minute. */
export function trainsBetween(fromIdx, toIdx, after, limit = 12) {
  if (fromIdx === toIdx) return [];
  return TRAINS.filter(t => serves(t, fromIdx, toIdx)).map(t => {
    const d = sMin(t, fromIdx, 'd'), a = sMin(t, toIdx, 'a');
    if (d == null || a == null) return null;
    // Arrival stays on the SAME timeline as departure. Wrapping it at midnight
    // made a train leaving 22:55 and arriving 00:30 arrive at minute 30 - four
    // hundred minutes BEFORE it left. allocate.span() then read that journey as
    // costing minus sixteen hours and recommended it over every train that
    // actually left sooner, from every afternoon query. hhmm() wraps for
    // display on its own, so nothing downstream needs the truncation.
    const dep = dayMin(d), min = ((dayMin(a) - dep) + 1440) % 1440;
    return { train: t.no, name: t.name, dep, arr: dep + min, min };
  }).filter(Boolean).filter(x => x.dep >= after).sort((a, b) => a.dep - b.dep).slice(0, limit);
}

/**
 * Ride a bus out of one corridor station and pick the train up at another.
 *
 * The bus has to actually start near where she is and end near a station that
 * lies BETWEEN her and where she is going - a bus that overshoots, or doubles
 * back, is not a leg of this journey however convenient its timetable looks.
 * The berth count asked for is the one for the stretch she actually rides,
 * which is the point: it can be free when the whole run is not.
 */
function busThenTrain(fromRail, toRail, after, freeOf, within = 2.5) {
  const out = [];
  if (fromRail < 0 || toRail < 0 || fromRail === toRail) return out;
  const dir = toRail > fromRail ? 1 : -1;
  BUSES.forEach(raw => {
    if (km(GEO[fromRail], { lat: raw.fromLat, lng: raw.fromLng }) > within) return;
    // BUSES is the raw table; the seat odds are what busesBetween() adds, and
    // without them the leg reaches the allocator with no seat at all
    const bus = { ...raw, seat: seatOdds({ mode: 'bus', at: raw.nStops ? raw.boardIdx / raw.nStops : null }) };
    const mid = railNear(bus.toLat, bus.toLng, within);
    if (!mid) return;
    // strictly between, and going her way
    if ((mid.i - fromRail) * dir <= 0 || (toRail - mid.i) * dir <= 0) return;
    const nb = nextBus(bus, after);
    if (!nb.ok) return;
    const arrive = nb.board + bus.runMin;
    const inLeg = busLegOut(bus, nb, arrive);
    const legs = [inLeg];
    // the walk from where the bus stops to the platform, if there is one
    let walkMin = 0;
    if (mid.km > 0.05) {
      walkMin = Math.max(1, Math.round(mid.km / WALK_KMH * 60));
      legs.push({ mode: 'walk', name: 'Walk', from: bus.to, to: ST[mid.i].n, km: mid.km, min: walkMin,
        depMin: arrive, arrMin: arrive + walkMin, dep: hhmm(dayMin(arrive)), arr: hhmm(dayMin(arrive + walkMin)),
        fare: 0, source: 'measured', fromLat: bus.toLat, fromLng: bus.toLng,
        toLat: GEO[mid.i].lat, toLng: GEO[mid.i].lng, seat: null });
    }
    // The change has to be one a person could make. Until now the onward train
    // was asked for from the minute the bus landed, so khaali offered
    // connections with nothing at all in them - and this is exactly where the
    // slack matters most, because a bus that keeps a declared headway rather
    // than a published timetable can be twenty minutes out and a missed train
    // on this corridor is not another train soon.
    const win = transfer.windowFor(inLeg, transfer.edge({
      fromStopId: bus.to, toStopId: ST[mid.i].c, walkMinutes: walkMin,
      source: 'measured', quality: walkMin ? 'measured' : 'declared' }), 'train');
    if (!win.ok) return;
    trainsBetween(mid.i, toRail, win.earliest).filter(t => t.dep <= win.latest).slice(0, 4).forEach(t => {
      out.push({ kind: 'bus+train',
        legs: legs.concat([LEG_TRAIN(t, mid.i, toRail, freeOf(t.train, mid.i, toRail))]),
        dep: nb.board, arr: t.arr,
        fare: busFare(bus) + railFare('SL', Math.abs(ST[toRail].km - ST[mid.i].km)) });
    });
  });
  return out;
}

const LEG_TRAIN = (t, fi, ti, freeSL) => ({
  mode: 'train', id: t.train, name: t.name, from: ST[fi].n, to: ST[ti].n, fromIdx: fi, toIdx: ti,
  dep: hhmm(t.dep), arr: hhmm(t.arr), depMin: t.dep, arrMin: t.arr, min: t.min,
  seat: seatOdds({ mode: 'train', free: freeSL }), source: 'timetable',
});

/**
 * Every sensible way from `from` to `to`, after a minute of the day.
 * `from` and `to` are { kind: 'rail'|'metro', id }.
 * `modes` limits what may be used: any of train, metro, bus.
 */
export function journeys({ from, to, after = 0, by = null, modes = MODES, needs = [], counts = null } = {}) {
  const use = m => modes.includes(m);
  const out = [];
  const fromRail = from.kind === 'rail' ? railIdx(from.id) : -1;
  const fromMetro = from.kind === 'metro' ? stopIdx(from.id) : -1;
  const toMetro = to.kind === 'metro' ? stopIdx(to.id) : -1;
  const toRail = to.kind === 'rail' ? railIdx(to.id) : -1;
  if (from.kind === 'rail' && fromRail < 0) return { ok: false, reason: 'unknown-from' };
  if (to.kind === 'metro' && toMetro < 0) return { ok: false, reason: 'unknown-to' };

  const freeOf = (no, f, t) => counts ? counts(no, f, t) : null;
  const b = boardStop();                                   // the metro nearest Whitefield rail
  const WFD = railIdx(RAIL_STATION);

  // ---- both ends on the corridor: it is simply a train ----
  if (from.kind === 'rail' && to.kind === 'rail') {
    if (use('train')) trainsBetween(fromRail, toRail, after).forEach(t => {
      out.push({ kind: 'train', legs: [LEG_TRAIN(t, fromRail, toRail, freeOf(t.train, fromRail, toRail))],
        dep: t.dep, arr: t.arr, fare: railFare('SL', Math.abs(ST[toRail].km - ST[fromRail].km)) });
    });
    // ...or the bus for the stretch the bus has seats on, and the train for the
    // stretch the train has berths on.
    //
    // This is seat hop, one level up. khaali already chains two partial berths
    // on one train because a berth taken Bangarpet to Whitefield can be free
    // from Whitefield onward - that is the whole product. The same fact makes a
    // bus worth taking first: she boards it where it STARTS, so she sits, and
    // by the time she reaches the corridor the berth that was occupied behind
    // her has come free in front of her. Neither vehicle could carry her the
    // whole way seated; together they can.
    if (use('bus') && use('train')) out.push(...busThenTrain(fromRail, toRail, after, freeOf));
  }

  // ---- already on the line ----
  if (from.kind === 'metro' && to.kind === 'metro') {
    if (!use('metro')) return { ok: true, chains: [] };
    const p = plan({ arriveAt: after, needs, from: from.id, to: to.id });
    if (p.ok) out.push({ kind: 'metro', legs: p.legs.map(l => metroLegOut(l, from.id)),
      dep: after, arr: p.arrive, fare: p.fare.qr, plan: p });
  }

  // ---- a corridor station to somewhere on the line ----
  if (from.kind === 'rail' && to.kind === 'metro') {
    const destNear = railNear(STOPS[toMetro].lat, STOPS[toMetro].lng, 1.0);

    // A0. already at Whitefield: walk to the line and ride it. No train at all.
    //
    // This is the journey this whole module was written for - the 1.7 km nobody
    // mentions, and the stop 150 m away that is not the namesake. It was only
    // ever reachable AFTER a train, so somebody standing at Whitefield asking
    // for the metro was told nothing runs. A walk is not a mode she has to
    // enable; it is how a person gets from a platform to a platform.
    if (use('metro') && fromRail === WFD) {
      const p = plan({ arriveAt: after, needs, to: to.id });
      if (p.ok) out.push({ kind: 'metro-from-rail',
        legs: p.legs.map(l => metroLegOut(l, b.stop.id)),
        dep: after, arr: p.arrive, fare: p.fare.qr, plan: p });
    }

    // A. train to Whitefield, then the metro
    if (use('train') && use('metro') && fromRail !== WFD) {
      trainsBetween(fromRail, WFD, after).forEach(t => {
        const tl = LEG_TRAIN(t, fromRail, WFD, freeOf(t.train, fromRail, WFD));
        // plan() already walks the 1.7 km this module was written about. What
        // was missing is the minutes before that walk starts - getting off a
        // train and out of a station is not instantaneous. No upper bound is
        // applied here: plan() takes the next metro, and the headways are
        // shorter than any wait khaali would object to.
        const win = transfer.windowFor(tl, transfer.edge({
          fromStopId: ST[WFD].c, toStopId: b.stop.id, source: 'measured' }), 'metro');
        if (!win.ok) return;
        const p = plan({ arriveAt: win.earliest, needs, to: to.id });
        if (!p.ok) return;
        out.push({ kind: 'train+metro',
          legs: [tl]
            .concat(p.legs.map(l => metroLegOut(l, b.stop.id))),
          dep: t.dep, arr: p.arrive,
          fare: railFare('SL', Math.abs(ST[WFD].km - ST[fromRail].km)) + p.fare.qr });
      });
    }

    // B. straight through on one train, if the destination has a station beside it
    if (use('train') && destNear && destNear.i !== fromRail) {
      trainsBetween(fromRail, destNear.i, after).forEach(t => {
        const w = Math.max(1, Math.round(destNear.km / WALK_KMH * 60));
        out.push({ kind: 'train-through',
          legs: [LEG_TRAIN(t, fromRail, destNear.i, freeOf(t.train, fromRail, destNear.i)),
            { mode: 'walk', from: ST[destNear.i].n, to: STOPS[toMetro].n,
              km: destNear.km, min: w, depMin: t.arr, arrMin: t.arr + w, source: 'measured' }],
          dep: t.dep, arr: t.arr + w,
          fare: railFare('SL', Math.abs(ST[destNear.i].km - ST[fromRail].km)) });
      });
    }

    // C. the bus from here, then the metro - slower, but it starts where you are
    if (use('bus')) {
      const first = busesBetween(GEO[fromRail].lat, GEO[fromRail].lng, GEO[WFD].lat, GEO[WFD].lng, 2.5);
      first.forEach(bus => {
        const nb = nextBus(bus, after);
        if (!nb.ok) return;
        const arrive = nb.board + bus.runMin;
        const inLeg = busLegOut(bus, nb, arrive);
        const legs = [inLeg];
        if (use('metro')) {
          const win = transfer.windowFor(inLeg, transfer.edge({
            fromStopId: bus.to, toStopId: b.stop.id }), 'metro');
          const p = win.ok ? plan({ arriveAt: win.earliest, needs, to: to.id }) : { ok: false };
          if (p.ok) out.push({ kind: 'bus+metro',
            legs: legs.concat(p.legs.filter(l => l.mode !== 'walk').map(l => metroLegOut(l, b.stop.id))),
            dep: nb.board, arr: p.arrive, fare: busFare(bus) + p.fare.qr });
        }
        // D. bus all the way, when one runs to the destination
        const on = busesBetween(bus.toLat, bus.toLng, STOPS[toMetro].lat, STOPS[toMetro].lng, 1.2);
        on.forEach(b2 => {
          const wb = transfer.windowFor(inLeg, transfer.edge({
            fromStopId: bus.to, toStopId: b2.from }), 'bus');
          if (!wb.ok) return;
          const nb2 = nextBus(b2, wb.earliest);
          if (!nb2.ok || nb2.board > wb.latest) return;
          out.push({ kind: 'bus+bus', legs: legs.concat([busLegOut(b2, nb2, nb2.board + b2.runMin)]),
            dep: nb.board, arr: nb2.board + b2.runMin, fare: busFare(bus) + busFare(b2) });
        });
      });
    }

    // E. train to Whitefield, then the bus into town - the seat, the long way
    if (use('train') && use('bus') && fromRail !== WFD) {
      const cityBus = busesBetween(GEO[WFD].lat, GEO[WFD].lng, STOPS[toMetro].lat, STOPS[toMetro].lng, 1.2);
      if (cityBus.length) {
        const bus = cityBus.sort((x, y) => x.runMin - y.runMin)[0];
        trainsBetween(fromRail, WFD, after).slice(0, 6).forEach(t => {
          const tl = LEG_TRAIN(t, fromRail, WFD, freeOf(t.train, fromRail, WFD));
          const win = transfer.windowFor(tl, transfer.edge({
            fromStopId: ST[WFD].c, toStopId: bus.from }), 'bus');
          if (!win.ok) return;
          const nb = nextBus(bus, win.earliest);
          if (!nb.ok || nb.board > win.latest) return;
          out.push({ kind: 'train+bus',
            legs: [tl, busLegOut(bus, nb, nb.board + bus.runMin)],
            dep: t.dep, arr: nb.board + bus.runMin,
            fare: railFare('SL', Math.abs(ST[WFD].km - ST[fromRail].km)) + busFare(bus) });
        });
      }
    }
  }

  // two trains leaving together by the same route are one choice, not two
  const seenKey = new Set();
  let chains = out.filter(c => by == null || c.arr <= by).filter(c => {
    const k = c.kind + '|' + c.dep + '|' + c.arr;
    if (seenKey.has(k)) return false;
    seenKey.add(k); return true;
  });
  // one of each shape, then whichever gets there soonest - a list of twelve
  // near-identical trains is not a choice
  const bestOf = new Map();
  chains.sort((a, b2) => a.arr - b2.arr).forEach(c => {
    const k = c.kind;
    if (!bestOf.has(k)) bestOf.set(k, []);
    if (bestOf.get(k).length < 4) bestOf.get(k).push(c);
  });
  chains = [...bestOf.values()].flat().sort((a, b2) => a.arr - b2.arr).slice(0, 12);
  return { ok: true, chains: chains.map(summarise) };
}

function busFare(b) {
  const d = km({ lat: b.fromLat, lng: b.fromLng }, { lat: b.toLat, lng: b.toLng });
  return Math.max(BUS_MIN_FARE, Math.round(d * BUS_FARE_PER_KM / 5) * 5);
}
function busLegOut(b, nb, arrive) {
  return { mode: 'bus', id: b.id, name: b.op + ' ' + b.id, from: b.from, to: b.to,
    dep: hhmm(nb.board), arr: hhmm(dayMin(arrive)), depMin: nb.board, arrMin: arrive,
    min: b.runMin, every: b.every, wait: nb.wait,
    boardIdx: b.boardIdx, nStops: b.nStops, seat: b.seat, source: b.source,
    fromLat: b.fromLat, fromLng: b.fromLng, toLat: b.toLat, toLng: b.toLng };
}
function metroLegOut(l, fromId) {
  if (l.mode !== 'metro') return { ...l, seat: null };
  return { ...l, seat: seatOdds({ mode: 'metro', load: l.crowdAlight ? l.crowdAlight.level : null }) };
}

/**
 * Vehicles khaali does not reserve a place on. It sells a PASS for these - the
 * right to board - and the next one comes. Whatever a model says about how
 * likely a seat is, khaali has not held one.
 */
export const UNRESERVED = new Set(['bus', 'metro']);

/**
 * Two claims, never one.
 *
 * A berth is inventory khaali allocates itself and can say it holds. Boarding
 * room on a bus is a forecast, and on the metro it is people walking through a
 * gate. Collapsing them into one journey-wide "SEAT YES" is how a card ended up
 * promising a seat for the whole trip on the strength of "77 berths are free on
 * your stretch" - a fact about a train, printed over a journey containing an
 * unreserved BMTC bus.
 */
export function seatClaimOf(legs) {
  const rail = (legs || []).filter(l => l.mode === 'train' && l.seat && l.seat.rank != null);
  const road = (legs || []).filter(l => UNRESERVED.has(l.mode));
  const worstRail = rail.length ? rail.reduce((p, l) => l.seat.rank < p.seat.rank ? l : p) : null;
  const kinds = [...new Set(road.map(l => l.mode))];
  const wordOf = { bus: 'the bus', metro: 'the metro' };
  return {
    rail: worstRail ? {
      word: worstRail.seat.word, why: worstRail.seat.why,
      leg: worstRail.name || 'the train',
      basis: 'berth inventory khaali allocates itself',
    } : null,
    road: road.length ? {
      word: 'unreserved', modes: kinds,
      basis: kinds.includes('bus')
        ? 'predicted boarding room, from khaali\u2019s simulated conductor'
        : 'BMRCL\u2019s own hourly station entries',
      why: 'No seat is reserved on ' + kinds.map(k => wordOf[k]).join(' or ')
        + '. khaali issues a pass, which is the right to board, not a place to sit.',
    } : null,
    // the only case where one word may speak for the whole journey
    journeyWide: road.length === 0 && rail.length > 0,
  };
}

/** What a row needs: the shape of it, the worst seat on it, and the words. */
function summarise(c) {
  const legs = c.legs;
  const seated = legs.filter(l => l.seat && l.seat.rank != null);
  const worst = seated.length ? seated.reduce((p, l) => l.seat.rank < p.seat.rank ? l : p) : null;
  const modes = legs.filter(l => l.mode !== 'walk').map(l => l.mode);
  const simulated = legs.some(l => l.source === 'simulated');
  return { ...c, modes,
    totalMin: ((c.arr - c.dep) + 1440) % 1440,
    depText: hhmm(dayMin(c.dep)), arrText: hhmm(dayMin(c.arr)),
    seat: worst ? worst.seat : { word: 'unknown', why: '' },
    seatLeg: worst ? (worst.name || worst.mode) : null,
    seatClaim: seatClaimOf(legs),
    simulated,
    changes: Math.max(0, modes.length - 1) };
}


// ------------------------------------------------------------- anywhere --
/** How far a person will walk before they would rather take a bus. */
export const WALK_MAX_KM = 1.2;
/** How far from anything khaali knows a place may be before we say so. */
export const REACH_MAX_KM = 15;
/** ...and how far, once she has said she will hire something to close the gap.
    Past this khaali still says no: a two-hour taxi is not a journey plan. */
export const HIRE_REACH_MAX_KM = hire.HIRE_MAX_KM;
/** How many nearby stations to try for a bus: the nearest one is not always
    the one with a bus to where she is going. */
export const NODES_TO_TRY = 5;

let _bmtc = null;
async function bmtc() { if (!_bmtc) _bmtc = await import('./bmtc.mjs'); return _bmtc; }
/** Loaded once at boot by the server, so the sync planner can use it. */
export function useBmtc(mod) { _bmtc = mod; }

/** The nearest stations or stops to a point, of any kind, nearest first. */
export function nearestNodes(lat, lng, n = NODES_TO_TRY, within = REACH_MAX_KM) {
  const all = [];
  const take = (kind, id, name, p) => {
    const d = km({ lat, lng }, p);
    if (d <= within) all.push({ kind, id, name, lat: p.lat, lng: p.lng, km: Math.round(d * 100) / 100 });
  };
  ST.forEach((st, i) => take('rail', st.c, st.n, GEO[i]));
  STOPS.forEach(m => take('metro', m.id, m.n, m));
  return all.sort((a, b) => a.km - b.km).slice(0, n);
}
export function nearestNode(lat, lng, within = REACH_MAX_KM) { return nearestNodes(lat, lng, 1, within)[0] || null; }

const walkLeg = (from, to, startMin, kmv) => {
  const min = Math.max(1, Math.round(kmv / WALK_KMH * 60));
  return { mode: 'walk', name: 'Walk', from: from.name, to: to.name, km: kmv, min, depMin: startMin, arrMin: startMin + min,
    dep: hhmm(dayMin(startMin)), arr: hhmm(dayMin(startMin + min)), fare: 0, source: 'measured',
    fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng, seat: null };
};

/**
 * The miles between a point and a station: a walk if it is short, otherwise
 * a BMTC bus with its walks - a real route, a real stop, a boarding position.
 * `after` is when she is at `from`.
 *
 * Only when both of those fail, and only if she has said she will hire one,
 * does a car or a bike appear. The order is the whole point: a named bus is
 * always tried first, and a hired ride never gets to compete with one.
 * Without `opts.hire` this function behaves exactly as it did before - null,
 * and null means null.
 */
export function mile(from, to, after, kmv, opts = {}) {
  if (kmv <= WALK_MAX_KM) { const l = walkLeg(from, to, after, kmv); return { legs: [l], min: l.min, fare: 0, walk: true }; }
  if (_bmtc) {
    const found = _bmtc.directBus({ fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng, after, within: 0.7, limit: 1 });
    if (found.length) {
      const o = found[0];
      o.legs.forEach(l => { if (l.mode === 'walk') { if (l.from === 'here') l.from = from.name; if (l.to === 'there') l.to = to.name; } });
      return { legs: o.legs, min: o.arrive - after, fare: o.fare, bus: o.legs.find(l => l.mode === 'bus') };
    }
  }
  const kind = opts.only || hire.pick(opts.hire || [], { pax: opts.pax || 1, needs: opts.needs || [] });
  if (!kind || kmv > hire.HIRE_MAX_KM) return null;
  // A hired ride is a LAST MILE. Riding thirty-seven kilometres out of the city
  // because that station happened to be on a convenient train is not a last
  // mile, it is a taxi with a train ticket stapled to it. The caller says how
  // far the nearest station to this end actually is, and khaali will not hire
  // from one much further away than that.
  if (opts.maxHireKm != null && kmv > opts.maxHireKm) return null;
  const l = hire.leg(kind, from, to, after, kmv, hhmm, dayMin);
  return { legs: [l], min: l.min, fare: l.fare, ride: l };
}

/**
 * A whole hop in a hired vehicle, as a chain in its own right.
 *
 * The guided planner will not do this, and should not: there, a car exists to
 * close a last mile nothing else reaches, and the cap and the hire penalty are
 * what stop it becoming a taxi with a train ticket stapled to it.
 *
 * A journey she has built herself is a different question. If she says "car
 * from the office to home", that is not khaali choosing a car over a bus - it
 * is khaali being told, and refusing would be pretending not to understand.
 */
export function rideChain(kind, from, to, after, { pax = 1, needs = [] } = {}) {
  if (!hire.HIRE[kind]) return null;
  if (!hire.allowed([kind], { pax, needs }).length) return null;
  if (!from || !to || from.lat == null || to.lat == null) return null;
  const kmv = km(from, to);
  if (!(kmv > 0) || kmv > hire.HIRE_MAX_KM) return null;
  const l = hire.leg(kind, from, to, after, kmv, hhmm, dayMin);
  return { kind: 'hire:' + kind, legs: [l], dep: l.depMin, arr: l.arrMin,
    fare: l.fare, modes: [kind], totalMin: l.min,
    depText: l.dep, arrText: l.arr, changes: 0, seat: l.seat, simulated: false };
}

/**
 * EVERY way one end can be closed, not just the first.
 *
 * A walk is a walk and a named bus is a named bus - one answer each. But when
 * the answer is a hired vehicle and she has turned on both, a car and a bike
 * are two different journeys with different fares, speeds and comfort, and the
 * ranking profile is the thing entitled to choose between them. Handing the
 * allocator only the cheaper one is deciding on her behalf.
 */
export function milesFor(from, to, after, kmv, opts = {}) {
  const one = mile(from, to, after, kmv, opts);
  if (!one || !one.ride) return one ? [one] : [];
  const kinds = hire.allowed(opts.hire || [], { pax: opts.pax || 1, needs: opts.needs || [] });
  if (kinds.length < 2) return [one];
  return kinds.map(k => mile(from, to, after, kmv, { ...opts, only: k })).filter(Boolean);
}

/**
 * When she can actually board something at the far end of a hop.
 *
 * journeysAnywhere joins two planners: journeys() for the corridor, and mile()
 * for whatever closes each end. Both were joined at the arrival minute, so a
 * train landing at 12:33 was followed by a walk at 12:33 and a bus at 12:34 -
 * the whole minute spent walking, nothing for getting off the train, out of the
 * station, or to the door before it shuts. transfer.mjs was wired into the six
 * joins INSIDE journeys() and this is the seventh, which is the one on the
 * screen for every journey that ends at a place rather than a station.
 *
 * mile() adds its own walk on top of what this returns, so the terms do not
 * double up: three minutes to get out, then the walk, then five to board.
 */
function readyAfter(legs, fallback) {
  const last = (legs && legs.length) ? legs[legs.length - 1] : null;
  if (!last || last.arrMin == null) return fallback;
  const w = transfer.windowFor(last, transfer.edge({}));
  return w.ok ? w.earliest : fallback;
}

/** Where an end actually is, whatever kind of end it is. */
export function pointOfEnd(end) {
  if (!end) return null;
  if (end.kind === 'place') return (end.lat == null) ? null : { name: end.name || 'there', lat: end.lat, lng: end.lng };
  if (end.kind === 'rail') { const i = railIdx(end.id); return i < 0 ? null : { name: ST[i].n, lat: GEO[i].lat, lng: GEO[i].lng }; }
  if (end.kind === 'metro') { const m = STOPS.find(x => x.id === end.id); return m ? { name: m.n, lat: m.lat, lng: m.lng } : null; }
  return null;
}

/**
 * journeys(), but either end may be { kind:'place', lat, lng, name }.
 * Every nearby station is tried, and a journey is built through each one
 * that can actually be reached - by foot or by a named bus. The station
 * with the bus beats the station that is merely nearest.
 */
export function journeysAnywhere(req) {
  const { from, to } = req;
  // What she is willing to hire, if anything. Nothing, unless she said so.
  const hireKinds = (req.modes || MODES).filter(m => HIRE_MODES.includes(m));
  const mileOpts = { hire: hireKinds, pax: req.pax || 1, needs: req.needs || [] };
  // How far to LOOK for a station is not the same question as how far she is
  // willing to travel to one. khaali used to tie the two together and so
  // refused a place 37 km out that a BMTC bus reaches perfectly well, then
  // offered a car for it - the wrong answer twice over. Look wide; let mile()
  // decide what can actually be closed, by foot, by bus, or by hire.
  const reach = HIRE_REACH_MAX_KM;
  /** How a station was reached, for the "we tried these" report. */
  const byOf = m => m ? (m.walk ? 'walk' : m.ride ? m.ride.name.toLowerCase() : m.bus ? m.bus.name : 'a ride') : null;
  const Fs = from.kind === 'place' ? nearestNodes(from.lat, from.lng, NODES_TO_TRY, reach) : [null];
  const Ts = to.kind === 'place' ? nearestNodes(to.lat, to.lng, NODES_TO_TRY, reach) : [null];
  if (from.kind === 'place' && !Fs.length) return { ok: false, reason: 'from-too-far', reach };
  if (to.kind === 'place' && !Ts.length) return { ok: false, reason: 'to-too-far', reach };
  const fromPt = { name: from.name || 'Start', lat: from.lat, lng: from.lng };
  const toPt = { name: to.name || 'Destination', lat: to.lat, lng: to.lng };
  // nearestNodes is sorted nearest first, so the head of each list is the
  // shortest a hired ride at that end could possibly be. Anything much longer
  // is a different journey pretending to be a last mile.
  const HIRE_SLACK = 1.5, HIRE_PAD = 3;
  const capOf = list => (list[0] && list[0].km != null) ? list[0].km * HIRE_SLACK + HIRE_PAD : null;
  const fromOpts = { ...mileOpts, maxHireKm: capOf(Fs) };
  const toOpts = { ...mileOpts, maxHireKm: capOf(Ts) };
  const out = []; const tried = { from: [], to: [] }; let anyMile = false;

  // Sometimes the whole journey IS one bus. Every journey used to be routed
  // through a railway or a metro station and then closed at each end, so
  // Majestic to Koramangala - one direct BMTC bus, ten rupees, no train
  // anywhere near it - came back as "no bus runs there". The city is not a
  // set of last miles hanging off a rail corridor.
  const A0 = pointOfEnd(from), B0 = pointOfEnd(to);
  const wants = m => (req.modes || MODES).includes(m);
  if (A0 && B0 && (wants('bus') || hireKinds.length)) {
    const straight = km(A0, B0);
    if (straight > 0.05) milesFor(A0, B0, req.after || 0, straight, mileOpts).forEach(m => {
      if (!m || m.walk) return;                     // a walk alone is not a journey to offer
      if (m.bus && !wants('bus')) return;
      if (m.ride && !hireKinds.includes(m.ride.mode)) return;
      const dep = req.after || 0, arr = dep + m.min;
      if (req.by != null && arr > req.by) return;
      const modes = m.legs.filter(l => l.mode !== 'walk').map(l => l.mode);
      if (!modes.length) return;
      const seated = m.legs.filter(l => l.seat && l.seat.rank != null);
      anyMile = true;
      out.push({
        kind: 'direct|' + (m.ride ? m.ride.mode : m.bus ? m.bus.id : 'walk'),
        legs: m.legs, dep, arr, fare: m.fare, modes,
        totalMin: ((arr - dep) + 1440) % 1440,
        depText: hhmm(dayMin(dep)), arrText: hhmm(dayMin(arr)),
        changes: Math.max(0, modes.length - 1),
        seat: seated.length ? seated.reduce((p, l) => l.seat.rank < p.seat.rank ? l : p).seat : { word: 'unknown', why: '' },
        simulated: m.legs.some(l => l.source === 'simulated'),
        via: { from: null, to: null },
      });
    });
  }

  Fs.forEach(F => {
    const firsts = F ? milesFor(fromPt, F, req.after || 0, F.km, fromOpts) : [null];
    if (F) tried.from.push({ ...F, reached: !!firsts.length, by: byOf(firsts[0]) });
    if (F && !firsts.length) return;
    firsts.forEach(first => {
    Ts.forEach(T => {
      // a rough allowance for the last mile, so reach-by is honest before the
      // bus - or the car - is known. A hired ride is quicker than a bus, so
      // guessing at bus speed would throw away journeys that do reach in time.
      const lastKmh = hireKinds.length ? 20 : 15;
      const lastWait = hireKinds.length ? 5 : 15;
      const lastGuess = T ? (T.km <= WALK_MAX_KM ? Math.round(T.km / WALK_KMH * 60) : Math.round(T.km / lastKmh * 60) + lastWait) : 0;
      const inner = journeys({ ...req,
        from: F ? { kind: F.kind, id: F.id } : from,
        to: T ? { kind: T.kind, id: T.id } : to,
        // arriving at the station is not boarding at it
        after: first ? readyAfter(first.legs, (req.after || 0) + first.min) : (req.after || 0),
        by: req.by != null ? req.by - lastGuess : null });
      if (!inner.ok) return;
      inner.chains.forEach(c => {
        const legs = c.legs.slice();
        let dep = c.dep, arr = c.arr, fare = c.fare;
        if (first) { legs.unshift(...first.legs); dep = req.after || 0; fare += first.fare; }
        // she is not on the pavement the minute the train stops
        const ready = readyAfter(c.legs, c.arr);
        const lasts = T ? milesFor({ name: T.name, lat: T.lat, lng: T.lng }, toPt, ready, T.km, toOpts) : [null];
        if (T && !lasts.length) return;
        lasts.forEach(last => {
          const legs2 = legs.slice();
          let arr2 = arr, fare2 = fare;
          if (last) {
            legs2.push(...last.legs); arr2 = ready + last.min; fare2 = fare + last.fare;
            if (req.by != null && arr2 > req.by) return;
          }
          anyMile = true;
          const modes = legs2.filter(l => l.mode !== 'walk').map(l => l.mode);
          // the vehicle is part of the identity: a car and a bike over the same
          // ground are two choices, and must not collapse into one
          const ride = [first, last].filter(x => x && x.ride).map(x => x.ride.mode).join('+');
          /* The seat was carried over from the inner corridor chain and never
             recomputed, so the bus into Hebbala was invisible to it: a journey
             with an unreserved BMTC leg wore the train's berth availability as
             its own. Recount over every leg, and keep the two claims apart. */
          const seated2 = legs2.filter(l => l.seat && l.seat.rank != null);
          const worst2 = seated2.length
            ? seated2.reduce((p, l) => l.seat.rank < p.seat.rank ? l : p) : null;
          out.push({ ...c, legs: legs2, dep, arr: arr2, fare: fare2, modes,
            kind: c.kind + (F ? '|' + F.id : '') + (T ? '|' + T.id : '') + (ride ? '|' + ride : ''),
            totalMin: ((arr2 - dep) + 1440) % 1440,
            depText: hhmm(dayMin(dep)), arrText: hhmm(dayMin(arr2)),
            seat: worst2 ? worst2.seat : { word: 'unknown', why: '' },
            seatLeg: worst2 ? (worst2.name || worst2.mode) : null,
            seatClaim: seatClaimOf(legs2),
            simulated: legs2.some(l => l.source === 'simulated'),
            changes: Math.max(0, modes.length - 1),
            via: { from: F ? { kind: F.kind, id: F.id, name: F.name, km: F.km } : null, to: T ? { kind: T.kind, id: T.id, name: T.name, km: T.km } : null } });
        });
      });
    });
    });
  });
  Ts.forEach(T => { if (T) { const m = mile({ name: T.name, lat: T.lat, lng: T.lng }, toPt, req.after || 0, T.km, toOpts); tried.to.push({ ...T, reached: !!m, by: byOf(m) }); } });
  // with something hired on the table, "no bus runs there" is no longer the
  // reason nothing was found - so say which wall was actually hit
  if (!out.length && (Fs[0] || Ts[0])) return { ok: false, reason: hireKinds.length ? 'no-way' : 'no-bus', tried };
  // the same shape through the same stations at the same times is one choice
  const seen = new Set();
  const uniq = out.filter(c => { const k = c.kind + '|' + c.dep + '|' + c.arr; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.arr - b.arr);
  const chains = uniq.slice(0, 14);
  // Offering a car AND a bike doubles the hired journeys, and they are quick,
  // so they can fill the whole list and push the bus off the bottom of it. The
  // way there without hiring anything is the one khaali exists to show: if it
  // did not survive the trim, it takes the last place.
  const hired = c => c.legs.some(l => hire.isHire(l.mode));
  if (chains.length === 14 && chains.every(hired)) {
    const bestNet = uniq.find(c => !hired(c));
    if (bestNet) chains[13] = bestNet;
  }
  return { ok: true, chains, tried };
}
