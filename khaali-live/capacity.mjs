// How full is it - and how well do we actually know that.
//
// Capacity is a first-class thing here, not a guess hidden in a colour. Every
// leg of a journey gets a snapshot with four fields that matter: how full it
// is (0..1), how many people the vehicle takes, where the number came from,
// and its QUALITY - exact, estimated, predicted, or unknown.
//
//   exact      counted. A train's berths for this stretch, read from the same
//              inventory the booking page sells from.
//   estimated  derived from a structural fact. A bus boarded at stop 3 of 37
//              is nearly empty; that is arithmetic on the timetable, not a
//              measurement.
//   predicted  history. A metro station's own hourly entries, averaged over
//              weekdays. Tomorrow at nine will look like last Tuesday at nine.
//   unknown    we do not know. Unknown is NOT zero and NOT "probably 40%".
//              It is carried as null and the confidence says so.
//
// Nothing here talks to a language model. This file is arithmetic.

export const QUALITY = ['exact', 'estimated', 'predicted', 'unknown'];

/** Modes that are not the network: a footpath, and anything she hires for
    herself. None of them may add to - or subtract from - network pressure. */
export const HIRED = ['car', 'bike'];
export const OFF_NETWORK = ['walk', 'auto', ...HIRED];

/** How much a quality label is worth when a recommendation leans on it. */
export const QUALITY_WEIGHT = { exact: 1.0, estimated: 0.7, predicted: 0.6, unknown: 0.3 };

/** People a vehicle carries. Train and metro seated counts are structural;
    the rest are operator figures and say so. */
export const VEHICLE = {
  // BMTC standard 12 m bus: ~40 seats, ~35 standing (BMTC fleet spec)
  bus:   { seats: 40, crush: 75, source: 'BMTC fleet specification' },
  // BMRCL six-coach Purple Line train: ~300 seats, ~2,000 crush (BMRCL)
  metro: { seats: 300, crush: 2000, source: 'BMRCL six-coach rating' },
};

const clamp01 = x => Math.max(0, Math.min(1, x));

/**
 * The occupancy a bus has when you board it at a position along its route.
 * People get on all the way along and mostly get off in town, so a load rises
 * roughly with distance. The 1.3 makes a bus full about two-thirds of the way
 * in, which is what BMTC's own occupancy surveys on radial routes show.
 */
export function busLoadAt(at) {
  if (at == null) return null;
  return clamp01(at * 1.3);
}

/**
 * A snapshot for one leg. Pass what you know; get back what that is worth.
 *   train: { free, total }   berths free and total on this stretch, this class
 *   bus:   { boardIdx, nStops, source }
 *   metro: { level }         0..1 crowd at the alighting station this hour
 */
export function snapshot(leg, facts = {}) {
  const base = { mode: leg.mode, occupancy: null, capacity: null, quality: 'unknown',
    source: '', simulated: leg.source === 'simulated' };
  if (leg.mode === 'train') {
    const { free, total } = facts;
    if (free == null || !total) return { ...base, source: 'berths not counted for this stretch' };
    return { ...base, occupancy: clamp01(1 - free / total), capacity: total,
      quality: 'exact', source: 'berth inventory for this stretch, ' + free + ' of ' + total + ' free' };
  }
  if (leg.mode === 'bus') {
    const at = (facts.boardIdx != null && facts.nStops) ? facts.boardIdx / facts.nStops : null;
    if (at == null) return { ...base, capacity: VEHICLE.bus.crush, source: 'boarding position unknown' };
    return { ...base, occupancy: busLoadAt(at), capacity: VEHICLE.bus.crush,
      quality: 'estimated',
      source: 'boarding at stop ' + (facts.boardIdx + 1) + ' of ' + facts.nStops
        + (leg.source === 'simulated' ? ' on a simulated timetable' : ' from the published timetable') };
  }
  if (leg.mode === 'metro') {
    if (facts.level == null) return { ...base, capacity: VEHICLE.metro.crush, source: 'no ridership record for this hour' };
    return { ...base, occupancy: clamp01(facts.level), capacity: VEHICLE.metro.crush,
      quality: 'predicted', source: 'weekday hourly entries at this station, BMRCL under RTI' };
  }
  if (leg.mode === 'walk' || leg.mode === 'auto') return { ...base, quality: 'exact', occupancy: 0, capacity: null,
    source: leg.mode === 'walk' ? 'a footpath has no capacity' : 'an auto is not a network vehicle' };
  // A hired vehicle carries her and nobody else. It is not shared capacity, so
  // it has no occupancy to know - and, importantly, no EMPTINESS to offer the
  // network either. See the exclusions in pressure() and impact() below.
  if (HIRED.includes(leg.mode)) return { ...base, quality: 'exact', occupancy: 0, capacity: null,
    source: 'a hired ' + leg.mode + ' carries only her; it is not network capacity' };
  return base;
}

