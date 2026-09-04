// Which way should she go.
//
// Routing (journey.mjs) answers "what can this person physically do". This
// file answers "which of those should we put first" - and it answers for two
// people at once: the passenger, who wants to be there by nine sitting down,
// and the network, which would rather she did not add herself to a train that
// is already at ninety percent when a bus beside it is at forty.
//
// Everything here is arithmetic. Every candidate gets a passenger cost and a
// network cost, both in minutes-equivalent so they can be added, and the
// smallest total wins - subject to LIMITS, which exist so that no passenger is
// ever sent a materially worse way to make the network's numbers prettier.
//
// The reasons are machine-readable codes with verified facts beside them. A
// language model may later turn those into a sentence; it may not add to them.

import { pressure, impact } from './capacity.mjs';

/** Everything in minutes-equivalent: what a rupee, a change, a minute of
    walking, and standing for the ride are worth against a minute of travel. */
export const WEIGHTS = {
  balanced:    { time: 1.0, fare: 0.08, change: 8, walk: 1.5, seat: 14, crowd: 24, hire: 18 },
  fastest:     { time: 1.0, fare: 0.00, change: 2, walk: 1.0, seat: 0,  crowd: 0,  hire: 6  },
  cheapest:    { time: 0.3, fare: 0.60, change: 3, walk: 0.5, seat: 4,  crowd: 4,  hire: 40 },
  comfortable: { time: 0.8, fare: 0.04, change: 16, walk: 3.0, seat: 30, crowd: 30, hire: 26 },
  network:     { time: 1.0, fare: 0.06, change: 8, walk: 1.5, seat: 10, crowd: 48, hire: 30 },
};

/** A hired ride is a last resort she opted into, not a convenience the
    allocator reaches for. It costs nothing to the network and everything to
    the point of the product, so it carries its own standing penalty - without
    which `fastest` (fare weight 0.00) would hand out a free taxi every time.

    `comfortable` is among the MOST reluctant, which looks backwards until you
    remember what it is weighing: a hired vehicle guarantees a seat, so the
    seat weight of 30 pulls hard toward it - and the comfort of that seat is
    the one thing khaali cannot check. A bike in Bengaluru traffic is not what
    somebody choosing Comfortable meant. */
export const HIRE_MODES = ['car', 'bike'];
export const isHire = m => HIRE_MODES.includes(m);
export const PROFILES = Object.keys(WEIGHTS);

/** The lines the network may never cross on a passenger's behalf. A profile
    is the passenger's own statement of what she will trade, so the line moves
    with it - but there is always a line. */
export const LIMITS = {
  extraMin: 25,        // never recommend more than this slower than the fastest way
  extraChanges: 1,     // nor more than one change beyond the fastest way
  maxWalkKm: 1.5,      // nor a long walk nobody asked for
  // Nor a hired ride longer than a last mile plausibly is. This is deliberately
  // far - a real gap in a metro region is fifteen or twenty kilometres, and a
  // cap that cannot close the gap makes hiring pointless. What keeps a car from
  // being the easy answer is the hire penalty in the score, not this line; this
  // line is only here so khaali never answers "Bangarpet to Majestic" with a
  // ninety-kilometre taxi.
  maxRideKm: 25,
};
export const PROFILE_LIMITS = {
  fastest: { extraMin: 10 }, balanced: { extraMin: 25 }, network: { extraMin: 30 },
  comfortable: { extraMin: 45 }, cheapest: { extraMin: 60 },
};

/**
 * The time a journey really costs her. "Leave after eight" means the clock
 * starts at eight, not when the train does: a 10:30 departure that runs 95
 * minutes has cost her four and a half hours of the morning. "Reach by nine"
 * runs the other way - what matters is how early she has to set out.
 */
export function span(c, { after = null, by = null } = {}) {
  if (by != null) return by - c.dep;
  if (after != null) return c.arr - after;
  return c.totalMin;
}

/** How much standing costs, in minutes, by the seat word the engine gave. */
const SEAT_COST = { yes: 0, likely: 2, maybe: 6, standing: 14, unknown: 4 };

