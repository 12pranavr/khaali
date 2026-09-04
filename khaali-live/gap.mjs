// ---------------------------------------------------------------------------
// The number the whole loop is trying to close.
//
// demand.mjs counts the people. commit.mjs and reliability.mjs count the
// drivers. This subtracts, and then decides how far to shout about it.
//
// THE POINT IS NOT TO ATTRACT DRIVERS. It is to close a gap - which means
// knowing when to stop, and saying so out loud when more drivers have said yes
// than there are people booked. A shortage broadcast to every driver in the
// city produces a hundred drivers for forty passengers, and the sixty who came
// for nothing are the ones who paid for the mistake. So the signal goes out in
// rings, the ring widens with the gap, and it closes the moment the gap does.
//
// THE PRIVACY RULE, and it is the one that could quietly break:
//
//   The gap is arithmetic over numbers the map ALREADY PUBLISHES, and it
//   introduces no new denominator. demandFloor and demandCeiling are on
//   /api/demand. `said` and the rung counts are counts of DRIVERS, shown to
//   drivers. So a driver who reads a gap learns nothing about any passenger
//   that /api/demand had not already told them.
//
//   The moment a gap is derived from a demand count that was NOT published -
//   because it fell under the privacy floor - it becomes a subtraction oracle:
//   publish "gap 2" beside "3 drivers said yes" and you have published that
//   five people are travelling, at a place khaali refused to name a count for.
//   That is the leak, it is not obvious, and gapOf() returning null below the
//   floor is the whole of the defence.
//
// Nothing here is a promise to anybody. It is a difference between two counts,
// one of which is a forecast, and both of which say what they are.

import { FLOOR } from './demand.mjs';

/** How far a call for drivers reaches, in kilometres. Three rings and a hard
    stop - never "the city", however big the gap gets. */
export const RING_KM = [2, 5, 10];

/** How many people short before the ring widens by one. */
export const GAP_PER_RING = 4;

/**
 * How far to ask, for a gap of `g`.
 *
 * Zero means do not ask at all, and zero is the goal. The cap is the point:
 * a gap of a thousand still reaches ten kilometres and no further, because a
 * driver ninety minutes away is not supply for a window that starts in twenty.
 */
export function radiusFor(g) {
  if (!(g > 0)) return 0;
  return RING_KM[Math.min(Math.ceil(g / GAP_PER_RING), RING_KM.length) - 1];
}

/**
 * The supply side of one place and half hour, as counts.
 *
 * `floor` is the drivers khaali can see are near it or serving it - measured,
 * not forecast. `said` is everyone who said yes. Between those two is where
 * the true number is, and reliability.mjs's expectation is clamped into it.
 */
export function supplyOf(commits, { at, window, rungOf } = {}) {
  const mine = (commits || []).filter(c => c && !c.outcome && c.at === at && c.window === window);
  const rungs = { 'said-yes': 0, 'moving-toward': 0, nearby: 0, available: 0, served: 0 };
  for (const c of mine) {
    const r = rungOf ? rungOf(c) : { rung: 'said-yes' };
    if (rungs[r.rung] != null) rungs[r.rung]++;
  }
  return { said: mine.length, rungs,
    floor: rungs.nearby + rungs.available + rungs.served, ceiling: mine.length };
}

/**
 * Demand minus supply, at one place in one half hour.
 *
 * Returns null where the map publishes nothing - see the header. Otherwise
 * three numbers, because two of them are honest even with no reliability at
 * all and the third is the one that needs it:
 *
 *   gapCeiling  most people, fewest confirmed drivers - the pessimistic bound
 *   gapFloor    fewest people, every yes turning up - may be negative, which
 *               is information rather than an error
 *   gap         the working number, null until khaali has measured a rate
 */