/**
 * Put a snapshot on every leg of every chain. `trainCap(no, from, to)` returns
 * { free, total } from the live inventory, or null when it cannot.
 */
export function annotate(chains, { trainCap = null } = {}) {
  chains.forEach(c => {
    c.legs.forEach(l => {
      let facts = {};
      if (l.mode === 'train' && trainCap) {
        try { facts = trainCap(l.id, l.fromIdx, l.toIdx) || {}; } catch { facts = {}; }
      } else if (l.mode === 'bus') {
        facts = { boardIdx: l.boardIdx, nStops: l.nStops };
      } else if (l.mode === 'metro') {
        facts = { level: l.crowdAlight ? l.crowdAlight.level : null };
      }
      l.cap = snapshot(l, facts);
    });
  });
  return chains;
}

/**
 * The pressure a journey puts on the network: minute-weighted occupancy,
 * squared so a 90% segment weighs far more than two 45% ones. Unknown legs
 * count as 0.5 with their doubt recorded in `confidence`, never as empty.
 */
export function pressure(chain) {
  let num = 0, den = 0, conf = 0, n = 0, unknown = 0;
  chain.legs.forEach(l => {
    // A hired ride is empty by definition. Counting it would let a journey look
    // kind to the network precisely BECAUSE it took a car off it, which is
    // backwards - so it counts for nothing here, in either direction.
    if (OFF_NETWORK.includes(l.mode) || !l.cap) return;
    const occ = l.cap.occupancy == null ? 0.5 : l.cap.occupancy;
    if (l.cap.occupancy == null) unknown++;
    const w = Math.max(1, l.min || 1);
    num += w * occ * occ; den += w;
    conf += QUALITY_WEIGHT[l.cap.quality] || 0.3; n++;
  });
  const p = den ? num / den : 0.25;
  let c = n ? conf / n : 0.3;
  if (chain.legs.some(l => l.source === 'simulated')) c *= 0.85;
  // `certainty`, not `word`. demand.mjs bands a COUNT into the same three
  // strings, and a page that showed both would put HIGH next to HIGH meaning
  // two different things - how sure khaali is, and how many people there are.
  return { value: Math.round(p * 1000) / 1000, confidence: Math.round(c * 100) / 100,
    unknownLegs: unknown, certainty: c >= 0.8 ? 'HIGH' : c >= 0.55 ? 'MEDIUM' : 'LOW' };
}

/**
 * What one more person does to each leg. "Train 90% -> 90.1%" is the whole
 * argument for moving people, so it is computed, not asserted.
 */
export function impact(chain, passengers = 1) {
  return chain.legs.filter(l => !OFF_NETWORK.includes(l.mode) && l.cap).map(l => {
    const before = l.cap.occupancy, cap = l.cap.capacity;
    const after = (before == null || !cap) ? null : clamp01(before + passengers / cap);
    return { leg: l.name || l.line || l.mode, mode: l.mode, capacity: cap,
      before: before == null ? null : Math.round(before * 1000) / 10,
      after: after == null ? null : Math.round(after * 1000) / 10,
      quality: l.cap.quality };
  });
}
