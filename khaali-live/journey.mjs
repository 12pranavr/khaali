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

export const WALK_KMH = 4.5;
export const MODES = ['train', 'metro', 'bus'];

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
    return { train: t.no, name: t.name, dep: dayMin(d), arr: dayMin(a),
      min: ((dayMin(a) - dayMin(d)) + 1440) % 1440 };
  }).filter(Boolean).filter(x => x.dep >= after).sort((a, b) => a.dep - b.dep).slice(0, limit);
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
    if (!use('train')) return { ok: true, chains: [] };
    trainsBetween(fromRail, toRail, after).forEach(t => {
      out.push({ kind: 'train', legs: [LEG_TRAIN(t, fromRail, toRail, freeOf(t.train, fromRail, toRail))],
        dep: t.dep, arr: t.arr, fare: railFare('SL', Math.abs(ST[toRail].km - ST[fromRail].km)) });
    });
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

    // A. train to Whitefield, then the metro
    if (use('train') && use('metro') && fromRail !== WFD) {
      trainsBetween(fromRail, WFD, after).forEach(t => {
        const p = plan({ arriveAt: t.arr, needs, to: to.id });
        if (!p.ok) return;
        out.push({ kind: 'train+metro',
          legs: [LEG_TRAIN(t, fromRail, WFD, freeOf(t.train, fromRail, WFD))]
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
        const legs = [busLegOut(bus, nb, arrive)];
        if (use('metro')) {
          const p = plan({ arriveAt: arrive, needs, to: to.id });
          if (p.ok) out.push({ kind: 'bus+metro',
            legs: legs.concat(p.legs.filter(l => l.mode !== 'walk').map(l => metroLegOut(l, b.stop.id))),
            dep: nb.board, arr: p.arrive, fare: busFare(bus) + p.fare.qr });
        }
        // D. bus all the way, when one runs to the destination
        const on = busesBetween(bus.toLat, bus.toLng, STOPS[toMetro].lat, STOPS[toMetro].lng, 1.2);
        on.forEach(b2 => {
          const nb2 = nextBus(b2, arrive);
          if (!nb2.ok) return;
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
          const nb = nextBus(bus, t.arr);
          if (!nb.ok) return;
          out.push({ kind: 'train+bus',
            legs: [LEG_TRAIN(t, fromRail, WFD, freeOf(t.train, fromRail, WFD)),
              busLegOut(bus, nb, nb.board + bus.runMin)],
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
    simulated,
    changes: Math.max(0, modes.length - 1) };
}


// ------------------------------------------------------------- anywhere --
/** How far a person will walk before they would rather take an auto. */
export const WALK_MAX_KM = 1.2;
/** How far from anything khaali knows a place may be before we say so. */
export const REACH_MAX_KM = 15;
export const AUTO_KMH = 18;
export const autoFare = k => Math.round(30 + 12 * k);

/** The nearest station or stop to a point, of any kind, or null. */
export function nearestNode(lat, lng, within = REACH_MAX_KM) {
  let best = null;
  const take = (kind, id, name, p) => {
    const d = km({ lat, lng }, p);
    if (d <= within && (!best || d < best.km)) best = { kind, id, name, lat: p.lat, lng: p.lng, km: Math.round(d * 100) / 100 };
  };
  ST.forEach((st, i) => take('rail', st.c, st.n, GEO[i]));
  STOPS.forEach(m => take('metro', m.id, m.n, m));
  return best;
}

/** The leg between a point and the station that serves it. */
function mileLeg(from, to, startMin, kmv) {
  const walk = kmv <= WALK_MAX_KM;
  const min = walk ? Math.max(1, Math.round(kmv / WALK_KMH * 60)) : Math.round(kmv / AUTO_KMH * 60) + 5;
  return { mode: walk ? 'walk' : 'auto', name: walk ? 'Walk' : 'Auto or local bus',
    from: from.name, to: to.name, km: kmv, min, depMin: startMin, arrMin: startMin + min,
    dep: hhmm(dayMin(startMin)), arr: hhmm(dayMin(startMin + min)),
    fare: walk ? 0 : autoFare(kmv), source: 'estimated',
    fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng, seat: null };
}

/**
 * journeys(), but either end may be { kind:'place', lat, lng, name }.
 * The place is joined to its nearest station by a walk or an auto, and that
 * leg is part of the journey - in the time, the fare, and on the map.
 */
export function journeysAnywhere(req) {
  const { from, to } = req;
  const F = from.kind === 'place' ? nearestNode(from.lat, from.lng) : null;
  const T = to.kind === 'place' ? nearestNode(to.lat, to.lng) : null;
  if (from.kind === 'place' && !F) return { ok: false, reason: 'from-too-far' };
  if (to.kind === 'place' && !T) return { ok: false, reason: 'to-too-far' };
  const first = F ? mileLeg({ name: from.name || 'Start', lat: from.lat, lng: from.lng }, F, req.after || 0, F.km) : null;
  const lastMin = T ? mileLeg({ name: T.name, lat: T.lat, lng: T.lng }, { name: to.name || 'Destination', lat: to.lat, lng: to.lng }, 0, T.km).min : 0;
  const inner = journeys({ ...req,
    from: F ? { kind: F.kind, id: F.id } : from,
    to: T ? { kind: T.kind, id: T.id } : to,
    after: first ? first.arrMin : (req.after || 0),
    by: req.by != null ? req.by - lastMin : null });
  if (!inner.ok) return inner;
  const chains = inner.chains.map(c => {
    const legs = c.legs.slice();
    let dep = c.dep, arr = c.arr, fare = c.fare;
    if (first) { legs.unshift(first); dep = first.depMin; fare += first.fare; }
    if (T) {
      const last = mileLeg({ name: T.name, lat: T.lat, lng: T.lng }, { name: to.name || 'Destination', lat: to.lat, lng: to.lng }, c.arr, T.km);
      legs.push(last); arr = last.arrMin; fare += last.fare;
    }
    const modes = legs.filter(l => l.mode !== 'walk').map(l => l.mode);
    return { ...c, legs, dep, arr, fare, modes,
      totalMin: ((arr - dep) + 1440) % 1440,
      depText: hhmm(dayMin(dep)), arrText: hhmm(dayMin(arr)),
      changes: Math.max(0, modes.length - 1),
      via: { from: F ? { ...F } : null, to: T ? { ...T } : null } };
  });
  return { ok: true, chains, via: { from: F, to: T } };
}
