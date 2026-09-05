// ---------------------------------------------------------------------------
// Change the stretch, not the journey.
//
// The thing khaali is actually for. A train leaving Bangarpet is sold out for
// the first 47 km and has berths going spare after Whitefield, where the
// commuters get off. A bus runs that same first stretch, because it STARTS
// there - so she sits on the bus to Whitefield, joins the train she could not
// have joined at Bangarpet, and rides it in with a berth.
//
// Google can tell her the bus exists. Nobody but khaali can tell her the train
// has room from Whitefield onward, because that is berth inventory khaali
// allocates itself, stretch by stretch. It was being computed and thrown away.
//
// WHAT THIS IS PRECISELY, because loose phrasings kept creeping in:
//
// * It is a PREFIX REPLACEMENT, not "only the unavailable legs". The trigger
//   proves the whole span is unsellable, not that the prefix is the bad part.
//   With A-B free, B-C full and C-D free, the answer is a bus A to C, which
//   replaces an available stretch too. The honest name is the shortest feasible
//   prefix replacement that preserves the onward train.
//
// * A NEW SPLIT BOOKING FREES NOTHING. It avoids consuming the early stretch,
//   which leaves that stretch's availability exactly as it was. If it was sold
//   out, this does not make it available to anybody else. Only shortening a
//   paid full-route booking would release anything, and khaali does not do that.
//
// * THE QUESTION IS NEVER "ARE BUSES EMPTY". It is which specific departure has
//   room on the stretch she needs, at the time she needs it, and whether it
//   connects. Two departures of one route are two different answers.
//
// * KHAALI HAS NEVER WATCHED A CROWD. The train side counts booked inventory;
//   the bus side is simulated conductor events. Neither is a person looking at
//   a platform, and no sentence in this file says otherwise.
//
// WHY IT IS NOT "THE SAME TRAIN". The first draft pinned the onward half to the
// exact train she would otherwise have caught, and on this corridor that can
// never happen: the bus takes ninety-five minutes to cover a stretch the train
// does in fifty, so by the time she reaches Whitefield her train left long ago.
// Every candidate was refused TRANSFER_TOO_TIGHT with "the onward service leaves
// before this one arrives", which is true and makes the feature impossible.
//
// So the onward half is anchored to a SPECIFIC NAMED DEPARTURE from the
// boundary - counted, bookable, and the earliest she can actually make - rather
// than to the train she started out wanting. That is the journey people already
// do. The guarantee is unchanged in the part that matters: it is one identified
// service with berth availability khaali counted, never "some train later".
//
// RE-ENTRANCY. find() must never call a journey enumerator that would generate
// splits, or it recurses. Everything it needs arrives as injected functions,
// and the module imports no planner.

import * as transfer from './transfer.mjs';
import * as claims from './claims.mjs';
import * as constraint from './constraint.mjs';

export const CODES = [
  'OK',
  'DIRECT_IS_BOOKABLE',          // silent: there was nothing to solve
  'NO_TRIGGER',                  // khaali could not tell, so it does not act
  'BOUNDARY_NOT_REACHABLE',
  'NO_PINNED_ONWARD',
  'NO_DEPARTURE_WITH_ROOM',
  'BOARDING_NOT_FEASIBLE',
  'SPAN_OVER_PLANNING_LIMIT',
  'TRANSFER_TOO_TIGHT',
  'TRANSFER_TOO_LONG',
  'ONWARD_NOT_BOOKABLE',
  'NO_CLEAR_BENEFIT',
];

/** Codes khaali stays quiet about: nothing was wrong, so nothing is said. */
export const SILENT = new Set(['DIRECT_IS_BOOKABLE']);

const nope = (code, extra = {}) => ({ ok: false, code, split: null, ...extra });

