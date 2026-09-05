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
 * The shortest feasible prefix replacement that preserves the onward train.
 *
 * Everything that could re-enter the planner is injected:
 *
 *   sell(f, t)        places khaali could actually sell on the pinned train
 *                     between two stops. Null means it does not know, which is
 *                     not zero and never a reason to move anybody.
 *   busesFor(f, k, a) candidate bus DEPARTURES from f to boundary k after a.
 *                     Each is judged on its own room and its own connection.
 *   onwardAt(k)       the pinned train's departure from boundary k, or null.
 *
 * `alternativeArr` is the arrival of some other journey she could actually
 * book. If the split cannot beat it, the split has not earned its place.
 */
export function find({
  fromIdx, toIdx, pax = 1, after = 0, now = Date.now(),
  sell, busesFor, onwardAt, train = null,
  ledger = null, alternativeArr = null,
  maxBoundaries = 6, keepTrace = false,
} = {}) {
  const tried = [];
  const note = (o) => { if (keepTrace) tried.push(o); return o; };

  // ---- the trigger, and only this ----------------------------------------
  // anySeats, not free: `free` means berths clear the whole way, which is seat
  // hop's question. Selling by packing partials is still selling, and if khaali
  // can do it there is nothing here to solve.
  const whole = sell(fromIdx, toIdx);
  if (whole == null) {
    return nope('NO_TRIGGER', { tried,
      says: 'khaali cannot count what is left on this train, so it will not move anybody.' });
  }
  if (whole >= pax) {
    return nope('DIRECT_IS_BOOKABLE', { tried, silent: true,
      says: 'This train can carry you the whole way.' });
  }

  const dir = toIdx > fromIdx ? 1 : -1;
  const trigger = constraint.constraint({ mode: 'train', n: whole, of: null, need: pax,
    basis: 'this-trip', at: { fromIdx, toIdx } });

  // ---- candidate boundaries ----------------------------------------------
  // Every stop strictly between, in her direction, where the REST of the train
  // is sellable. `k === t` is not a boundary; it is the destination.
  const boundaries = [];
  for (let k = fromIdx + dir; k !== toIdx; k += dir) {
    const rest = sell(k, toIdx);
    if (rest != null && rest >= pax) boundaries.push({ k, rest });
    if (boundaries.length >= maxBoundaries) break;
  }
  if (!boundaries.length) {
    return nope('NO_PINNED_ONWARD', { tried, trigger,
      says: 'There is no stretch of this train khaali could sell you either.' });
  }

  // ---- each boundary, then each departure, judged on its own --------------
  // Earliest rejoining station is a POLICY, not an optimum: among candidates
  // that meet her constraints, prefer the first one she can rejoin at.
  let lastWhy = 'BOUNDARY_NOT_REACHABLE';
  for (const b of boundaries) {
    const dep = onwardAt(b.k);
    if (!dep || dep.depMin == null) { note({ boundary: b.k, code: 'NO_PINNED_ONWARD' }); continue; }

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

      // then the change itself
      const v = transfer.feasible(bus, { depMin: dep.depMin, mode: 'train' },
        transfer.edge({ fromStopId: bus.toStopId || null, toStopId: dep.stopId || null,
          walkMinutes: bus.walkMinutes || 0 }));
      if (!v.ok) {
        note({ boundary: b.k, bus: bus.tripInstanceId, code: v.code, says: v.says });
        lastWhy = v.code;
        continue;
      }

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
        onward: { train: train && train.id, from: b.k, to: toIdx, ...dep },
        pax,
        transfer: v,
        room,
        trigger,
        onwardConstraint: constraint.constraint({ mode: 'train', n: b.rest, need: pax,
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
  const lines = [];
  lines.push('No sellable itinerary on this train for your party the whole way.');
  lines.push('It has room again from ' + at + ' onward, which is where you would join it.');
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
