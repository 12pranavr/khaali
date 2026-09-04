// What happens if ten thousand people do this.
//
// One recommendation is a courtesy. Ten thousand of the same recommendation
// is a crowd, and a planner that sends everyone the obvious way has only moved
// the crush from one platform to another. So this file runs the morning
// twice: once the way people travel now - everyone takes the way that gets
// them there soonest - and once with the allocator, where each person is
// given the best way GIVEN EVERYONE WHO WAS ALLOCATED BEFORE THEM, so the
// loads it can see are the loads the earlier passengers made.
//
// It is deterministic: the same demand gives the same answer every time, so a
// change in the result is a change in the code, not the dice. Passengers are
// spread evenly over the window rather than drawn at random, for the same
// reason.
//
// Everything about the network comes in through `candidates(t)` - the ways a
// person ready at minute t can go, with capacity snapshots on every leg - so
// the same engine runs on the golden test network and on Bengaluru.

import { allocate, span } from './allocate.mjs';
import { VEHICLE, OFF_NETWORK } from './capacity.mjs';

/** A footpath and a hired car are both things the network does not have to
    find room on. Neither takes a load, neither fills up, neither can leave
    somebody standing. */
const offNet = m => OFF_NETWORK.includes(m);

/** Vehicles a passenger can be put on, keyed so two people on the same
    train trip share a load. A metro is a train every headway; a bus is a
    trip; a train is a trip. */
export function vehicleKey(leg, headway = 10) {
  if (leg.mode === 'metro') return 'metro|' + Math.floor((leg.depMin || 0) / headway);
  // A hired vehicle is hers alone. Sharing a key would pack ten thousand
  // passengers into one car and report it at 13,000% full. It is excluded from
  // load accounting anyway; this is the belt to that pair of braces.
  if (offNet(leg.mode) && leg.mode !== 'walk') return leg.mode + '|private|' + (++_privateSeq);
  return leg.mode + '|' + (leg.id || leg.name) + '|' + (leg.depMin || 0);
}
let _privateSeq = 0;

/** What a vehicle can carry, at a crush. Trains: the berths on this stretch
    plus the aisle - Indian sleeper coaches run well past their berth count. */
export function crushOf(leg) {
  if (offNet(leg.mode)) return Infinity;      // a footpath and a hired car never fill
  if (leg.mode === 'bus') return VEHICLE.bus.crush;
  if (leg.mode === 'metro') return VEHICLE.metro.crush;
  if (leg.mode === 'train') return Math.round((leg.cap && leg.cap.capacity ? leg.cap.capacity : 432) * 1.5);
  return Infinity;
}
/** ...and seated. */
export function seatsOf(leg) {
  if (offNet(leg.mode)) return Infinity;      // nobody stands in a car they hired
  if (leg.mode === 'bus') return VEHICLE.bus.seats;
  if (leg.mode === 'metro') return VEHICLE.metro.seats;
  if (leg.mode === 'train') return (leg.cap && leg.cap.capacity) ? leg.cap.capacity : 432;
  return Infinity;
}

/**
 * Run the window.
 *   candidates(t)  -> chains for someone ready at minute t (with leg.cap)
 *   n              passengers
 *   start, end     the window, minutes of the day
 *   profile        the allocator profile everybody gets
 *   bucket         minutes between distinct ready-times (candidates are cached per bucket)
 */