/**
 * The shortest feasible prefix replacement that reaches a named onward train.
 *
 * Everything that could re-enter the planner is injected:
 *
 *   sellWhole(f, t)     the most places khaali could sell anybody the whole way,
 *                       across every train that runs it. Null means it does not
 *                       know, which is not zero and never a reason to move
 *                       anybody.
 *   onwardFrom(k, t, a) named departures from boundary k that khaali could
 *                       actually sell for this party, in time order. Already
 *                       filtered on availability - this module does not
 *                       recompute what the inventory said.
 *   busesFor(f, k, a)   candidate bus DEPARTURES from f to boundary k after a.
 *                       Each is judged on its own room and its own connection.
 *
 * `alternativeArr` is the arrival of some other journey she could actually
 * book. If the split cannot beat it, the split has not earned its place.
 */
export function find({
  fromIdx, toIdx, pax = 1, after = 0, now = Date.now(),
  sellWhole, busesFor, onwardFrom,
  ledger = null, alternativeArr = null,
  maxBoundaries = 6, keepTrace = false,
} = {}) {
  const tried = [];
  const note = (o) => { if (keepTrace) tried.push(o); return o; };

  // ---- the trigger, and only this ----------------------------------------
  // anySeats, not free: `free` means berths clear the whole way, which is seat
  // hop's question. Selling by packing partials is still selling, and if khaali
  // can do it there is nothing here to solve.
  const whole = sellWhole(fromIdx, toIdx);
  if (whole == null) {
    return nope('NO_TRIGGER', { tried,
      says: 'khaali cannot count what is left on this stretch, so it will not move anybody.' });
  }
  if (whole >= pax) {
    return nope('DIRECT_IS_BOOKABLE', { tried, silent: true,
      says: 'A train can carry you the whole way.' });
  }

  const dir = toIdx > fromIdx ? 1 : -1;
  const trigger = constraint.constraint({ mode: 'train', n: whole, of: null, need: pax,
    basis: 'this-trip', at: { fromIdx, toIdx } });

  // ---- candidate boundaries ----------------------------------------------
  // Every stop strictly between, in her direction, where SOME named departure
  // onward is sellable. `k === t` is not a boundary; it is the destination.
  const boundaries = [];
  for (let k = fromIdx + dir; k !== toIdx; k += dir) {
    const onward = onwardFrom(k, toIdx, after) || [];
    if (onward.length) boundaries.push({ k, onward });
    if (boundaries.length >= maxBoundaries) break;
  }
  if (!boundaries.length) {
    return nope('NO_PINNED_ONWARD', { tried, trigger,
      says: 'There is no onward stretch khaali could sell you either.' });
  }

  // ---- each boundary, then each departure, judged on its own --------------
  // Earliest rejoining station is a POLICY, not an optimum: among candidates
  // that meet her constraints, prefer the first one she can rejoin at.
  let lastWhy = 'BOUNDARY_NOT_REACHABLE';
  for (const b of boundaries) {
    const cands = busesFor(fromIdx, b.k, after) || [];
    if (!cands.length) { note({ boundary: b.k, code: 'BOUNDARY_NOT_REACHABLE' }); continue; }

    for (const bus of cands) {
      // room first, on THIS departure, over the span she would ride - never a
      // route average, and never the boarding stop
      const room = ledger
        ? claims.roomOver(ledger, {
          profile: bus.profile, tripInstanceId: bus.tripInstanceId,
          fromStopSequence: bus.fromStopSequence, toStopSequence: bus.toStopSequence,
          pax, now })
        : { ok: true, code: 'OK', undetermined: false, quality: 'simulated' };
      if (!room.ok) {
        note({ boundary: b.k, bus: bus.tripInstanceId, code: room.code, says: room.says });
        lastWhy = room.undetermined ? 'NO_DEPARTURE_WITH_ROOM' : room.code;
        continue;
      }

      // then the change itself: the earliest named departure she could make
      const edge = transfer.edge({ fromStopId: bus.toStopId || null,
        toStopId: b.onward[0] && b.onward[0].stopId, walkMinutes: bus.walkMinutes || 0 });
      const pick = transfer.firstFeasible(bus, b.onward.map(o =>
        ({ ...o, mode: 'train' })), edge);
      if (!pick.ok) {
        note({ boundary: b.k, bus: bus.tripInstanceId, code: pick.verdict.code });
        lastWhy = pick.verdict.code;
        continue;
      }
      const dep = pick.out, v = pick.verdict;

      const arr = dep.arrMin;
      if (arr == null) { note({ boundary: b.k, bus: bus.tripInstanceId, code: 'ONWARD_NOT_BOOKABLE' });
        lastWhy = 'ONWARD_NOT_BOOKABLE'; continue; }
      // and it has to be worth doing
      if (alternativeArr != null && arr > alternativeArr) {
        note({ boundary: b.k, bus: bus.tripInstanceId, code: 'NO_CLEAR_BENEFIT', arr, alternativeArr });
        lastWhy = 'NO_CLEAR_BENEFIT';
        continue;
      }

      note({ boundary: b.k, bus: bus.tripInstanceId, code: 'OK' });
      const split = {
        boundaryIdx: b.k,
        replacement: bus,
        onward: { train: dep.trainNo, name: dep.name, from: b.k, to: toIdx,
          depMin: dep.depMin, arrMin: dep.arrMin, stopId: dep.stopId },
        pax,
        transfer: v,
        room,
        trigger,
        onwardConstraint: constraint.constraint({ mode: 'train', n: dep.sell, need: pax,
          basis: 'this-trip', at: { fromIdx: b.k, toIdx } }),
        busConstraint: constraint.constraint({ mode: 'bus', n: room.headroom == null ? null : room.headroom,
          need: pax, basis: 'this-trip', quality: room.quality || 'simulated',
          at: { from: bus.fromStopSequence, to: bus.toStopSequence } }),
        arr, dep: bus.depMin,
        releasesInventory: false,   // stated, because somebody will assume otherwise
      };
      return { ok: true, code: 'OK', split, tried, trigger, says: null };
    }
  }
  return nope(lastWhy, { tried, trigger,
    says: 'khaali could not assemble a change that works for this train.' });
}

