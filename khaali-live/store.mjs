// Shared, server-authoritative berth state.
//
// Locking model
// -------------
// Each berth carries two 13-bit masks: `booked` (paid for) and `held` (someone
// is at the payment screen right now). A berth is available for a journey only
// if BOTH masks are clear on every leg of it.
//
// hold() does check-then-set inside a single synchronous function. Node runs
// one turn of the event loop at a time, so no other request can interleave
// between the check and the set — two phones racing for the same berth cannot
// both win. This is a real compare-and-swap, not an approximation.
//
// Two ways to book, and what moves
// --------------------------------
// A CHOSEN berth is the old way: you pick S6/66 and it is yours now. Its legs
// are PINNED - they can never move - which can cost the coach packing room,
// so it carries a choice fee.
//
// ANY berth is the airline way: you book the journey, not the berth. It goes
// into a pool. At charting, four hours before departure, everyone who is not
// pinned - the pool, and the travellers the railway already booked the old
// way - is seated by the packer around the pinned berths, and each any-berth
// traveller is told where they sit. That re-seating is the whole point: it is
// what turns one sellable berth into a hundred.
//
// Every hold, of either kind, must first pass one test - can everyone already
// in, plus this one, still be seated? - by actually running the packer.
// Before charting the seat map keeps showing the railway's scattered
// assignment, because that is what is physically true today; the number
// beside it says what charting will make of it.
import { ST } from './data.mjs';
import crypto from 'crypto';
import {
  SEGMENTS, journeyMask, spanMask, berthState, seedOccupancy, berthLayout,
  packPlan, packInto, classByKey, fare, journeyKm, priceFor, coveredKm, popcount, isLowerBerth, legCounts } from './engine.mjs';

export const HOLD_MS = 5 * 60 * 1000;          // 5 minutes at the payment screen
// One request used to be able to lock every free berth on a train. Six is
// IRCTC's own per-booking limit; two open holds is enough to change your mind
// once without letting one account fence off a coach.
export const MAX_BERTHS_PER_HOLD = 6;
export const MAX_OPEN_HOLDS = 2;
// Pinned berths are obstacles to packing. Airlines cap the seats you may
// pre-assign for exactly this reason; forty percent of a coach is generous.
export const MAX_CHOSEN_FRACTION = 0.4;
// Charting: everyone unpinned is seated this long before the train leaves.
export const CHART_BEFORE_MS = 4 * 60 * 60 * 1000;

/** The price of pinning a berth. Per traveller, by class. */
/** Nothing. Choosing a berth costs khaali the same query as not choosing one,
    so it is not charged for. Kept as a function because the hold, the seat map
    and the ticket all still ask, and all three should get the same answer. */
export function choiceFeeFor(cls) {
  return 0;
}

/**
 * Charges are the server's to compute, and every one of them is a charge the
 * railway itself makes: reservation and superfast per traveller, GST on the
 * air-conditioned fare. khaali adds nothing to that - no booking fee, no
 * convenience fee, nothing for choosing a berth. A fare quoted here is a fare
 * somebody at a counter would also read out.
 */
export function feesFor(cls, pax, berthSum, chosen = false) {
  const ac = cls !== 'SL';
  const gst = ac ? Math.round(berthSum * 0.05) : 0;
  return 20 * pax + (ac ? 15 * pax : 0) + gst + (chosen ? choiceFeeFor(cls) * pax : 0);
}

/** Holds this identity still has at the payment screen. */
export function pendingHoldsFor(who) {
  let n = 0;
  for (const h of holds.values()) if (h.status === 'pending' && h.who === who) n++;
  return n;
}

const inventory = new Map();                    // key -> inventory
const holds = new Map();                        // holdId -> hold
const bookings = new Map();                     // pnr -> booking
const listeners = new Set();
// Every confirmed booking goes here as a plain record. The server points
// this at the journal; on its own the store just remembers in memory.
let recorder = null;
export function onRecord(fn) { recorder = fn; }

export const keyOf = (train, date, cls) => `${train}|${date}|${cls}`;

