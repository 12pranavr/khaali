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
import crypto from 'crypto';
import {
  SEGMENTS, journeyMask, berthState, seedOccupancy, berthLayout,
  packPlan, classByKey, fare, journeyKm, priceFor, coveredKm,
} from './engine.mjs';

export const HOLD_MS = 5 * 60 * 1000;          // 5 minutes at the payment screen

const inventory = new Map();                    // key -> { booked, held, owner }
const holds = new Map();                        // holdId -> hold
const bookings = new Map();                     // pnr -> booking
const listeners = new Set();

export const keyOf = (train, date, cls) => `${train}|${date}|${cls}`;

function inv(key) {
  let v = inventory.get(key);
  if (!v) {
    const [train, date, cls] = key.split('|');
    // Seed by how far in the future the travel date is, so day 30 does not
    // look identical to today. Further out = deterministic but emptier.
    const dayIdx = Math.max(0, Math.round(
      (new Date(date + 'T00:00:00') - new Date(new Date().toDateString())) / 864e5));
    const seeded = seedOccupancy(cls, train, dayIdx);
    v = {
      booked: Int32Array.from(seeded),
      held: new Int32Array(seeded.length),
      owner: new Array(seeded.length).fill(null),
      layout: berthLayout(cls),
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

// ------------------------------------------------------------ availability --
export function availability(train, date, cls, from, to) {
  const key = keyOf(train, date, cls);
  const v = inv(key);
  const j = journeyMask(from, to);
  const counts = { free: 0, part: 0, taken: 0, locked: 0 };
  const km = journeyKm(from, to);
  const fullPrice = fare(cls, km);
  const berths = v.layout.map(b => {
    const occ = v.booked[b.idx];
    const lockedHere = (v.held[b.idx] & j) !== 0;
    const st = berthState(occ, from, to);
    const k = lockedHere ? 'locked' : st.k;
    counts[k]++;
    const gotKm = k === 'taken' ? 0 : coveredKm(occ, from, to);
    return {
      ...b, k, at: st.at ?? null, mode: st.mode ?? null,
      price: k === 'taken' ? null : priceFor(occ, from, to, cls),
      km: gotKm,                       // how much of your journey this berth covers
    };
  });
  return {
    train, date, cls, from, to, km,
    price: fullPrice,
    label: classByKey(cls).label,
    counts, berths,
    pack: packPlan(Array.from(v.booked)),
  };
}

/** Counts only — no berth objects, no packing. Cheap enough for 61 dates. */
export function countsFor(train, date, cls, from, to) {
  const v = inv(keyOf(train, date, cls));
  const j = journeyMask(from, to);
  let free = 0, part = 0, taken = 0, locked = 0;
  for (let i = 0; i < v.booked.length; i++) {
    if ((v.held[i] & j) !== 0) { locked++; continue; }
    const hit = v.booked[i] & j;
    if (hit === 0) free++;
    else if (hit === j) taken++;
    else part++;
  }
  return { free, part, taken, locked };
}

export function snapshot(train, date, cls) {
  const v = inv(keyOf(train, date, cls));
  return { booked: Array.from(v.booked), held: Array.from(v.held) };
}

// ------------------------------------------------------------------- holds --
/**
 * Try to lock `berthIdxs` for [from,to). All-or-nothing.
 * Returns { ok:true, hold } or { ok:false, reason, conflicts }.
 */
export function hold({ train, date, cls, from, to, berthIdxs, pax, who, fees }) {
  const key = keyOf(train, date, cls);
  const v = inv(key);
  const j = journeyMask(from, to);

  if (!berthIdxs.length) return { ok: false, reason: 'no-berths' };
  if (berthIdxs.length !== pax) return { ok: false, reason: 'berth-count-mismatch' };

  // --- check (no await between here and the set below) ---
  // A berth may be free for only part of the journey. Lock exactly the legs it
  // can actually give you; reject only if it gives you nothing, or if someone
  // else already holds any of those legs.
  const conflicts = [], grants = [];
  for (const i of berthIdxs) {
    if (i < 0 || i >= v.layout.length) return { ok: false, reason: 'bad-berth' };
    const grant = j & ~v.booked[i];
    if (grant === 0) { conflicts.push({ idx: i, why: 'booked' }); continue; }
    if ((v.held[i] & grant) !== 0) { conflicts.push({ idx: i, why: 'held' }); continue; }
    grants.push({ idx: i, mask: grant });
  }
  if (conflicts.length) return { ok: false, reason: 'taken', conflicts };

  // --- set ---
  for (const g of grants) { v.held[g.idx] |= g.mask; }

  const id = crypto.randomBytes(9).toString('hex');
  const expiresAt = Date.now() + HOLD_MS;
  const jkm = journeyKm(from, to);

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
  const extra = Math.max(0, Math.min(2000, Math.floor(+fees || 0)));
  const amount = berths.reduce((a, b) => a + b.price, 0) + extra;

  const h = {
    id, key, train, date, cls, from, to, berthIdxs, grants, mask: j, pax, who: who || 'guest',
    amount, fees: extra, fullPrice: fare(cls, jkm) * pax + extra, journeyKm: jkm,
    status: 'pending', createdAt: Date.now(), expiresAt, berths,
  };
  for (const i of berthIdxs) v.owner[i] = id;
  holds.set(id, h);
  h.timer = setTimeout(() => release(id, 'expired'), HOLD_MS);
  emit('held', { key, train, date, cls, berthIdxs, holdId: id });
  return { ok: true, hold: publicHold(h) };
}

export function release(id, reason = 'released') {
  const h = holds.get(id);
  if (!h || h.status !== 'pending') return { ok: false, reason: 'not-pending' };
  const v = inv(h.key);
  for (const g of h.grants) {
    v.held[g.idx] &= ~g.mask;
    if (v.owner[g.idx] === id) v.owner[g.idx] = null;
  }
  clearTimeout(h.timer);
  h.status = reason;
  emit('released', { key: h.key, train: h.train, date: h.date, cls: h.cls, berthIdxs: h.berthIdxs, holdId: id, reason });
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
  for (const g of h.grants) {
    if ((v.booked[g.idx] & g.mask) !== 0) {   // should be impossible; belt and braces
      release(id, 'conflict');
      return { ok: false, reason: 'conflict' };
    }
  }
  for (const g of h.grants) {
    v.booked[g.idx] |= g.mask;
    v.held[g.idx] &= ~g.mask;
    if (v.owner[g.idx] === id) v.owner[g.idx] = null;
  }
  clearTimeout(h.timer);
  h.status = 'paid';

  const pnr = String(4500000000 + Math.floor(Math.random() * 499999999));
  h.pnr = pnr;
  const booking = {
    pnr, train: h.train, date: h.date, cls: h.cls, from: h.from, to: h.to,
    pax: h.pax, amount: h.amount, who: h.who,
    berths: h.berths.map(b => `${b.coach}/${b.no}`),
    paidAt: Date.now(),
  };
  bookings.set(pnr, booking);
  emit('booked', { key: h.key, train: h.train, date: h.date, cls: h.cls, berthIdxs: h.berthIdxs, pnr });
  return { ok: true, booking };
}

export const getHold = id => {
  const h = holds.get(id);
  return h ? publicHold(h) : null;
};
export const getBooking = pnr => bookings.get(pnr) || null;
export const allBookings = () => [...bookings.values()].sort((a, b) => b.paidAt - a.paidAt);

function publicHold(h) {
  return {
    id: h.id, train: h.train, date: h.date, cls: h.cls, from: h.from, to: h.to,
    pax: h.pax, amount: h.amount, fees: h.fees || 0, fullPrice: h.fullPrice, journeyKm: h.journeyKm,
    status: h.status, who: h.who, pnr: h.pnr || null,
    expiresAt: h.expiresAt, msLeft: Math.max(0, h.expiresAt - Date.now()),
    berths: h.berths.map(b => ({
      idx: b.idx, coach: b.coach, no: b.no, type: b.type,
      price: b.price, km: b.km, partial: b.partial, gapKm: b.gapKm,
    })),
  };
}

/** Test/demo helper: wipe everything back to the seeded state. */
export function reset() {
  for (const h of holds.values()) clearTimeout(h.timer);
  holds.clear(); bookings.clear(); inventory.clear();
  emit('reset', {});
}

export function stats() {
  return {
    inventories: inventory.size,
    holds: [...holds.values()].filter(h => h.status === 'pending').length,
    bookings: bookings.size,
    listeners: listeners.size,
  };
}
