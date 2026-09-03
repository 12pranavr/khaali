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

export const WALK_KMH = 4.5;
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
    id, who, date, holder: holder || null, covers: modes,
    fare: FARE.qr, status: 'valid', issuedAt: now, rides: [],
  } };
}

/** The conductor's or the gate's tap. Marks a ride; refuses the wrong day,
    a cancelled pass, or a mode it never covered. A pass is never "used up" -
    that is the difference between a pass and a ticket. */
export function scan(p, { by, mode, where } = {}, now = Date.now()) {
  if (!p) return { ok: false, reason: 'missing' };
  if (p.status !== 'valid') return { ok: false, reason: p.status };
  if (!PASS_MODES.includes(mode)) return { ok: false, reason: 'bad-mode' };
  if (!p.covers.includes(mode)) return { ok: false, reason: 'not-covered' };
  const day = new Date(now);
  const iso = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
  if (iso !== p.date) return { ok: false, reason: 'wrong-day', validOn: p.date };
  // the same door twice in a minute is one tap, not two rides
  const last = p.rides[p.rides.length - 1];
  if (last && last.mode === mode && last.where === (where || null) && now - last.at < 60000)
    return { ok: true, ride: last, repeat: true };
  const ride = { n: p.rides.length + 1, mode, by: by || null, where: where || null, at: now };
  p.rides.push(ride);
  return { ok: true, ride };
}

export function cancelPass(p, now = Date.now()) {
  if (!p) return { ok: false, reason: 'missing' };
  p.status = 'cancelled'; p.cancelledAt = now;
  return { ok: true };
}

/** What a phone, or a conductor's phone, is allowed to see. */
export function publicOf(p) {
  if (!p) return null;
  return { id: p.id, date: p.date, holder: p.holder, covers: p.covers, fare: p.fare,
    status: p.status, issuedAt: p.issuedAt, rides: p.rides.length,
    last: p.rides.length ? p.rides[p.rides.length - 1] : null };
}