function inv(key) {
  let v = inventory.get(key);
  if (!v) {
    const [train, date, cls] = key.split('|');
    // Seed by how far in the future the travel date is, so day 30 does not
    // look identical to today. Further out = deterministic but emptier.
    // Engine convention: dayIdx 0 = TODAY (same-day booking is allowed),
    // which is also what the client uses. Today's date therefore maps to 0.
    const dayIdx = Math.max(0, Math.round(
      (new Date(date + 'T00:00:00') - new Date(new Date().toDateString())) / 864e5));
    const seeded = seedOccupancy(cls, train, dayIdx);
    // The seed is the railway's own bookings, pinned at booking time the way
    // the railway pins them. Physically they sit where they sit (`booked`);
    // for charting they are journeys that may move (`movable`).
    // a realistic share of the railway's own travellers need a lower berth
    const movable = [];
    seeded.forEach((m, i) => { if (m) movable.push({ id: 'seed#' + i, mask: m, group: null, at: i,
      need: ((i * 7919 + seeded.length) % 100) < 12 ? 'senior' : null }); });
    v = {
      booked: Int32Array.from(seeded),   // what is physically on each berth now
      // The same numbers again, frozen. `booked` grows as people book through
      // khaali; this does not - so subtracting one from the other is how a leg
      // can say which of its passengers khaali counted and which were there
      // when the day started. Written once, never again.
      seedMask: Int32Array.from(seeded),
      pinned: new Int32Array(seeded.length),  // the legs a chosen booking nailed down
      held: new Int32Array(seeded.length),
      owner: new Array(seeded.length).fill(null),
      layout: berthLayout(cls),
      movable,                // railway-booked journeys that charting may re-seat
      pool: new Map(),        // itemId -> any-berth journey waiting for a berth
      chosen: new Set(),      // berth idx pinned by a khaali chosen booking or hold
      charted: false, chartedAt: null,
    };
    inventory.set(key, v);
  }
  return v;
}

// ------------------------------------------------------------------ events --
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(type, payload) {
  const msg = { type, ...payload, at: Date.now() };
  for (const fn of listeners) { try { fn(msg); } catch { /* dead client */ } }
}

// -------------------------------------------------------------------- pool --
/** Legs that can never move. Before charting: pinned and held. After: all of it. */
function fixedOf(v, extraGrants) {
  const f = new Int32Array(v.booked.length);
  for (let i = 0; i < f.length; i++) f[i] = (v.charted ? v.booked[i] : v.pinned[i]) | v.held[i];
  if (extraGrants) for (const g of extraGrants) f[g.idx] |= g.mask;
  return f;
}
/** Any-berth journeys still waiting for a berth: held or booked, not assigned. */
function poolItems(v) {
  const out = [];
  for (const p of v.pool.values()) if (p.status === 'held' || p.status === 'booked') out.push(p);
  return out;
}
/** Everyone charting may move: the railway's own travellers plus the pool. */
function movableItems(v) {
  return v.charted ? poolItems(v) : v.movable.concat(poolItems(v));
}
/** Can everyone who may move, plus `extra`, be seated around what cannot? */
function seatable(v, extra = [], extraGrants = null) {
  return packInto(fixedOf(v, extraGrants), movableItems(v).concat(extra), v.layout);
}
const chosenCap = v => Math.floor(MAX_CHOSEN_FRACTION * v.layout.length);

/** Seats left for this journey if nobody were pinned: capacity minus the
    busiest leg of the journey. Exact with no obstacles, an upper bound with
    them, and cheap enough for a 61-day calendar. */
function anySeatsFor(v, j) {
  const n = v.booked.length;
  const occ = new Array(SEGMENTS).fill(0);
  for (let i = 0; i < n; i++) {
    const m = v.booked[i] | v.held[i];
    if (!m) continue;
    for (let l = 0; l < SEGMENTS; l++) if (m & (1 << l)) occ[l]++;
  }
  for (const p of poolItems(v)) for (let l = 0; l < SEGMENTS; l++) if (p.mask & (1 << l)) occ[l]++;
  let room = n;
  for (let l = 0; l < SEGMENTS; l++) if (j & (1 << l)) room = Math.min(room, n - occ[l]);
  return Math.max(0, room);
}

