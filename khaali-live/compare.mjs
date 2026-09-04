// ---------------------------------------------------------------------------
// What you would have done, and what khaali did instead.
//
// The comparison every mapping app makes is "this way is faster". khaali's is
// not, and pretending otherwise would misrepresent the whole product: its
// recommendation is frequently SLOWER on purpose, because it spent four minutes
// buying a seat or getting off a train that is at ninety per cent. A panel that
// leads with minutes makes khaali look like it is failing precisely when it is
// doing the thing it exists to do.
//
// So this shows WHATEVER ACTUALLY CHANGED, signed both ways:
//
//     Normally    direct train, 58 min, very crowded
//     khaali      bus then train, 64 min, lower crowding, seat likely
//     ->          6 minutes longer, and it avoids the busiest train.
//
// THE BASELINE IS THE OBVIOUS ROUTE, not khaali's own fastest.
//
// Comparing khaali's pick against khaali's fastest is comparing khaali against
// itself, and it answers a question nobody asked. What a person wants to know
// is what they would have done WITHOUT this - the direct train, the one bus
// everybody on that corridor knows by number - and what they got instead. The
// fastest chain stays as a third benchmark and appears only as a footnote.
//
// And the thing under all of it, which is the one number khaali does not have:
// it has never watched anybody travel, so "what you would have done" is a rule,
// not an observation. FOOT says so, on every comparison, without exception.

import { pressure } from './capacity.mjs';
import * as load from './load.mjs';

/** Below this a crowding difference is noise. Shared with allocate.mjs, which
    drew the same line at the same number and kept its own copy of it. */
export const CROWD_EPS = 0.08;

/**
 * Which axis leads the sentence.
 *
 * Minutes sit deliberately in the middle. They are not unimportant - they are
 * simply not what khaali is for, and letting the biggest number win would put
 * them in front every time, because minutes are numerically larger than every
 * other axis on this list.
 */
export const HEADLINE_WEIGHT = {
  seat: 1.0, worstSegment: 0.9, crowding: 0.8, minutes: 0.7, fare: 0.5, changes: 0.4,
};

/** How the axes are normalised before they are weighed against each other. */
const SCALE = { minutes: 20, fare: 60, changes: 2, crowding: 0.4, seat: 3, worstSegment: 1 };

const SEAT_RANK = { yes: 3, likely: 2, maybe: 1, standing: 0, unknown: 1 };
const modesOf = c => [...new Set((c.legs || []).filter(l => l.mode !== 'walk').map(l => l.mode))];
const rankOf = c => (c.seat && c.seat.rank != null) ? c.seat.rank : (SEAT_RANK[(c.seat || {}).word] ?? 1);

/**
 * The route somebody would have taken without khaali.
 *
 * Pure, over the same chains the allocator was handed, and deliberately blind
 * to every score: this must not become "the second best answer khaali found",
 * which would make the comparison circular. First rule that fits wins, and the
 * rules are ordered by what a passenger would say she is doing - a journey with
 * both a direct train and a direct bus is a rail journey, and she would say so.
 */
export function obviousOf(chains, { after = null } = {}) {
  const list = (chains || []).filter(Boolean);
  if (!list.length) return null;
  const earliest = (a, b) => (a.dep - b.dep) || (a.arr - b.arr);
  const pick = (subset, rule, why) => {
    if (!subset.length) return null;
    const c = subset.slice().sort(earliest)[0];
    return { idx: list.indexOf(c), chain: c, rule, why };
  };

  // O1 - the direct train. What she books without opening khaali at all.
  const direct = list.filter(c => c.changes === 0 && modesOf(c).join() === 'train');
  const o1 = pick(direct, 'DIRECT_TRAIN', 'the direct train, which is what you would book without khaali');
  if (o1) return o1;

  // O2 - still a train journey, just not a through one.
  const rail = list.filter(c => (c.legs || []).some(l => l.mode === 'train'));
  if (rail.length) {
    const fewest = Math.min(...rail.map(c => c.changes));
    const o2 = pick(rail.filter(c => c.changes === fewest), 'FEWEST_CHANGES_RAIL',
      'the train, with as few changes as the line allows');
    if (o2) return o2;
  }

  // O3 - one bus, end to end. The route everybody on that corridor knows.
  const oneBus = list.filter(c => c.changes === 0 && modesOf(c).join() === 'bus');
  const o3 = pick(oneBus, 'DIRECT_BUS', 'the one bus that runs the whole way');
  if (o3) return o3;

  // O5 - the network does not reach, so a person hires something.
  const allHire = list.every(c => (c.legs || []).some(l => l.mode === 'car' || l.mode === 'bike'));
  if (allHire) {
    const o5 = pick(list, 'ONLY_A_RIDE', 'a ride, because nothing on the network reaches');
    if (o5) return o5;
  }

  // O4 - absent local knowledge, the obvious way is the one with the least
  // deciding in it.
  const fewest = Math.min(...list.map(c => c.changes));
  const few = list.filter(c => c.changes === fewest);
  const modes = Math.min(...few.map(c => modesOf(c).length));
  return pick(few.filter(c => modesOf(c).length === modes), 'FEWEST_CHANGES',
    'the way with the fewest changes, because that is what you pick without a plan');
}