/**
 * Whether a split may be offered at all. Separate from find() so that the
 * reasons khaali must not act - rather than cannot find - are in one place.
 */
export function gate(result, { allowUndetermined = false } = {}) {
  if (!result) return { offer: false, code: 'NO_TRIGGER' };
  if (result.ok) return { offer: true, code: 'OK' };
  if (SILENT.has(result.code)) return { offer: false, silent: true, code: result.code };
  if (!allowUndetermined && result.code === 'NO_TRIGGER') return { offer: false, code: 'NO_TRIGGER' };
  return { offer: false, code: result.code };
}

/**
 * The sentences khaali is allowed to say about a split.
 *
 * It consumes the structured evidence and NEVER recomputes availability - two
 * places doing the same arithmetic is two places to disagree, and the one that
 * writes the sentence would win.
 */
export function whyLines(split, { stationName = (i => 'stop ' + i) } = {}) {
  if (!split) return [];
  const at = stationName(split.boundaryIdx);
  const on = split.onward || {};
  const lines = [];
  lines.push('No train khaali can sell you runs the whole way for your party.');
  lines.push('There is room from ' + at + ' onward, on the '
    + (on.name || on.train) + ' at ' + fmt(on.depMin) + ', which is where you would join it.');
  const bus = split.replacement || {};
  lines.push('The ' + (bus.name || 'bus') + ' leaving at ' + fmt(bus.depMin)
    + ' covers the stretch to ' + at + '.');
  lines.push('Bus room is ' + (split.busConstraint.evidence.label) + '. No bus seat is reserved.');
  lines.push(split.transfer.says);
  lines.push('Booking this does not free the early stretch for anyone else; it only avoids using it.');
  return lines;
}

const fmt = (m) => {
  if (m == null) return '--:--';
  const d = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(d / 60)).padStart(2, '0') + ':' + String(d % 60).padStart(2, '0');
};

/** Every boundary and departure considered. Development only - it names other
    people's departures and their remaining room. */
export function trace(result) {
  return { code: result && result.code, tried: (result && result.tried) || [] };
}