// ------------------------------------------------------------ availability --
export function availability(train, date, cls, from, to) {
  const key = keyOf(train, date, cls);
  const v = inv(key);
  const j = journeyMask(from, to);
  const counts = { free: 0, part: 0, taken: 0, locked: 0, pooled: 0 };
  const km = journeyKm(from, to);
  const fullPrice = fare(cls, km);
  // where the pool would sit today, if nobody else moved: shown hatched. Pool
  // travellers who only fit once others are re-seated are simply not hatched;
  // the count beside the map says how many are waiting for charting.
  const phys = new Int32Array(v.booked.length);
  for (let i = 0; i < phys.length; i++) phys[i] = v.booked[i] | v.held[i];
  const hatch = packInto(phys, poolItems(v), v.layout);
  const berths = v.layout.map(b => {
    const occ = v.booked[b.idx];
    const lockedHere = (v.held[b.idx] & j) !== 0;
    const pooledHere = (hatch.packed[b.idx] & j) !== 0;
    const st = berthState(occ, from, to);
    const k = lockedHere ? 'locked' : (pooledHere && st.k !== 'taken') ? 'pooled' : st.k;
    counts[k]++;
    const gotKm = (k === 'taken' || k === 'pooled') ? 0 : coveredKm(occ, from, to);
    return {
      ...b, k, at: st.at ?? null, mode: st.mode ?? null,
      price: (k === 'taken' || k === 'pooled') ? null : priceFor(occ, from, to, cls),
      km: gotKm,
      pooled: hatch.packed[b.idx] | 0,
      chosen: v.chosen.has(b.idx),
    };
  });
  // what charting makes of this coach, and whether one more traveller fits
  const after = seatable(v);
  const probe = v.charted ? { ok: false } : seatable(v, [{ id: '?', mask: j, group: '?', at: Number.MAX_SAFE_INTEGER }]);
  return {
    train, date, cls, from, to, km,
    price: fullPrice,
    label: classByKey(cls).label,
    counts, berths,
    pack: packPlan(Array.from(v.booked)),
    charted: v.charted, chartedAt: v.chartedAt,
    pool: poolItems(v).length,
    wholeFreeAfterPacking: after.wholeFree,
    anySeats: anySeatsFor(v, j),
    anyBerth: { ok: !!probe.ok, price: fullPrice, choiceFee: v.charted ? 0 : choiceFeeFor(cls) },
    chosenCap: { used: v.chosen.size, max: chosenCap(v) },
    lower: lowerPicture(v),
  };
}

/** Lower berths in this coach, and how many people already need one. */
function lowerPicture(v) {
  let total = 0, free = 0;
  for (let i = 0; i < v.layout.length; i++) {
    if (!isLowerBerth(v.layout[i])) continue;
    total++;
    if ((v.booked[i] | v.held[i]) === 0) free++;
  }
  const needed = movableItems(v).filter(p => p.need).length;
  return { total, free, needed, spoken: Math.min(total, needed), charted: v.charted, result: v.lower || null };
}

/** Counts only — no berth objects, no packing plan. Cheap enough for 61 dates.
    `anySeats` is the number khaali can actually sell for this journey. */
export function countsFor(train, date, cls, from, to) {
  const v = inv(keyOf(train, date, cls));
  const j = journeyMask(from, to);
  let free = 0, part = 0, taken = 0, locked = 0;
  for (let i = 0; i < v.booked.length; i++) {
    if ((v.held[i] & j) !== 0) { locked++; continue; }
    const hit = v.booked[i] & j;
    if (hit === 0) free++; else if (hit === j) taken++; else part++;
  }
  return { free, part, taken, locked, anySeats: v.charted ? free : anySeatsFor(v, j), charted: v.charted };
}

/**
 * How full each of the thirteen legs is - counted, not estimated.
 *
 * Read-only: four passes over arrays this function does not own, no mutation,
 * no await, nothing held across a turn. It cannot disturb hold()'s
 * compare-and-swap because it never takes part in one.
 *
 * The split matters more than the total. khaali's corridor starts each day
 * with a seeded occupancy - engine.seedOccupancy, a deterministic model with a
 * hard-coded blockers table - and real bookings are laid on top of it. A leg
 * that reports 41 of 72 taken has therefore counted two different things, and
 * the map has to say which is which: `booked`/`held`/`pooled` are people who
 * went through khaali, `seeded` is the inventory khaali declared. A leg made
 * entirely of the second is labelled `simulated`, however exact the count is.
 */
export function segmentLoad(train, date, cls) {
  const key = keyOf(train, date, cls);
  const v = inv(key);
  const total = v.booked.length;
  const own = [], all = [], held = [], seed = [];
  for (let i = 0; i < total; i++) {
    const mine = v.booked[i] & ~v.seedMask[i];
    own.push(mine); held.push(v.held[i]); seed.push(v.seedMask[i]);
    all.push(v.booked[i] | v.held[i]);
  }
  const pool = poolItems(v).map(p => p.mask);
  const cOwn = legCounts(own), cHeld = legCounts(held), cSeed = legCounts(seed);
  const cPool = legCounts(pool), cAll = legCounts(all.concat(pool));

  const segments = [];
  for (let l = 0; l < SEGMENTS; l++) {
    const occupied = cAll[l];
    const khaali = cOwn[l] + cHeld[l] + cPool[l];
    const seeded = cSeed[l];
    segments.push({
      leg: l, from: ST[l].c, to: ST[l + 1].c, fromName: ST[l].n, toName: ST[l + 1].n,
      km: ST[l + 1].km - ST[l].km,
      occupied, free: Math.max(0, total - occupied), total,
      booked: cOwn[l], held: cHeld[l], pooled: cPool[l], seeded,
      load: total ? Math.round(occupied / total * 100) / 100 : null,
      // Counted either way. But a leg nobody has booked through khaali is a
      // leg khaali declared, and it says so rather than borrowing the word
      // 'exact' from an inventory it invented.
      quality: !total ? 'unknown' : seeded === 0 ? 'exact' : khaali === 0 ? 'simulated' : 'mixed',
      says: !total ? 'no berths counted here'
        : occupied + ' of ' + total + ' berths taken on this leg'
          + (khaali ? ' · ' + khaali + ' booked through khaali' : '')
          + (seeded ? ' · ' + seeded + ' were there when the day started' : ''),
    });
  }
  return { train, date, cls, total, charted: v.charted, segments };
}

