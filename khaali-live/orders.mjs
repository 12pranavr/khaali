// One order, many trains.
//
// A traveller says what they need - two stations, a date, a window of
// departure times, the classes they would accept and the most they would
// pay - and khaali watches every train that fits and books the first whole
// berth that appears. The money is blocked when the order is placed and
// taken only when a berth is booked, for exactly what that berth cost; the
// rest of the block is released.
//
// Everything here is a pure function over an order object plus a `deps` bag
// the server fills with the store's functions and its clock, so the matching
// can be tested without HTTP, a token or a timer.
//
// An order fills with whole berths only. A stitched seat-hop is a different
// promise, and the traveller did not make it.

import { ST, TRAINS } from './data.mjs';
import { serves, sMin, fare, journeyKm, cancelledOn, trainByNo, journeyMask, isLowerBerth } from './engine.mjs';

export const MAX_OPEN_ORDERS = 2;
export const MAX_PAX = 6;
export const CLASSES = ['SL', '3A', '2A'];

/** Midnight at the start of a calendar day, in the server's own zone. */
export const dayStart = iso => new Date(iso + 'T00:00:00').getTime();

/** What the whole party would pay in one class, fees included. */
export function priceOf(o, cls, deps) {
  const berthSum = fare(cls, journeyKm(o.from, o.to)) * o.pax;
  return berthSum + deps.feesFor(cls, o.pax, berthSum, false);
}

/** Disbelieve the request; return a clean order or a reason. */
export function validate(b, deps) {
  const from = Number(b.from), to = Number(b.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
      || from >= ST.length || to >= ST.length || from === to)
    return { ok: false, error: 'bad stations' };
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad date' };
  const t0 = dayStart(deps.today()), d0 = dayStart(date);
  if (!(d0 >= t0 && d0 <= t0 + 60 * 864e5))
    return { ok: false, error: 'Orders run from today to sixty days ahead.' };
  const after = Number(b.after), before = Number(b.before);
  if (!(Number.isInteger(after) && Number.isInteger(before) && after >= 0 && before <= 1440 && after < before))
    return { ok: false, error: 'bad window' };
  const classes = [...new Set((Array.isArray(b.classes) ? b.classes : []).filter(c => CLASSES.includes(c)))];
  if (!classes.length) return { ok: false, error: 'Pick at least one class.' };
  const pax = Number(b.pax);
  if (!(Number.isInteger(pax) && pax >= 1 && pax <= MAX_PAX)) return { ok: false, error: 'bad pax' };
  if (!TRAINS.some(t => serves(t, from, to)))
    return { ok: false, error: 'No train runs between those stations.' };
  const o = { from, to, date, after, before, classes, pax };
  // a waitlist is an order pinned to one train: its window is that train's
  // departure, its class is the one being waited for
  if (b.train != null && b.train !== '') {
    const t = trainByNo(String(b.train));
    if (!t || !serves(t, from, to)) return { ok: false, error: 'That train does not run between those stations.' };
    const dm = sMin(t, from, 'd');
    if (dm == null) return { ok: false, error: 'That train has no departure from there.' };
    const dep = ((dm % 1440) + 1440) % 1440;
    o.train = t.no; o.after = dep; o.before = dep + 1; o.classes = [classes[0]];
    if (cancelledOn(t.no, date)) return { ok: false, error: 'This train is cancelled on that date.' };
  }
  o.travellers = travellersOf(b.travellers, pax);
  const cheapest = Math.min(...o.classes.map(c => priceOf(o, c, deps)));
  const cap = Number(b.cap);
  if (!(Number.isInteger(cap) && cap >= cheapest))
    return { ok: false, cheapest, error: 'The most you would pay has to cover the cheapest fare, ₹' + cheapest + '.' };
  o.cap = cap; o.cheapest = cheapest;
  return { ok: true, order: o };
}

/**
 * Every train and class this order could fill with, cheapest first and then
 * earliest. Today's trains that have already left are out; so is a run that
 * is cancelled on the date.
 */
