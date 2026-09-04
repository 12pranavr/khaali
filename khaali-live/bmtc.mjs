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

/** A polyline-encoded shape back into [lat, lng] points, cached per pattern. */
export function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
function shapeOf(p) {
  if (!p.sh) return null;
  if (!p._pts) p._pts = decodePolyline(p.sh);
  return p._pts;
}
/** The road between two stops of a pattern: the shape sliced at the points
    nearest each stop. A straight line between two ends is a lie; this is the
    route the bus actually drives. */
export function pathBetween(p, k, j) {
  const D = data(); const pts = shapeOf(p);
  if (!pts || pts.length < 2) return null;
  const near = si => { const st = D.stops[si]; let bi = 0, bd = Infinity;
    pts.forEach((q, i) => { const d = (q[0] - st[2]) ** 2 + (q[1] - st[3]) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
  let a = near(p.s[k]), b = near(p.s[j]);
  if (b < a) [a, b] = [b, a];
  const seg = pts.slice(a, b + 1);
  return seg.length >= 2 ? seg.map(q => [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5]) : null;
}
/** What a stop is, from its name. */
export const stopKind = name => /bus station|bus stand|ttmc|depot|bmtc/i.test(name) ? 'bus station' : 'bus stop';

/**
 * The road for a bus leg that came from elsewhere (buses.mjs's KBS routes):
 * find the route by its short name, the pattern that runs from near A to
 * near B, and slice its shape.
 */
export function pathForRoute(name, fromLat, fromLng, toLat, toLng) {
  const D = data();
  const rs = D.routes.filter(r => r.n === name || r.n.split(' ')[0] === name);
  if (!rs.length) return null;
  const A = stopsNear(fromLat, fromLng, 1.0), B = stopsNear(toLat, toLng, 1.0);
  const aSet = new Set(A.map(x => x.i)), bSet = new Set(B.map(x => x.i));
  for (const r of rs) for (const p of r.p) {
    let k = -1, j = -1;
    p.s.forEach((si, i) => { if (k < 0 && aSet.has(si)) k = i; if (k >= 0 && i > k && j < 0 && bSet.has(si)) j = i; });
    if (k >= 0 && j > k) return pathBetween(p, k, j);
  }
  return null;
}

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
          a.km > 0.05 ? { mode: 'walk', name: 'Walk', from: 'here', to: a.n, toKind: stopKind(a.n), km: a.km, min: walk1, depMin: after, arrMin: ready,
            dep: hhmm(after), arr: hhmm(ready), fare: 0, source: 'measured', fromLat, fromLng, toLat: a.lat, toLng: a.lng, seat: null } : null,
          { mode: 'bus', id: r.n, name: 'BMTC ' + r.n, headsign: r.ln, from: a.n, to: b.n,
            fromKind: stopKind(a.n), toKind: stopKind(b.n), path: pathBetween(p, k, j),
            dep: hhmm(board), arr: hhmm(alight), depMin: board, arrMin: alight, min: run, every, wait: board - ready,
            boardIdx: k, nStops: p.s.length, stops: j - k, km: Math.round(dist * 10) / 10, fare: fareFor(dist),
            seat: seatOdds({ mode: 'bus', at: k / p.s.length }), source: 'timetable', trips: p.t,
            fromLat: a.lat, fromLng: a.lng, toLat: b.lat, toLng: b.lng },
          b.km > 0.05 ? { mode: 'walk', name: 'Walk', from: b.n, fromKind: stopKind(b.n), to: 'there', km: b.km, min: walk2, depMin: alight, arrMin: arrive,
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

/** Stops by name, for the pickers. Platform variants of one station collapse
    to one entry; the many stops sharing a name collapse to the first. */
const base = t => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Kannada transliteration keeps or drops a final a - per word ("Shivajinagara
// Bus Station") or only at the end ("Indira Nagar" for "Indiranagara"). Both
// forms of both sides are compared, with spaces removed.
const forms = t => { const b = base(t); return [b.replace(/a$/, ''), b.replace(/a\b/g, '')].map(x => x.replace(/ /g, '')); };
const normName = t => base(t).replace(/a$/, '');
export function searchStops(q, limit = 8) {
  const D = data();
  const needle = normName(q); const nf = forms(q);
  if (needle.length < 2) return [];
  const seen = new Map();
  const score = (n, name) => {
    const f = forms(name);
    if (f.some(x => nf.some(y => x.startsWith(y)))) return 0;
    if (n.split(' ').some(w => w.startsWith(needle))) return 1;
    if (f.some(x => nf.some(y => x.includes(y)))) return 2;
    return -1;
  };
  D.stops.forEach((s, si) => {
    const name = s[1].replace(/\s*-\s*platform.*$/i, '').trim();
    const n = normName(name);
    const sc = score(n, name);
    if (sc < 0) return;
    const isStation = /bus station|bus stand|ttmc|depot/i.test(name) ? 0 : 1;
    // two stops with one name a street apart are one place; ten kilometres
    // apart they are two places, and both are kept - Bengaluru has twins
    const key = n + '|' + Math.round(s[2] / 0.02) + ':' + Math.round(s[3] / 0.02);
    const cur = seen.get(key);
    if (!cur) seen.set(key, { n: name, lat: s[2], lng: s[3], sc, isStation, routes: (D.at.get(si) || []).length });
    else cur.routes += (D.at.get(si) || []).length;
  });
  return [...seen.values()].sort((a, b) => a.sc - b.sc || a.isStation - b.isStation || b.routes - a.routes || a.n.length - b.n.length).slice(0, limit)
    .map(x => ({ kind: 'stop', id: x.lat.toFixed(5) + ',' + x.lng.toFixed(5), name: x.n, lat: x.lat, lng: x.lng, station: x.isStation === 0,
      routes: x.routes, hint: whereabouts(x.lat, x.lng) }));
}
/** "6 km E of Majestic" - enough to tell twins apart. */
const MAJESTIC = { lat: 12.97567, lng: 77.57281 };
export function whereabouts(lat, lng) {
  const d = km(MAJESTIC, { lat, lng });
  if (d < 0.8) return 'at Majestic';
  const ang = Math.atan2(lat - MAJESTIC.lat, (lng - MAJESTIC.lng) * Math.cos(lat * Math.PI / 180)) * 180 / Math.PI;
  const dirs = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
  const dir = dirs[Math.round(((ang + 360) % 360) / 45) % 8];
  return Math.round(d) + ' km ' + dir + ' of Majestic';
}
/** A stop that IS what she said - "Kempegowda Bus Station", "Depot-06
    Indiranagara", "Shivajinagar bus station" - or null. */
export function stopNamed(q) {
  const nf = forms(q);
  if (!nf[0]) return null;
  const hits = searchStops(q, 5);
  return hits.find(x => { const f = forms(x.name); return f.some(a => nf.some(b => a === b || a === b + 'busstation' || a === b + 'busstand')); }) || null;
}