export function snapshot(train, date, cls) {
  const v = inv(keyOf(train, date, cls));
  return { booked: Array.from(v.booked), held: Array.from(v.held), pool: poolItems(v).length, charted: v.charted };
}

// ------------------------------------------------------------------- holds --
/**
 * Try to lock berths for [from,to). All-or-nothing.
 *   mode 'exact'  berthIdxs are the berths; each is pinned and carries the fee
 *   mode 'any'    no berths; pax journeys join the pool if they can be seated
 * Returns { ok:true, hold } or { ok:false, reason, conflicts }.
 */
export const NEEDS = ['senior', 'disabled', 'expecting'];
/** One entry per traveller: what they need and what they would like. */
export function travellersOf(list, paxN) {
  return Array.from({ length: paxN }, (_, k) => {
    const t = (Array.isArray(list) && list[k]) || {};
    return { name: String(t.name || '').slice(0, 60),
      need: NEEDS.includes(t.need) ? t.need : null,
      pref: t.pref === 'lower' ? 'lower' : null };
  });
}

export function hold({ train, date, cls, from, to, berthIdxs = [], pax, who, segs, hop, mode = 'exact', cap = true, travellers }) {
  const key = keyOf(train, date, cls);
  const v = inv(key);
  const j = journeyMask(from, to);
  const paxN = Math.floor(+pax || 0);
  const trav = travellersOf(travellers, Math.max(0, paxN));

  // At the cap, the oldest of this person's own holds gives way. Refusing
  // instead locked out anyone who refreshed twice, for five minutes, with
  // nothing to pay for. The cap is against hoarding, not against changing
  // your mind.
  if (who && cap) {
    let mine = [...holds.values()].filter(h => h.status === 'pending' && h.who === who)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= MAX_OPEN_HOLDS) release(mine.shift().id, 'superseded');
  }

  const id = crypto.randomBytes(9).toString('hex');
  const expiresAt = Date.now() + HOLD_MS;
  const jkm = journeyKm(from, to);

  if (mode === 'any') {
    if (!(paxN >= 1 && paxN <= MAX_BERTHS_PER_HOLD)) return { ok: false, reason: 'bad-pax' };
    // once the chart is prepared there is no "later" to assign in
    if (v.charted) return { ok: false, reason: 'charted' };
    if (anySeatsFor(v, j) < paxN) return { ok: false, reason: 'no-whole-berth' };
    const now = Date.now();
    const items = [];
    for (let k = 0; k < paxN; k++) items.push({ id: id + '#' + k, mask: j, from, to, group: id, at: now, who: who || 'guest', status: 'held', holdId: id,
      need: trav[k].need, pref: trav[k].pref });
    // --- check: can everyone who may move, plus these, be seated? ---
    if (!seatable(v, items).ok) return { ok: false, reason: 'no-whole-berth' };
    // --- set ---
    for (const it of items) v.pool.set(it.id, it);
    const berthSum = fare(cls, jkm) * paxN;
    const extra = feesFor(cls, paxN, berthSum, false);
    const h = {
      mode: 'any', hop: false,
      id, key, train, date, cls, from, to, berthIdxs: [], grants: [], mask: j, pax: paxN, who: who || 'guest', travellers: trav,
      amount: berthSum + extra, berthSum, fees: extra, choiceFee: 0, fullPrice: berthSum + extra, journeyKm: jkm,
      status: 'pending', createdAt: now, expiresAt, berths: [], items: items.map(x => x.id),
    };
    holds.set(id, h);
    h.timer = setTimeout(() => release(id, 'expired'), HOLD_MS);
    emit('held', { key, train, date, cls, berthIdxs: [], holdId: id, mode: 'any' });
    return { ok: true, hold: publicHold(h) };
  }

  if (!berthIdxs.length) return { ok: false, reason: 'no-berths' };
  if (berthIdxs.length > MAX_BERTHS_PER_HOLD) return { ok: false, reason: 'too-many-berths' };
  if (new Set(berthIdxs).size !== berthIdxs.length) return { ok: false, reason: 'duplicate-berth' };
  if (!(paxN >= 1 && paxN <= MAX_BERTHS_PER_HOLD)) return { ok: false, reason: 'bad-pax' };
  // Hops: one traveller, several berths in sequence. segs pins each berth to
  // its promised stretch; without segs, one berth per passenger as before.
  // A hop is at most two berths per traveller - pax used to go unchecked in
  // this mode, which let one passenger lock twenty berths.
  if (segs && segs.length !== berthIdxs.length) return { ok: false, reason: 'bad-segs' };
  if (segs && berthIdxs.length > 2 * paxN) return { ok: false, reason: 'too-many-berths' };
  if (!segs && berthIdxs.length !== paxN) return { ok: false, reason: 'berth-count-mismatch' };

  // --- check (no await between here and the set below) ---
  // A berth may be free for only part of the journey. Lock exactly the legs it
  // can actually give you; reject only if it gives you nothing, or if someone
  // else already holds any of those legs.
  const conflicts = [], grants = [];
  for (let k = 0; k < berthIdxs.length; k++) {
    const i = berthIdxs[k];
    if (i < 0 || i >= v.layout.length) return { ok: false, reason: 'bad-berth' };
    let grant;
    if (segs && segs[k] && segs[k].to > segs[k].from) {
      grant = spanMask(segs[k].from, segs[k].to) & j;      // exactly the promised stretch
      if (grant === 0) return { ok: false, reason: 'bad-segs' };
      if ((grant & v.booked[i]) !== 0) { conflicts.push({ idx: i, why: 'booked' }); continue; }
    } else {
      grant = j & ~v.booked[i];
      if (grant === 0) { conflicts.push({ idx: i, why: 'booked' }); continue; }
    }
    if ((v.held[i] & grant) !== 0) { conflicts.push({ idx: i, why: 'held' }); continue; }
    grants.push({ idx: i, mask: grant });
  }
  if (conflicts.length) return { ok: false, reason: 'taken', conflicts };
  // Pinned berths are obstacles. Two limits keep them from blocking everyone
  // else: a share of the coach, and - the one that matters - everyone who may
  // still move must be seatable with these legs nailed down.
  const chosenNow = !v.charted;                            // post-chart, picking is just picking
  if (chosenNow) {
    // a whole lower berth is not for sale before the chart: lower berths go
    // to the people who need them at charting, and a choice fee never
    // outranks a seventy-year-old. Partial lowers are already somebody's.
    for (const i of berthIdxs)
      if (v.booked[i] === 0 && isLowerBerth(v.layout[i])) return { ok: false, reason: 'lower-reserved' };
    const newlyChosen = berthIdxs.filter(i => !v.chosen.has(i)).length;
    if (v.chosen.size + newlyChosen > chosenCap(v)) return { ok: false, reason: 'chosen-cap' };
    if (!seatable(v, [], grants).ok) return { ok: false, reason: 'needed-for-pool' };
  }

  // --- set ---
  for (const g of grants) { v.held[g.idx] |= g.mask; }
  if (chosenNow) for (const i of berthIdxs) v.chosen.add(i);

  // Each berth is priced for the part of the journey it actually covers, so a
  // partial berth costs less than one that is free your whole way.
  const berths = grants.map(g => {
    const occ = j & ~g.mask;               // the legs of your journey it cannot give you
    const gotKm = coveredKm(occ, from, to);
    return {
      ...v.layout[g.idx], mask: g.mask,
      price: priceFor(occ, from, to, cls),
      km: gotKm,
      partial: gotKm < jkm,
      gapKm: jkm - gotKm,
    };
  });
  const berthSum = berths.reduce((a, b) => a + b.price, 0);
  const extra = feesFor(cls, paxN, berthSum, chosenNow);
  const amount = berthSum + extra;

  const hopFlag = !!(hop || segs);
  const h = {
    mode: 'exact', hop: hopFlag, chosen: chosenNow,
    id, key, train, date, cls, from, to, berthIdxs, grants, mask: j, pax: paxN, who: who || 'guest', travellers: trav,
    amount, berthSum, fees: extra, choiceFee: chosenNow ? choiceFeeFor(cls) * paxN : 0,
    fullPrice: fare(cls, jkm) * paxN + extra, journeyKm: jkm,
    status: 'pending', createdAt: Date.now(), expiresAt, berths,
  };
  for (const i of berthIdxs) v.owner[i] = id;
  holds.set(id, h);
  h.timer = setTimeout(() => release(id, 'expired'), HOLD_MS);
  emit('held', { key, train, date, cls, berthIdxs, holdId: id, mode: 'exact' });
  return { ok: true, hold: publicHold(h) };
}

