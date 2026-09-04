// ---------------------------------------------------------------------------
// One ladder, for everything the network can be full of.
//
// khaali had four different sets of thresholds and three colour tables: road
// speed bands in road.mjs, metro crowd words in journey.mjs duplicated again in
// map.html, seat odds in journey.mjs, certainty in capacity.mjs. Every one of
// them turns a number into a colour, and no two of them agreed on how.
//
// This is the single ladder. Every mode converts its own number into LOAD - a
// fraction from 0 to 1 where higher is worse - and the ladder does the rest.
//
//   green   under 0.20   as good as this network gets
//   yellow  0.20 - 0.45  filling
//   orange  0.45 - 0.60  uncomfortable
//   red     over 0.60    the thing people complain about
//   grey    unknown      khaali has not measured this
//
// THE NUMBERS ARE NOT NEW. road.BANDS is { green: 0.80, yellow: 0.55,
// orange: 0.40 } on a speed RATIO. load = 1 - ratio maps them across exactly:
// 0.20, 0.45, 0.60. So every road cell keeps the colour it already had, and a
// test asserts that, because a refactor that quietly re-tunes what people have
// already seen on a map is worse than no refactor.
//
// AND THE PART THAT MATTERS MORE THAN THE COLOUR.
//
// A band is not a claim on its own. "This stretch is red" means nothing until
// you know whether khaali counted it, estimated it from a timetable, or made it
// up for a demo. So the BAND IS THE COLOUR and the QUALITY IS THE TEXTURE:
//
//   exact, counted        solid, with a casing
//   estimated, predicted  soft fill, no casing
//   simulated             hatched, dashed
//   unknown               grey, dotted
//
// A red segment khaali counted and a red segment khaali guessed are the same
// HUE - the congestion is real either way - and they are never the same object
// on the screen. Grey is not a fifth kind of good. It is khaali saying it does
// not know, and it has to look like that.

/** On LOAD, ascending: higher is worse. */
export const BANDS = { green: 0.20, yellow: 0.45, orange: 0.60 };

/**
 * Where a mode's own vocabulary breaks somewhere else, and it is worth
 * respecting rather than overriding.
 *
 * Metro is the one. BMRCL's own words - quiet, busy, crush - break at 0.40 and
 * 0.75 (journey.mjs:162), and running the metro through the road ladder would
 * paint a station at 0.30 yellow and rename half the line. So the thresholds
 * sit here, next to each other, where they can be argued with.
 */
export const OVERRIDES = {
  metro: { green: 0.40, yellow: 0.60, orange: 0.75 },
  // A road at 60% of free-flowing speed is a jam. A sleeper coach at 60% of
  // its berths is a comfortable train with room to spare. Same scalar, two
  // physical meanings, so the cuts cannot be the same - reading the corridor
  // through the road ladder painted all thirteen legs red at occupancies khaali
  // would describe as "seats available" everywhere else in the app.
  rail: { green: 0.70, yellow: 0.88, orange: 0.97 },
};

export function bandsFor(key = null) { return (key && OVERRIDES[key]) || BANDS; }

/** The colours the client already draws road cells with. Unchanged. */
export const COLOUR = {
  green: '#1f9d55', yellow: '#e0a516', orange: '#e07b16',
  red: '#d8385a', unknown: '#9a9a94',
};

export const WORD = {
  green: 'clear', yellow: 'filling', orange: 'busy', red: 'crush', unknown: 'not known',
};

/** Best to worst. `counted` is a floor khaali counted; see busload.mjs. */
export const RUNGS = ['exact', 'counted', 'estimated', 'predicted', 'simulated', 'unknown'];

/** How sure khaali is, drawn rather than written. */
export const TEXTURE = {
  exact: 'solid', counted: 'solid', mixed: 'solid',
  estimated: 'soft', predicted: 'soft',
  simulated: 'hatch', unknown: 'void',
};

export const FILL = { solid: 0.32, soft: 0.22, hatch: 0.22, void: 0.10 };

const clamp01 = x => Math.max(0, Math.min(1, x));

