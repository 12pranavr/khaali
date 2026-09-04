// How fast the road actually moves, measured by the buses on it.
//
// khaali used to answer "how long is that car ride" with a constant: 22 km/h,
// everywhere, all day, from nowhere. That is the least honest number in the
// product - worse than a labelled simulation, because it does not even admit
// to being a guess.
//
// It does not have to be. bmtc.json is BMTC's own timetable, and a timetable is
// a measurement: 4,358 routes give roughly 196,000 timed stop-to-stop segments,
// each one a bus covering a known distance in a known number of minutes. Buses
// are traffic probes that have been running this whole time.
//
// Binned onto a coarse grid the city separates properly - the slowest cells run
// at about 12 km/h and the fastest at about 32 - so khaali can say where a road
// is slow, and say it with a source.
//
// What this file does NOT know is WHEN. A pattern's departure field is its first
// bus of the day, so an all-day route lands in one hour bucket and the hourly
// signal that falls out is an artifact, not a rush hour. The hour lives in
// traffic.mjs, is labelled `simulated`, and is kept separate on purpose.
//
// Nothing here talks to a language model. This file is arithmetic.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** ~2 km cells. Smaller splits the samples too thin to trust; larger averages
    a jammed arterial together with the side street beside it. */
export const CELL = 0.02;
/** Below this many timed segments a cell does not get to have an opinion. */
export const MIN_SAMPLES = 20;
/** Segments shorter than this are mostly stop dwell time, not travel. */
const MIN_SEG_KM = 0.15;
/** A bus doing 70 km/h through Bengaluru is a data error, not a fast road. */
const MIN_KMH = 1, MAX_KMH = 70;

export const SOURCE = 'BMTC scheduled run times (GTFS via Vonter, ODbL)';

const cellKey = (lat, lng) => Math.round(lat / CELL) + ':' + Math.round(lng / CELL);

const R = 6371;
function km(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180;
  const dla = (bLat - aLat) * r, dln = (bLng - aLng) * r;
  const s = Math.sin(dla / 2) ** 2
    + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dln / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const median = xs => {
  const a = xs.slice().sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};

let FIELD = null;

/**
 * Build the speed field once: every timed stop-pair in the city, binned by
 * where it starts, reduced to a median so one delayed pattern cannot move a
 * cell. Roughly a second at boot, then a Map of a few hundred cells.
 */
export function build(raw = null) {
  const D = raw || JSON.parse(fs.readFileSync(path.join(DIR, 'bmtc.json'), 'utf8'));
  const S = D.stops || [];
  const acc = new Map();
  let samples = 0;
  (D.routes || []).forEach(rt => (rt.p || []).forEach(p => {
    if (!p.m || !p.s || p.m.length < 3) return;
    for (let i = 1; i < p.s.length; i++) {
      const a = S[p.s[i - 1]], b = S[p.s[i]];
      if (!a || !b) continue;
      const dt = p.m[i] - p.m[i - 1];
      if (!(dt > 0)) continue;
      const d = km(a[2], a[3], b[2], b[3]);
      if (!(d >= MIN_SEG_KM)) continue;
      const kmh = d / dt * 60;
      if (!(kmh >= MIN_KMH && kmh <= MAX_KMH)) continue;
      const k = cellKey(a[2], a[3]);
      if (!acc.has(k)) acc.set(k, []);
      acc.get(k).push(kmh);
      samples++;
    }
  }));
  const cells = new Map();
  const speeds = [];
  acc.forEach((v, k) => {
    if (v.length < MIN_SAMPLES) return;             // too thin to speak
    const m = Math.round(median(v) * 10) / 10;
    cells.set(k, { kmh: m, samples: v.length });
    speeds.push(m);
  });
  // the city's own median, computed - not a number somebody typed
  const cityKmh = speeds.length ? Math.round(median(speeds) * 10) / 10 : 19;
  FIELD = { cells, cityKmh, samples, built: Date.now() };
  return FIELD;
}

export function field() { return FIELD || build(); }

/** So the tests can build a field from a fixture instead of the whole city. */
export function useField(f) { FIELD = f; }

/** The free-flow-ish speed of the roads around a point. Free of the hour: this
    is where, not when. */
export function speedAt(lat, lng) {
  const F = field();
  const c = F.cells.get(cellKey(lat, lng));
  if (!c) return { kmh: F.cityKmh, samples: 0, quality: 'unknown',
    source: 'no bus times near that point; the city median instead' };
  return { kmh: c.kmh, samples: c.samples, quality: 'estimated',
    source: c.samples + ' timed bus segments here · ' + SOURCE };
}

/**
 * The speed over a whole ride, weighted by how much of it falls in each cell.
 * A ride out of a jammed centre into an open suburb is neither one nor the
 * other, and averaging the two by distance is the honest middle.
 */
export function speedAlong(path = []) {
  const F = field();
  const pts = path.filter(p => p && p.length >= 2);
  if (pts.length < 2) return { kmh: F.cityKmh, cells: 0, samples: 0, quality: 'unknown',
    source: 'no route drawn; the city median instead' };
  let num = 0, den = 0, known = 0, samples = 0;
  const seen = new Set();
  for (let i = 1; i < pts.length; i++) {
    const d = km(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (!(d > 0)) continue;
    const s = speedAt(pts[i - 1][0], pts[i - 1][1]);
    // harmonic: speeds average over DISTANCE by their reciprocals, not directly.
    // Two halves at 10 and 30 km/h is 15 km/h overall, never 20.
    num += d; den += d / s.kmh;
    if (s.quality === 'estimated') {
      known += d; samples += s.samples;
      seen.add(cellKey(pts[i - 1][0], pts[i - 1][1]));
    }
  }
  if (!den) return { kmh: F.cityKmh, cells: 0, samples: 0, quality: 'unknown', source: 'nothing measurable' };
  const kmh = Math.round(num / den * 10) / 10;
  // a route mostly over cells khaali has never measured is not an estimate
  const covered = num ? known / num : 0;
  const quality = covered >= 0.5 ? 'estimated' : 'unknown';
  return { kmh, cells: seen.size, samples, covered: Math.round(covered * 100) / 100, quality,
    source: quality === 'estimated'
      ? Math.round(covered * 100) + '% of the way over roads with bus times · ' + SOURCE
      : 'most of that route has no bus times; the figure is the city median' };
}

/** A straight line between two points, for when no road shape is known. */
export function speedBetween(fromLat, fromLng, toLat, toLng, steps = 6) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([fromLat + (toLat - fromLat) * t, fromLng + (toLng - fromLng) * t]);
  }
  return speedAlong(pts);
}