/** The travellers behind a pending hold changed their needs: the hold and
    its pool items learn it, so charting seats them right. */
export function setTravellers(id, list) {
  const h = holds.get(id);
  if (!h || h.status !== 'pending') return { ok: false, reason: h ? h.status : 'unknown-hold' };
  const trav = travellersOf(list, h.pax);
  h.travellers = trav;
  if (h.mode === 'any') {
    const v = inv(h.key);
    (h.items || []).forEach((itId, k) => { const it = v.pool.get(itId); if (it) { it.need = trav[k].need; it.pref = trav[k].pref; } });
  }
  return { ok: true, travellers: trav };
}

export function release(id, reason = 'released') {
  const h = holds.get(id);
  if (!h || h.status !== 'pending') return { ok: false, reason: 'not-pending' };
  const v = inv(h.key);
  if (h.mode === 'any') {
    for (const itId of h.items) v.pool.delete(itId);
  } else {
    for (const g of h.grants) {
      v.held[g.idx] &= ~g.mask;
      if (v.owner[g.idx] === id) v.owner[g.idx] = null;
    }
    // a pinned berth that was never paid for is not chosen any more
    for (const i of h.berthIdxs) if (v.pinned[i] === 0) v.chosen.delete(i);
  }
  clearTimeout(h.timer);
  h.status = reason;
  emit('released', { key: h.key, train: h.train, date: h.date, cls: h.cls, berthIdxs: h.berthIdxs, holdId: id, reason, mode: h.mode });
  return { ok: true };
}

