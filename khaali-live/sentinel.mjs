// Sentinel: the behavioural layer over Fair Tatkal.
//
// What this is for
// ----------------
// The identity check and the four-a-month cap are the fairness floor. They are
// arithmetic, anyone can replay them, and they already collapse a few hundred
// automated requests into twelve standing entries. What they cannot see is
// HOW an entry arrived: a farm that owns three real verified identities still
// gets to buy in bulk, four entries each, entirely within the rules.
//
// Sentinel scores that behaviour. It reads six signals the round already
// records - when you arrived, how hard you hit, how many accounts sit behind
// one origin, whether one payment instrument settles several identities, how
// much you actually did in the app before entering, and how regular your
// timing was - and returns a probability that the entry is automated.
//
// Deliberately not an LLM
// -----------------------
// This is a logistic model with six named features and published weights. You
// can recompute any score in this file by hand from the numbers shown in the
// glass box. That matters: a black box deciding who gets a berth is the exact
// failure mode khaali exists to argue against. The model is allowed to weigh
// an entry down. It is never allowed to be the reason nobody can check.
//
// What a score can and cannot do
// ------------------------------
// A high score never blocks a person outright. The worst outcome for a real
// traveller who trips every signal is that they are treated as ONE person
// entering ONCE, which is what they are. What gets stripped is the bulk
// advantage, not the entry.

/** Weights are published on purpose. Changing them changes the audit line. */
export const MODEL = {
  version: 'sentinel-1',
  bias: -3.2,
  // Weights are deliberately modest. An earlier set was strong enough that
  // every farm scored a flat 1.000, which is not a probability, it is a
  // saturated sigmoid pretending to be one. These land a clear farm around
  // 0.95 and an ordinary traveller around 0.06, which leaves the middle of
  // the range meaning something.
  weights: {
    burst: 1.5,      // arrived in the first instants after the window opened
    rate: 1.3,       // requests fired from this origin during the window
    fanout: 1.1,     // distinct accounts behind one origin
    payReuse: 0.8,   // one payment instrument settling several identities
    shallow: 0.7,    // entered without doing anything else in the app
    cadence: 1.0,    // machine-regular gaps between requests
  },
  bands: { challenge: 0.85, throttle: 0.55 },
  chits: { clear: 4, throttle: 2, challenge: 1 },
};

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Six features, each normalised to 0..1, each with a plain-English meaning.
 *
 * @param s.atMs      ms after the window opened that this entry arrived
 * @param s.tries     requests this origin fired during the window
 * @param s.accounts  distinct accounts seen behind this origin
 * @param s.payReuse  true when one instrument has settled another identity
 * @param s.actions   things the session did in the app before entering
 * @param s.gaps      ms between this origin's requests, for cadence
 */
export function features(s = {}) {
  const atMs = Math.max(0, +s.atMs || 0);
  const tries = Math.max(1, +s.tries || 1);
  const accounts = Math.max(1, +s.accounts || 1);
  const actions = Math.max(0, +s.actions || 0);
  const gaps = Array.isArray(s.gaps) ? s.gaps.filter(g => g > 0) : [];

  // A person cannot read the screen and decide inside three seconds.
  const burst = clamp01((3000 - atMs) / 3000);

  // One entry is one request. log scale so 200 and 2000 are not miles apart.
  const rate = clamp01(Math.log10(tries) / 2.5);

  // Six accounts behind one origin is the whole tout business model.
  const fanout = clamp01((accounts - 1) / 5);

  const payReuse = s.payReuse ? 1 : 0;

  // Browsing is human. Landing straight on the entry is not.
  const shallow = clamp01((3 - actions) / 3);

  // Machines keep time. The coefficient of variation of the gaps is low for a
  // script and high for a person; with fewer than three gaps we know nothing,
  // so the feature stays neutral rather than guessing.
  let cadence = 0;
  if (gaps.length >= 3) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean > 0) {
      const varc = gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length;
      cadence = clamp01(1 - Math.sqrt(varc) / mean);
    }
  }

  return { burst, rate, fanout, payReuse, shallow, cadence };
}

/**
 * Score one entry. Returns the probability, the band, how many chits the entry
 * is worth, and every feature's contribution so the glass box can show the
 * arithmetic rather than assert the answer.
 */
export function score(signals = {}) {
  const f = features(signals);
  const W = MODEL.weights;
  // a signal that was not observed (payReuse, when the payment is simulated)
  // is carried as a zero and labelled, never silently counted as innocence
  const parts = Object.keys(W).map(k => ({
    k, value: +f[k].toFixed(3), w: W[k], add: +(W[k] * f[k]).toFixed(3),
    observed: !(k === 'payReuse' && signals.payReuse === null),
  }));
  const z = parts.reduce((a, p) => a + p.add, MODEL.bias);
  const p = 1 / (1 + Math.exp(-z));

  const band = p >= MODEL.bands.challenge ? 'challenge'
    : p >= MODEL.bands.throttle ? 'throttle' : 'clear';

  return {
    p: +p.toFixed(3), z: +z.toFixed(3), band,
    chits: MODEL.chits[band],
    parts: parts.sort((a, b) => b.add - a.add),
    why: reasons(f),
  };
}

/** The named reasons, strongest first. Only ones that actually fired. */
function reasons(f) {
  const out = [];
  if (f.burst > 0.5) out.push('entered in the first instants after the window opened');
  if (f.rate > 0.5) out.push('fired far more requests than an entry needs');
  if (f.fanout > 0.4) out.push('several accounts trace back to one origin');
  if (f.payReuse) out.push('one payment instrument settling more than one identity');
  if (f.shallow > 0.6) out.push('entered without touching anything else in the app');
  if (f.cadence > 0.6) out.push('gaps between requests are machine-regular');
  if (!out.length) out.push('nothing in this entry looks automated');
  return out;
}

/**
 * Score a whole round. Real people and simulated travellers go through the
 * same function as the farms - a scorer that only ever runs on the entries you
 * already suspect is not a scorer, it is a label.
 */
export function scoreRound(entries) {
  return entries.map(e => ({ id: e.id, kind: e.kind, name: e.name || null, ...score(e.signals || {}) }));
}