/**
 * The colour a road wears.
 *
 * The ratio is speed against a FREE-FLOWING Bengaluru - the 90th-percentile
 * cell, which is what this city looks like when nothing is in the way - not
 * against a motorway that does not exist here. So green means "as good as this
 * city gets", not "as good as a motorway".
 *
 * Configurable, like every other threshold in khaali: per mode, per corridor,
 * per experiment. Nothing else decides a colour.
 */
export const BANDS = { green: 0.80, yellow: 0.55, orange: 0.40 };
export const OVERRIDES = {};

export function bandsFor(key = null) { return (key && OVERRIDES[key]) || BANDS; }

/** Where free-flowing Bengaluru actually is, computed from the field. */
export function freeFlowKmh() {
  const F = field();
  const s = [...F.cells.values()].map(c => c.kmh).sort((a, b) => a - b);
  if (!s.length) return F.cityKmh;
  return s[Math.floor(s.length * 0.9)];
}

/**
 * green / yellow / orange / red - or GREY, when khaali has not measured this
 * road. A road drawn green because nobody has driven it is the single most
 * dangerous thing this feature could do.
 */
export function stateOf({ kmh, quality = 'estimated' }, key = null) {
  if (quality === 'unknown' || kmh == null) return { band: 'unknown', ratio: null };
  const b = bandsFor(key);
  const ratio = Math.round(kmh / freeFlowKmh() * 100) / 100;
  const band = ratio >= b.green ? 'green'
    : ratio >= b.yellow ? 'yellow'
      : ratio >= b.orange ? 'orange' : 'red';
  return { band, ratio };
}

/** Every cell, for the map overlay. Read-only. */
export function cells() {
  const F = field();
  return [...F.cells.entries()].map(([k, v]) => {
    const [a, b] = k.split(':').map(Number);
    return { lat: a * CELL, lng: b * CELL, kmh: v.kmh, samples: v.samples };
  });
}

export function stats() {
  const F = field();
  const s = [...F.cells.values()].map(c => c.kmh).sort((a, b) => a - b);
  return { cells: F.cells.size, samples: F.samples, cityKmh: F.cityKmh,
    slowest: s[0] ?? null, fastest: s[s.length - 1] ?? null, source: SOURCE };
}
