// ---------------------------------------------------------------------------
// The split, wired to the real corridor.
//
// split.mjs is deliberately ignorant: it takes injected functions so it cannot
// recurse into the enumerator that calls it. This is the adapter that hands it
// khaali's actual inventory, khaali's actual timetable and khaali's actual bus
// ledger, and turns what comes back into a chain the page already knows how to
// draw.
//
// It is rail-to-rail only, on purpose. That is V1's frozen scope: replace the
// prefix with a specific bus departure and rejoin the SAME train. Bus-to-bus
// swaps, arbitrary middle-stretch replacement and metro-triggered diagnosis are
// all out, and the interfaces are shaped so they could come in later without
// this file having guessed at them.

import { ST, TRAINS } from './data.mjs';
import { GEO } from './geo.mjs';
import { sMin, hhmm, fare as railFare } from './engine.mjs';
import * as journey from './journey.mjs';
import * as busledger from './busledger.mjs';
import * as split from './split.mjs';
import * as claims from './claims.mjs';

const dayMin = m => ((m % 1440) + 1440) % 1440;
const idxOf = code => ST.findIndex(s => s.c === code);

/**
 * The train she would have taken - the one the split is pinned to.
 *
 * A different train that happens to beat it is a separate option and appears on
 * its own; it is never substituted inside something khaali is calling a
 * same-train split.
 */
export function pinnedTrain(chains) {
  const direct = (chains || []).filter(c => c.kind === 'train'
    && c.legs && c.legs.length === 1 && c.legs[0].mode === 'train');
  if (!direct.length) return null;
  return direct.sort((a, b) => a.dep - b.dep)[0].legs[0];
}

/**
 * Everything split.find needs, from the corridor khaali actually runs.
 *
 * `sell` is anySeats, not free. `free` means berths clear the whole way, which
 * is seat hop's question; if khaali can sell the journey by packing partial
 * berths then it can sell it, and there is nothing here to solve. The four
 * existing planner sites thread `.free` and are deliberately left alone -
 * switching them would move every recommendation khaali currently makes.
 */
export function findFor({ fromIdx, toIdx, date, pax = 1, after = 0,
                          countsFor, ledger = null, now = Date.now(),
                          alternativeArr = null, keepTrace = false } = {}) {
  const seats = (no, f, to) => {
    try {
      const k = countsFor(String(no), date, 'SL', f, to);
      return k == null ? null : k.anySeats;
    } catch { return null; }
  };

  /** The most anybody could be sold the whole way, over every train that runs
      it. Null only when khaali could not count a single one of them. */
  const sellWhole = (f, to) => {
    let best = null;
    journey.trainsBetween(f, to, 0, 24).forEach(t => {
      const n = seats(t.train, f, to);
      if (n == null) return;
      best = best == null ? n : Math.max(best, n);
    });
    return best;
  };

  /**
   * Named departures from the boundary khaali could actually sell, in time
   * order. Filtered on availability HERE so split.mjs never recomputes what the
   * inventory said - one place does that arithmetic.
   */
  const onwardFrom = (k, to, from) => journey.trainsBetween(k, to, from, 12)
    .map(t => {
      const n = seats(t.train, k, to);
      return (n != null && n >= pax)
        ? { trainNo: String(t.train), name: t.name, depMin: t.dep, arrMin: t.arr,
          stopId: ST[k].c, stopName: ST[k].n, sell: n }
        : null;
    }).filter(Boolean);

  // Buses that start near where she is and end near the boundary. Each ROUTE
  // yields several DEPARTURES, and every one of them is judged on its own.
  const busesFor = (f, k, from) => {
    const routes = journey.busesBetween(GEO[f].lat, GEO[f].lng, GEO[k].lat, GEO[k].lng, 2.5);
    const out = [];
    routes.forEach(bus => {
      const mid = journey.railNear(bus.toLat, bus.toLng, 2.5);
      const walkKm = mid && mid.i === k ? mid.km : null;
      if (walkKm == null) return;
      const walkMinutes = walkKm > 0.05 ? Math.max(1, Math.round(walkKm / journey.WALK_KMH * 60)) : 0;
      busledger.candidates(bus, date, from, { now }).forEach(c => out.push({
        ...c, walkMinutes, walkKm: walkKm || 0,
        fromLat: bus.fromLat, fromLng: bus.fromLng, toLat: bus.toLat, toLng: bus.toLng,
        from: bus.from, to: bus.to, boardIdx: bus.boardIdx, nStops: bus.nStops,
        every: bus.every, runMin: bus.runMin, seat: bus.seat || null,
      }));
    });
    return out.sort((a, b) => a.depMin - b.depMin);
  };

  return split.find({ fromIdx, toIdx, pax, after, now,
    sellWhole, busesFor, onwardFrom,
    ledger: ledger || claims.ledger(),
    alternativeArr, keepTrace });
}