const walkKm = c => c.legs.filter(l => l.mode === 'walk').reduce((s, l) => s + (l.km || 0), 0);
const walkMin = c => c.legs.filter(l => l.mode === 'walk').reduce((s, l) => s + (l.min || 0), 0);
export const rideKm = c => c.legs.filter(l => isHire(l.mode)).reduce((s, l) => s + (l.km || 0), 0);
const rideLegs = c => c.legs.filter(l => isHire(l.mode)).length;
const seatRank = c => (c.seat && c.seat.rank != null) ? c.seat.rank : -1;

/**
 * Score one chain. Returns the parts, so a trace can show its work.
 */
export function score(c, w, ref) {
  const seatW = (SEAT_COST[(c.seat || {}).word] ?? 4) * (w.seat / 14);
  const p = pressure(c);
  const passenger = {
    time: span(c, ref) * w.time,
    fare: (c.fare - ref.minFare) * w.fare,
    changes: c.changes * w.change,
    walk: walkMin(c) * w.walk,
    seat: seatW,
  };
  // hiring is charged per ride and again per kilometre: one short hop to a
  // station is a different thing from being driven most of the way
  const nHire = rideLegs(c);
  if (nHire) passenger.hire = (w.hire || 0) * nHire + rideKm(c) * (w.hire || 0) * 0.25;
  const network = { crowd: p.value * w.crowd };
  const pCost = Object.values(passenger).reduce((a, b) => a + b, 0);
  const nCost = network.crowd;
  return { passenger, network, passengerCost: r1(pCost), networkCost: r1(nCost),
    total: r1(pCost + nCost), pressure: p };
}
const r1 = x => Math.round(x * 10) / 10;

/**
 * Rank the candidates. Returns the same chains, each with `alloc`, plus which
 * one is recommended and why.
 *
 *   profile   one of PROFILES
 *   limits    override LIMITS
 *   maxChanges, maxWalkKm   hard constraints from the passenger
 */
export function allocate(chains, { profile = 'balanced', limits = {}, maxChanges = null, maxWalkKm = null,
  after = null, by = null } = {}) {
  if (!chains.length) return { chains, recommended: null, reason: null };
  const w = WEIGHTS[profile] || WEIGHTS.balanced;
  const L = { ...LIMITS, ...(PROFILE_LIMITS[profile] || {}), ...limits };
  const sp = c => span(c, { after, by });

  // ---- hard constraints first: a chain that breaks one is not a candidate ----
  const hard = c => {
    const out = [];
    if (maxChanges != null && c.changes > maxChanges) out.push('TOO_MANY_CHANGES');
    if (maxWalkKm != null && walkKm(c) > maxWalkKm) out.push('TOO_FAR_TO_WALK');
    return out;
  };

  const minFare = Math.min(...chains.map(c => c.fare));
  const fastest = chains.reduce((p, c) => sp(c) < sp(p) ? c : p);
  const ref = { minFare, fastest, after, by };

  chains.forEach((c, i) => {
    const s = score(c, w, ref);
    const broken = hard(c);
    // the network may not push her past these
    const overLimit = [];
    if (sp(c) - sp(fastest) > L.extraMin) overLimit.push('SLOWER_THAN_LIMIT');
    if (c.changes - fastest.changes > L.extraChanges) overLimit.push('MORE_CHANGES_THAN_LIMIT');
    if (walkKm(c) > L.maxWalkKm) overLimit.push('LONGER_WALK_THAN_LIMIT');
    if (rideKm(c) > L.maxRideKm) overLimit.push('LONGER_RIDE_THAN_LIMIT');
    c.alloc = { ...s, idx: i, broken, overLimit,
      candidate: broken.length === 0 && overLimit.length === 0 };
  });

  const eligible = chains.filter(c => c.alloc.candidate);
  const pool = eligible.length ? eligible : chains.filter(c => !c.alloc.broken.length);
  if (!pool.length) return { chains, recommended: null, reason: { primary: 'NO_JOURNEY_MEETS_CONSTRAINTS', facts: {} } };
  const rec = pool.reduce((p, c) => c.alloc.total < p.alloc.total ? c : p);

  // ---- labels: which chain is best at what ----
  const cheapest = chains.reduce((p, c) => c.fare < p.fare ? c : p);
  const fewest = chains.reduce((p, c) => c.changes < p.changes ? c : p);
  const leastWalk = chains.reduce((p, c) => walkKm(c) < walkKm(p) ? c : p);
  const bestSeat = chains.reduce((p, c) => seatRank(c) > seatRank(p) ? c : p);
  chains.forEach(c => {
    c.alloc.labels = [];
    if (c === rec) c.alloc.labels.push('recommended');
    if (sp(c) === sp(fastest)) c.alloc.labels.push('fastest');
    if (c.fare === cheapest.fare) c.alloc.labels.push('cheapest');
    if (c.changes === fewest.changes && chains.length > 1) c.alloc.labels.push('fewest-changes');
    if (walkKm(c) < walkKm(leastWalk) + 0.01 && walkKm(fastest) > 0.3) c.alloc.labels.push('least-walking');
    if (seatRank(c) >= 2 && seatRank(c) === seatRank(bestSeat)) c.alloc.labels.push('seated');
  });

  // The best way there that hires nothing. If one exists, a hired journey is a
  // CHOICE over it, not a necessity - and the recommendation has to say which.
  const netOnly = chains.filter(c => !rideKm(c));
  const netBest = netOnly.length ? netOnly.reduce((p, c) => sp(c) < sp(p) ? c : p) : null;
  return { chains, recommended: rec.alloc.idx,
    reason: explain(rec, fastest, cheapest, { after, by, netBest, span: sp }) };
}