export function simulate({ candidates, n = 10000, start = 480, end = 540, profile = 'balanced', bucket = 5, headway = 10 } = {}) {
  const buckets = Math.max(1, Math.round((end - start) / bucket));
  const perBucket = [];
  for (let i = 0; i < buckets; i++) perBucket.push(Math.floor(n / buckets) + (i < n % buckets ? 1 : 0));
  const cache = new Map();
  const ways = t => { if (!cache.has(t)) cache.set(t, candidates(t) || []); return cache.get(t); };

  const run = (mode) => {
    const loads = new Map();               // vehicleKey -> people added by this run
    const base = new Map();                // vehicleKey -> occupancy before anyone (0..1)
    const seen = new Map();                // vehicleKey -> leg (for capacity)
    const chosen = [];                     // per bucket: { t, chain, count }
    let totalSpan = 0, standing = 0, assigned = 0, none = 0;
    const modeCount = {};
    for (let i = 0; i < buckets; i++) {
      const t = start + i * bucket;
      const count = perBucket[i];
      if (!count) continue;
      const cands = ways(t).map(c => ({ ...c, legs: c.legs.map(l => ({ ...l, cap: l.cap ? { ...l.cap } : l.cap })) }));
      if (!cands.length) { none += count; continue; }
      // the loads this run has already made become the occupancy the next
      // person sees - and once a vehicle is past its seats, the seat is gone
      const people = (k, l) => base.get(k) * crushOf(l) + (loads.get(k) || 0);
      const refresh = () => cands.forEach(c => {
        c.legs.forEach(l => {
          if (offNet(l.mode) || !l.cap) return;
          const k = vehicleKey(l, headway);
          if (!base.has(k)) base.set(k, l.cap.occupancy == null ? 0.5 : l.cap.occupancy);
          if (!seen.has(k)) seen.set(k, l);
          l.cap.occupancy = Math.min(1, people(k, l) / crushOf(l));
          if (l.seat && people(k, l) > seatsOf(l)) l.seat = { word: 'standing', rank: 0, why: 'full by the time you board' };
        });
        const seated = c.legs.filter(l => l.seat && l.seat.rank != null);
        c.seat = seated.length ? seated.reduce((p, l) => l.seat.rank < p.seat.rank ? l : p).seat : c.seat;
      });
      refresh();
      // a vehicle that cannot take the next slice is not a choice
      const full = (c, slice) => c.legs.some(l => !offNet(l.mode) && l.cap && people(vehicleKey(l, headway), l) + slice > crushOf(l));
      // one decision per slice, so a bucket of two hundred does not all pile
      // onto one bus and the next slice sees what the last one did
      let left = count;
      while (left > 0) {
        const slice = Math.min(left, 10);
        let open = cands.filter(c => !full(c, slice));
        if (!open.length) open = cands;                      // everything is full: they cram on
        let pick;
        if (mode === 'baseline') pick = open.reduce((p, c) => span(c, { after: t }) < span(p, { after: t }) ? c : p);
        else { const a = allocate(open, { profile, after: t }); pick = a.recommended != null ? open[a.recommended] : open[0]; }
        pick.legs.forEach(l => {
          if (offNet(l.mode) || !l.cap) return;
          const k = vehicleKey(l, headway);
          loads.set(k, (loads.get(k) || 0) + slice);
        });
        refresh();
        // did this slice stand: any leg past its seats
        const stands = pick.legs.some(l => !offNet(l.mode) && l.cap && people(vehicleKey(l, headway), l) > seatsOf(l));
        if (stands) standing += slice;
        totalSpan += span(pick, { after: t }) * slice;
        assigned += slice;
        pick.modes.forEach(m => { modeCount[m] = (modeCount[m] || 0) + slice; });
        chosen.push({ t, kind: pick.kind, count: slice });
        left -= slice;
      }
    }
    // the vehicles at the end
    const veh = [...seen.entries()].map(([k, l]) => {
      const occ = Math.min(1.2, base.get(k) + (loads.get(k) || 0) / crushOf(l));
      return { key: k, mode: l.mode, name: l.name || l.line || l.mode, occupancy: Math.round(occ * 1000) / 10, added: loads.get(k) || 0 };
    });
    const used = veh.filter(v => v.added > 0);
    const peak = used.length ? Math.max(...used.map(v => v.occupancy)) : 0;
    const over = used.filter(v => v.occupancy >= 90).length;
    const busAvg = avg(used.filter(v => v.mode === 'bus').map(v => v.occupancy));
    const trainAvg = avg(used.filter(v => v.mode === 'train').map(v => v.occupancy));
    const metroAvg = avg(used.filter(v => v.mode === 'metro').map(v => v.occupancy));
    return {
      assigned, unserved: none,
      averageMinutes: assigned ? Math.round(totalSpan / assigned) : 0,
      standingShare: assigned ? Math.round(standing / assigned * 100) : 0,
      peakOccupancy: peak, overloadedVehicles: over, vehiclesUsed: used.length,
      busOccupancy: busAvg, trainOccupancy: trainAvg, metroOccupancy: metroAvg,
      modeSplit: Object.fromEntries(Object.entries(modeCount).map(([k, v]) => [k, Math.round(v / Math.max(1, assigned) * 100)])),
      worst: used.sort((a, b) => b.occupancy - a.occupancy).slice(0, 5),
    };
  };

  const baseline = run('baseline');
  const allocated = run('allocated');
  const delta = {
    averageMinutes: allocated.averageMinutes - baseline.averageMinutes,
    standingShare: allocated.standingShare - baseline.standingShare,
    peakOccupancy: Math.round((allocated.peakOccupancy - baseline.peakOccupancy) * 10) / 10,
    overloadedVehicles: allocated.overloadedVehicles - baseline.overloadedVehicles,
    busOccupancy: Math.round((allocated.busOccupancy - baseline.busOccupancy) * 10) / 10,
  };
  return { n, start, end, profile, baseline, allocated, delta, finding: finding(baseline, allocated, delta, n) };
}

function avg(xs) { return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : 0; }

/** One sentence of arithmetic. */
export function finding(b, a, d, n) {
  if (!b.assigned) return 'Nobody could travel in that window.';
  const bits = [];
  if (d.peakOccupancy < -1) bits.push('the most crowded vehicle drops from ' + b.peakOccupancy + '% to ' + a.peakOccupancy + '%');
  if (d.overloadedVehicles < 0) bits.push((b.overloadedVehicles - a.overloadedVehicles) + ' fewer vehicles past 90%');
  if (d.standingShare < -1) bits.push('standing falls from ' + b.standingShare + '% to ' + a.standingShare + '% of passengers');
  if (d.busOccupancy > 1) bits.push('buses go from ' + b.busOccupancy + '% to ' + a.busOccupancy + '% used');
  const mins = m => m + (m === 1 ? ' minute' : ' minutes');
  const cost = d.averageMinutes > 0 ? ', at a cost of ' + mins(d.averageMinutes) + ' more on average' : d.averageMinutes < 0 ? ', and ' + mins(-d.averageMinutes) + ' faster on average' : ', at no cost in time';
  if (!bits.length) return 'With ' + n.toLocaleString('en-IN') + ' people, the allocator changes nothing here: the fastest way was also the emptiest.';
  return 'With ' + n.toLocaleString('en-IN') + ' people: ' + bits.join(', ') + cost + '.';
}