/** Payment succeeded: turn the hold into a booking. Re-checks under CAS. */
export function confirm(id) {
  const h = holds.get(id);
  if (!h) return { ok: false, reason: 'unknown-hold' };
  if (h.status === 'paid') return { ok: true, booking: bookings.get(h.pnr), replay: true };
  if (h.status !== 'pending') return { ok: false, reason: h.status };
  if (Date.now() > h.expiresAt) { release(id, 'expired'); return { ok: false, reason: 'expired' }; }

  const v = inv(h.key);
  const pnr = String(4500000000 + Math.floor(Math.random() * 499999999));

  if (h.mode === 'any') {
    clearTimeout(h.timer);
    h.status = 'paid'; h.pnr = pnr;
    const booking = {
      pnr, mode: 'any', train: h.train, date: h.date, cls: h.cls, from: h.from, to: h.to,
      pax: h.pax, amount: h.amount, who: h.who, travellers: h.travellers || [],
      berths: [], berthIdxs: [], assigned: false, paidAt: Date.now(),
    };
    for (const itId of h.items) { const it = v.pool.get(itId); if (it) { it.status = 'booked'; it.pnr = pnr; } }
    bookings.set(pnr, booking);
    // paid after the chart was prepared: seat them now, there is no later
    let grants = null;
    if (v.charted) grants = assignNow(v, h.items, booking);
    if (recorder) recorder({ t: 'booked', ...booking, key: h.key, grants: grants || [] });
    emit('booked', { key: h.key, train: h.train, date: h.date, cls: h.cls, berthIdxs: booking.berthIdxs, pnr, mode: 'any' });
    return { ok: true, booking };
  }

  for (const g of h.grants) {
    if ((v.booked[g.idx] & g.mask) !== 0) {   // should be impossible; belt and braces
      release(id, 'conflict');
      return { ok: false, reason: 'conflict' };
    }
  }
  for (const g of h.grants) {
    v.booked[g.idx] |= g.mask;
    if (h.chosen) v.pinned[g.idx] |= g.mask;
    v.held[g.idx] &= ~g.mask;
    if (v.owner[g.idx] === id) v.owner[g.idx] = null;
  }
  clearTimeout(h.timer);
  h.status = 'paid'; h.pnr = pnr;
  const booking = {
    pnr, mode: 'exact', chosen: !!h.chosen, train: h.train, date: h.date, cls: h.cls, from: h.from, to: h.to,
    pax: h.pax, amount: h.amount, who: h.who, travellers: h.travellers || [],
    berths: h.berths.map(b => `${b.coach}/${b.no}`), berthIdxs: h.berthIdxs.slice(), assigned: true,
    paidAt: Date.now(),
  };
  bookings.set(pnr, booking);
  // the record carries the exact leg masks, so replay puts the same bits
  // back on the same berths without re-deriving anything
  if (recorder) recorder({ t: 'booked', ...booking, key: h.key,
    grants: h.grants.map(g => ({ idx: g.idx, mask: g.mask })) });
  emit('booked', { key: h.key, train: h.train, date: h.date, cls: h.cls, berthIdxs: h.berthIdxs, pnr, mode: 'exact' });
  return { ok: true, booking };
}