/**
 * Why this one - as codes and verified numbers. No prose here; prose is
 * somebody else's job and they are only allowed to use these facts.
 */
export function explain(rec, fastest, cheapest, ref = {}) {
  const dt = span(rec, ref) - span(fastest, ref);
  const pr = rec.alloc.pressure, pf = fastest.alloc ? fastest.alloc.pressure : pressure(fastest);
  const crowdDiff = pf.value - pr.value;
  const facts = {
    timeDifferenceMinutes: dt,
    fastestMinutes: fastest.totalMin, recommendedMinutes: rec.totalMin,
    fareDifference: rec.fare - fastest.fare,
    recommendedFare: rec.fare, cheapestFare: cheapest.fare,
    changes: rec.changes,
    seat: (rec.seat || {}).word || 'unknown', seatWhy: (rec.seat || {}).why || '',
    fastestSeat: (fastest.seat || {}).word || 'unknown',
    crowdingDifference: crowdDiff > 0.08 ? 'lower' : crowdDiff < -0.08 ? 'higher' : 'similar',
    networkPressure: pr.value, fastestPressure: pf.value,
    capacityConfidence: pr.word,
    simulated: !!rec.simulated,
    modes: rec.modes,
    hiredKm: rideKm(rec),
    hired: rec.legs.filter(l => isHire(l.mode)).map(l => ({ mode: l.mode, from: l.from, to: l.to, km: l.km })),
    // what the network could have done instead, if anything
    networkAlternative: (ref.netBest && ref.netBest !== rec) ? {
      minutes: ref.netBest.totalMin, fare: ref.netBest.fare,
      modes: ref.netBest.modes,
      slowerByMinutes: ref.span ? Math.max(0, ref.span(ref.netBest) - ref.span(rec)) : null,
    } : null,
  };
  const reasons = [];
  if (rec === fastest) reasons.push('FASTEST');
  if (facts.crowdingDifference === 'lower') reasons.push('LOWER_CROWDING');
  if (seatRank(rec) > seatRank(fastest)) reasons.push('BETTER_SEAT');
  if (rec.fare < fastest.fare - 15) reasons.push('CHEAPER');
  if (rec.changes < fastest.changes) reasons.push('FEWER_CHANGES');
  if (rec !== fastest && dt > 0) reasons.push(dt <= 10 ? 'ONLY_MINUTES_SLOWER' : 'SLOWER_BUT_WORTH_IT');
  if (rec.changes === 0) reasons.push('DIRECT');
  // a hired ride is never silently preferred: if one is on the recommended
  // journey, saying why is part of the recommendation
  if (facts.hired.length) {
    // "no bus runs there" is only true when no bus runs there. When one does
    // and is merely slower, saying otherwise is a lie khaali would be telling
    // to justify a fare it invented.
    reasons.unshift(facts.networkAlternative ? 'RIDE_IS_FASTER_THAN_THE_NETWORK' : 'RIDE_BECAUSE_NOTHING_RUNS');
    // carried through so the sentence can own up to it
    if (rec.alloc && rec.alloc.overLimit && rec.alloc.overLimit.includes('LONGER_RIDE_THAN_LIMIT'))
      reasons.push('LONGER_RIDE_THAN_LIMIT');
  }
  if (!reasons.length) reasons.push('BEST_BALANCE');
  return { primary: reasons[0], secondary: reasons[1] || null, reasons,
    confidence: pr.confidence, facts, impact: impact(rec) };
}