const spanOf = (c, ref) => {
  if (!c) return null;
  if (ref && ref.by != null) return ref.by - c.dep;
  if (ref && ref.after != null) return c.arr - ref.after;
  return c.totalMin;
};

/**
 * What is different, axis by axis, each carrying its own quality.
 *
 * `layer` is optional and everything works without it: pass a per-leg load
 * reader and the worstSegment axis appears; pass nothing and it is absent from
 * the array, and lines() never mentions it. That is what lets the comparison
 * ship before or after the map.
 */
export function diff(obvious, pick, { after = null, by = null, fastest = null, layer = null } = {}) {
  if (!obvious || !pick) return null;
  const a = obvious.chain || obvious, b = pick.chain || pick;
  const ref = { after, by };
  const same = a === b;

  const axes = [];
  const add = (key, label, av, bv, better, quality, unit) => {
    if (av == null || bv == null) return;
    const delta = bv - av;
    axes.push({ key, label, obvious: av, pick: bv, delta,
      direction: delta === 0 ? 'same' : (better(delta) ? 'better' : 'worse'),
      quality: quality || 'exact', unit: unit || '' });
  };

  add('minutes', 'Time', spanOf(a, ref), spanOf(b, ref), d => d < 0, 'exact', 'min');
  add('fare', 'Fare', a.fare, b.fare, d => d < 0, 'exact', '₹');
  add('changes', 'Changes', a.changes, b.changes, d => d < 0, 'exact', '');
  add('seat', 'Seat', rankOf(a), rankOf(b), d => d > 0,
    (b.seat && b.seat.word) ? 'estimated' : 'unknown', '');

  const pa = a.alloc ? a.alloc.pressure : pressure(a);
  const pb = b.alloc ? b.alloc.pressure : pressure(b);
  if (pa && pb && Math.abs(pb.value - pa.value) > CROWD_EPS) {
    add('crowding', 'Crowding', pa.value, pb.value, d => d < 0,
      (pb.certainty === 'HIGH' ? 'estimated' : 'predicted'), '');
  }

  if (typeof layer === 'function') {
    const worst = c => load.worstOf((c.legs || []).map(l => { try { return layer(l); } catch { return null; } }));
    const wa = worst(a), wb = worst(b);
    if (wa && wb && wa.load != null && wb.load != null && Math.abs(wb.load - wa.load) > CROWD_EPS) {
      axes.push({ key: 'worstSegment', label: 'Busiest stretch',
        obvious: wa.load, pick: wb.load, delta: wb.load - wa.load,
        direction: wb.load < wa.load ? 'better' : 'worse',
        quality: wb.quality, unit: '',
        obviousBand: wa.band, pickBand: wb.band });
    }
  }

  // The headline is whichever axis matters most, not whichever number is
  // biggest - which is the whole reason HEADLINE_WEIGHT exists.
  const weigh = x => (HEADLINE_WEIGHT[x.key] || 0.1)
    * Math.min(1, Math.abs(x.delta) / (SCALE[x.key] || 1));
  const better = axes.filter(x => x.direction === 'better');
  const worse = axes.filter(x => x.direction === 'worse');
  const headline = (better.length ? better : worse)
    .slice().sort((x, y) => weigh(y) - weigh(x))[0] || null;

  const fast = fastest && fastest !== b
    ? { minutes: spanOf(fastest, ref), slowerByMinutes: spanOf(b, ref) - spanOf(fastest, ref),
      seat: (fastest.seat || {}).word || 'unknown' }
    : null;

  return { same, rule: obvious.rule || null, why: obvious.why || null,
    obviousIdx: obvious.idx != null ? obvious.idx : null,
    obviousKind: a.kind || null, pickKind: b.kind || null,
    obviousModes: modesOf(a), pickModes: modesOf(b),
    axes, headline: headline ? headline.key : null, fastest: fast,
    caveats: axes.filter(x => x.quality === 'simulated' || x.quality === 'unknown').map(x => x.key) };
}

const mins = n => Math.abs(Math.round(n)) + (Math.abs(Math.round(n)) === 1 ? ' minute' : ' minutes');
const SEAT_WORD = ['standing', 'if you are lucky', 'likely', 'yes'];
/** The same four ranks as a phrase that can be the object of a sentence.
    "A seat is standing this way" is not English; "this way it is standing" is. */
const SEAT_PHRASE = ['standing', 'a seat if you are lucky', 'a seat likely', 'a seat'];
const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
/** "standing the whole way" reads; "with a seat standing" does not. */
const seatPhrase = w => w === 'standing' ? 'standing the whole way'
  : w === 'unknown' ? 'a seat khaali cannot vouch for'
    : 'a seat ' + w;

