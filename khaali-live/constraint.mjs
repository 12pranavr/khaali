// ---------------------------------------------------------------------------
// The difference between "this looks busy" and "khaali may act on this".
//
// khaali has one number that can move somebody's journey and several that can
// only describe it, and until now they were the same shape - an occupancy
// between zero and one, coloured by load.mjs, handed to whatever asked. That is
// how a metro reading built from BMRCL's station entry counts ended up looking
// like an argument for putting somebody on a different train.
//
// So there are three shapes here, and only one of them is allowed to trigger.
//
//   constraint - n of N, for THIS party, on THIS stretch. It is a countable
//                shortage of something khaali can allocate. Only this triggers.
//   load       - a description. A colour and a word. It never triggers, and
//                nothing downstream may promote it into a constraint.
//   evidence   - where the number came from, what it may be used for, and the
//                exact sentence khaali is allowed to say about it.
//
// WHAT EACH MODE'S TRIGGER MEANS, because they are not the same thing:
//
//   train  insufficient sellable berth capacity for this party over this
//          stretch. khaali owns that inventory and can count it exactly.
//   bus    insufficient projected planning room over the span she would ride,
//          from SIMULATED conductor events. Never a claim about a real bus.
//   metro  prohibited. Station entry counts are people walking through a gate;
//          they cannot describe how full a train is between two stations, and
//          no argument to metroProfile can make them able to.

import * as capacity from './capacity.mjs';
import * as load from './load.mjs';

export const RUNGS = capacity.QUALITY;          // one ladder, not a second one
export const MODES = ['train', 'bus', 'metro'];

/**
 * What each mode's evidence is, and what it is allowed to do with it. This
 * table is the safety property; everything else reads it.
 */
export const EVIDENCE = {
  train: { rung: 'exact', mayTrigger: true, mayReplace: true,
    basis: 'berth inventory khaali allocates itself',
    label: 'counted from the berth inventory' },
  bus: { rung: 'simulated', mayTrigger: true, mayReplace: true,
    basis: 'simulated conductor events',
    label: 'from khaali’s demo conductor - no operator is connected' },
  metro: { rung: 'predicted', mayTrigger: false, mayReplace: false,
    basis: 'BMRCL hourly station entries',
    label: 'from BMRCL’s own hourly entries at the station' },
};

/** Why a forecast said what it said, in the order khaali prefers them. */
export const BASIS = ['this-trip', 'completed-trips', 'model'];
/** Below this many completed trips, history is not history. */
export const MIN_TRIPS = 3;

const bad = m => { const e = new Error(m); e.code = 'CONSTRAINT'; throw e; };

/**
 * THE TRIGGER. `n` of `of` available for a party of `need`.
 *
 * `of` may be null - a stretch whose capacity nobody has stated is not a
 * shortage, it is an unknown, and `ok` is null rather than false. Nothing
 * downstream may read a null as a reason to move anybody.
 */
export function constraint({ mode, n = null, of = null, need = 1,
                             basis = 'model', quality = null, at = null } = {}) {
  if (!MODES.includes(mode)) bad('unknown mode: ' + mode);
  const ev = EVIDENCE[mode];
  const q = quality || ev.rung;
  const known = n != null && Number.isFinite(n);
  const ok = known ? n >= need : null;
  return {
    mode, n: known ? n : null, of, need, at,
    ok,
    // a mode that may not trigger cannot produce a shortage, whatever it counts
    triggers: !!(ev.mayTrigger && ok === false),
    basis, quality: q,
    weight: capacity.QUALITY_WEIGHT[q] == null ? 0.3 : capacity.QUALITY_WEIGHT[q],
    evidence: { ...ev, quality: q, basis },
    says: saysConstraint(mode, known, n, need, ev, basis),
  };
}

function saysConstraint(mode, known, n, need, ev, basis) {
  if (!known) return 'khaali cannot count what is left on this stretch, so it will not move anybody over it.';
  if (!ev.mayTrigger)
    return 'This is ' + ev.label + '. It describes the station, not the stretch between two of them, '
      + 'so khaali will not plan around it.';
  const room = n + (n === 1 ? ' place' : ' places');
  const src = basis === 'this-trip' ? ' on this departure’s own ledger'
    : basis === 'completed-trips' ? ' from completed trips on this route and hour'
      : ' from khaali’s model, for want of enough completed trips';
  return (n >= need ? 'Room for ' + need + ' here: ' + room + ' left' + src + '.'
    : 'Only ' + room + ' left here and you need ' + need + src + '.');
}

/**
 * A DESCRIPTION. Colour and a word, on the one band ladder that already exists.
 * It has no `ok` and no `triggers`, and that absence is the point.
 */
export function describe({ value = null, quality = 'unknown', key = null, unit = 'of capacity' } = {}) {
  const b = load.bandOf(value, quality, key);
  return { value, band: b.band, colour: b.colour, texture: b.texture, word: b.word,
    quality, unit, key,
    says: value == null
      ? 'Nobody has measured this, and khaali is not going to guess.'
      : Math.round(value * 100) + '% ' + unit + ' · ' + b.word };
}

/**
 * Where a forecast came from, in the order khaali prefers - and it says which,
 * because "the model" and "this bus's own ledger" are not the same claim.
 *
 * The demo is true precisely because `this-trip` exists: the conductor page
 * fills a real departure and the planner reads that departure, not an average.
 */
export function basisFor({ hasTripLedger = false, completedTrips = 0 } = {}) {
  if (hasTripLedger) return { basis: 'this-trip', quality: 'simulated',
    says: 'From this departure’s own ticketing, projected forward.' };
  if (completedTrips >= MIN_TRIPS) return { basis: 'completed-trips', quality: 'estimated',
    says: 'From ' + completedTrips + ' completed trips on this route at this hour.' };
  return { basis: 'model', quality: 'simulated', completedTrips,
    // not "no record" - one or two completed trips are records, just not enough
    says: 'Insufficient completed-trip history for this route and hour, so this is khaali’s model.' };
}

/**
 * The floor on what khaali may call a number.
 *
 * It is applied PER EVENT SOURCE, not per operator. Registering an operator
 * lifts the floor only for trips whose events actually came from production
 * systems, and it never reaches back and relabels events that were simulated
 * when they happened. A demo trip run last Tuesday stays a demo trip.
 *
 * `sourceKind: 'production'` is not something a client may assert; it is set by
 * the ingest path that knows where the bytes came from.
 */
export function publishedQuality(sourceKinds, { registeredOperator = false } = {}) {
  const kinds = new Set(Array.isArray(sourceKinds) ? sourceKinds : [sourceKinds]);
  if (!kinds.size) return 'unknown';
  if (!registeredOperator) return 'simulated';
  if (kinds.size === 1 && kinds.has('production')) return 'counted';
  return 'simulated';                    // one simulated event floors the lot
}

/** A metro reading, built so it cannot be turned into a reason. */
export function metroProfile(opts = {}) {
  const c = constraint({ ...opts, mode: 'metro' });
  return { ...c, ok: null, triggers: false, mayTrigger: false,
    describe: describe({ value: opts.value == null ? null : opts.value,
      quality: 'predicted', key: 'metro' }) };
}
