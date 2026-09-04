// ---------------------------------------------------------------------------
// How often a yes turns out to be true.
//
// commit.mjs records drivers saying they will be somewhere. This counts how
// many of them were - not to judge anybody, but because "twelve said yes" and
// "twelve will be there" are different sentences and khaali should not let the
// first quietly become the second.
//
// EVERY NUMBER HERE IS COUNTED. There is no fitted model, no decay, no
// smoothing prior and no constant anybody typed. The rate is kept over
// kept-plus-missed-plus-withdrawn, and both halves travel with it everywhere
// it goes. That last part is the rule: demand.mjs says a range is two counts
// and never a percentage, and a ratio is allowed here only because it is never
// shown without its denominator. "31 of the last 50" can be checked. "62%"
// cannot.
//
// WHAT IS NOT COUNTED, and why it matters more than what is:
//
//   `lapsed` - a driver who shared no position and got no ride told khaali
//   nothing about whether they turned up. Putting that in the denominator
//   would manufacture a low rate out of a privacy choice: the number would get
//   worse for exactly the drivers who declined, and declining would start to
//   cost them something. It is reported on its own, as `unobserved`, and the
//   page says how many khaali could not see.
//
// NOT KEYED BY DRIVER, EVER. A per-driver score is two lines of arithmetic and
// it is a reputation system hung on a device id khaali has never verified and
// the driver can reset by clearing their browser. A score you can erase is not
// a score, and one attached to a person who was never identified is worse than
// none. So this measures PLACES AT TIMES OF DAY - Whitefield in the morning,
// Kengeri at night - which is the thing a forecast actually needs.
//
// The rung it earns is `predicted`. capacity.mjs:14 defines that as history
// specifically, and this is exactly that: khaali's own past outcomes, averaged,
// applied forward. Not `exact` - the COUNT of what happened is exact, but a
// rate carried into a window that has not happened is not a measurement of
// that window.

import { bandOf } from './commit.mjs';

/**
 * Below this khaali does not have a number, and says so instead of shrinking
 * one to fit.
 *
 * The failure this exists for: two commitments, both kept, is 1.0 - the most
 * confident-looking figure anywhere on the page, from the thinnest evidence on
 * it. A smaller sample does not deserve a smaller estimate; it deserves no
 * estimate.
 */
export const MIN_SAMPLE = 20;

/** In the denominator. `lapsed` is deliberately absent. */
export const COUNTED = ['kept', 'missed', 'withdrawn'];

export { bandOf };

const tally = (rows) => {
  const t = { kept: 0, missed: 0, withdrew: 0, unobserved: 0, seeded: 0, real: 0 };
  for (const r of rows) {
    if (r.outcome === 'kept') t.kept++;
    else if (r.outcome === 'missed') t.missed++;
    else if (r.outcome === 'withdrawn') t.withdrew++;
    else if (r.outcome === 'lapsed') { t.unobserved++; continue; }
    else continue;
    if (r.seed) t.seeded++; else t.real++;
  }
  t.of = t.kept + t.missed + t.withdrew;
  return t;
};

/**
 * The kept-rate for a place and a time of day, or null.
 *
 * Three rungs of fallback, narrowest first, and it says which one it used.
 * Whitefield-in-the-morning is the honest cell; when that is thin it widens to
 * Whitefield-any-hour, then to everywhere, then gives up. Giving up is a
 * normal outcome and the page has words for it.
 */
export function rateFor(history, { at = null, minute = null, band = null } = {}) {
  const rows = history || [];
  const b = band != null ? band : (minute != null ? bandOf(minute) : null);

  const levels = [];
  if (at && b != null) levels.push(['place-band', rows.filter(r => r.at === at && r.band === b)]);
  if (at) levels.push(['place', rows.filter(r => r.at === at)]);
  levels.push(['global', rows]);

  for (const [level, subset] of levels) {
    const t = tally(subset);
    if (t.of < MIN_SAMPLE) continue;
    const rate = t.kept / t.of;
    return {
      rate: Math.round(rate * 100) / 100,
      kept: t.kept, of: t.of, missed: t.missed, withdrew: t.withdrew,
      unobserved: t.unobserved,
      level, at: level === 'global' ? null : at, band: level === 'place-band' ? b : null,
      // khaali's own history, applied to a window that has not happened yet.
      // capacity.mjs's word for exactly that.
      quality: 'predicted',
      sample: t.of, min: MIN_SAMPLE,
      seed: t.seeded > 0 && t.real === 0,
      partSeed: t.seeded > 0 && t.real > 0,
      // Never the ratio on its own. Both counts, always, so a reader can check
      // the denominator rather than take the fraction on trust.
      says: t.kept + ' of the last ' + t.of + ' who said yes '
        + (level === 'place-band' ? 'here at this time of day were'
          : level === 'place' ? 'here were' : 'anywhere were') + ' there'
        + (t.unobserved ? ', and khaali could not see another ' + t.unobserved : ''),
    };
  }

  // Not enough of anything. Null, not zero and not a half.
  const t = tally(rows);
  return {
    rate: null, kept: t.kept, of: t.of, missed: t.missed, withdrew: t.withdrew,
    unobserved: t.unobserved, level: null, at: null, band: null,
    quality: 'unknown', sample: t.of, min: MIN_SAMPLE,
    seed: false, partSeed: false,
    says: 'khaali has not measured enough of these to say how many turn up — '
      + t.of + ' of the ' + MIN_SAMPLE + ' it would need.',
  };
}

/**
 * How many of the drivers who said yes khaali expects to actually be there.
 *
 * An INTEGER, bracketed by two things it counted. `12 x 0.62 = 7.44` never
 * leaves this file: a decimal would be a claim to a precision nobody has, and
 * the clamp means that even a bad rate cannot put the answer outside the range
 * between "the ones already near it" and "everyone who said yes".
 */
export function expected(said, floor, rate) {
  if (!rate || rate.rate == null) return null;
  const n = Math.round(said * rate.rate);
  return Math.max(floor || 0, Math.min(said, n));
}