/**
 * The comparison in sentences, pure, so a test can read every one of them.
 *
 * The rule they are all held to: a claim of a saving may only appear on an axis
 * that actually improved. "Faster" and "saves" are not decorations.
 */
export function lines(d) {
  if (!d) return [];
  const out = [];
  const by = k => d.axes.find(x => x.key === k);

  if (d.same) {
    out.push('The obvious way is also the way khaali would pick — ' + (d.why || 'this one') + '.');
    out.push('Nothing here is a detour.');
    const w = by('worstSegment');
    if (w) out.push('Its busiest stretch runs at about ' + Math.round(w.pick * 100) + '% full.');
    if (d.fastest && d.fastest.slowerByMinutes > 0) {
      out.push('There is a way ' + mins(d.fastest.slowerByMinutes) + ' quicker, '
        + seatPhrase(d.fastest.seat) + '.');
    }
    return out;
  }

  const head = by(d.headline);
  const m = by('minutes');
  const cost = m && m.direction === 'worse' ? mins(m.delta) + ' longer' : null;
  const gain = m && m.direction === 'better' ? mins(m.delta) + ' quicker' : null;

  // the headline, with its price folded into the same sentence rather than
  // apologised for underneath it
  if (head && head.key === 'worstSegment') {
    out.push((cost ? cost.charAt(0).toUpperCase() + cost.slice(1) + ' — and it avoids' : 'It avoids')
      + ' the busiest stretch: about ' + Math.round(head.obvious * 100) + '% full the obvious way, '
      + Math.round(head.pick * 100) + '% this way.');
  } else if (head && head.key === 'seat') {
    out.push((cost ? cost.charAt(0).toUpperCase() + cost.slice(1) + ' — and your chance of a seat goes from '
      : 'Your chance of a seat goes from ')
      + SEAT_WORD[head.obvious] + ' to ' + SEAT_WORD[head.pick] + '.');
  } else if (head && head.key === 'crowding') {
    out.push((cost ? cost.charAt(0).toUpperCase() + cost.slice(1) + ' — and it is ' : 'It is ')
      + (head.direction === 'better' ? 'less' : 'more') + ' crowded than the obvious way.');
  } else if (head && head.key === 'fare') {
    out.push('₹' + Math.abs(Math.round(head.delta)) + (head.direction === 'better' ? ' cheaper' : ' dearer')
      + ' than the obvious way' + (cost ? ', and ' + cost : gain ? ', and ' + gain : '') + '.');
  } else if (gain) {
    out.push(gain.charAt(0).toUpperCase() + gain.slice(1) + ' than the obvious way.');
  } else if (cost) {
    out.push(cost.charAt(0).toUpperCase() + cost.slice(1) + ' than the obvious way, and khaali still '
      + 'prefers it — see below for what it buys.');
  } else {
    out.push('Much the same either way.');
  }

  // then everything else that moved, so nothing is hidden behind the headline
  for (const x of d.axes) {
    if (x.key === d.headline || x.direction === 'same') continue;
    if (x.key === 'minutes') continue;                 // already in the headline
    if (x.key === 'seat') out.push('This way it is ' + SEAT_PHRASE[x.pick]
      + ', the obvious way ' + SEAT_PHRASE[x.obvious] + '.');
    if (x.key === 'fare') out.push('It costs ₹' + Math.abs(Math.round(x.delta))
      + (x.direction === 'better' ? ' less.' : ' more.'));
    if (x.key === 'changes') {
      const n = Math.abs(Math.round(x.delta));
      out.push((COUNT[n] || n).replace(/^./, ch => ch.toUpperCase()) + ' '
        + (n === 1 ? 'more change' : 'more changes') .replace('more',
          x.direction === 'better' ? 'fewer' : 'more') + '.');
    }
    if (x.key === 'crowding') out.push('It is ' + (x.direction === 'better' ? 'less' : 'more')
      + ' crowded across the whole journey.');
    if (x.key === 'worstSegment') out.push('Its busiest stretch is '
      + Math.round(x.pick * 100) + '% full, against ' + Math.round(x.obvious * 100) + '% the obvious way.');
  }

  if (d.fastest && d.fastest.slowerByMinutes > 0) {
    out.push('The quickest way of all is ' + mins(d.fastest.slowerByMinutes)
      + ' ahead of this one, ' + seatPhrase(d.fastest.seat) + '.');
  }
  if (d.caveats.length) {
    out.push('Some of that is khaali’s own model rather than a measurement, and the map says which.');
  }
  return out;
}

/** The sentence under every comparison, without exception. */
export const FOOT = 'The obvious route is khaali’s guess at what you would have done without it — '
  + 'the direct train, or the one bus that runs. It is not a route anyone has measured you taking.';
