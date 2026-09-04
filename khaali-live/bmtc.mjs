// Every BMTC bus in the city, and which one goes from here to there.
//
// bmtc.json is BMTC's own published timetable (GTFS, via
// github.com/Vonter/bmtc-gtfs, ODbL), boiled down to what a planner needs:
// every stop with its position, and for every route the one or two stop
// sequences it actually runs, with the median minute at which a bus reaches
// each stop after leaving the first, the median gap between buses, and the
// first and last departure of the day.
//
// The question this file answers is the one nobody in Bengaluru can answer
// without asking a conductor: from a point near here to a point near there,
// which bus, from which stop, boarding at what position on its route - and
// so, whether there will be a seat.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seatOdds } from './journey.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let DATA = null;
function data() {
  if (DATA) return DATA;
  DATA = JSON.parse(fs.readFileSync(path.join(DIR, 'bmtc.json'), 'utf8'));
  // a grid over the city, so "stops within 600 m" is a lookup, not a scan
  DATA.grid = new Map();
  DATA.stops.forEach((s, i) => {
    const k = cell(s[2], s[3]);
    if (!DATA.grid.has(k)) DATA.grid.set(k, []);
    DATA.grid.get(k).push(i);
  });
  // which patterns pass each stop, and where in the pattern
  DATA.at = new Map();
  DATA.routes.forEach((r, ri) => r.p.forEach((p, pi) => p.s.forEach((si, k) => {
    if (!DATA.at.has(si)) DATA.at.set(si, []);
    DATA.at.get(si).push([ri, pi, k]);
  })));
  return DATA;
}
const CELL = 0.01;                                   // ~1.1 km
const cell = (lat, lng) => Math.floor(lat / CELL) + ':' + Math.floor(lng / CELL);
const R = 6371;
export function km(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const WALK_KMH = 4.5;
const walkMin = k => Math.max(1, Math.round(k / WALK_KMH * 60));
const hhmm = m => { const x = ((m % 1440) + 1440) % 1440; const h = Math.floor(x / 60), mm = String(x % 60).padStart(2, '0'); return String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0') + ':' + mm + ' ' + (h < 12 ? 'AM' : 'PM'); };

/** Stops within `within` km of a point, nearest first. */
export function stopsNear(lat, lng, within = 0.6) {
  const D = data(); const out = [];
  const c = Math.ceil(within / 1.1);
  const la = Math.floor(lat / CELL), ln = Math.floor(lng / CELL);
  for (let i = -c; i <= c; i++) for (let j = -c; j <= c; j++) {
    (D.grid.get((la + i) + ':' + (ln + j)) || []).forEach(si => {
      const s = D.stops[si]; const d = km({ lat, lng }, { lat: s[2], lng: s[3] });
      if (d <= within) out.push({ i: si, id: s[0], n: s[1], lat: s[2], lng: s[3], km: Math.round(d * 100) / 100 });
    });
  }
  return out.sort((a, b) => a.km - b.km);
}

/** Fare, BMTC ordinary: a stage system, but ~₹1.2 a km with a ₹6 floor is
    what people pay in practice. */
export const fareFor = k => Math.max(6, Math.round(k * 1.2 / 5) * 5);

/**
 * Direct buses from near one point to near another, leaving after a minute.
 * Returns legs shaped like every other bus leg in khaali, best first, with the
 * walks to and from the stops as their own legs.
 */
export function directBus({ fromLat, fromLng, toLat, toLng, after = 0, within = 0.6, limit = 4 } = {}) {
  const D = data();
  const A = stopsNear(fromLat, fromLng, within), B = stopsNear(toLat, toLng, within);
  if (!A.length || !B.length) return [];
  const bIdx = new Map(); B.forEach(b => { if (!bIdx.has(b.i)) bIdx.set(b.i, b); });
  const seen = new Set(); const out = [];
  A.forEach(a => (D.at.get(a.i) || []).forEach(([ri, pi, k]) => {
    const r = D.routes[ri], p = r.p[pi];
    // the first stop of the pattern at or after k that is in B
    for (let j = k + 1; j < p.s.length; j++) {
      const b = bIdx.get(p.s[j]);
      if (!b) continue;
      const key = r.id + '|' + pi;
      if (seen.has(key)) break; seen.add(key);
      const walk1 = walkMin(a.km), ready = after + walk1;
      const every = p.e || 30;
      const atStop = p.f + p.m[k];                               // first bus of the day reaches this stop
      let board = atStop;
      if (ready > board) board = atStop + Math.ceil((ready - atStop) / every) * every;
      if (board - p.m[k] > p.l) break;                           // past the last bus
      const run = p.m[j] - p.m[k];
      const alight = board + run, walk2 = walkMin(b.km), arrive = alight + walk2;
      const dist = km(a, b);
      out.push({
        arrive, dep: board, legs: [
          a.km > 0.05 ? { mode: 'walk', name: 'Walk', from: 'here', to: a.n, km: a.km, min: walk1, depMin: after, arrMin: ready,
            dep: hhmm(after), arr: hhmm(ready), fare: 0, source: 'measured', fromLat, fromLng, toLat: a.lat, toLng: a.lng, seat: null } : null,
          { mode: 'bus', id: r.n, name: 'BMTC ' + r.n, headsign: r.ln, from: a.n, to: b.n,
            dep: hhmm(board), arr: hhmm(alight), depMin: board, arrMin: alight, min: run, every, wait: board - ready,
            boardIdx: k, nStops: p.s.length, stops: j - k, km: Math.round(dist * 10) / 10, fare: fareFor(dist),
            seat: seatOdds({ mode: 'bus', at: k / p.s.length }), source: 'timetable', trips: p.t,
            fromLat: a.lat, fromLng: a.lng, toLat: b.lat, toLng: b.lng },
          b.km > 0.05 ? { mode: 'walk', name: 'Walk', from: b.n, to: 'there', km: b.km, min: walk2, depMin: alight, arrMin: arrive,
            dep: hhmm(alight), arr: hhmm(arrive), fare: 0, source: 'measured', fromLat: b.lat, fromLng: b.lng, toLat, toLng, seat: null } : null,
        ].filter(Boolean), fare: fareFor(dist), min: arrive - after,
      });
      break;
    }
  }));
  return out.sort((x, y) => x.arrive - y.arrive || x.min - y.min).slice(0, limit);
}

/** How many stops and routes are loaded - for /api/meta and the tests. */
export function stats() { const D = data(); return { stops: D.stops.length, routes: D.routes.length, patterns: D.routes.reduce((n, r) => n + r.p.length, 0), source: D.source }; }