/**
 * A sentence from the codes, for when no language model is there. Dull on
 * purpose: it may only say what the facts say.
 */
export function sentence(reason) {
  if (!reason) return '';
  const f = reason.facts, has = k => reason.reasons.includes(k);
  const parts = [];
  if (has('FASTEST')) parts.push('This is the fastest way');
  else if (f.timeDifferenceMinutes > 0) parts.push('About ' + f.timeDifferenceMinutes + ' minutes slower than the fastest way');
  if (has('BETTER_SEAT')) parts.push(f.seat === 'yes' ? 'you get a seat' : 'a seat is ' + f.seat);
  if (has('LOWER_CROWDING')) parts.push('it keeps you off the most crowded stretch');
  if (has('CHEAPER')) parts.push('it saves ₹' + (-f.fareDifference));
  if (has('FEWER_CHANGES')) parts.push('with fewer changes');
  if (has('DIRECT') && !has('FASTEST')) parts.push('no changes');
  let s = parts.length ? parts.join(', ') : 'The best balance of time, cost and comfort';
  s = s.charAt(0).toUpperCase() + s.slice(1) + '.';
  if ((has('RIDE_BECAUSE_NOTHING_RUNS') || has('RIDE_IS_FASTER_THAN_THE_NETWORK')) && f.hired && f.hired.length) {
    const h = f.hired[0], alt = f.networkAlternative;
    s += alt
      ? (' The ' + h.mode + ' covers the last ' + h.km + ' km to ' + h.to + '. The '
        + (alt.modes || []).filter((m, i, a) => a.indexOf(m) === i).join(' and ')
        + ' gets there for ₹' + alt.fare
        + (alt.slowerByMinutes ? ', about ' + alt.slowerByMinutes + ' minutes slower' : '')
        + '; the ride is an estimated fare, not a quote.')
      : (' The ' + h.mode + ' is there because no bus khaali knows runs the '
        + h.km + ' km to ' + h.to + '; that fare is an estimate.');
    // A ride past khaali's own limit is only here because nothing else reached
    // at all. Recommending it quietly would be the part that is not honest.
    if (has('LONGER_RIDE_THAN_LIMIT'))
      s += ' That is a longer ride than khaali would normally put you in, and it '
        + 'is offered only because nothing else reaches at all.';
  }
  if (f.capacityConfidence === 'LOW') s += ' Crowding here is partly unknown.';
  return s;
}

/** The trace a developer reads when the recommendation looks wrong. */
export function trace(chains) {
  return chains.map(c => ({
    kind: c.kind, dep: c.depText, arr: c.arrText, min: c.totalMin, fare: c.fare,
    seat: (c.seat || {}).word, passengerCost: c.alloc.passengerCost, networkCost: c.alloc.networkCost,
    total: c.alloc.total, pressure: c.alloc.pressure.value, confidence: c.alloc.pressure.word,
    candidate: c.alloc.candidate, overLimit: c.alloc.overLimit, broken: c.alloc.broken,
    labels: c.alloc.labels, parts: c.alloc.passenger,
    legs: c.legs.filter(l => l.mode !== 'walk').map(l => ({ leg: l.name || l.line, occupancy: l.cap && l.cap.occupancy, quality: l.cap && l.cap.quality })),
  }));
}