/**
 * The result, as a chain the existing renderer draws without being taught
 * anything new: a bus leg, a walk if there is one, and the train leg.
 *
 * `tail` is the journey the split came out of. Everything AFTER its rail leg -
 * the walk out of Bengaluru Cantt, the BMTC bus to Hebbala, the last walk - is
 * kept, because she is still going to Hebbala and a journey that stops at a
 * railway station is an answer to a question nobody asked. The tail's times are
 * shifted by however much later the new train arrives, and the connection into
 * it is re-checked rather than assumed.
 */
export function chainOf(result, { fromIdx, toIdx, date, tail = null }) {
  if (!result || !result.ok) return null;
  const s = result.split, bus = s.replacement, k = s.boundaryIdx;
  const arrive = bus.arrMin;
  const legs = [{
    mode: 'bus', id: bus.id, name: bus.name, from: bus.from, to: bus.to,
    dep: hhmm(dayMin(bus.depMin)), arr: hhmm(dayMin(arrive)),
    depMin: bus.depMin, arrMin: arrive, min: bus.runMin, every: bus.every,
    boardIdx: bus.boardIdx, nStops: bus.nStops, source: bus.source,
    fromLat: bus.fromLat, fromLng: bus.fromLng, toLat: bus.toLat, toLng: bus.toLng,
    seat: journey.seatOdds({ mode: 'bus', at: bus.nStops ? bus.boardIdx / bus.nStops : null }),
    tripInstanceId: bus.tripInstanceId, basis: bus.basis,
  }];
  if (bus.walkMinutes > 0) legs.push({
    mode: 'walk', name: 'Walk', from: bus.to, to: ST[k].n, km: bus.walkKm, min: bus.walkMinutes,
    depMin: arrive, arrMin: arrive + bus.walkMinutes,
    dep: hhmm(dayMin(arrive)), arr: hhmm(dayMin(arrive + bus.walkMinutes)),
    fare: 0, source: 'measured', seat: null,
    fromLat: bus.toLat, fromLng: bus.toLng, toLat: GEO[k].lat, toLng: GEO[k].lng,
  });
  const on = s.onward;
  legs.push({
    mode: 'train', id: on.train, name: on.name || on.train,
    from: ST[k].n, to: ST[toIdx].n, fromIdx: k, toIdx,
    dep: hhmm(dayMin(on.depMin)), arr: hhmm(dayMin(on.arrMin)),
    depMin: on.depMin, arrMin: on.arrMin, min: on.arrMin - on.depMin,
    seat: journey.seatOdds({ mode: 'train', free: s.onwardConstraint.n }),
    source: 'timetable',
  });
  // ---- the rest of her journey, kept and re-timed -------------------------
  let arr = on.arrMin, tailFare = 0, tailNote = null;
  if (tail && tail.legs) {
    const cut = tail.legs.findIndex(l => l.mode === 'train' && l.toIdx === toIdx);
    const rest = cut >= 0 ? tail.legs.slice(cut + 1) : [];
    if (rest.length) {
      const oldArr = tail.legs[cut].arrMin;
      const shift = on.arrMin - oldArr;
      // A shifted timetable is not a re-planned journey. If the onward leg runs
      // to a headway khaali can re-time it honestly; if it is a fixed departure
      // that has already gone, this chain is not offerable and says so.
      const fixed = rest.find(l => l.mode !== 'walk' && !l.every && l.depMin != null
        && (l.depMin + shift) !== l.depMin && shift > 0);
      if (fixed && shift > 0) tailNote = 'ONWARD_NOT_REVALIDATED';
      rest.forEach(l => {
        const m = { ...l };
        if (m.depMin != null) { m.depMin = l.depMin + shift; m.dep = hhmm(dayMin(m.depMin)); }
        if (m.arrMin != null) { m.arrMin = l.arrMin + shift; m.arr = hhmm(dayMin(m.arrMin)); }
        legs.push(m);
        tailFare += (l.fare || 0);
      });
      arr = legs[legs.length - 1].arrMin;
    }
  }
  return {
    kind: 'split', legs,
    dep: bus.depMin, arr,
    fare: Math.max(6, Math.round(journey.km({ lat: bus.fromLat, lng: bus.fromLng },
      { lat: bus.toLat, lng: bus.toLng }) * 1.2 / 5) * 5)
      + railFare('SL', Math.abs(ST[toIdx].km - ST[k].km)) + tailFare,
    totalMin: ((arr - bus.depMin) + 1440) % 1440,
    depText: hhmm(dayMin(bus.depMin)), arrText: hhmm(dayMin(arr)),
    modes: legs.filter(l => l.mode !== 'walk').map(l => l.mode),
    changes: Math.max(0, legs.filter(l => l.mode !== 'walk').length - 1),
    simulated: legs.some(l => l.source === 'simulated'),
    seat: { word: 'unknown', why: '' },       // set honestly by the seat pass
    tailNote,
    split: {
      boundaryIdx: k, boundary: ST[k].n, boundaryCode: ST[k].c,
      train: on.train, tripInstanceId: bus.tripInstanceId,
      basis: bus.basis, quality: s.busConstraint.quality,
      releasesInventory: false,
      transferMinutes: s.transfer.wait,
      why: split.whyLines(s, { stationName: i => ST[i] ? ST[i].n : ('stop ' + i) }),
    },
  };
}