export function gapOf(spot, supply, expected, { floor = FLOOR } = {}) {
  if (!spot || !supply) return null;
  // No hotspot, no gap. The subtraction oracle closes here and nowhere else.
  if (!(spot.ceiling >= floor)) return null;

  const gapCeiling = spot.ceiling - supply.floor;
  const gapFloor = spot.floor - supply.ceiling;
  const gap = expected == null ? null : spot.floor - expected;
  const over = expected == null ? null : expected - spot.ceiling;

  // What to act on. With a measured rate it is the working gap; without one it
  // is the pessimistic bound - so deleting the history makes khaali recruit
  // MORE cautiously rather than stopping, which is the right way round.
  const acting = gap != null ? gap : gapCeiling;

  // Three independent stops, and the second needs no reliability at all, so it
  // works on the first day khaali runs.
  const enough = supply.said >= spot.ceiling;
  const asking = enough ? 0 : Math.max(0, Math.min(acting, spot.ceiling - supply.said));
  const crowded = over != null && over > 0;

  return {
    at: spot.at, window: spot.window, windowText: spot.windowText,
    lat: spot.lat, lng: spot.lng,
    demandFloor: spot.floor, demandCeiling: spot.ceiling,
    said: supply.said, supplyFloor: supply.floor, expected,
    gap, gapFloor, gapCeiling,
    asking, radiusKm: crowded ? 0 : radiusFor(asking), enough, crowded, over,
    says: crowded
      ? ('More drivers have said they will be around ' + spot.at + ' in this half hour than there are '
        + 'people booked. khaali is not asking for any more.')
      : enough
        ? ('As many drivers have said they will be around ' + spot.at + ' as there are people booked.')
        : asking > 0
          ? (asking + ' more ' + (asking === 1 ? 'driver' : 'drivers') + ' would cover what is booked at '
            + spot.at + (gap == null ? ', on the cautious count - khaali has not measured how many of a '
              + 'yes turn up here.' : '.'))
          : 'Nobody is short here.',
  };
}

/**
 * Every place worth asking about, nearest first, and only the ones a driver
 * standing where they are could actually reach.
 */
export function asks(gaps, { near = null, limit = 6 } = {}) {
  const out = [];
  for (const g of gaps || []) {
    if (!g || g.asking <= 0 || g.radiusKm <= 0) continue;
    const away = (near && g.lat != null) ? km(near, g) : null;
    // The ring is the whole control: a driver further out than the gap
    // justifies is not asked, however keen khaali is to fill the window.
    if (away != null && away > g.radiusKm) continue;
    out.push({ ...g, away: away == null ? null : Math.round(away * 10) / 10 });
  }
  out.sort((a, b) => b.asking - a.asking
    || ((a.away == null ? 1e9 : a.away) - (b.away == null ? 1e9 : b.away)));
  return out.slice(0, Math.max(1, limit));
}

/**
 * What khaali may say to a PASSENGER about the last mile ahead of her.
 *
 * THE LINE, and every sentence this returns sits on the right side of it:
 *
 *   "Six drivers have said they will be around Whitefield" is a statement
 *   about the board. "A vehicle will be waiting for you" is a promise about
 *   the road. khaali is only ever on the board.
 *
 * So the subject of every sentence is a count, a place, or a driver - never
 * her ride. No future tense about what happens to her, no arrival time, and no
 * vehicle count dressed as availability, because khaali cannot see a vehicle:
 * only somebody who said they would be somewhere and, if they allowed it,
 * roughly where they are.
 *
 * It also does not warm up with the clock. Every line here is caused by
 * something that happened - a booking, a yes, a position shared. If none of
 * those happen, what this says at 08:35 is word for word what it said at
 * 08:00. A reassurance that grows as the hour approaches, driven by nothing,
 * is the most comfortable lie available in this whole feature.
 *
 * It lives here, pure, rather than in the route that renders it, so that the
 * test which reads every one of these sentences looking for a promise can
 * actually reach them.
 */
export function outlookLines({ at, spot = null, said = 0, near = 0, moving = 0, rate = null } = {}) {
  const lines = [];
  if (spot) lines.push(spot.floor === spot.ceiling
    ? (spot.ceiling + ' people are booked around ' + spot.at + ' for ' + spot.windowText + '.')
    : (spot.floor + ' to ' + spot.ceiling + ' people are booked around ' + spot.at
      + ' for ' + spot.windowText + '.'));
  if (said) lines.push(said + (said === 1 ? ' driver has' : ' drivers have')
    + ' said they expect to be around ' + at + ' in that half hour.');
  if (said && rate && rate.rate != null) lines.push(rate.says.charAt(0).toUpperCase() + rate.says.slice(1) + '.');
  if (said && (!rate || rate.rate == null)) lines.push('khaali has not measured how many of those turn up.');
  // Not "three vehicles are available" - khaali has not seen a vehicle. Three
  // people who said they would be here are here, which is a smaller claim and
  // is the true one.
  if (near) lines.push(near + ' of them ' + (near === 1 ? 'is' : 'are') + ' near ' + at + ' now.');
  else if (moving) lines.push(moving + ' of them ' + (moving === 1 ? 'is' : 'are')
    + ' closer than when they said so.');
  return lines;
}

/** The sentence under all of them, which is the one that has to be there. */
export const OUTLOOK_FOOT = 'khaali has not sent anybody. It publishes this last mile to whoever is '
  + 'looking at its demand page, and one of them may accept it — until one does, nobody is on the way.';

const km = (a, b) => {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};