/**
 * A load and a quality, in.
 *
 * Note the first line, which is the whole point of the file: a quality of
 * `unknown` is grey WHATEVER the number is. A number khaali did not measure
 * cannot colour anything, however confident the arithmetic that produced it
 * looked on the way here.
 */
export function bandOf(load, quality = 'estimated', key = null) {
  const texture = TEXTURE[quality] || 'void';
  if (quality === 'unknown' || load == null || !isFinite(load)) {
    return { band: 'unknown', load: null, quality: 'unknown', word: WORD.unknown,
      texture: 'void', colour: COLOUR.unknown, fill: FILL.void, atLeast: false };
  }
  const b = bandsFor(key);
  const x = clamp01(load);
  const band = x < b.green ? 'green' : x < b.yellow ? 'yellow' : x < b.orange ? 'orange' : 'red';
  return { band, load: Math.round(x * 100) / 100, quality, word: WORD[band],
    texture, colour: COLOUR[band], fill: FILL[texture] || FILL.soft, atLeast: false };
}

/**
 * A floor, not a reading.
 *
 * Somebody counted N people getting on. That is a statement that the load is AT
 * LEAST this much - it is not the load, because khaali has no idea who else is
 * already aboard. So it may only ever RAISE the band, never lower it: a count
 * can turn grey into red and can never turn red into green. The arithmetic runs
 * one way on purpose, and there is a test that it does.
 */
export function bandAtLeast(current, floorLoad, quality = 'counted', key = null) {
  const cur = current || bandOf(null, 'unknown', key);
  const at = bandOf(floorLoad, quality, key);
  if (at.band === 'unknown') return cur;
  // A floor that lands in green says nothing. "At least a little full" is true
  // of every vehicle that ever ran, and green is a CLAIM - that this stretch is
  // clear - which a lower bound cannot support. Four people boarding does not
  // make a bus empty, so it leaves the colour exactly as it found it.
  if (at.band === 'green') return cur;
  const order = ['unknown', 'green', 'yellow', 'orange', 'red'];
  if (order.indexOf(cur.band) >= order.indexOf(at.band)) return cur;
  return { ...at, atLeast: true };
}

/**
 * A speed becomes a load by being turned upside down: the slower the road
 * against a free-flowing version of this city, the fuller it is behaving.
 */
export function fromSpeed(kmh, freeKmh, quality = 'estimated') {
  if (quality === 'unknown' || kmh == null || !(freeKmh > 0)) return bandOf(null, 'unknown', 'road');
  return bandOf(1 - clamp01(kmh / freeKmh), quality, 'road');
}

/**
 * The worst thing on a journey, which is what a passenger actually feels. A
 * chain is as crowded as its worst leg, not as its average - an hour of sitting
 * does not undo twenty minutes of being crushed.
 */
export function worstOf(readings) {
  const order = ['unknown', 'green', 'yellow', 'orange', 'red'];
  let worst = null;
  for (const r of readings || []) {
    if (!r || r.band === 'unknown') continue;
    if (!worst || order.indexOf(r.band) > order.indexOf(worst.band)
      || (r.band === worst.band && (r.load || 0) > (worst.load || 0))) worst = r;
  }
  return worst;
}

/** The rows a page draws its key from - both axes, because both are needed. */
export function legend(key = null) {
  const b = bandsFor(key);
  return {
    bands: [
      { band: 'green', word: WORD.green, colour: COLOUR.green, upTo: b.green },
      { band: 'yellow', word: WORD.yellow, colour: COLOUR.yellow, upTo: b.yellow },
      { band: 'orange', word: WORD.orange, colour: COLOUR.orange, upTo: b.orange },
      { band: 'red', word: WORD.red, colour: COLOUR.red, upTo: 1 },
      { band: 'unknown', word: WORD.unknown, colour: COLOUR.unknown, upTo: null },
    ],
    textures: [
      { texture: 'solid', quality: 'counted', says: 'khaali counted this' },
      { texture: 'soft', quality: 'estimated', says: 'worked out from a timetable' },
      { texture: 'hatch', quality: 'simulated', says: 'a demo model, nobody measured it' },
      { texture: 'void', quality: 'unknown', says: 'khaali has not measured this' },
    ],
    says: 'Grey is not green. It means khaali has not measured this stretch.',
  };
}