export function candidates(o, deps) {
  const now = deps.now();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = o.date === deps.today();
  const out = [];
  for (const t of TRAINS) {
    if (o.train && t.no !== o.train) continue;
    if (!serves(t, o.from, o.to)) continue;
    const dm = sMin(t, o.from, 'd');
    if (dm == null) continue;
    const dep = ((dm % 1440) + 1440) % 1440;
    if (dep < o.after || dep >= o.before) continue;
    if (today && dep <= nowMin) continue;
    if (cancelledOn(t.no, o.date)) continue;
    for (const cls of o.classes) {
      const price = priceOf(o, cls, deps);
      if (price > o.cap) continue;
      out.push({ train: t.no, name: t.name, cls, dep, price });
    }
  }
  return out.sort((a, b) => a.price - b.price || a.dep - b.dep);
}

export const NEEDS = ['senior', 'disabled', 'expecting'];
export function travellersOf(list, paxN) {
  return Array.from({ length: paxN }, (_, k) => {
    const t = (Array.isArray(list) && list[k]) || {};
    return { name: String(t.name || '').slice(0, 60),
      need: NEEDS.includes(t.need) ? t.need : null,
      pref: t.pref === 'lower' ? 'lower' : null };
  });
}

const overlaps = (a, b) => (journeyMask(a.from, a.to) & journeyMask(b.from, b.to)) !== 0;

/**
 * Where an order stands. `position` counts the approved, still-open orders
 * pinned to the same train, date and class whose journey overlaps and which
 * were approved earlier: one more than that is the waitlist number, and it
 * is the number the matcher itself honours. `flexAhead` is the honest
 * footnote: older flexible orders that could also take this train.
 */
export function queueOf(o, all, deps) {
  const at = o.openedAt == null ? Infinity : o.openedAt;
  let position = 1, flexAhead = 0;
  for (const x of all) {
    if (!x || x.id === o.id || x.status !== 'open' || x.date !== o.date || !overlaps(x, o)) continue;
    if ((x.openedAt == null ? Infinity : x.openedAt) >= at) continue;
    if (o.train && x.train === o.train && x.classes.includes(o.classes[0])) position++;
    else if (o.train && !x.train && candidates(x, deps).some(c => c.train === o.train && c.cls === o.classes[0])) flexAhead++;
  }
  return { position, flexAhead };
}

/** The window has closed: the last train the order could take has left. */
export function expired(o, deps) {
  return deps.now().getTime() >= dayStart(o.date) + o.before * 60000;
}

/**
 * Book the first candidate with a whole berth for everyone in the party.
 * Before charting that is an any-berth booking; after it, the free berths
 * themselves. The hold is placed outside the traveller's own hold cap so an
 * order filling never knocks out a checkout they are in the middle of.
 */
export function tryFill(o, deps) {
  if (o.status !== 'open') return { ok: false, reason: o.status };
  for (const c of candidates(o, deps)) {
    const counts = deps.countsFor(c.train, o.date, c.cls, o.from, o.to);
    if (counts.anySeats < o.pax) continue;
    const base = { train: c.train, date: o.date, cls: c.cls, from: o.from, to: o.to, pax: o.pax, who: o.who, cap: false,
      travellers: o.travellers || [] };
    let h;
    if (counts.charted) {
      // after the chart the free berths are what they are: lower ones go to
      // the travellers who need them first
      const av = deps.availability(c.train, o.date, c.cls, o.from, o.to);
      const free = av.berths.filter(b => b.k === 'free');
      const needN = (o.travellers || []).filter(t => t.need).length;
      const lowers = free.filter(isLowerBerth), others = free.filter(b => !isLowerBerth(b));
      const idx = lowers.slice(0, needN).concat(others, lowers.slice(needN)).slice(0, o.pax).map(b => b.idx);
      if (idx.length < o.pax) continue;
      h = deps.hold({ ...base, berthIdxs: idx, mode: 'exact' });
    } else {
      h = deps.hold({ ...base, mode: 'any' });
    }
    if (!h.ok) continue;
    if (h.hold.amount > o.cap) { deps.release(h.hold.id, 'over-cap'); continue; }
    const r = deps.confirm(h.hold.id);
    if (!r.ok) { deps.release(h.hold.id, 'order-failed'); continue; }
    o.status = 'filled';
    o.filledAt = deps.now().getTime();
    o.pnr = r.booking.pnr;
    o.paid = r.booking.amount;
    o.fill = { train: c.train, name: c.name, cls: c.cls, dep: c.dep };
    return { ok: true, booking: r.booking, pick: c };
  }
  return { ok: false, reason: 'nothing-yet' };
}