/** Seat one booking's pool items immediately (post-chart). Returns grants. */
function assignNow(v, itemIds, booking) {
  const items = itemIds.map(i => v.pool.get(i)).filter(Boolean);
  const r = packInto(fixedOf(v), items, v.layout);
  const grants = [];
  for (const it of items) {
    const idx = r.assign.get(it.id);
    if (idx == null) continue;                 // was checked at hold time; belt and braces
    v.booked[idx] |= it.mask;
    it.status = 'assigned'; it.idx = idx;
    grants.push({ idx, mask: it.mask });
  }
  booking.berthIdxs = grants.map(g => g.idx);
  booking.berths = grants.map(g => `${v.layout[g.idx].coach}/${v.layout[g.idx].no}`);
  booking.assigned = grants.length === items.length;
  return grants;
}

// ---------------------------------------------------------------- charting --
/**
 * Prepare the chart: seat everyone who may move - the railway's own travellers
 * and every any-berth booking - around the pinned berths, and tell each
 * any-berth traveller where they sit. This is where scattered bookings become
 * whole empty berths. Idempotent; deterministic from the bookings themselves.
 */
export function chart(train, date, cls) {
  const key = keyOf(train, date, cls);
  const v = inv(key);
  if (v.charted) return { ok: true, already: true, assigned: 0 };
  const items = movableItems(v).filter(p => !p.holdId || p.status === 'booked');
  const r = packInto(fixedOf(v), items, v.layout);

  // rebuild the physical map: pinned legs stay, everyone else lands where the
  // packer put them
  const booked = new Int32Array(v.booked.length);
  for (let i = 0; i < booked.length; i++) booked[i] = v.pinned[i];
  const byPnr = new Map();
  const lowerByPnr = new Map();
  for (const it of items) {
    const idx = r.assign.get(it.id);
    if (idx == null) continue;
    booked[idx] |= it.mask;
    if (it.pnr) {
      it.status = 'assigned'; it.idx = idx;
      if (!byPnr.has(it.pnr)) byPnr.set(it.pnr, []);
      byPnr.get(it.pnr).push({ idx, mask: it.mask });
      if (it.need) {
        const L = lowerByPnr.get(it.pnr) || { needed: 0, given: 0, missed: 0 };
        L.needed++; if (r.lowerMissed.includes(it.id)) L.missed++; else L.given++;
        lowerByPnr.set(it.pnr, L);
      }
    }
  }
  // a railway traveller the packer could not seat keeps the berth they had
  for (const id of r.unseated) {
    const it = items.find(x => x.id === id);
    if (it && !it.pnr && it.id.startsWith('seed#')) booked[+it.id.slice(5)] |= it.mask;
  }
  v.booked = booked;
  v.movable = [];
  const assignments = [];
  for (const [pnr, grants] of byPnr) {
    const b = bookings.get(pnr);
    const lower = lowerByPnr.get(pnr) || null;
    if (b) {
      b.berthIdxs = grants.map(g => g.idx);
      b.berths = grants.map(g => `${v.layout[g.idx].coach}/${v.layout[g.idx].no}`);
      b.assigned = true;
      if (lower) b.lower = lower;
      emit('charted', { key, train, date, cls, pnr, berths: b.berths, berthIdxs: b.berthIdxs, who: b.who, lower });
    }
    assignments.push({ pnr, grants, lower });
  }
  v.charted = true; v.chartedAt = Date.now();
  v.lower = { needed: r.lowerNeeded, given: r.lowerGiven, missed: r.lowerMissed.length };
  let wholeFree = 0;
  for (let i = 0; i < v.booked.length; i++) if (v.booked[i] === 0) wholeFree++;
  if (recorder) recorder({ t: 'charted', key, train, date, cls, assignments, lower: v.lower,
    booked: Array.from(v.booked), pinned: Array.from(v.pinned), unseated: r.unseated.filter(x => !x.startsWith('seed#')) });
  emit('chart', { key, train, date, cls, assigned: assignments.length, wholeFree, lower: v.lower });
  return { ok: true, assigned: assignments.length, unseated: r.unseated.filter(x => !x.startsWith('seed#')).length, wholeFree, lower: v.lower };
}

/** Every inventory this process knows about, for the charting timer. */
export function inventoryKeys() { return [...inventory.keys()]; }
export function chartInfo(train, date, cls) {
  const v = inventory.get(keyOf(train, date, cls));
  if (!v) return { charted: false, pool: 0 };
  return { charted: v.charted, chartedAt: v.chartedAt, pool: poolItems(v).filter(p => p.status === 'booked').length, lower: v.lower || null };
}

export const getHold = id => {
  const h = holds.get(id);
  return h ? publicHold(h) : null;
};
export const getBooking = pnr => bookings.get(pnr) || null;
export const allBookings = () => [...bookings.values()].sort((a, b) => b.paidAt - a.paidAt);

