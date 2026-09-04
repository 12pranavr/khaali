// WHEN the road is slow.
//
// road.mjs answers where, and it answers it with a measurement: two hundred
// thousand timed bus segments. This file answers when, and it CANNOT do that
// from the same data. A pattern's departure field is its first bus of the day,
// so an all-day route falls into a single hour and the curve that comes out is
// an artifact - about seven percent between the best hour and the worst, when
// Bengaluru's real peak is far worse than that.
//
// So the hour is not measured here. It is DECLARED: a stated assumption about
// a city, labelled `simulated` everywhere it is shown, exactly like the KSRTC
// leg and the seeded berth occupancy. That is the difference between a model
// and a lie - a model says what it is, and a reviewer can argue with the number
// instead of guessing at it.
//
// When a live feed exists it replaces CURVE and the quality becomes `exact`.
// Nothing else in khaali has to change, which is the point of keeping it here.

export const QUALITY = 'simulated';
export const SOURCE = 'a declared weekday congestion curve for Bengaluru, not a measurement';

/**
 * What is left of the free-flow speed, hour by hour, on a weekday. 1.0 means
 * the road runs at the speed the bus timetable implies; 0.55 means it crawls at
 * a bit over half that.
 *
 * The shape is the one every Bengaluru commuter would recognise: a hard morning
 * peak around nine, a softer midday, a worse and longer evening peak, and open
 * roads after ten at night. The exact figures are arguable ON PURPOSE - they
 * are in one table so they can be argued with.
 */
export const CURVE = {
  0: 1.30, 1: 1.35, 2: 1.35, 3: 1.35, 4: 1.30, 5: 1.20,
  6: 1.05, 7: 0.85, 8: 0.66, 9: 0.58, 10: 0.72, 11: 0.85,
  12: 0.88, 13: 0.90, 14: 0.90, 15: 0.86, 16: 0.78, 17: 0.66,
  18: 0.55, 19: 0.56, 20: 0.68, 21: 0.85, 22: 1.05, 23: 1.20,
};

/** A Sunday is not a Tuesday. One number, and it says it is a guess too. */
export const WEEKEND_EASE = 1.25;

/** Overridable the way the rest of khaali's thresholds are: by corridor, by
    day type, by experiment. Nothing here is read from a call site directly. */
export const OVERRIDES = {};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * The multiplier on free-flow speed at a minute of the day. Interpolated
 * between hours so a journey crossing 08:59 does not fall off a cliff.
 */
export function factorAt(minute, { weekday = true, where = null } = {}) {
  const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
  const table = (where && OVERRIDES[where]) || CURVE;
  const h = Math.floor(m / 60), frac = (m % 60) / 60;
  const a = table[h] ?? 1, b = table[(h + 1) % 24] ?? 1;
  let f = a + (b - a) * frac;
  if (!weekday) f = Math.min(1.4, f * WEEKEND_EASE);
  return { factor: Math.round(clamp(f, 0.35, 1.4) * 100) / 100,
    quality: QUALITY, source: SOURCE, hour: h, weekday };
}

/** The worst hour on the curve, and the best - for the tests and the copy. */
export function peak() {
  const hours = Object.keys(CURVE).map(Number);
  const worst = hours.reduce((p, h) => CURVE[h] < CURVE[p] ? h : p);
  const best = hours.reduce((p, h) => CURVE[h] > CURVE[p] ? h : p);
  return { worstHour: worst, worstFactor: CURVE[worst], bestHour: best, bestFactor: CURVE[best] };
}

/**
 * A speed and an hour, combined - and carrying the WORSE of the two qualities,
 * because a measurement multiplied by an assumption is an assumption.
 */
export function apply(speed, minute, opts = {}) {
  const f = factorAt(minute, opts);
  const kmh = Math.round(speed.kmh * f.factor * 10) / 10;
  return { kmh, freeKmh: speed.kmh, factor: f.factor,
    // 'simulated' is worse than 'estimated' is worse than 'unknown' is... no:
    // unknown is the worst thing to be. Simulated beats estimated; unknown loses.
    quality: speed.quality === 'unknown' ? 'unknown' : QUALITY,
    source: speed.source + ' · ' + f.source,
    hour: f.hour };
}
