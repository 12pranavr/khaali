// ---------------------------------------------------------------------------
// The demo's state of the world, and the promise that it stays put.
//
// khaali has no operator feed, no traffic subscription and no ticketing
// integration. For the demo those are simulated - but a simulation that
// reshuffles itself on every page load is not a demonstration of anything, and
// a recommendation that changes when nothing changed is worse than no
// recommendation at all.
//
// So: one scenario, one seed, one demo clock, one revision. The same four
// produce the same answer, every time, on every refresh. A control moves an
// input and BUMPS THE REVISION; nothing else moves. When the answer changes it
// is because a fact changed, and the revision says which generation of facts
// the answer was computed from.
//
// WHAT THIS IS NOT. It is not a store of recommendations. Nothing in here says
// which bus wins - it says how crowded the roads are and how many people are
// waiting, and the planner works the rest out. Seeding an answer into the
// scenario would make the whole exercise a slideshow with extra steps.

export const SOURCE_KIND = 'simulation';

/** The controls, and what each one is a fact about. */
export const KNOBS = {
  /** Minutes of road delay on the stretch after the interchange. The reason a
      through bus can lose to a change even though it needs no walking. */
  downstreamRoadDelayMin: 40,
  /** ...and before it, which is what makes a feeder late rather than slow. */
  upstreamRoadDelayMin: 0,
  /** How many people are already aboard, and boarding, before she gets on. */
  demandBeforeBoarding: 1.0,
  /** ...and after the interchange, which is crowding she would ride through. */
  demandAfterInterchange: 1.0,
  /** A late vehicle is a different fact from a slow road. */
  busADelayMin: 0,
  metroDelayMin: 0,
  /** A longer walk can wipe out the benefit of changing. */
  walkExtraMin: 0,
  /** Services that are not running today. */
  cancelled: [],
};

const START = {
  scenarioId: 'interchange-demo',
  seed: 20260905,
  demoTime: 600,            // 10:00, the fixed clock the fixture is written on
  revision: 1,
  ...KNOBS,
};

let S = { ...START, cancelled: [] };

export const state = () => ({ ...S, cancelled: S.cancelled.slice(), sourceKind: SOURCE_KIND });

/** The label that must travel with anything computed from this. */
export const stamp = () => ({
  scenarioId: S.scenarioId, seed: S.seed, demoTime: S.demoTime,
  revision: S.revision, sourceKind: SOURCE_KIND,
});

export const NUMERIC = ['downstreamRoadDelayMin', 'upstreamRoadDelayMin',
  'demandBeforeBoarding', 'demandAfterInterchange', 'busADelayMin',
  'metroDelayMin', 'walkExtraMin', 'demoTime', 'seed'];

const LIMITS = {
  downstreamRoadDelayMin: [0, 120], upstreamRoadDelayMin: [0, 120],
  demandBeforeBoarding: [0, 6], demandAfterInterchange: [0, 6],
  busADelayMin: [0, 60], metroDelayMin: [0, 60], walkExtraMin: [0, 30],
  demoTime: [0, 1439], seed: [1, 999999999],
};

/**
 * Move an input. The revision goes up whether or not the answer does - it is a
 * generation counter for the facts, not a claim that the plan changed.
 */
export function set(patch = {}) {
  let touched = false;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'cancelled') {
      const list = (Array.isArray(v) ? v : []).map(String).slice(0, 24);
      if (list.join('|') !== S.cancelled.join('|')) { S.cancelled = list; touched = true; }
      continue;
    }
    if (!NUMERIC.includes(k)) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const [lo, hi] = LIMITS[k] || [-Infinity, Infinity];
    const c = Math.min(hi, Math.max(lo, n));
    if (S[k] !== c) { S[k] = c; touched = true; }
  }
  if (touched) S.revision += 1;
  return state();
}

/** Back to the seeded state, and a new generation so caches let go. */
export function reset() {
  const rev = S.revision + 1;
  S = { ...START, cancelled: [], revision: rev };
  return state();
}

export const isCancelled = id => S.cancelled.includes(String(id));

/**
 * A number in [0,1) that depends only on the seed and what it is about.
 *
 * No internal state, so the tenth call for a stretch gives what the first did,
 * and two requests a second apart see the same city. Math.random() here would
 * mean the passenger could refresh her way to a different answer, which is the
 * one thing a demo of a decision must not do.
 */
export function rand(...parts) {
  let h = 2166136261 ^ (S.seed >>> 0);
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

/** A jitter of +/- `spread`, deterministic for the same subject. */
export const wobble = (spread, ...parts) => Math.round((rand(...parts) * 2 - 1) * spread);