function publicHold(h) {
  return {
    id: h.id, mode: h.mode || 'exact', chosen: !!h.chosen, train: h.train, date: h.date, cls: h.cls, from: h.from, to: h.to,
    pax: h.pax, amount: h.amount, berthSum: h.berthSum, fees: h.fees || 0, choiceFee: h.choiceFee || 0,
    fullPrice: h.fullPrice, journeyKm: h.journeyKm,
    status: h.status, who: h.who, pnr: h.pnr || null,
    expiresAt: h.expiresAt, msLeft: Math.max(0, h.expiresAt - Date.now()),
    hop: !!h.hop,
    berths: h.berths.map(b => {
      let lo = -1, hi = -1;
      for (let l = 0; l < 13; l++) if (b.mask & (1 << l)) { if (lo < 0) lo = l; hi = l + 1; }
      return {
        idx: b.idx, coach: b.coach, no: b.no, type: b.type,
        price: b.price, km: b.km, partial: b.partial, gapKm: b.gapKm,
        segFrom: lo, segTo: hi,
      };
    }),
  };
}

/**
 * Rebuild from journal records. A 'booked' record re-marks its legs on its
 * berths and restores the booking; an any-berth record without grants goes
 * back into the pool; a 'charted' record restores the physical map exactly as
 * charting left it; a 'reset' record forgets everything before it. No events
 * are emitted: nothing is happening, it already happened.
 */
export function replay(records) {
  let booked = 0, resets = 0, charted = 0;
  for (const r of records || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.t === 'reset') { bookings.clear(); inventory.clear(); resets++; continue; }
    if (r.t === 'charted' && r.key && Array.isArray(r.assignments)) {
      const v = inv(r.key);
      if (Array.isArray(r.booked) && r.booked.length === v.booked.length) v.booked = Int32Array.from(r.booked);
      if (Array.isArray(r.pinned) && r.pinned.length === v.pinned.length) v.pinned = Int32Array.from(r.pinned);
      for (const a of r.assignments) {
        const b = bookings.get(String(a.pnr));
        for (const p of v.pool.values()) if (p.pnr === String(a.pnr)) p.status = 'assigned';
        if (b) {
          b.berthIdxs = (a.grants || []).map(g => g.idx);
          b.berths = b.berthIdxs.map(i => `${v.layout[i].coach}/${v.layout[i].no}`);
          b.assigned = true;
          if (a.lower) b.lower = a.lower;
        }
      }
      if (r.lower) v.lower = r.lower;
      v.movable = [];
      v.charted = true; v.chartedAt = r.at || Date.now();
      charted++;
      continue;
    }
    if (r.t !== 'booked' || !r.pnr || !r.key) continue;
    const v = inv(r.key);
    const grants = Array.isArray(r.grants) ? r.grants : [];
    for (const g of grants) {
      if (Number.isInteger(g.idx) && g.idx >= 0 && g.idx < v.booked.length) {
        v.booked[g.idx] |= (g.mask | 0);
        if (r.mode !== 'any' && r.chosen !== false) v.pinned[g.idx] |= (g.mask | 0);
      }
    }
    const { t, key, grants: _g, ...booking } = r;
    if (booking.mode === 'any' && !grants.length) {
      // still waiting for a berth: back into the pool, one item per traveller
      const mask = journeyMask(booking.from, booking.to);
      const trav = travellersOf(booking.travellers, booking.pax || 1);
      for (let k = 0; k < (booking.pax || 1); k++) {
        const id = String(booking.pnr) + '#' + k;
        v.pool.set(id, { id, mask, from: booking.from, to: booking.to, group: String(booking.pnr),
          who: booking.who, at: booking.paidAt || 0, status: 'booked', pnr: String(booking.pnr),
          need: trav[k].need, pref: trav[k].pref });
      }
    } else if (booking.mode !== 'any' && booking.chosen !== false) {
      for (const i of booking.berthIdxs || []) v.chosen.add(i);
    }
    bookings.set(String(r.pnr), booking);
    booked++;
  }
  return { booked, resets, charted };
}

/** Test/demo helper: wipe everything back to the seeded state. */
export function reset() {
  for (const h of holds.values()) clearTimeout(h.timer);
  holds.clear(); bookings.clear(); inventory.clear();
  if (recorder) recorder({ t: 'reset' });
  emit('reset', {});
}

export function stats() {
  let pooled = 0, chartedN = 0;
  for (const v of inventory.values()) { pooled += poolItems(v).length; if (v.charted) chartedN++; }
  return {
    inventories: inventory.size,
    holds: [...holds.values()].filter(h => h.status === 'pending').length,
    bookings: bookings.size,
    pooled, charted: chartedN,
    listeners: listeners.size,
  };
}
