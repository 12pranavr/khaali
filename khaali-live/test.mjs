// Locking, payment and expiry tests. Run: node test.mjs
import assert from 'assert';
import * as S from './store.mjs';
import { journeyMask, seedOccupancy, berthState, packPlan, serves, journeyKm, stationByCode, liveOf, stopIdxs, sMin, oddsOf2, packInto, SEGMENTS, berthLayout } from './engine.mjs';
import { TRAINS, ST } from './data.mjs';
import * as sentinel from './sentinel.mjs';
import * as limits from './limits.mjs';
import * as activity from './activity.mjs';
import * as journal from './journal.mjs';
import * as tatkal from './tatkal.mjs';
import * as orders from './orders.mjs';
import * as dl from './digilocker.mjs';
import * as sos from './sos.mjs';
import * as CAP from './capacity.mjs';
import * as AL from './allocate.mjs';
import * as IN from './intel.mjs';
import * as SIM from './sim.mjs';
import * as JY from './journey.mjs';
import * as M from './metro.mjs';
import * as BM from './bmtc.mjs';
import * as HR from './hire.mjs';
import * as RD from './road.mjs';
import * as TR from './traffic.mjs';
import os from 'os';
import path from 'path';
import fs from 'fs';

const D = '2026-08-21';
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

console.log('\nrouting vs corridor_all_pairs.xlsx');
const truth = JSON.parse(fs.readFileSync(new URL('./_truth.json', import.meta.url), 'utf8'));
t('157 served pairs match train lists and km', () => {
  for (const [pair, exp] of Object.entries(truth.served)) {
    const [a, b] = pair.split('>');
    const i = stationByCode(a), j = stationByCode(b);
    const got = TRAINS.filter(x => x.core && serves(x, i, j)).map(x => x.no).sort();
    assert.deepStrictEqual(got, exp.trains, pair);
    assert.strictEqual(journeyKm(i, j), exp.km, pair + ' km');
  }
});
t('25 no-service pairs really have no train', () => {
  for (const pair of truth.none) {
    const [a, b] = pair.split('>');
    const i = stationByCode(a), j = stationByCode(b);
    assert.strictEqual(TRAINS.filter(x => x.core && serves(x, i, j)).length, 0, pair);
  }
});

console.log('\ninterval maths');
t('no overlap is free', () => {
  assert.strictEqual(berthState(journeyMask(0, 5), 11, 13).k, 'free');
  assert.strictEqual(berthState(journeyMask(8, 13), 0, 4).k, 'free');
});
t('covering the whole journey is taken', () => {
  assert.strictEqual(berthState(journeyMask(0, 13), 5, 11).k, 'taken');
});
t('partial reports the handover station, per direction', () => {
  const up = berthState(journeyMask(0, 11), 5, 13);
  assert.strictEqual(up.k, 'part'); assert.strictEqual(up.mode, 'from'); assert.strictEqual(up.at, 11);
  const dn = berthState(journeyMask(0, 11), 13, 5);
  assert.strictEqual(dn.k, 'part'); assert.strictEqual(dn.mode, 'until'); assert.strictEqual(dn.at, 11);
});
t('packing is optimal on every train and class', () => {
  for (const tr of TRAINS) for (const c of ['SL', '3A', '2A']) {
    const p = packPlan(seedOccupancy(c, tr.no, 0));
    assert.strictEqual(p.used, p.peak, `${tr.no}/${c} used ${p.used} peak ${p.peak}`);
    assert.ok(p.freed >= 0);
  }
});

console.log('\nlocking');
S.reset();
const base = S.availability('16021', D, 'SL', 5, 13);
const freeIdx = base.berths.filter(b => b.k === 'free').map(b => b.idx);

t('two phones cannot hold the same berths', () => {
  const pick = freeIdx.slice(0, 2);
  const a = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 2, who: 'A' });
  assert.ok(a.ok, 'first hold should win');
  const b = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 2, who: 'B' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, 'taken');
  assert.strictEqual(b.conflicts[0].why, 'held');
  S.release(a.hold.id);
});

t('a held berth shows as locked to everyone else', () => {
  const pick = [freeIdx[3]];
  const a = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 1, who: 'A' });
  const view = S.availability('16021', D, 'SL', 5, 13);
  assert.strictEqual(view.berths.find(b => b.idx === pick[0]).k, 'locked');
  assert.strictEqual(view.counts.locked, 1);
  S.release(a.hold.id);
  assert.strictEqual(S.availability('16021', D, 'SL', 5, 13).counts.locked, 0);
});

t('all-or-nothing: one bad berth rejects the whole hold', () => {
  const pick = [freeIdx[4]];
  const a = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 1, who: 'A' });
  const b = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: [freeIdx[5], freeIdx[4]], pax: 2, who: 'B' });
  assert.strictEqual(b.ok, false);
  // the innocent berth must NOT have been locked by the failed attempt
  assert.strictEqual(S.availability('16021', D, 'SL', 5, 13).berths.find(x => x.idx === freeIdx[5]).k, 'free');
  S.release(a.hold.id);
});

t('a different journey on the same berth is allowed when legs do not overlap', () => {
  // find a berth booked only on the far half, so the near half is genuinely free
  const av = S.availability('16021', D, 'SL', 0, 4);
  const cand = av.berths.find(b => b.k === 'free' && S.availability('16021', D, 'SL', 11, 13).berths.find(x => x.idx === b.idx).k === 'free');
  const a = S.hold({ train: '16021', date: D, cls: 'SL', from: 0, to: 4, berthIdxs: [cand.idx], pax: 1, who: 'A' });
  assert.ok(a.ok, 'near leg');
  const b = S.hold({ train: '16021', date: D, cls: 'SL', from: 11, to: 13, berthIdxs: [cand.idx], pax: 1, who: 'B' });
  assert.ok(b.ok, 'far leg on the same berth should also be allowed');
  S.release(a.hold.id); S.release(b.hold.id);
});

console.log('\npayment');
t('confirming a hold books it and frees the lock', () => {
  const pick = [freeIdx[8], freeIdx[9]];
  const a = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 2, who: 'A' });
  const r = S.confirm(a.hold.id);
  assert.ok(r.ok);
  assert.ok(/^\d{10}$/.test(r.booking.pnr), 'pnr');
  assert.strictEqual(r.booking.amount, a.hold.amount);
  const view = S.availability('16021', D, 'SL', 5, 13);
  assert.strictEqual(view.berths.find(b => b.idx === pick[0]).k, 'taken');
  assert.strictEqual(view.counts.locked, 0);
});
t('paying twice does not double-book', () => {
  const pick = [freeIdx[12]];
  const a = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 1, who: 'A' });
  const r1 = S.confirm(a.hold.id);
  const r2 = S.confirm(a.hold.id);
  assert.ok(r1.ok && r2.ok);
  assert.strictEqual(r2.replay, true);
  assert.strictEqual(r1.booking.pnr, r2.booking.pnr);
  assert.strictEqual(S.allBookings().filter(b => b.pnr === r1.booking.pnr).length, 1);
});
t('a released hold cannot be paid', () => {
  const a = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: [freeIdx[14]], pax: 1, who: 'A' });
  S.release(a.hold.id);
  assert.strictEqual(S.confirm(a.hold.id).ok, false);
});
t('after release the berth is bookable by someone else', () => {
  const pick = [freeIdx[16]];
  const a = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 1, who: 'A' });
  S.release(a.hold.id);
  const b = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 1, who: 'B' });
  assert.ok(b.ok);
  S.release(b.hold.id);
});

console.log('\nrace: 50 phones, 1 berth');
t('exactly one wins', () => {
  const pick = [freeIdx[20]];
  let won = 0;
  const results = [];
  for (let i = 0; i < 50; i++) {
    const r = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: pick, pax: 1, who: 'p' + i });
    results.push(r);
    if (r.ok) won++;
  }
  assert.strictEqual(won, 1, `${won} winners`);
  results.filter(r => r.ok).forEach(r => S.release(r.hold.id));
});

t('50 phones each grabbing a different berth all succeed', () => {
  const now = S.availability('16021', D, 'SL', 5, 13).berths.filter(b => b.k === 'free' && b.type !== 'LB').map(b => b.idx);
  const picks = now.slice(30, 80);
  const ok = picks.map(i => S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: [i], pax: 1, who: 'x' + i }));
  const refused = ok.filter(r => !r.ok).map(r => r.reason);
  assert.strictEqual(ok.filter(r => r.ok).length, picks.length, 'refused: ' + JSON.stringify(refused));
  const view = S.availability('16021', D, 'SL', 5, 13);
  assert.strictEqual(view.counts.locked, picks.length);
  ok.forEach(r => S.release(r.hold.id));
});

t('inventory is conserved: free+part+taken+locked always equals the coach count', () => {
  for (const c of ['SL', '3A', '2A']) for (const [f, t2] of [[5, 13], [13, 5], [0, 13], [11, 13]]) {
    const v = S.availability('16021', D, c, f, t2);
    const sum = v.counts.free + v.counts.part + v.counts.taken + v.counts.locked;
    assert.strictEqual(sum, v.berths.length, `${c} ${f}->${t2}`);
  }
});

console.log('\npricing');
t('a partial berth always costs less than a free-the-whole-way one', () => {
  for (const c of ['SL', '3A', '2A']) for (const [f, to2] of [[5, 13], [0, 13], [13, 5], [11, 13]]) {
    const v = S.availability('16021', D, c, f, to2);
    const full = v.price;
    for (const b of v.berths) {
      if (b.k === 'free') assert.strictEqual(b.price, full, `${c} ${f}->${to2} free berth`);
      if (b.k === 'part') assert.ok(b.price < full && b.price > 0,
        `${c} ${f}->${to2}: partial ₹${b.price} vs full ₹${full}`);
      if (b.k === 'taken') assert.strictEqual(b.price, null);
    }
  }
});
t('partial price tracks the distance actually covered', () => {
  const v = S.availability('16021', D, 'SL', 5, 13);
  const parts = v.berths.filter(b => b.k === 'part');
  assert.ok(parts.length, 'expected some partial berths');
  for (const b of parts) {
    assert.ok(b.km > 0 && b.km < v.km, `covered ${b.km} of ${v.km}`);
    const expected = Math.max(5, Math.round((v.price * b.km) / v.km / 5) * 5);
    assert.strictEqual(b.price, expected);
  }
  // more distance covered => higher price
  const sorted = [...parts].sort((a, b) => a.km - b.km);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].price >= sorted[i - 1].price);
});
t('a hold charges the sum of its berths, not a flat fare', () => {
  const v = S.availability('16021', D, 'SL', 5, 13);
  const cheap = v.berths.find(b => b.k === 'part');
  const full = v.berths.find(b => b.k === 'free');
  const h = S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13,
    berthIdxs: [cheap.idx, full.idx], pax: 2, who: 'A' });
  assert.ok(h.ok);
  assert.strictEqual(h.hold.berthSum, cheap.price + full.price);
  assert.strictEqual(h.hold.amount, h.hold.berthSum + h.hold.fees, 'total is berths plus server fees');
  assert.ok(h.hold.amount < h.hold.fullPrice, 'mixed basket beats two full fares');
  const p = h.hold.berths.find(b => b.idx === cheap.idx);
  assert.strictEqual(p.partial, true);
  assert.strictEqual(p.gapKm, v.km - cheap.km);
  S.release(h.hold.id);
});

console.log('\nlive simulation');
t('every train reports a valid state and position', () => {
  for (const tr of TRAINS) {
    const lv = liveOf(tr);
    assert.ok(['run', 'idle'].includes(lv.state), tr.no);
    if (lv.state === 'run') {
      assert.ok(lv.prog >= 0 && lv.prog <= 1, `${tr.no} prog ${lv.prog}`);
      assert.ok(lv.at != null && lv.next != null, tr.no);
    }
  }
});
t('position advances as the clock advances', () => {
  const tr = TRAINS[0];
  const idxs = stopIdxs(tr);
  const base = sMin(tr, idxs[0], 'd');
  const mk = mins => new Date(2026, 7, 21, Math.floor(mins / 60) % 24, mins % 60, 0);
  const a = liveOf(tr, mk(base + 20)), b = liveOf(tr, mk(base + 60));
  assert.strictEqual(a.state, 'run'); assert.strictEqual(b.state, 'run');
  assert.ok(b.prog > a.prog, `prog ${a.prog} -> ${b.prog}`);
});
t('a train is idle outside its running window', () => {
  const tr = TRAINS[0];
  const idxs = stopIdxs(tr);
  const base = sMin(tr, idxs[0], 'd');
  const before = new Date(2026, 7, 21, Math.floor(((base - 90 + 1440) % 1440) / 60), 0, 0);
  assert.strictEqual(liveOf(tr, before).state, 'idle');
});

console.log('\nexpiry');
const av2 = S.availability('16022', D, 'SL', 13, 11);
const pick2 = [av2.berths.find(b => b.k === 'free').idx];
const held = S.hold({ train: '16022', date: D, cls: 'SL', from: 13, to: 11, berthIdxs: pick2, pax: 1, who: 'A' });
t('hold reports a 5 minute window', () => {
  assert.ok(held.hold.msLeft > 4.9 * 60000 && held.hold.msLeft <= 5 * 60000, held.hold.msLeft + 'ms');
});
t('expired holds release automatically', () => {
  // simulate the timer firing
  S.release(held.hold.id, 'expired');
  assert.strictEqual(S.getHold(held.hold.id).status, 'expired');
  assert.strictEqual(S.availability('16022', D, 'SL', 13, 11).berths.find(b => b.idx === pick2[0]).k, 'free');
});


console.log('\nsentinel: behavioural scoring');
const BOTSIG = { atMs: 12, tries: 190, accounts: 34, payReuse: true, actions: 0,
  gaps: [14, 15, 14, 16, 14, 15] };
const HUMANSIG = { atMs: 18400, tries: 1, accounts: 1, payReuse: false, actions: 7,
  gaps: [2300, 8100, 1400, 9600] };

t('a farm scores high and a person scores low', () => {
  const b = sentinel.score(BOTSIG), h = sentinel.score(HUMANSIG);
  assert.ok(b.p > 0.85, 'farm scored ' + b.p);
  assert.ok(h.p < 0.15, 'person scored ' + h.p);
});

t('the score is reproducible by hand from the published weights', () => {
  const r = sentinel.score(BOTSIG);
  const z = r.parts.reduce((a, p) => a + p.add, sentinel.MODEL.bias);
  const p = 1 / (1 + Math.exp(-z));
  assert.ok(Math.abs(p - r.p) < 0.002, 'recomputed ' + p + ' vs reported ' + r.p);
});

t('no entrant is ever reduced below one entry', () => {
  const worst = sentinel.score({ atMs: 0, tries: 99999, accounts: 500,
    payReuse: true, actions: 0, gaps: [10, 10, 10, 10] });
  assert.ok(worst.chits >= 1, 'chits ' + worst.chits);
  assert.ok(worst.chits < sentinel.MODEL.chits.clear, 'a farm kept full weight');
});

t('a clear entry keeps its full weight', () => {
  assert.strictEqual(sentinel.score(HUMANSIG).chits, sentinel.MODEL.chits.clear);
});

t('too few gaps leaves cadence neutral rather than guessing', () => {
  const f = sentinel.features({ atMs: 9000, tries: 1, gaps: [500, 500] });
  assert.strictEqual(f.cadence, 0);
});

t('every feature stays inside 0..1', () => {
  for (const sig of [BOTSIG, HUMANSIG, {}, { atMs: -5, tries: 0, accounts: 0 }]) {
    const f = sentinel.features(sig);
    for (const k of Object.keys(f)) {
      assert.ok(f[k] >= 0 && f[k] <= 1, k + ' = ' + f[k]);
    }
  }
});

t('a slow, browsing, single-request entry cannot be flagged', () => {
  const r = sentinel.score({ atMs: 30000, tries: 1, accounts: 1,
    payReuse: false, actions: 10, gaps: [3000, 9000, 1200, 7000] });
  assert.strictEqual(r.band, 'clear');
});

t('people and farms go through the same function', () => {
  const rows = sentinel.scoreRound([
    { id: 'A', kind: 'bot', signals: BOTSIG },
    { id: 'me', kind: 'real', name: 'Pranav', signals: HUMANSIG },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].band, 'challenge');
  assert.strictEqual(rows[1].band, 'clear');
  assert.ok(rows[1].why[0].indexOf('nothing') >= 0, rows[1].why[0]);
});



console.log('\ncaps: what one request may lock');
const capDate = '2026-09-20';
t('more than six berths in one hold is rejected', () => {
  const v = S.availability('16021', capDate, 'SL', 5, 6);
  const free = v.berths.filter(b => b.k === 'free').map(b => b.idx);
  assert.ok(free.length >= 7, 'need seven free berths for this test, got ' + free.length);
  const r = S.hold({ train: '16021', date: capDate, cls: 'SL', from: 5, to: 6,
    berthIdxs: free.slice(0, 7), pax: 7, who: 'cap-1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too-many-berths');
  assert.strictEqual(S.availability('16021', capDate, 'SL', 5, 6).counts.locked, 0, 'nothing was locked');
});

t('a hop cannot carry more than two berths per traveller', () => {
  const v = S.availability('16021', capDate, 'SL', 5, 6);
  const free = v.berths.filter(b => b.k === 'free').map(b => b.idx).slice(0, 3);
  const r = S.hold({ train: '16021', date: capDate, cls: 'SL', from: 5, to: 6,
    berthIdxs: free, pax: 1, segs: free.map(() => ({ from: 5, to: 6 })), hop: true, who: 'cap-2' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too-many-berths');
});

t('duplicate berth indexes are rejected', () => {
  const v = S.availability('16021', capDate, 'SL', 5, 6);
  const one = v.berths.find(b => b.k === 'free').idx;
  const r = S.hold({ train: '16021', date: capDate, cls: 'SL', from: 5, to: 6,
    berthIdxs: [one, one], pax: 2, who: 'cap-3' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'duplicate-berth');
});

t('fees come from the server, never from the request', () => {
  const v = S.availability('16021', capDate, 'SL', 5, 6);
  const one = v.berths.find(b => b.k === 'free').idx;
  const r = S.hold({ train: '16021', date: capDate, cls: 'SL', from: 5, to: 6,
    berthIdxs: [one], pax: 1, who: 'cap-4', fees: 1999 });
  assert.ok(r.ok);
  assert.strictEqual(r.hold.fees, S.feesFor('SL', 1, r.hold.berthSum, true), 'a picked berth is a chosen berth');
  assert.notStrictEqual(r.hold.fees, 1999);
  assert.strictEqual(r.hold.amount, r.hold.berthSum + r.hold.fees);
  S.release(r.hold.id);
});

t('AC fares carry superfast and GST, sleeper does not', () => {
  assert.strictEqual(S.feesFor('SL', 2, 1000), 20 * 2 + 12);
  assert.strictEqual(S.feesFor('3A', 2, 1000), 20 * 2 + 15 * 2 + 50 + 12);
});

t('a third hold supersedes the oldest, so a refresh never locks you out', () => {
  const v = S.availability('16021', capDate, 'SL', 5, 6);
  const free = v.berths.filter(b => b.k === 'free').map(b => b.idx);
  const mk = i => S.hold({ train: '16021', date: capDate, cls: 'SL', from: 5, to: 6,
    berthIdxs: [free[i]], pax: 1, who: 'cap-5' });
  const a = mk(0), b = mk(1), c = mk(2);
  assert.ok(a.ok && b.ok && c.ok, 'all three go ahead');
  assert.strictEqual(S.getHold(a.hold.id).status, 'superseded', 'the oldest gave way');
  assert.strictEqual(S.getHold(b.hold.id).status, 'pending');
  assert.strictEqual(S.pendingHoldsFor('cap-5'), 2, 'still at most two');
  assert.strictEqual(S.availability('16021', capDate, 'SL', 5, 6).berths.find(x => x.idx === free[0]).k, 'free', 'its berth is back on the board');
  S.release(b.hold.id); S.release(c.hold.id);
});



console.log('\nrate limits: the routes that cost money');
t('the twenty-first call in a minute is refused', () => {
  limits.reset();
  let last;
  for (let i = 0; i < 20; i++) last = limits.hit('ip|/api/tts', 20, 60000, 1000);
  assert.ok(last.ok, 'twenty are allowed');
  const r = limits.hit('ip|/api/tts', 20, 60000, 1000);
  assert.strictEqual(r.ok, false);
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60, 'retryAfter ' + r.retryAfter);
});

t('the window resets and callers are independent', () => {
  limits.reset();
  for (let i = 0; i < 21; i++) limits.hit('a|/api/chat', 20, 60000, 1000);
  assert.strictEqual(limits.hit('a|/api/chat', 20, 60000, 1000).ok, false);
  assert.strictEqual(limits.hit('b|/api/chat', 20, 60000, 1000).ok, true, 'another caller is unaffected');
  assert.strictEqual(limits.hit('a|/api/chat', 20, 60000, 1000 + 60001).ok, true, 'a minute later, allowed again');
});

t('a proxied caller is identified by x-forwarded-for', () => {
  assert.strictEqual(limits.callerOf({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: {} }), '1.2.3.4');
  assert.strictEqual(limits.callerOf({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
});



console.log('\nsentinel: signals the server saw, not signals the browser claimed');
t('a caller who never looked at a train is shallow', () => {
  activity.reset();
  const sig = activity.signalsFor('ip-blank', 1000);
  assert.deepStrictEqual(sig, { actions: 0, gaps: [] });
  assert.strictEqual(sentinel.features({ ...sig, atMs: 20, tries: 30 }).shallow, 1);
});

t('a caller who browsed shows up with real gaps', () => {
  activity.reset();
  const hits = [0, 2300, 10400, 11800, 21400];
  hits.forEach(ms => activity.note('ip-human', '/api/search', 100000 + ms));
  const sig = activity.signalsFor('ip-human', 100000 + 30000);
  assert.strictEqual(sig.actions, 5);
  assert.deepStrictEqual(sig.gaps, [2300, 8100, 1400, 9600]);
  const f = sentinel.features({ ...sig, atMs: 18400, tries: 1, accounts: 1 });
  assert.strictEqual(f.shallow, 0);
  assert.ok(f.cadence < 0.5, 'irregular taps are not machine cadence');
});

t('polling does not count as looking', () => {
  activity.reset();
  activity.note('ip-poll', '/api/tatkal/state', 1);
  activity.note('ip-poll', '/api/sim', 2);
  activity.note('ip-poll', '/api/events', 3);
  assert.strictEqual(activity.signalsFor('ip-poll', 10).actions, 0);
});

t('accounts is the identities actually seen behind one caller', () => {
  activity.reset();
  ['a@x', 'b@x', 'c@x', 'a@x'].forEach(e => activity.identity('ip-farm', e, 5000));
  assert.strictEqual(activity.accountsFor('ip-farm', 6000), 3);
  assert.strictEqual(activity.accountsFor('ip-nobody', 6000), 0);
});

t('the log forgets after half an hour', () => {
  activity.reset();
  activity.note('ip-old', '/api/search', 0);
  activity.identity('ip-old', 'z@x', 0);
  assert.strictEqual(activity.signalsFor('ip-old', 31 * 60 * 1000).actions, 0);
  assert.strictEqual(activity.accountsFor('ip-old', 31 * 60 * 1000), 0);
});

t('an unobserved payReuse is labelled, not counted as innocent', () => {
  const r = sentinel.score({ atMs: 15000, tries: 1, accounts: 1, payReuse: null, actions: 6,
    gaps: [2000, 7000, 1500, 9000] });
  const pr = r.parts.find(p => p.k === 'payReuse');
  assert.strictEqual(pr.observed, false);
  assert.strictEqual(pr.add, 0);
  assert.strictEqual(r.parts.filter(p => p.observed).length, 5);
  assert.strictEqual(r.band, 'clear');
});

t('measured end to end: a browsing person clears, a silent burst is challenged', () => {
  activity.reset();
  [0, 3100, 9000, 15500].forEach(ms => activity.note('ip-p', 'page', 1000 + ms));
  activity.identity('ip-p', 'p@x', 20000);
  const person = sentinel.score({ ...activity.signalsFor('ip-p', 20000), atMs: 19000, tries: 1,
    accounts: activity.accountsFor('ip-p', 20000), payReuse: null });
  ['f1@x', 'f2@x', 'f3@x', 'f4@x', 'f5@x', 'f6@x'].forEach(e => activity.identity('ip-b', e, 20000));
  // the farm never looked at a train; it hit the entry route 190 times, 15 ms apart
  for (let i = 0; i < 190; i++) activity.note('ip-b', '/api/tatkal/paysession', 17000 + i * 15);
  assert.strictEqual(activity.signalsFor('ip-b', 20000).actions, 0, 'entry attempts are not looking');
  const bot = sentinel.score({ ...activity.signalsFor('ip-b', 20000), atMs: 12, tries: 190,
    accounts: activity.accountsFor('ip-b', 20000), payReuse: null });
  assert.strictEqual(person.band, 'clear', 'person ' + person.p);
  assert.strictEqual(bot.band, 'challenge', 'bot ' + bot.p);
});



console.log('\npersistence: memory decides, the journal remembers');
const jDate = '2026-09-25';
t('a confirmed booking is recorded with its exact leg masks', () => {
  const recs = [];
  S.onRecord(r => recs.push(r));
  const v = S.availability('16021', jDate, 'SL', 5, 6);
  const b = v.berths.find(x => x.k === 'free');
  const h = S.hold({ train: '16021', date: jDate, cls: 'SL', from: 5, to: 6, berthIdxs: [b.idx], pax: 1, who: 'j-1' });
  const c = S.confirm(h.hold.id);
  assert.ok(c.ok);
  const r = recs.find(x => x.t === 'booked' && x.pnr === c.booking.pnr);
  assert.ok(r, 'recorded');
  assert.strictEqual(r.grants.length, 1);
  assert.strictEqual(r.grants[0].idx, b.idx);
  assert.strictEqual(r.grants[0].mask, journeyMask(5, 6));
  S.onRecord(null);
});

t('replay puts the booking and its berth back after a wipe', () => {
  const recs = [];
  S.onRecord(r => recs.push(r));
  const v = S.availability('16022', jDate, '3A', 13, 5);
  const b = v.berths.find(x => x.k === 'free');
  const h = S.hold({ train: '16022', date: jDate, cls: '3A', from: 13, to: 5, berthIdxs: [b.idx], pax: 1, who: 'j-2' });
  const pnr = S.confirm(h.hold.id).booking.pnr;
  S.onRecord(null);
  S.reset();                                             // everything gone
  assert.strictEqual(S.getBooking(pnr), null);
  assert.strictEqual(S.availability('16022', jDate, '3A', 13, 5).berths.find(x => x.idx === b.idx).k, 'free');
  const got = S.replay(recs.filter(x => x.t === 'booked'));
  assert.strictEqual(got.booked, 1);
  assert.ok(S.getBooking(pnr), 'booking is back');
  assert.strictEqual(S.getBooking(pnr).train, '16022');
  assert.strictEqual(S.availability('16022', jDate, '3A', 13, 5).berths.find(x => x.idx === b.idx).k, 'taken', 'berth is taken again');
});

t('a reset record on replay forgets what came before it', () => {
  const v = S.availability('16021', jDate, 'SL', 0, 5);
  const b = v.berths.find(x => x.k === 'free');
  const before = { t: 'booked', pnr: '4500000001', key: '16021|' + jDate + '|SL', train: '16021', date: jDate,
    cls: 'SL', from: 0, to: 5, pax: 1, amount: 100, who: 'old', berths: ['S1/1'], grants: [{ idx: b.idx, mask: journeyMask(0, 5) }] };
  const got = S.replay([before, { t: 'reset' }]);
  assert.strictEqual(got.resets, 1);
  assert.strictEqual(S.getBooking('4500000001'), null);
});

t('replay is silent: no events fire for things that already happened', () => {
  let fired = 0;
  const off = S.subscribe(() => fired++);
  S.replay([{ t: 'booked', pnr: '4500000002', key: '16021|' + jDate + '|SL', train: '16021', date: jDate,
    cls: 'SL', from: 5, to: 6, pax: 1, amount: 50, who: 'q', berths: ['S1/2'], grants: [{ idx: 1, mask: journeyMask(5, 6) }] }]);
  off();
  assert.strictEqual(fired, 0);
});

t('the journal file round-trips, and a torn last line is skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khaali-j-'));
  const file = journal.open(dir);
  assert.ok(journal.append({ t: 'booked', pnr: '1' }));
  assert.ok(journal.append({ t: 'tkwin', who: 'a@x', month: '2026-09' }));
  fs.appendFileSync(file, '{"t":"booked","pnr":"torn');            // crash mid-write
  const all = journal.readAll();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].pnr, '1');
  assert.ok(all[1].at > 0, 'stamped');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('the odds move with the clock they are given', () => {
  const far = oddsOf2('16021', '2026-10-15', 'SL', { from: 5, to: 13, now: new Date('2026-09-01T12:00:00+05:30') });
  const near = oddsOf2('16021', '2026-10-15', 'SL', { from: 5, to: 13, now: new Date('2026-10-14T12:00:00+05:30') });
  assert.strictEqual(far.days, 44);
  assert.strictEqual(near.days, 1);
  assert.ok(far.expCancel > near.expCancel, 'more churn with more lead time');
});



console.log('\nfair tatkal: the round, without HTTP');
const tkDate = tatkal.tkIso(new Date('2026-09-10T12:00:00+05:30').getTime());
t('a round is deterministic from who opened it, its number and its date', () => {
  const a = tatkal.newRound('p@x', 1, tkDate, 0), b = tatkal.newRound('p@x', 1, tkDate, 0);
  assert.strictEqual(a.seed, b.seed);
  assert.strictEqual(a.sim.humans, b.sim.humans);
  assert.notStrictEqual(tatkal.newRound('q@x', 1, tkDate, 0).seed, a.seed, 'another person gets another round');
  assert.strictEqual(a.sim.agents.length, 3);
  assert.ok(a.sim.humans >= 120 && a.sim.humans < 150);
});

t('one entry per identity, and only while the window is open', () => {
  const R = tatkal.newRound('p@x', 1, tkDate, 0);
  assert.ok(tatkal.enter(R, { who: 'a@x', name: 'A' }).ok);
  assert.strictEqual(tatkal.enter(R, { who: 'a@x', name: 'A again' }).reason, 'duplicate');
  assert.ok(tatkal.enter(R, { who: 'b@x', name: 'B' }).ok);
  assert.strictEqual(R.real.length, 2);
  R.state = 'done';
  assert.strictEqual(tatkal.enter(R, { who: 'c@x', name: 'C' }).reason, 'closed');
});

t('allotment weights the farms down and never below one', () => {
  const R = tatkal.newRound('p@x', 2, tkDate, 0);
  const av = S.availability(tatkal.TKN, tkDate, tatkal.TKC, tatkal.TKF, tatkal.TKT);
  const out = tatkal.allot(R, av);
  assert.ok(out.ok);
  assert.strictEqual(R.state, 'done');
  const sn = R.result.sentinel;
  assert.strictEqual(sn.capChits, 12);
  assert.strictEqual(sn.botChits, 3, 'three farms, one chit each');
  assert.strictEqual(sn.stripped, 9);
  assert.strictEqual(sn.flagged, 3);
  assert.strictEqual(sn.cleared, R.sim.humans, 'every simulated traveller clears');
  assert.strictEqual(R.result.chits, R.sim.humans + 3);
  assert.strictEqual(R.result.winners.bots + R.result.winners.humans, Math.min(tatkal.TKB, R.result.chits));
  assert.strictEqual(tatkal.allot(R, av).reason, 'closed', 'cannot allot twice');
});

t('the same seed allots the same winners, so anyone can replay it', () => {
  const av = S.availability(tatkal.TKN, tkDate, tatkal.TKC, tatkal.TKF, tatkal.TKT);
  const a = tatkal.newRound('p@x', 3, tkDate, 0), b = tatkal.newRound('p@x', 3, tkDate, 0);
  const wa = tatkal.allot(a, av).winners.map(w => w.kind + ':' + w.id);
  const wb = tatkal.allot(b, av).winners.map(w => w.kind + ':' + w.id);
  assert.deepStrictEqual(wa, wb);
});

t('a real winner is pointed at a berth that is genuinely free', () => {
  // enough real entrants that at least one lands in the first forty
  const av = S.availability(tatkal.TKN, tkDate, tatkal.TKC, tatkal.TKF, tatkal.TKT);
  let R, out, tries = 0;
  do {
    R = tatkal.newRound('p@x', 10 + tries, tkDate, 0);
    for (let i = 0; i < 60; i++) tatkal.enter(R, { who: 'r' + i + '@x', name: 'R' + i, signals: { atMs: 9000, tries: 1, actions: 5, gaps: [2000, 6000, 1500] } });
    out = tatkal.allot(R, av);
  } while (!out.realWinners.length && ++tries < 5);
  assert.ok(out.realWinners.length, 'someone real won');
  const usable = new Set(av.berths.filter(b => b.k === 'free' || (b.k === 'part' && b.price != null)).map(b => b.idx));
  for (const w of out.realWinners) assert.ok(usable.has(w.berthIdx), 'winner ' + w.id + ' got berth ' + w.berthIdx);
  const idxs = out.realWinners.map(w => w.berthIdx);
  assert.strictEqual(new Set(idxs).size, idxs.length, 'no two winners share a berth');
});

console.log('\nseat hop: two half-empty berths, one ticket');
t('two partial berths chain into one hold, each priced for its own stretch', () => {
  const hd = '2026-09-22';
  // a berth free on the near half and a different berth free on the far half
  const near = S.availability('16021', hd, 'SL', 5, 9), far = S.availability('16021', hd, 'SL', 9, 13);
  const a = near.berths.find(b => b.k === 'free');
  const b = far.berths.find(x => x.k === 'free' && x.idx !== a.idx);
  assert.ok(a && b, 'a near berth and a far berth');
  const h = S.hold({ train: '16021', date: hd, cls: 'SL', from: 5, to: 13, berthIdxs: [a.idx, b.idx], pax: 1,
    segs: [{ from: 5, to: 9 }, { from: 9, to: 13 }], hop: true, who: 'hop-1' });
  assert.ok(h.ok, h.reason);
  assert.strictEqual(h.hold.hop, true);
  assert.strictEqual(h.hold.berths.length, 2);
  const [ba, bb] = h.hold.berths;
  assert.strictEqual(ba.segFrom, 5); assert.strictEqual(ba.segTo, 9);
  assert.strictEqual(bb.segFrom, 9); assert.strictEqual(bb.segTo, 13);
  assert.ok(ba.partial && bb.partial, 'each covers part of the journey');
  assert.strictEqual(ba.km + bb.km, journeyKm(5, 13), 'together they cover the whole trip');
  // a hop is priced by the kilometres ridden, so the two halves together cost
  // what one through berth costs (within rounding to five rupees), and each
  // half on its own is cheaper than a full-way berth
  const through = h.hold.fullPrice - h.hold.fees;
  assert.ok(Math.abs(h.hold.berthSum - through) <= 10, 'halves ' + h.hold.berthSum + ' vs through ' + through);
  assert.ok(ba.price < through && bb.price < through, 'each half is cheaper than a through berth');
  // both locked, exactly on their stretches
  const v = S.availability('16021', hd, 'SL', 5, 13);
  assert.strictEqual(v.berths.find(x => x.idx === a.idx).k, 'locked');
  assert.strictEqual(v.berths.find(x => x.idx === b.idx).k, 'locked');
  // the near berth is somebody else's beyond station 9 - that is why it is
  // only the near berth - so the hop must not have locked it there
  assert.notStrictEqual(S.availability('16021', hd, 'SL', 9, 13).berths.find(x => x.idx === a.idx).k, 'locked', 'the hop locks the near berth only on its own stretch');
  // and released together
  S.release(h.hold.id);
  const w = S.availability('16021', hd, 'SL', 5, 13);
  assert.strictEqual(w.counts.locked, 0);
});



console.log('\nany berth: the packer');
t('with nothing fixed, berths used equals the busiest leg (optimal)', () => {
  const seeded = seedOccupancy('SL', '16021', 1);
  const items = [];
  seeded.forEach((m, i) => { if (m) items.push({ id: 'b' + i, mask: m, group: null, at: i }); });
  const r = packInto(new Int32Array(seeded.length), items, null);
  assert.ok(r.ok);
  assert.strictEqual(r.touched, packPlan(seeded).peak, 'touched ' + r.touched + ' peak ' + packPlan(seeded).peak);
});

t('a checkerboard of chosen berths can make a journey unseatable, and the packer says so', () => {
  // two berths: A pinned on leg 0 of berth 0, B pinned on leg 1 of berth 1
  const fixed = Int32Array.from([journeyMask(0, 1), journeyMask(1, 2)]);
  const r = packInto(fixed, [{ id: 'c', mask: journeyMask(0, 2), group: null, at: 0 }], null);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.unseated, ['c']);
});

t('best fit keeps whole berths whole', () => {
  // berth 0 is already used on leg 0; a leg-1 journey should go there, not onto a pristine berth
  const fixed = Int32Array.from([journeyMask(0, 1), 0, 0]);
  const r = packInto(fixed, [{ id: 'x', mask: journeyMask(1, 2), group: null, at: 0 }], null);
  assert.strictEqual(r.assign.get('x'), 0);
  assert.strictEqual(r.wholeFree, 2);
});

t('a family is kept in one coach when it can be', () => {
  const layout = [{ coach: 'S1' }, { coach: 'S1' }, { coach: 'S2' }, { coach: 'S2' }];
  const fixed = new Int32Array(4);
  const r = packInto(fixed, [
    { id: 'f1', mask: journeyMask(2, 9), group: 'fam', at: 1 },
    { id: 'f2', mask: journeyMask(2, 9), group: 'fam', at: 1 },
  ], layout);
  assert.ok(r.ok);
  assert.strictEqual(layout[r.assign.get('f1')].coach, layout[r.assign.get('f2')].coach);
});

console.log('\nany berth: the store');
const abDate = '2026-09-28';
t('an any-berth hold joins the pool and is priced at the through fare, no choice fee', () => {
  const r = S.hold({ train: '16021', date: abDate, cls: 'SL', from: 5, to: 13, pax: 1, who: 'ab-1', mode: 'any' });
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.hold.mode, 'any');
  assert.strictEqual(r.hold.berths.length, 0);
  assert.strictEqual(r.hold.choiceFee, 0);
  assert.strictEqual(r.hold.berthSum, r.hold.fullPrice - r.hold.fees);
  const av = S.availability('16021', abDate, 'SL', 5, 13);
  assert.strictEqual(av.pool, 1);
  assert.ok(av.counts.pooled >= 1, 'the map shows a provisional berth');
  S.release(r.hold.id);
  assert.strictEqual(S.availability('16021', abDate, 'SL', 5, 13).pool, 0, 'released from the pool');
});

t('a chosen berth carries the choice fee, per traveller, by class', () => {
  const av = S.availability('16021', abDate, '3A', 5, 6);
  const notLower = b => b.type !== 'LB' && b.type !== 'SLB';   // lowers are not for choosing pre-chart
  const free = av.berths.filter(b => b.k === 'free' && notLower(b)).map(b => b.idx).slice(0, 2);
  const r = S.hold({ train: '16021', date: abDate, cls: '3A', from: 5, to: 6, berthIdxs: free, pax: 2, who: 'ab-2', mode: 'exact' });
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.hold.choiceFee, 100, '50 x 2 travellers in 3A');
  assert.strictEqual(r.hold.fees, S.feesFor('3A', 2, r.hold.berthSum, true));
  assert.ok(r.hold.fees > S.feesFor('3A', 2, r.hold.berthSum, false), 'chosen costs more than any');
  S.release(r.hold.id);
});

t('the pool is never oversold: when nobody more can be seated, the hold is refused', () => {
  // fill every whole-way berth for one leg via the pool, then ask for one more
  const av = S.availability('16022', abDate, '2A', 13, 12);
  const room = av.anySeats;
  assert.ok(room > 0, 'some room to start with');
  let ok = 0, r;
  for (let i = 0; i < room + 3; i++) {
    r = S.hold({ train: '16022', date: abDate, cls: '2A', from: 13, to: 12, pax: 1, who: 'ab-fill-' + i, mode: 'any' });
    if (r.ok) ok++; else break;
  }
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-whole-berth');
  assert.ok(ok > 0 && ok <= room, 'seated ' + ok + ' of room ' + room);
  assert.strictEqual(S.availability('16022', abDate, '2A', 13, 12).anyBerth.ok, false);
});

t('a chosen berth that would unseat someone already booked is refused', () => {
  S.reset();
  const d = '2026-09-29';
  // pool up everyone possible on the whole run, then try to pin a berth the pool needs
  let ok = 0;
  for (let i = 0; i < 500; i++) {
    const r = S.hold({ train: '22817', date: d, cls: '2A', from: 0, to: 13, pax: 1, who: 'need-' + i, mode: 'any' });
    if (!r.ok) break; ok++;
    S.confirm(r.hold.id);
  }
  assert.ok(ok > 0, 'someone got in');
  const av = S.availability('22817', d, '2A', 0, 13);
  // the hatch can only show the pool on physically empty berths; whichever
  // those are, pinning one is refused - as needed by the pool, or, if it is a
  // lower berth, as reserved for people who need one (checked first)
  const pooledIdx = av.berths.find(b => b.k === 'pooled' && b.type !== 'LB' && b.type !== 'SLB') || av.berths.find(b => b.k === 'pooled');
  assert.ok(pooledIdx, 'a provisional berth exists');
  const isLow = pooledIdx.type === 'LB' || pooledIdx.type === 'SLB';
  const r = S.hold({ train: '22817', date: d, cls: '2A', from: 0, to: 13, berthIdxs: [pooledIdx.idx], pax: 1, who: 'pin', mode: 'exact' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, isLow ? 'lower-reserved' : 'needed-for-pool');
});

t('chosen berths are capped at a share of the coach', () => {
  S.reset();
  const d = '2026-09-30';
  // find a class and date with more free berths on one leg than the cap allows
  let cls = null, free = [], cap = 0, dd = d;
  outer: for (const c of ['2A', '3A', 'SL']) for (let k = 20; k < 61; k++) {
    dd = k <= 30 ? '2026-09-' + String(k).padStart(2, '0') : '2026-10-' + String(k - 30).padStart(2, '0');
    const size = { '2A': 96, '3A': 192, 'SL': 432 }[c];
    cap = Math.floor(S.MAX_CHOSEN_FRACTION * size);
    const av = S.availability('16021', dd, c, 5, 6);
    free = av.berths.filter(b => b.k === 'free' && b.type !== 'LB' && b.type !== 'SLB').map(b => b.idx);
    if (free.length > cap + 2) { cls = c; break outer; }
  }
  if (!cls) {
    // lower berths are not for choosing before the chart, so with real seed
    // data the choosable berths run out before the cap does: pin everything
    // choosable and check the cap was never crossed and never wrongly cited
    cls = 'SL'; dd = '2026-10-12'; cap = Math.floor(S.MAX_CHOSEN_FRACTION * 432);
    free = S.availability('16021', dd, cls, 5, 6).berths.filter(b => b.k === 'free' && b.type !== 'LB' && b.type !== 'SLB').map(b => b.idx);
  }
  let held = 0, last;
  for (let i = 0; i < free.length; i++) {
    last = S.hold({ train: '16021', date: dd, cls, from: 5, to: 6, berthIdxs: [free[i]], pax: 1, who: 'cap-' + i, mode: 'exact' });
    if (!last.ok) break; held++;
    S.confirm(last.hold.id);
  }
  assert.ok(held <= cap, 'never more than the cap');
  if (held === cap) assert.strictEqual(last.reason, 'chosen-cap', 'stopped by the cap, not by ' + last.reason);
  else assert.notStrictEqual(last && last.reason, 'chosen-cap', 'the cap is not cited while it has room');
  const anyR = S.hold({ train: '16021', date: dd, cls, from: 5, to: 6, pax: 1, who: 'still-any', mode: 'any' });
  assert.ok(anyR.ok, 'any berth still works past the chosen cap');
  S.release(anyR.hold.id);
});

t('charting seats the pool on real berths, journals it, and a restart keeps it', () => {
  S.reset();
  const recs = []; S.onRecord(r => recs.push(r));
  const d = '2026-10-01';
  const h1 = S.hold({ train: '16021', date: d, cls: 'SL', from: 5, to: 13, pax: 2, who: 'fam', mode: 'any' });
  const h2 = S.hold({ train: '16021', date: d, cls: 'SL', from: 0, to: 5, pax: 1, who: 'solo', mode: 'any' });
  assert.ok(h1.ok && h2.ok);
  const b1 = S.confirm(h1.hold.id).booking, b2 = S.confirm(h2.hold.id).booking;
  assert.strictEqual(b1.assigned, false);
  assert.strictEqual(b1.berths.length, 0);
  const c = S.chart('16021', d, 'SL');
  assert.ok(c.ok); assert.strictEqual(c.assigned, 2); assert.strictEqual(c.unseated, 0);
  const g1 = S.getBooking(b1.pnr), g2 = S.getBooking(b2.pnr);
  assert.strictEqual(g1.assigned, true); assert.strictEqual(g1.berths.length, 2);
  assert.strictEqual(g2.berths.length, 1);
  assert.ok(/^S\d\/\d+$/.test(g1.berths[0]), g1.berths[0]);
  const idxs = g1.berthIdxs.concat(g2.berthIdxs);
  assert.strictEqual(new Set(idxs).size, idxs.length, 'no two travellers on one berth');
  // the family sits in one coach
  assert.strictEqual(g1.berths[0].split('/')[0], g1.berths[1].split('/')[0]);
  // the berths are marked taken now
  const av = S.availability('16021', d, 'SL', 5, 13);
  for (const i of g1.berthIdxs) assert.strictEqual(av.berths[i].k, 'taken');
  assert.strictEqual(av.charted, true);
  assert.strictEqual(S.chart('16021', d, 'SL').already, true, 'idempotent');
  // restart
  S.onRecord(null);
  const journal = recs.slice();
  S.reset();
  const got = S.replay(journal.filter(r => r.t !== 'reset'));
  assert.strictEqual(got.charted, 1);
  const r1 = S.getBooking(b1.pnr);
  assert.deepStrictEqual(r1.berths, g1.berths, 'same berths after replay');
  const av2 = S.availability('16021', d, 'SL', 5, 13);
  for (const i of g1.berthIdxs) assert.strictEqual(av2.berths[i].k, 'taken');
  assert.strictEqual(av2.charted, true);
});

t('after charting, any berth is closed and a late payer is seated immediately', () => {
  S.reset();
  const d = '2026-10-02';
  const early = S.hold({ train: '16021', date: d, cls: 'SL', from: 5, to: 13, pax: 1, who: 'early', mode: 'any' });
  assert.ok(early.ok);
  S.chart('16021', d, 'SL');
  const late = S.hold({ train: '16021', date: d, cls: 'SL', from: 5, to: 13, pax: 1, who: 'late', mode: 'any' });
  assert.strictEqual(late.ok, false); assert.strictEqual(late.reason, 'charted');
  const paid = S.confirm(early.hold.id).booking;
  assert.strictEqual(paid.assigned, true, 'held before the chart, paid after: seated at once');
  assert.strictEqual(paid.berths.length, 1);
});

t('a restart puts an uncharted any-berth booking back in the pool', () => {
  S.reset();
  const recs = []; S.onRecord(r => recs.push(r));
  const d = '2026-10-03';
  const h = S.hold({ train: '16021', date: d, cls: 'SL', from: 5, to: 11, pax: 1, who: 'pool-replay', mode: 'any' });
  const b = S.confirm(h.hold.id).booking;
  S.onRecord(null);
  S.reset();
  S.replay(recs.filter(r => r.t === 'booked'));
  assert.strictEqual(S.availability('16021', d, 'SL', 5, 11).pool, 1, 'back in the pool');
  assert.strictEqual(S.getBooking(b.pnr).assigned, false);
  const c = S.chart('16021', d, 'SL');
  assert.strictEqual(c.assigned, 1);
});

t('the number that matters: one sellable berth becomes many after packing', () => {
  S.reset();
  const av = S.availability('16021', '2026-09-03', 'SL', 0, 13);
  assert.ok(av.wholeFreeAfterPacking > av.counts.free, av.counts.free + ' -> ' + av.wholeFreeAfterPacking);
  assert.strictEqual(av.wholeFreeAfterPacking, av.pack.freed, 'the packer agrees with the bound');
});


console.log('\nfair tatkal: blocked, not taken');
const sess = (who, round, status = 'pending') =>
  ({ id: 'p-' + who, who, round, amount: 175, expiresAt: 1000, status });

t('the bank approves a block once, and only while the request is live', () => {
  const p = sess('a@x', 1);
  assert.deepStrictEqual(tatkal.authorise(p, 10), { ok: true, status: 'authorised' });
  assert.strictEqual(p.captured, 0, 'approved means blocked, and blocked means nothing taken');
  assert.strictEqual(tatkal.authorise(p, 20).reason, 'authorised', 'a second approval changes nothing');
  const late = sess('b@x', 1);
  assert.strictEqual(tatkal.authorise(late, 5000).reason, 'expired');
  assert.strictEqual(late.status, 'expired', 'a lapsed request is marked so, not approved');
});

t('allotment takes a winner\'s block and releases a loser\'s', () => {
  const w = sess('w@x', 1), l = sess('l@x', 1);
  tatkal.authorise(w, 10); tatkal.authorise(l, 10);
  assert.deepStrictEqual(tatkal.settle(w, true, 20), { ok: true, status: 'captured', captured: 175 });
  assert.deepStrictEqual(tatkal.settle(l, false, 20), { ok: true, status: 'released', captured: 0 });
});

t('a settled block stays settled; a block the bank never approved is never taken', () => {
  const w = sess('w@x', 1); tatkal.authorise(w, 10); tatkal.settle(w, true, 20);
  assert.strictEqual(tatkal.settle(w, false, 30).reason, 'captured', 'cannot un-take');
  assert.strictEqual(tatkal.authorise(w, 30).reason, 'captured', 'cannot re-approve');
  const cold = sess('c@x', 1);
  assert.strictEqual(tatkal.settle(cold, true, 20).reason, 'pending');
  assert.strictEqual(cold.captured, undefined, 'no approval, no money, ever');
});

t('the draw settles every approved block in the round against its result', () => {
  const R = tatkal.newRound('w@x', 1, tkDate, 0);
  tatkal.enter(R, { who: 'w@x', name: 'W', signals: {} }, 5);
  const av = { berths: [{ k: 'free', idx: 7 }], counts: { free: 1, part: 0 } };
  const done = tatkal.allot(R, av, 10);
  const won = done.realWinners.some(x => x.id === 'w@x');
  const mine = sess('w@x', 1), old = sess('w@x', 0), never = sess('w@x', 1);
  tatkal.authorise(mine, 6); tatkal.authorise(old, 6);
  const changed = tatkal.settleRound([mine, old, never], R, 20);
  assert.deepStrictEqual(changed, [mine], 'only this round, only approved blocks');
  assert.strictEqual(mine.status, won ? 'captured' : 'released');
  assert.strictEqual(mine.captured, won ? 175 : 0);
  if (won) assert.strictEqual(mine.berthIdx, 7, 'the taken block points at the berth it bought');
  assert.strictEqual(old.status, 'authorised', 'another round\'s block is not this draw\'s business');
  assert.strictEqual(never.status, 'pending');
});

t('abandoning a window releases every approved block, and only those', () => {
  const a = sess('a@x', 3), b = sess('a@x', 3), c = sess('a@x', 3);
  tatkal.authorise(a, 1); tatkal.authorise(b, 1); tatkal.settle(b, true, 2);
  const out = tatkal.releaseAll([a, b, c], 3, 5);
  assert.deepStrictEqual(out.map(x => x.status), ['released']);
  assert.strictEqual(a.captured, 0);
  assert.strictEqual(b.status, 'captured', 'a berth already bought is not undone by a reset');
  assert.strictEqual(c.status, 'pending');
});


console.log('\norders: tell khaali what you need, not which train');
const oDeps = (at = '2026-09-10T08:00:00+05:30') => ({
  feesFor: S.feesFor, countsFor: S.countsFor, availability: S.availability,
  hold: S.hold, release: S.release, confirm: S.confirm,
  now: () => new Date(at), today: () => '2026-09-10',
});
const oReq = (x = {}) => ({ from: 5, to: 13, date: '2026-09-12', after: 0, before: 1440, classes: ['SL'], pax: 1, cap: 400, ...x });
const place = (x, deps) => { const v = orders.validate(oReq(x), deps); assert.ok(v.ok, v.error);
  return { ...v.order, id: 'o1', who: 'me@x', status: 'open', openedAt: 1 }; };

t('an order is disbelieved: window, class, party size, and a cap below the cheapest fare', () => {
  const d = oDeps();
  assert.strictEqual(orders.validate(oReq({ after: 600, before: 600 }), d).ok, false, 'empty window');
  assert.strictEqual(orders.validate(oReq({ classes: ['1A'] }), d).ok, false, 'unknown class');
  assert.strictEqual(orders.validate(oReq({ pax: 7 }), d).ok, false, 'seven is a group, not a party');
  assert.strictEqual(orders.validate(oReq({ date: '2026-09-09' }), d).ok, false, 'yesterday');
  const low = orders.validate(oReq({ cap: 10 }), d);
  assert.strictEqual(low.ok, false);
  assert.ok(low.cheapest > 10, 'says what the cheapest actually is');
  assert.ok(orders.validate(oReq({ cap: low.cheapest }), d).ok, 'exactly the cheapest fare is enough');
});

t('candidates honour the window, the classes, the cap, and trains that already left today', () => {
  const d = oDeps();
  const all = orders.candidates(place({}, d), d);
  assert.ok(all.length > 1, 'more than one train serves SBC to MYS');
  assert.ok(all.every((c, i) => i === 0 || c.price >= all[i - 1].price), 'cheapest first');
  const narrow = orders.candidates(place({ after: 300, before: 420 }, d), d);
  assert.ok(narrow.length && narrow.every(c => c.dep >= 300 && c.dep < 420), 'window respected');
  const both = orders.candidates(place({ classes: ['SL', '3A'], cap: 5000 }, d), d);
  assert.ok(both.some(c => c.cls === '3A') && both.some(c => c.cls === 'SL'));
  const tight = orders.candidates(place({ classes: ['SL', '3A'], cap: 400 }, d), d);
  assert.ok(tight.every(c => c.cls === 'SL'), 'the cap prices AC out');
  // today at 23:50: nearly everything has gone
  const late = oDeps('2026-09-10T23:50:00+05:30');
  const gone = orders.candidates({ ...place({ date: '2026-09-10' }, late) }, late);
  assert.ok(gone.length < all.length, 'today only sells what has not left');
});

t('an open order fills with a whole berth on the cheapest train that has one, for what it costs', () => {
  S.reset();
  const d = oDeps();
  const o = place({ classes: ['SL', '3A'], cap: 900 }, d);
  const r = orders.tryFill(o, d);
  assert.ok(r.ok, r.reason);
  assert.strictEqual(o.status, 'filled');
  assert.strictEqual(r.booking.who, 'me@x', 'booked in the traveller\'s own name');
  assert.ok(o.paid <= o.cap, 'never more than the cap');
  assert.strictEqual(o.paid, r.pick.price, 'paid exactly the candidate price');
  assert.strictEqual(r.booking.mode, 'any', 'before charting it is an any-berth booking');
  assert.strictEqual(S.getBooking(o.pnr).pnr, o.pnr);
  assert.strictEqual(orders.tryFill(o, d).ok, false, 'a filled order does not fill twice');
});

t('nothing fits, the order waits; a berth freeing up fills it; the window closing expires it', () => {
  S.reset();
  const d = oDeps();
  // one train alone, isolated by a one-minute window: fill it to the brim first
  const first = orders.candidates(place({ cap: 300 }, d), d)[0];
  const o = place({ after: first.dep, before: first.dep + 1, cap: 300 }, d);
  const cands = orders.candidates(o, d);
  assert.strictEqual(cands.length, 1, 'one train in that slice: ' + cands.map(c => c.train));
  const tr = cands[0].train;
  const holds = [];
  while (S.countsFor(tr, o.date, 'SL', 5, 13).anySeats > 0) {
    const h = S.hold({ train: tr, date: o.date, cls: 'SL', from: 5, to: 13, pax: 1, who: 'crowd' + holds.length, mode: 'any' });
    if (!h.ok) break;
    holds.push(h.hold.id);
  }
  assert.strictEqual(orders.tryFill(o, d).ok, false, 'no whole berth, no fill');
  assert.strictEqual(o.status, 'open');
  S.release(holds[0], 'changed-mind');
  assert.ok(orders.tryFill(o, d).ok, 'the released berth goes to the order');
  assert.strictEqual(o.fill.train, tr);
  const o2 = place({ after: 230, before: 240, cap: 300 }, d);
  assert.strictEqual(orders.expired(o2, oDeps('2026-09-12T03:59:00+05:30')), false);
  assert.strictEqual(orders.expired(o2, oDeps('2026-09-12T04:00:00+05:30')), true, 'the window has closed');
});

t('a fill never knocks out the traveller\'s own checkout, and never overpays after charting', () => {
  S.reset();
  const d = oDeps();
  const a = S.hold({ train: '16021', date: '2026-09-12', cls: 'SL', from: 0, to: 5, pax: 1, who: 'me@x', mode: 'any' });
  const b = S.hold({ train: '16021', date: '2026-09-12', cls: 'SL', from: 6, to: 9, pax: 1, who: 'me@x', mode: 'any' });
  assert.ok(a.ok && b.ok);
  const o = place({ classes: ['SL'], cap: 400 }, d);
  assert.ok(orders.tryFill(o, d).ok);
  assert.strictEqual(S.getHold(a.hold.id).status, 'pending', 'first checkout still alive');
  assert.strictEqual(S.getHold(b.hold.id).status, 'pending', 'second checkout still alive');
  // after the chart, the order books real berths and still pays the plain fare
  const c = orders.candidates(place({}, d), d)[0];
  S.chart(c.train, '2026-09-12', c.cls);
  const o2 = { ...place({}, d), id: 'o2' };
  const r2 = orders.tryFill(o2, d);
  assert.ok(r2.ok, r2.reason);
  assert.strictEqual(r2.booking.mode, 'exact');
  assert.ok(r2.booking.berths.length === 1, 'a real berth number');
  assert.ok(o2.paid <= o2.cap);
});

t('the block behind an order is taken for the berth\'s price, and the rest released', () => {
  const s = { id: 'p', who: 'me@x', round: 0, amount: 400, expiresAt: 1e12, status: 'pending' };
  tatkal.authorise(s, 1);
  assert.deepStrictEqual(tatkal.settle(s, true, 2, 186), { ok: true, status: 'captured', captured: 186 });
  const s2 = { id: 'q', who: 'me@x', round: 0, amount: 400, expiresAt: 1e12, status: 'pending' };
  tatkal.authorise(s2, 1);
  assert.strictEqual(tatkal.settle(s2, true, 2, 9999).captured, 400, 'never more than was blocked');
});


console.log('\nlower berths: the quota counts berths, khaali counts people');
const LAY = berthLayout('SL');
const lowerIdx = i => LAY[i].type === 'LB' || LAY[i].type === 'SLB';

t('a need is seated on a lower berth first; a preference gets one only if it costs no need', () => {
  const fixed = new Int32Array(LAY.length);
  const j = journeyMask(0, 13);
  const items = [
    { id: 'young', mask: j, group: 'a', at: 1 },
    { id: 'gran', mask: j, group: 'b', at: 2, need: 'senior' },
    { id: 'likes', mask: j, group: 'c', at: 3, pref: 'lower' },
  ];
  const r = packInto(fixed, items, LAY);
  assert.ok(r.ok);
  assert.ok(lowerIdx(r.assign.get('gran')), 'the senior is on a lower berth');
  assert.ok(lowerIdx(r.assign.get('likes')), 'plenty of lowers, so the preference is met too');
  assert.deepStrictEqual([r.lowerNeeded, r.lowerGiven, r.lowerMissed], [1, 1, []]);
});

t('when lower berths run out, needs win over preferences and the miss is named', () => {
  const fixed = new Int32Array(LAY.length);
  const j = journeyMask(0, 13);
  // block every lower berth but two
  let left = 2;
  for (let i = LAY.length - 1; i >= 0; i--) if (lowerIdx(i)) { if (left > 0) { left--; continue; } fixed[i] = j; }
  const items = [
    { id: 'p1', mask: j, group: 'x', at: 1, pref: 'lower' },
    { id: 'n1', mask: j, group: 'y', at: 2, need: 'senior' },
    { id: 'n2', mask: j, group: 'z', at: 3, need: 'disabled' },
    { id: 'n3', mask: j, group: 'w', at: 4, need: 'expecting' },
  ];
  const r = packInto(fixed, items, LAY);
  assert.ok(r.ok, 'everyone still gets a berth');
  assert.ok(lowerIdx(r.assign.get('n1')) && lowerIdx(r.assign.get('n2')), 'the two lowers go to needs');
  assert.ok(!lowerIdx(r.assign.get('p1')), 'the preference gives way');
  assert.deepStrictEqual([r.lowerNeeded, r.lowerGiven, r.lowerMissed], [3, 2, ['n3']]);
});

t('a whole lower berth cannot be chosen before the chart; a partial one can; after the chart anything goes', () => {
  S.reset();
  // find a day whose coach has a whole-free lower, a whole-free upper and a partial lower
  let d = null, freeLower, freeUpper, partLower, F0 = 0, T0 = 13, cls = 'SL';
  outer: for (const [f, t] of [[0, 13], [5, 13], [0, 5], [5, 11]]) for (const c of ['SL', '3A', '2A']) for (let k = 14; k < 45; k++) {
    const dd = k <= 30 ? '2026-09-' + String(k).padStart(2, '0') : '2026-10-' + String(k - 30).padStart(2, '0');
    const av = S.availability('16021', dd, c, f, t);
    freeLower = av.berths.find(b => b.k === 'free' && (b.type === 'LB' || b.type === 'SLB'));
    freeUpper = av.berths.find(b => b.k === 'free' && b.type === 'UB');
    partLower = av.berths.find(b => b.k === 'part' && (b.type === 'LB' || b.type === 'SLB'));
    if (freeLower && freeUpper && partLower) { d = dd; F0 = f; T0 = t; cls = c; break outer; }
  }
  assert.ok(d, 'fixture has all three kinds');
  const r1 = S.hold({ train: '16021', date: d, cls, from: F0, to: T0, berthIdxs: [freeLower.idx], pax: 1, who: 'a@x' });
  assert.deepStrictEqual([r1.ok, r1.reason], [false, 'lower-reserved']);
  const r2 = S.hold({ train: '16021', date: d, cls, from: F0, to: T0, berthIdxs: [freeUpper.idx], pax: 1, who: 'a@x' });
  assert.ok(r2.ok, 'an upper berth is still for choosing');
  const r3 = S.hold({ train: '16021', date: d, cls, from: F0, to: T0, berthIdxs: [partLower.idx], pax: 1, who: 'b@x' });
  assert.ok(r3.ok, 'a partial lower is already somebody\'s, so the stretch is sellable');
  S.release(r2.hold.id); S.release(r3.hold.id);
  S.chart('16021', d, cls);
  const av2 = S.availability('16021', d, cls, F0, T0);
  const fl2 = av2.berths.find(b => b.k === 'free' && (b.type === 'LB' || b.type === 'SLB'));
  if (fl2) assert.ok(S.hold({ train: '16021', date: d, cls, from: F0, to: T0, berthIdxs: [fl2.idx], pax: 1, who: 'c@x' }).ok, 'post-chart, what is free is free');
});

t('at charting a booked need lands on a lower berth, the ticket says so, and a restart remembers it', () => {
  S.reset();
  const d = '2026-09-15';
  const recs = [];
  S.onRecord(r => recs.push(r));
  const h = S.hold({ train: '16021', date: d, cls: 'SL', from: 0, to: 13, pax: 2, who: 'fam@x', mode: 'any',
    travellers: [{ name: 'Ajji', need: 'senior' }, { name: 'Kid', pref: 'lower' }] });
  assert.ok(h.ok, h.reason);
  const b = S.confirm(h.hold.id).booking;
  assert.strictEqual(b.travellers[0].need, 'senior');
  const c = S.chart('16021', d, 'SL');
  assert.ok(c.lower.needed >= 1 && c.lower.given >= 1, JSON.stringify(c.lower));
  const bk = S.getBooking(b.pnr);
  assert.deepStrictEqual(bk.lower, { needed: 1, given: 1, missed: 0 });
  const first = LAY[bk.berthIdxs[0]];
  assert.ok(first.type === 'LB' || first.type === 'SLB', 'traveller 1 sits low: ' + first.type);
  assert.ok(S.availability('16021', d, 'SL', 0, 13).lower.result.needed >= 1, 'the coach publishes its count');
  // replay from the journal: the need and the result survive
  S.onRecord(null);
  S.reset();
  S.replay(recs);
  assert.deepStrictEqual(S.getBooking(b.pnr).lower, { needed: 1, given: 1, missed: 0 });
  // an uncharted any-berth booking gets its need back too
  S.reset();
  S.replay(recs.filter(r => r.t === 'booked'));
  const av = S.availability('16021', d, 'SL', 0, 13);
  assert.ok(av.lower.needed >= 1, 'the pool item still needs a lower berth');
});

t('a pending hold learns its travellers\' needs, and the pool items with it', () => {
  S.reset();
  const h = S.hold({ train: '16021', date: '2026-09-16', cls: 'SL', from: 0, to: 13, pax: 2, who: 'late@x', mode: 'any' });
  assert.ok(h.ok);
  const r = S.setTravellers(h.hold.id, [{ name: 'Ajji', need: 'senior' }, { name: 'Kid', pref: 'lower' }]);
  assert.ok(r.ok);
  const b = S.confirm(h.hold.id).booking;
  assert.strictEqual(b.travellers[0].need, 'senior');
  assert.strictEqual(S.availability('16021', '2026-09-16', 'SL', 0, 13).lower.needed >= 1, true);
  assert.strictEqual(S.setTravellers(h.hold.id, []).ok, false, 'a paid hold is not a hold any more');
});

console.log('\nwaitlist: an order pinned to one train');
t('a waitlist watches one train, closes at its departure, and counts its queue honestly', () => {
  S.reset();
  const d = oDeps();
  const v = orders.validate(oReq({ train: '16021', classes: ['3A', 'SL'], cap: 5000 }), d);
  assert.ok(v.ok, v.error);
  const o = { ...v.order, id: 'w1', who: 'w@x', status: 'open', openedAt: 10 };
  assert.strictEqual(o.train, '16021');
  assert.deepStrictEqual(o.classes, ['3A'], 'one class: the one being waited for');
  assert.strictEqual(o.before, o.after + 1, 'the window is that train\'s departure');
  const c = orders.candidates(o, d);
  assert.ok(c.length === 1 && c[0].train === '16021', 'only that train');
  assert.strictEqual(orders.validate(oReq({ train: '99999' }), d).ok, false, 'unknown train refused');
  const later = { ...o, id: 'w2', openedAt: 20 };
  const other = { ...o, id: 'w3', openedAt: 5, classes: ['SL'] };
  const flex = { ...v.order, id: 'f1', who: 'f@x', status: 'open', openedAt: 1, train: undefined, after: 0, before: 1440, classes: ['3A'] };
  const pending = { ...o, id: 'w4', openedAt: null, status: 'pending' };
  const all = [o, later, other, flex, pending];
  assert.deepStrictEqual(orders.queueOf(later, all, d), { position: 2, flexAhead: 1 }, 'behind w1, with one flexible order ahead');
  assert.deepStrictEqual(orders.queueOf(o, all, d), { position: 1, flexAhead: 1 }, 'a pending request holds no place');
  assert.deepStrictEqual(orders.queueOf(other, all, d).position, 1, 'a different class is a different line');
});


console.log('\nthe document locker: signing in');
t('a one-time code opens the locker, once, and only the right one', () => {
  const s = dl.newSignIn({ id: 's1', code: '482913' }, 0).session;
  assert.strictEqual(s.status, 'sent');
  assert.strictEqual(dl.signedIn(s, 1), false);
  assert.deepStrictEqual(dl.verify(s, '000000', 1), { ok: false, reason: 'wrong', left: 4 });
  assert.ok(dl.verify(s, '482913', 2).ok);
  assert.strictEqual(dl.signedIn(s, 3), true);
  assert.deepStrictEqual(dl.verify(s, '482913', 4), { ok: true, already: true }, 'already open');
  assert.strictEqual(dl.signedIn(s, 3 + 3600001), false, 'and it does not last for ever');
  assert.strictEqual(dl.newSignIn({ id: 'x', code: '12' }).reason, 'bad-code');
});

t('five wrong codes lock it, and a lapsed code opens nothing', () => {
  const s = dl.newSignIn({ id: 's2', code: '111111' }, 0).session;
  for (let i = 1; i <= 4; i++) assert.strictEqual(dl.verify(s, '999999', 1).left, dl.OTP_TRIES - i);
  assert.strictEqual(dl.verify(s, '999999', 1).reason, 'locked');
  assert.strictEqual(dl.verify(s, '111111', 1).reason, 'locked', 'the right code cannot rescue it');
  const e = dl.newSignIn({ id: 's3', code: '222222' }, 0).session;
  assert.strictEqual(dl.verify(e, '222222', dl.OTP_MS + 1).reason, 'expired');
  assert.strictEqual(dl.signedIn(e, dl.OTP_MS + 2), false);
});

t('the locker page lists every document, and offers only two answers', () => {
  const ps = dl.profiles('2026-09-10');
  assert.strictEqual(ps.length, 6);
  const sam = ps.find(p => p.name === 'Sam Altman');
  assert.ok(sam.documents.length >= 4, 'Aadhaar, PAN and his own papers');
  assert.ok(sam.documents.some(d => d.kind === 'pension'));
  assert.strictEqual(sam.need, 'senior');
  assert.deepStrictEqual(Object.keys(sam.offers).sort(), ['certificate', 'dob', 'need']);
  const may = ps.find(p => p.name === 'Meowy Mayya');
  assert.strictEqual(may.need, 'expecting');
  assert.strictEqual(may.offers.certificate, 'Antenatal care card');
  const ach = ps.find(p => p.name === 'Achina');
  assert.strictEqual(ach.age, 20);
  assert.strictEqual(ach.need, null);
  // adding papers to a locker must not turn them into a claim on a berth
  assert.strictEqual(ps.find(p => p.name === 'Varun').need, null);
});

console.log('\nthe document locker: a need proved instead of claimed');
const mkC = (name, date = '2026-09-10') => {
  const r = dl.newConsent({ id: 'c1', who: 'me@x', name, date }, 0);
  assert.ok(r.ok, r.reason); return r.consent;
};

t('the locker holds the cast, and answers age from the travel date', () => {
  assert.strictEqual(dl.holderOf('nobody'), null);
  assert.strictEqual(dl.newConsent({ id: 'x', who: 'a', name: 'nobody', date: '2026-09-10' }).reason, 'unknown-holder');
  assert.strictEqual(dl.newConsent({ id: 'x', who: 'a', name: 'Pranav', date: 'later' }).reason, 'bad-date');
  assert.strictEqual(dl.ageOn('1958-03-11', '2026-03-10'), 67, 'the day before the birthday');
  assert.strictEqual(dl.ageOn('1958-03-11', '2026-03-11'), 68, 'and on it');
});

t('nothing is read until the holder says yes, and nothing is kept if they say no', () => {
  const c = mkC('Sam Altman');
  assert.strictEqual(c.status, 'pending');
  assert.strictEqual(c.share, null, 'a pending request has read nothing');
  assert.strictEqual(dl.publicOf(c, 1).share, null, 'and shows nothing');
  assert.ok(dl.publicOf(c, 1).ask, 'but does say what it would read');
  const no = mkC('Sam Altman');
  assert.ok(dl.decline(no, 5).ok);
  assert.strictEqual(no.share, null);
  assert.strictEqual(dl.publicOf(no, 6).share, null);
  assert.strictEqual(dl.decline(no, 7).reason, 'declined', 'answered once, answered for good');
  assert.strictEqual(dl.allow(no, 7).reason, 'declined', 'and a no cannot become a yes');
});

t('a yes shares the date of birth and the need, and never an identifier', () => {
  const c = mkC('Sam Altman');
  const r = dl.allow(c, 10);
  assert.ok(r.ok);
  assert.strictEqual(r.share.dob, '1958-03-11');
  assert.strictEqual(r.share.age, 68);
  assert.strictEqual(r.share.need, 'senior');
  // the promise the whole feature rests on
  const flat = JSON.stringify(dl.publicOf(c, 11).share);
  assert.ok(!/xxxx|EYVPS1157B/.test(flat), 'no Aadhaar or PAN in what is shared: ' + flat);
  assert.deepStrictEqual(Object.keys(r.share).sort(), ['age', 'certificate', 'dob', 'need']);
});

t('a certificate proves a need that age does not', () => {
  const m = mkC('Meowy Mayya');
  assert.ok(dl.allow(m, 10).ok);
  assert.strictEqual(m.share.need, 'expecting');
  assert.ok(m.share.certificate.label, 'and says which certificate answered it');
  const y = mkC('Varun');
  assert.ok(dl.allow(y, 10).ok);
  assert.strictEqual(y.share.need, null, 'a young traveller with no certificate needs nothing');
  assert.strictEqual(y.share.certificate, null);
});

t('a request lapses, and a lapsed request reads nothing', () => {
  const c = mkC('Achina');
  assert.strictEqual(dl.expired(c, 10), false);
  assert.strictEqual(dl.expired(c, dl.CONSENT_MS + 1), true);
  assert.strictEqual(dl.allow(c, dl.CONSENT_MS + 1).reason, 'expired');
  assert.strictEqual(c.status, 'expired');
  assert.strictEqual(c.share, null);
  assert.strictEqual(dl.publicOf(c, dl.CONSENT_MS + 2).status, 'expired');
});


console.log('\nthe waitlist fallback: move me only if all of this holds');
const fbReq = (fb, x = {}) => oReq({ train: '16021', classes: ['SL'], cap: 5000, fallback: fb, ...x });
const fbOrder = (fb, d, x = {}) => {
  const v = orders.validate(fbReq(fb, x), d);
  assert.ok(v.ok, v.error);
  return { ...v.order, id: 'fb', who: 'me@x', status: 'open', openedAt: 1 };
};
const FB = { on: true, classes: ['SL', '3A'], after: 0, before: 1440, arriveBy: null, extra: 200 };

t('a fallback is disbelieved, and only a waitlist may carry one', () => {
  const d = oDeps();
  assert.strictEqual(orders.validate(fbReq({ ...FB, classes: [] }), d).ok, false, 'no classes');
  assert.strictEqual(orders.validate(fbReq({ ...FB, after: 600, before: 600 }), d).ok, false, 'empty window');
  assert.strictEqual(orders.validate(fbReq({ ...FB, arriveBy: 0 }), d).ok, false, 'arrive-by must be after midnight');
  assert.strictEqual(orders.validate(fbReq({ ...FB, arriveBy: 2881 }), d).ok, false, 'and inside two days');
  assert.ok(orders.validate(fbReq({ ...FB, arriveBy: 1800 }), d).ok, 'six the next morning is fine');
  assert.strictEqual(orders.validate(fbReq({ ...FB, extra: -1 }), d).ok, false, 'negative headroom');
  // a flexible order is not a waitlist, so it carries no fallback
  const flex = orders.validate(oReq({ classes: ['SL'], cap: 5000, fallback: FB }), d);
  assert.ok(flex.ok);
  assert.strictEqual(flex.order.fallback, undefined, 'only a pinned order gets one');
  assert.strictEqual(orders.fallbackRules(flex.order), null);
});

t('the rules keep the journey, the party and the money exactly as they were', () => {
  const d = oDeps();
  const o = fbOrder(FB, d);
  const rules = orders.fallbackRules(o);
  assert.strictEqual(rules.train, null, 'other trains become visible');
  assert.deepStrictEqual(rules.classes, ['SL', '3A']);
  // the three things Vikalp changes and khaali cannot
  assert.strictEqual(rules.from, undefined, 'from is never overridden');
  assert.strictEqual(rules.to, undefined, 'to is never overridden');
  assert.strictEqual(rules.pax, undefined, 'the party is never split');
  assert.strictEqual(rules.cap, undefined, 'the blocked amount still binds');
  const view = { ...o, ...rules };
  assert.strictEqual(view.from, o.from);
  assert.strictEqual(view.to, o.to);
  assert.strictEqual(view.cap, o.cap);
});

t('arrive-by filters candidates, and reads as the first such time after departure', () => {
  const d = oDeps();
  const all = orders.candidates({ ...fbOrder(FB, d), ...orders.fallbackRules(fbOrder(FB, d)) }, d);
  assert.ok(all.length > 1, 'several trains without the rule');
  const early = orders.candidates({ ...fbOrder({ ...FB, arriveBy: 360 }, d),
    ...orders.fallbackRules(fbOrder({ ...FB, arriveBy: 360 }, d)), arriveBy: 360 }, d);
  assert.ok(early.length < all.length, 'the rule removes some: ' + early.length + ' of ' + all.length);
  // and every survivor really does arrive by six that morning
  for (const c of early) {
    const tr = TRAINS.find(x => x.no === c.train);
    const dur = sMin(tr, 13, 'a') - sMin(tr, 5, 'd');
    assert.ok(c.dep + dur <= 360, c.train + ' arrives after 06:00');
  }
});

t('the fallback runs only once the waitlist has actually failed', () => {
  S.reset();
  const d = oDeps();
  const o = fbOrder(FB, d, { date: '2026-09-12' });
  // before charting, the pinned train is the only candidate
  assert.strictEqual(orders.chartedOut(o, d), false);
  assert.ok(orders.candidates(o, d).every(c => c.train === '16021'), 'pinned until it fails');
  S.chart('16021', '2026-09-12', 'SL');
  assert.strictEqual(orders.chartedOut(o, d), true, 'the chart is the moment it failed');
  // and only then do other trains come into view
  const alt = orders.candidates({ ...o, ...orders.fallbackRules(o) }, d);
  assert.ok(alt.some(c => c.train !== '16021'), 'other trains now considered');
});

t('a move fills the same order, from the same block, and is marked as a move', () => {
  S.reset();
  const d = oDeps();
  const o = fbOrder(FB, d, { date: '2026-09-13' });
  S.chart('16021', '2026-09-13', 'SL');
  const r = orders.tryFill(o, d, orders.fallbackRules(o));
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.via, 'fallback');
  assert.strictEqual(o.via, 'fallback');
  assert.strictEqual(o.status, 'filled');
  assert.ok(o.paid <= o.cap, 'never more than was blocked');
  assert.strictEqual(S.getBooking(o.pnr).who, 'me@x');
  assert.strictEqual(S.getBooking(o.pnr).from, o.from, 'boarding station unchanged');
  assert.strictEqual(S.getBooking(o.pnr).to, o.to, 'destination unchanged');
  assert.strictEqual(S.getBooking(o.pnr).pax, o.pax, 'party kept whole');
});

t('when a rule blocks the move, khaali names the rule rather than shrugging', () => {
  S.reset();
  const d = oDeps();
  // nothing on this corridor reaches Mysuru by 02:00, so arrive-by binds
  const o = fbOrder({ ...FB, arriveBy: 120 }, d, { date: '2026-09-14' });
  const rules = orders.fallbackRules(o);
  const r = orders.tryFill(o, d, rules);
  assert.strictEqual(r.ok, false);
  const why = orders.whyNot(o, d, rules);
  assert.strictEqual(why.rule, 'arriveBy', JSON.stringify(why));
  assert.ok(why.n > 0, 'and says how many trains it cost');
  assert.match(why.why, /arrive later/);
  // with no fallback at all there is nothing to explain
  const plain = { ...fbOrder(FB, d, { date: '2026-09-14' }), fallback: null };
  assert.strictEqual(orders.fallbackRules(plain), null);
});

t('the price rule and the window rule each bind on their own', () => {
  S.reset();
  const d = oDeps();
  // blocked at the sleeper fare with no headroom, so an AC alternative is out
  const tight = fbOrder({ ...FB, classes: ['2A'], extra: 0 }, d, { date: '2026-09-15', cap: 200 });
  const wCap = orders.whyNot(tight, d, orders.fallbackRules(tight));
  assert.strictEqual(wCap.rule, 'cap', JSON.stringify(wCap));
  assert.ok(wCap.n > 0, 'and says how many trains the price rule cost');
  // 23:56 to midnight: nothing on this corridor leaves then
  const narrow = fbOrder({ ...FB, after: 1436, before: 1440 }, d, { date: '2026-09-15', cap: 5000 });
  const wWin = orders.whyNot(narrow, d, orders.fallbackRules(narrow));
  assert.strictEqual(wWin.rule, 'window', JSON.stringify(wWin));
});


// The exact sequence server.mjs runs on every match tick, mirrored here so the
// path that actually moves a traveller is covered rather than merely reasoned
// about. If the server's loop changes, this has to change with it.
function runMatcher(list, deps) {
  const out = { filled: [], ended: [] };
  for (const o of list.filter(x => x.status === 'open')) {
    if (orders.tryFill(o, deps).ok) { out.filled.push(o); continue; }
    if (!(orders.expired(o, deps) || orders.chartedOut(o, deps))) continue;
    const fb = orders.fallbackRules(o);
    if (fb) {
      if (orders.tryFill(o, deps, fb).ok) { out.filled.push(o); continue; }
      o.declined = orders.whyNot(o, deps, fb);
    }
    o.status = 'expired'; out.ended.push(o);
  }
  return out;
}
const fillTrain = (no, date, cls) => {
  for (let i = 0; i < 500; i++) {
    const h = S.hold({ train: no, date, cls, from: 5, to: 13, pax: 1, who: 'crowd-' + no + i, mode: 'any' });
    if (!h.ok) break;
    S.confirm(h.hold.id);
  }
  return S.countsFor(no, date, cls, 5, 13).anySeats;
};

t('the matcher moves a waitlist only after charting, and keeps every promise', () => {
  S.reset();
  const d = oDeps();
  const date = '2026-09-16';
  assert.strictEqual(fillTrain('16021', date, 'SL'), 0, 'the waitlisted train is full');
  const o = fbOrder(FB, d, { date, cap: 5000 });

  let r = runMatcher([o], d);
  assert.deepStrictEqual([r.filled.length, r.ended.length], [0, 0], 'no move before the chart');
  assert.strictEqual(o.status, 'open');

  S.chart('16021', date, 'SL');
  r = runMatcher([o], d);
  assert.strictEqual(r.filled.length, 1, 'moved once the waitlist definitively failed');
  assert.strictEqual(o.via, 'fallback');
  assert.notStrictEqual(o.fill.train, '16021', 'onto a different train');
  const bk = S.getBooking(o.pnr);
  assert.strictEqual(bk.from, o.from, 'boarding station unchanged');
  assert.strictEqual(bk.to, o.to, 'destination unchanged');
  assert.strictEqual(bk.pax, o.pax, 'party kept together');
  assert.ok(o.paid <= o.cap, 'never more than was blocked');
});

t('the matcher declines rather than bending a rule, and records which one', () => {
  S.reset();
  const d = oDeps();
  const date = '2026-09-17';
  fillTrain('16021', date, 'SL');
  const o = fbOrder({ ...FB, arriveBy: 120 }, d, { date, cap: 5000 });
  S.chart('16021', date, 'SL');
  const r = runMatcher([o], d);
  assert.strictEqual(r.filled.length, 0, 'no rule was bent to make it fit');
  assert.strictEqual(o.status, 'expired');
  assert.strictEqual(o.declined.rule, 'arriveBy', JSON.stringify(o.declined));
  assert.ok(o.declined.n > 0);
  assert.strictEqual(o.pnr, undefined, 'and nothing was booked');
});

t('a waitlist with no fallback is left where it was, and nothing is taken', () => {
  S.reset();
  const d = oDeps();
  const date = '2026-09-18';
  fillTrain('16021', date, 'SL');
  const v = orders.validate(oReq({ train: '16021', classes: ['SL'], cap: 5000, date }), d);
  const o = { ...v.order, id: 'plain', who: 'me@x', status: 'open', openedAt: 1 };
  S.chart('16021', date, 'SL');
  runMatcher([o], d);
  assert.strictEqual(o.status, 'expired');
  assert.strictEqual(o.declined, undefined, 'no rules were written, so none are explained');
  assert.strictEqual(o.pnr, undefined);
});

console.log('\nsos: marking the moment, without holding the footage');
const J = { train: '16021', date: '2026-09-10', cls: 'SL', coach: 'S4', berth: 31, pnr: '4500770355', from: 0, to: 13 };
const at = new Date('2026-09-10T23:14:00+05:30').getTime();

t('the stamp carries what she would otherwise have to type while frightened', () => {
  const r = sos.newAlert({ id: 'a1', who: 'her@x', kind: 'video', journey: J }, at);
  assert.ok(r.ok, r.reason);
  const s = r.alert.stamp;
  assert.strictEqual(s.train, '16021');
  assert.strictEqual(s.coach, 'S4');
  assert.strictEqual(s.berth, 31);
  assert.strictEqual(s.clock, '11:14 PM');
  assert.ok(s.where && /between|after|before/.test(s.where.text), s.where && s.where.text);
  assert.match(sos.lineOf(r.alert), /16021 Kaveri Express .* S4\/31 .* 11:14 PM/);
});

t('khaali never holds the footage, only the note that it exists', () => {
  const a = sos.newAlert({ id: 'a2', who: 'her@x', kind: 'video', journey: J }, at).alert;
  const flat = JSON.stringify(sos.publicOf(a));
  assert.ok(!/blob|base64|data:|dataUrl/i.test(flat), 'nothing that could be media: ' + flat);
  assert.strictEqual(sos.publicOf(a).hasMedia, true, 'but it knows one exists on her phone');
  const mark = sos.newAlert({ id: 'a3', who: 'her@x', kind: 'mark', journey: J }, at).alert;
  assert.strictEqual(sos.publicOf(mark).hasMedia, false, 'and a silent mark has none at all');
  assert.ok(mark.stamp.clock, 'yet it still says when and where');
});

t('capturing is not reporting: an alert is held until she says otherwise', () => {
  const a = sos.newAlert({ id: 'a4', who: 'her@x', kind: 'photo', journey: J }, at).alert;
  assert.strictEqual(a.status, 'held');
  assert.strictEqual(a.ref, undefined, 'nothing has been handed anywhere');
  const r = sos.handOver(a, 'rpf', at + 60000);
  assert.ok(r.ok);
  assert.strictEqual(a.status, 'sent');
  assert.match(a.ref, /^KH-16021-\d{6}$/);
  assert.strictEqual(sos.handOver(a, 'nowhere').reason, 'bad-channel', 'only the two real channels');
});

t('deleted means deleted: the stamp goes too, not just the video', () => {
  const a = sos.newAlert({ id: 'a5', who: 'her@x', kind: 'video', journey: J }, at).alert;
  assert.ok(sos.remove(a, at + 5).ok);
  assert.strictEqual(a.stamp, null);
  assert.strictEqual(a.media, null);
  const pub = sos.publicOf(a);
  assert.strictEqual(pub.status, 'deleted');
  assert.strictEqual(pub.stamp, undefined, 'and there is nothing left to show');
  assert.strictEqual(sos.lineOf(a), '');
  assert.strictEqual(sos.handOver(a, 'rpf').reason, 'deleted', 'a deleted moment cannot be sent');
});

t('a stamp says whether khaali could confirm the journey, or only repeat it', () => {
  const claimed = sos.newAlert({ id: 'v1', who: 'her@x', kind: 'mark', journey: J }, at).alert;
  assert.strictEqual(claimed.stamp.verified, false, 'nobody checked this one');
  const checked = sos.newAlert({ id: 'v2', who: 'her@x', kind: 'mark',
    journey: { ...J, verified: true } }, at).alert;
  assert.strictEqual(checked.stamp.verified, true);
});

t('a woman who never booked through khaali still gets a place on a railway', () => {
  // no train, no pnr, no ticket - only a phone that knows where it is
  const r = sos.newAlert({ id: 'g1', who: 'her@x', kind: 'video',
    journey: { fix: { lat: 12.69, lng: 77.25, acc: 12 } } }, at);
  assert.ok(r.ok);
  const p = r.alert.stamp.place;
  assert.strictEqual(p.text, 'between Ramanagara and Channapatna');
  assert.strictEqual(p.onLine, true);
  assert.match(sos.lineOf(r.alert), /between Ramanagara and Channapatna/);
  assert.ok(!/No train attached/.test(sos.lineOf(r.alert)), 'and it does not dwell on what it lacks');
  // a phone nowhere near the line is told so rather than being placed on it
  const off = sos.placeOf(12.90, 77.90);
  assert.strictEqual(off.onLine, false);
  assert.match(off.text, /km off the line/);
});

t('the trail says which way she is going, which is the point of it', () => {
  const a = sos.newAlert({ id: 'g2', who: 'her@x', kind: 'mark',
    journey: { train: '16021', fix: { lat: 12.7262, lng: 77.2884 } } }, at).alert;
  assert.strictEqual(sos.headingOf(a.trail), 0, 'one fix is not a direction');
  sos.moved(a, { lat: 12.6576, lng: 77.2082 }, at + 60000);   // on towards Mysuru
  assert.strictEqual(sos.headingOf(a.trail), 1);
  assert.strictEqual(a.trail.length, 2);
  const rep = sos.forRpf(a, at + 60000);
  assert.strictEqual(rep.next.station, 'Channapatna', JSON.stringify(rep.next));
  assert.ok(rep.next.at, 'and when the train is due there');
  assert.strictEqual(rep.fixAgeSec, 0, 'with the age of the fix, so nobody trusts a stale one');
  // standing still is not a direction either
  const b = sos.newAlert({ id: 'g3', who: 'h', kind: 'mark', journey: { fix: { lat: 12.5232, lng: 76.8988 } } }, at).alert;
  sos.moved(b, { lat: 12.5233, lng: 76.8989 }, at + 1000);
  assert.strictEqual(sos.headingOf(b.trail), 0);
});

t('a fix that is not a fix is refused rather than plotted', () => {
  const a = sos.newAlert({ id: 'g4', who: 'h', kind: 'mark', journey: {} }, at).alert;
  assert.strictEqual(sos.moved(a, { lat: NaN, lng: 77 }).reason, 'bad-fix');
  assert.strictEqual(sos.moved(a, null).reason, 'bad-fix');
  sos.remove(a, at);
  assert.strictEqual(sos.moved(a, { lat: 12.7, lng: 77.2 }).reason, 'gone',
    'and a deleted moment stops being followed');
  assert.deepStrictEqual(a.trail, [], 'everywhere she had been goes with it');
  assert.strictEqual(a.fix, null);
});

t('the RPF gets a person to meet, or is told plainly that it has not', () => {
  const a = sos.newAlert({ id: 'g5', who: 'her@x', kind: 'video',
    journey: { train: '16021', coach: 'S4', berth: 31, pnr: '450077', verified: true,
      fix: { lat: 12.7262, lng: 77.2884 } } }, at).alert;
  sos.moved(a, { lat: 12.6576, lng: 77.2082 }, at + 60000);
  sos.handOver(a, 'rpf', at + 61000);
  a.contact = { name: 'Achina', phone: '+91 90350 50831', source: 'booking' };
  const rep = sos.forRpf(a, at + 61000);
  assert.strictEqual(rep.contact.name, 'Achina');
  assert.strictEqual(rep.contact.phone, '+91 90350 50831');
  assert.strictEqual(rep.coach, 'S4');
  assert.strictEqual(rep.next.station, 'Channapatna');
  assert.ok(rep.hasMedia, 'they are told footage exists');
  assert.ok(!/blob|base64|data:/i.test(JSON.stringify(rep)), 'but never handed it');

  const bare = sos.newAlert({ id: 'g6', who: 'x@y', kind: 'mark', journey: {} }, at).alert;
  sos.handOver(bare, 'rpf', at);
  bare.contact = { name: null, phone: null, source: 'none' };
  const rep2 = sos.forRpf(bare, at);
  assert.strictEqual(rep2.contact.source, 'none', 'no name is invented');
  assert.strictEqual(rep2.next, null, 'and nowhere is guessed at');
});

t('when the ticket and the phone disagree, the RPF is told, and still given a platform', () => {
  // her ticket says 12691, which runs Bengaluru -> Bangarpet. Her phone says she
  // is at Channapatna heading for Mysuru, which that train never does.
  const a = sos.newAlert({ id: 'd1', who: 'her@x', kind: 'mark',
    journey: { train: '12691', fix: { lat: 12.7262, lng: 77.2884 } } }, at).alert;
  sos.moved(a, { lat: 12.6576, lng: 77.2082 }, at + 60000);
  const rep = sos.forRpf(a, at + 60000);
  assert.strictEqual(rep.next.offRoute, true, 'the disagreement is surfaced');
  assert.ok(rep.next.station, 'and there is still somewhere to stand: ' + rep.next.station);
  assert.strictEqual(rep.next.at, null, 'but no time is taken from a train she is not on');

  // and a journey that does agree keeps its timetable
  const b = sos.newAlert({ id: 'd2', who: 'her@x', kind: 'mark',
    journey: { train: '16021', fix: { lat: 12.7262, lng: 77.2884 } } }, at).alert;
  sos.moved(b, { lat: 12.6576, lng: 77.2082 }, at + 60000);
  const rep2 = sos.forRpf(b, at + 60000);
  assert.strictEqual(rep2.next.offRoute, false);
  assert.ok(rep2.next.at, 'with the time the train is due');
});

t('the footage reaches the RPF only when she files it, and leaves when she deletes', () => {
  const a = sos.newAlert({ id: 'e1', who: 'her@x', kind: 'video',
    journey: { train: '16021', fix: { lat: 12.69, lng: 77.25 } } }, at).alert;
  sos.handOver(a, 'rpf', at);
  assert.strictEqual(sos.forRpf(a, at).evidence, null,
    'held, but khaali has not been given it');
  assert.strictEqual(sos.publicOf(a).filed, false);

  // she files it: only now does khaali hold a picture of anybody
  a.media = { ...a.media, onServer: true, type: 'video/mp4', bytes: 695822, file: 'e1.mp4' };
  const rep = sos.forRpf(a, at);
  assert.deepStrictEqual(rep.evidence,
    { type: 'video/mp4', bytes: 695822, files: [{ type: 'video/mp4', bytes: 695822 }] });

  // several photographs are one report, not several
  const p = sos.newAlert({ id: 'e3', who: 'her@x', kind: 'photo', journey: {} }, at).alert;
  sos.handOver(p, 'rpf', at);
  p.media = { ...p.media, onServer: true, type: 'image/jpeg', bytes: 3000, file: 'e3-0.jpg',
    files: [{ file: 'e3-0.jpg', type: 'image/jpeg', bytes: 1000 },
            { file: 'e3-1.jpg', type: 'image/jpeg', bytes: 2000 }] };
  const rp = sos.forRpf(p, at);
  assert.strictEqual(rp.evidence.files.length, 2);
  assert.ok(!/e3-0\.jpg|"file":/.test(JSON.stringify(rp.evidence)), 'file names stay on the server');
  assert.strictEqual(sos.publicOf(a).filed, true);
  assert.ok(!/blob|base64|data:/i.test(JSON.stringify(rep)),
    'and the report still carries a reference to it, never the bytes');

  sos.remove(a, at + 5);
  assert.strictEqual(a.media, null, 'deleting takes the filed copy with it');
  assert.strictEqual(sos.forRpf(a), null);
});

t('a moment sent to a friend never files anything with anybody', () => {
  const a = sos.newAlert({ id: 'e2', who: 'her@x', kind: 'photo', journey: {} }, at).alert;
  sos.handOver(a, 'trusted', at);
  assert.strictEqual(a.media.onServer, false);
  assert.strictEqual(sos.publicOf(a).filed, false);
});

t('a deleted alert is not a report, however the reference is held', () => {
  const a = sos.newAlert({ id: 'g7', who: 'h', kind: 'mark',
    journey: { train: '16021', fix: { lat: 12.69, lng: 77.25 } } }, at).alert;
  sos.handOver(a, 'rpf', at);
  sos.remove(a, at + 5);
  assert.strictEqual(sos.forRpf(a), null);
  assert.strictEqual(a.contact, null);
});

t('a moment with no journey still works, and says so', () => {
  const r = sos.newAlert({ id: 'a6', who: 'her@x', kind: 'mark', journey: {} }, at);
  assert.ok(r.ok);
  assert.strictEqual(r.alert.stamp.train, null);
  assert.match(sos.lineOf(r.alert), /No train attached/);
  // and a journey that is not real is refused rather than stamped with a lie
  assert.strictEqual(sos.newAlert({ id: 'x', who: 'h', kind: 'mark', journey: { train: '99999' } }).reason, 'unknown-train');
  assert.strictEqual(sos.newAlert({ id: 'x', who: 'h', kind: 'nope', journey: J }).reason, 'bad-kind');
});

console.log('\njourney: the part after the train');

t('the metro data is real, ordered, and says where it came from', () => {
  assert.strictEqual(M.STOPS.length, 23);
  assert.match(M.STOPS[0].n, /Whitefield/);
  assert.match(M.STOPS[22].n, /Majestic/);
  for (let i = 1; i < M.STOPS.length; i++) assert.ok(M.STOPS[i].min > M.STOPS[i - 1].min, 'run times climb');
  assert.ok(M.STOPS[0].kn && /[\u0C80-\u0CFF]/.test(M.STOPS[0].kn), 'Kannada names are there');
  assert.strictEqual(M.LINE.source, 'timetable');
  assert.ok(M.STOPS.every(s => s.crowd.length === 24), 'a crowding figure for every hour');
});

t('the train passenger is sent to the nearest metro, not the namesake', () => {
  const b = JY.boardStop();
  assert.strictEqual(b.stop.id, 'KDGD', 'Kadugodi Tree Park, 150 m away');
  assert.ok(b.km < 0.3, 'not the 1.7 km walk to Whitefield (Kadugodi)');
  assert.ok(b.namesakeKm > 1.5, 'and the difference is on record: ' + b.namesakeKm);
});

t('headways follow BMRCL bands and go dark after the last train', () => {
  assert.strictEqual(JY.headwayAt(JY.headwayAt && 12 * 60), 8, 'midday every 8');
  assert.strictEqual(JY.headwayAt(5 * 60 + 10), 20, 'first trains every 20');
  assert.strictEqual(JY.headwayAt(23 * 60), null, 'nothing after the last train');
  assert.strictEqual(JY.headwayAt(4 * 60), null, 'nothing before the first');
  const nm = JY.nextMetro(23 * 60, 2);
  assert.strictEqual(nm.ok, false);
  assert.strictEqual(nm.reason, 'no-service');
});

t('a plan from a train arrival reads in one breath and adds up', () => {
  const p = JY.plan({ arriveAt: 8 * 60 + 47 });
  assert.ok(p.ok, p.reason);
  assert.strictEqual(p.legs.length, 2);
  assert.strictEqual(p.legs[0].mode, 'walk');
  assert.strictEqual(p.legs[1].mode, 'metro');
  assert.strictEqual(p.legs[1].stops, 20);
  assert.ok(p.legs[1].runMin > 40 && p.legs[1].runMin < 48, 'about 44 minutes: ' + p.legs[1].runMin);
  assert.strictEqual(p.arrive - (8 * 60 + 47), p.totalMin);
  assert.match(p.line, /150 m/);
  assert.match(p.line, /Purple Line every \d+ min/);
  assert.match(p.line, /there by/);
  assert.strictEqual(p.fare.qr, 80);
  assert.strictEqual(p.fare.smartcard, 76, 'peak smartcard fare at 9am');
  assert.strictEqual(p.legs[1].source, 'timetable', 'and it says the metro time is a timetable, not a sighting');
});

t('off-peak is cheaper by card, and the plan says so honestly', () => {
  const p = JY.plan({ arriveAt: 13 * 60 });
  assert.strictEqual(p.fare.peak, false);
  assert.strictEqual(p.fare.smartcard, 72);
  assert.strictEqual(p.fare.qr, 80, 'QR is the same price all day');
});

t('after the last train the plan refuses, and names the first and last', () => {
  const p = JY.plan({ arriveAt: 23 * 60 + 30 });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'no-service');
  assert.match(p.line, /First train 05:00, last 22:45/);
});

t('someone who needs a lift is sent to an entrance that has one', () => {
  const p = JY.plan({ arriveAt: 8 * 60 + 47, needs: ['senior'] });
  assert.ok(p.legs[0].entrance.lift);
  assert.strictEqual(p.legs[0].entrance.stepFree, true);
  assert.match(p.line, /with a lift/);
  const q = JY.plan({ arriveAt: 8 * 60 + 47 });
  assert.strictEqual(q.legs[0].entrance.stepFree, false);
});

t('crowding is the station against its own worst hour', () => {
  const kg = JY.crowdAt('KGWA', 18);
  assert.strictEqual(kg.word, 'crush');
  assert.strictEqual(kg.peakHour, 18);
  const wh = JY.crowdAt('WHTM', 20);
  assert.ok(wh.level < 0.4, 'Whitefield at 8pm is quiet: ' + wh.level);
  assert.strictEqual(wh.word, 'quiet');
  assert.strictEqual(JY.crowdAt('NOPE', 9), null);
});

t('from one metro stop to another there is no walk, and the line reads from there', () => {
  const p = JY.plan({ arriveAt: 9 * 60, from: 'IDN', to: 'KGWA' });
  assert.ok(p.ok, p.reason);
  assert.strictEqual(p.legs.length, 1, 'metro only');
  assert.strictEqual(p.legs[0].from, 'Indiranagar');
  assert.strictEqual(p.legs[0].stops, 7);
  assert.match(p.line, /^Indiranagar/);
  assert.strictEqual(p.namesake, null, 'no railway, no namesake to warn about');
});

t('rail to any stop down the line keeps the walk and stops where asked', () => {
  const p = JY.plan({ arriveAt: 9 * 60, to: 'MAGR' });
  assert.ok(p.ok, p.reason);
  assert.strictEqual(p.legs[0].mode, 'walk');
  assert.strictEqual(p.legs[1].to, 'Mahatma Gandhi Road');
  assert.strictEqual(p.legs[1].stops, 16);
});

t('the wrong way and an unknown stop are refused, not guessed', () => {
  assert.strictEqual(JY.plan({ arriveAt: 9 * 60, from: 'KGWA', to: 'IDN' }).reason, 'wrong-way');
  assert.strictEqual(JY.plan({ arriveAt: 9 * 60, to: 'NOPE' }).reason, 'unknown-stop');
});

console.log('\njourney: several ways, and whether you get to sit');

t('boarding position is the whole answer for a bus', () => {
  const start = JY.seatOdds({ mode: 'bus', at: 2 / 37 });   // stop 3 of 37, zero-based
  assert.strictEqual(start.word, 'yes');
  assert.match(start.why, /where the bus starts/);
  assert.strictEqual(JY.seatOdds({ mode: 'bus', at: 0.2 }).word, 'likely');
  assert.strictEqual(JY.seatOdds({ mode: 'bus', at: 0.5 }).word, 'maybe');
  assert.strictEqual(JY.seatOdds({ mode: 'bus', at: 0.9 }).word, 'standing');
  assert.strictEqual(JY.seatOdds({ mode: 'bus', at: null }).word, 'unknown',
    'and it refuses to guess when it does not know');
});

t('a train is asked the question khaali was built to answer', () => {
  assert.strictEqual(JY.seatOdds({ mode: 'train', free: 86 }).word, 'yes');
  assert.strictEqual(JY.seatOdds({ mode: 'train', free: 3 }).word, 'likely');
  assert.strictEqual(JY.seatOdds({ mode: 'train', free: 0 }).word, 'standing');
  // a metro has no seat to book, so the hour decides
  assert.strictEqual(JY.seatOdds({ mode: 'metro', load: 0.95 }).word, 'standing');
  assert.strictEqual(JY.seatOdds({ mode: 'metro', load: 0.2 }).word, 'likely');
});

t('the real buses between Whitefield and Majestic are found, and start there', () => {
  const list = JY.busesBetween(12.9846, 77.7460, 12.97567, 77.57281);
  assert.ok(list.length >= 3, 'BMTC runs several: ' + list.length);
  const k = list.find(b => b.id === 'KBS-1K');
  assert.ok(k, 'KBS-1K is one of them');
  assert.strictEqual(k.source, 'timetable', 'and it is real, not invented');
  assert.strictEqual(k.boardIdx, 2, 'boarding stop 3 of ' + k.nStops);
  assert.strictEqual(k.seat.word, 'yes');
});

t('the leg with no open data is offered, and says it is simulated', () => {
  const list = JY.busesBetween(12.9908, 78.1770, 12.9846, 77.7460, 2.5);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].source, 'simulated',
    'Bangarpet has no published bus timetable, and khaali says so rather than implying one');
  assert.strictEqual(list[0].seat.word, 'yes', 'it starts at Bangarpet, so she sits');
});

t('Bangarpet to Majestic offers a real choice, not one answer', () => {
  const r = JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' },
    after: 8 * 60, counts: () => 86 });
  assert.ok(r.ok);
  assert.ok(r.chains.length >= 5, 'several ways: ' + r.chains.length);
  const kinds = new Set(r.chains.map(c => c.kind));
  assert.ok(kinds.size >= 3, 'and they are different shapes: ' + [...kinds].join(', '));

  const fastest = r.chains.reduce((p, c) => c.totalMin < p.totalMin ? c : p);
  const seated = r.chains.filter(c => c.seat.word === 'yes');
  assert.ok(seated.length, 'at least one gets her a seat');
  const cheapest = r.chains.reduce((p, c) => c.fare < p.fare ? c : p);
  assert.ok(cheapest.fare < fastest.fare, 'and the cheapest is not the fastest - that is the choice');
  assert.strictEqual(cheapest.seat.word, 'yes', 'the slow cheap way is the one you sit on');
  // every chain is ordered in time and adds up
  r.chains.forEach(c => {
    assert.ok(c.totalMin > 0 && c.totalMin < 400, c.kind + ' takes ' + c.totalMin + ' min');
    assert.ok(c.legs.length >= 1);
    assert.ok(c.modes.length >= 1);
  });
});

t('the mode chips actually decide what is offered', () => {
  const q = m => JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' },
    after: 8 * 60, modes: m, counts: () => 86 });
  const busOnly = q(['bus']);
  assert.ok(busOnly.chains.length, 'buses alone can do it');
  assert.ok(busOnly.chains.every(c => c.modes.every(x => x === 'bus')), 'and only buses are used');
  const noBus = q(['train', 'metro']);
  assert.ok(noBus.chains.every(c => !c.modes.includes('bus')));
  assert.strictEqual(q([]).chains.length, 0, 'nothing chosen, nothing offered');
});

t('reach by cuts off what arrives too late, and never invents a faster one', () => {
  const all = JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' }, after: 8 * 60 });
  const by10 = JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' },
    after: 8 * 60, by: 10 * 60 });
  assert.ok(by10.chains.length < all.chains.length);
  assert.ok(by10.chains.every(c => c.arr <= 10 * 60));
});

t('two trains leaving together by the same route are one choice, not two', () => {
  const r = JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' }, after: 8 * 60 });
  const keys = r.chains.map(c => c.kind + '|' + c.depText + '|' + c.arrText);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate rows');
});

t('a chain carries the worst seat on it, not the best', () => {
  const r = JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' },
    after: 8 * 60, counts: () => 86 });
  const mixed = r.chains.find(c => c.kind === 'train+metro');
  assert.ok(mixed, 'the train is seated and the metro at Majestic is not');
  assert.strictEqual(mixed.seat.word, 'standing',
    'so the journey says standing - a seat you lose halfway is not a seat');
});

t('a pass is a right to ride, not a seat: scanned, never used up', () => {
  const r = JY.newPass({ id: 'p1', who: 'her@x', date: '2026-09-10', holder: 'Achina' }, at);
  assert.ok(r.ok);
  const p = r.pass;
  assert.deepStrictEqual(p.covers, ['metro', 'bmtc']);
  const day = new Date('2026-09-10T09:00:00+05:30').getTime();
  assert.ok(JY.scan(p, { by: 'gate', mode: 'metro', where: 'KDGD' }, day).ok);
  assert.ok(JY.scan(p, { by: 'conductor 4471', mode: 'bmtc', where: '500D' }, day + 3600000).ok);
  assert.ok(JY.scan(p, { by: 'conductor 2210', mode: 'bmtc', where: '335E' }, day + 7200000).ok, 'a third ride is still fine');
  assert.strictEqual(p.rides.length, 3);
  assert.strictEqual(JY.publicOf(p).rides, 3);
});

t('the same door twice in a minute is one tap, not two rides', () => {
  const p = JY.newPass({ id: 'p2', who: 'h', date: '2026-09-10' }, at).pass;
  const day = new Date('2026-09-10T09:00:00+05:30').getTime();
  JY.scan(p, { by: 'gate', mode: 'metro', where: 'KDGD' }, day);
  const again = JY.scan(p, { by: 'gate', mode: 'metro', where: 'KDGD' }, day + 20000);
  assert.strictEqual(again.repeat, true);
  assert.strictEqual(p.rides.length, 1);
});

t('a pass refuses the wrong day, a mode it never covered, and a cancelled one', () => {
  const p = JY.newPass({ id: 'p3', who: 'h', date: '2026-09-10', covers: ['metro'] }, at).pass;
  const day = new Date('2026-09-10T09:00:00+05:30').getTime();
  assert.strictEqual(JY.scan(p, { mode: 'bmtc' }, day).reason, 'not-covered');
  assert.strictEqual(JY.scan(p, { mode: 'metro' }, day + 86400000).reason, 'wrong-day');
  assert.strictEqual(JY.scan(p, { mode: 'auto' }, day).reason, 'bad-mode');
  JY.cancelPass(p, day);
  assert.strictEqual(JY.scan(p, { mode: 'metro' }, day).reason, 'cancelled');
  assert.strictEqual(JY.newPass({ id: 'x', who: 'h', date: '2026-09-10', covers: ['auto'] }).reason, 'no-modes');
});

t('a trip pass covers this trip: the modes on it, and no others', () => {
  const p = JY.newTripPass({ id: 't1', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'bus', name: 'BMTC 500D', from: 'Hope Farm', to: 'Kempegowda Bus Station', fare: 35 }] }, at).pass;
  assert.strictEqual(p.kind, 'trip');
  assert.deepStrictEqual(p.covers, ['bmtc']);
  const day = new Date('2026-09-10T09:00:00+05:30').getTime();
  assert.strictEqual(JY.scan(p, { mode: 'metro' }, day).reason, 'not-covered',
    'no metro leg on this journey, so no metro on this pass');
});

t('a trip pass costs what its legs cost, not a flat day', () => {
  const p = JY.newTripPass({ id: 't2', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'bus', from: 'a', to: 'b', fare: 35 },
      { mode: 'metro', from: 'Whitefield (Kadugodi)', to: 'Majestic', fare: 80 }] }, at).pass;
  assert.strictEqual(p.fare, 115);
  assert.notStrictEqual(p.fare, JY.newPass({ id: 'd', who: 'h', date: '2026-09-10' }, at).pass.fare,
    'the day pass price is not the trip price');
  assert.deepStrictEqual(p.covers, ['bmtc', 'metro']);
  assert.strictEqual(JY.publicOf(p).legsLeft, 2);
});

t('a trip pass is spent by the trip: each named ride once, then it is done', () => {
  const p = JY.newTripPass({ id: 't3', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'bus', name: 'BMTC KIA-9', from: 'Kempegowda Bus Station', to: 'CBI', fare: 35 },
      { mode: 'metro', from: 'c', to: 'd', fare: 80 }] }, at).pass;
  const day = new Date('2026-09-10T09:00:00+05:30').getTime();
  const one = JY.scan(p, { by: 'conductor', mode: 'bmtc', where: 'KIA-9' }, day);
  assert.ok(one.ok); assert.strictEqual(one.spent, false, 'the metro is still ahead of her');
  assert.strictEqual(one.leg.to, 'CBI', 'the door crossed off a named ride, not a count');
  assert.ok(p.legs[0].ridden); assert.strictEqual(p.legs[1].ridden, null);
  assert.strictEqual(p.status, 'valid');
  // a second bus on the same ticket is refused: that ride is behind her
  assert.strictEqual(JY.scan(p, { mode: 'bmtc', where: 'somewhere else' }, day + 3600000).reason, 'leg-done');
  const two = JY.scan(p, { by: 'gate', mode: 'metro', where: 'KGWA' }, day + 5400000);
  assert.ok(two.ok); assert.strictEqual(two.spent, true);
  assert.strictEqual(p.status, 'used');
  assert.strictEqual(JY.scan(p, { mode: 'bmtc' }, day + 7200000).reason, 'used',
    'the trip has been travelled; the ticket is over');
  assert.strictEqual(JY.publicOf(p).legsLeft, 0);
});

t('the ticket is the trip, not the departure: a missed bus costs nothing', () => {
  const p = JY.newTripPass({ id: 't3b', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'bus', name: 'BMTC KIA-9', from: 'Kempegowda Bus Station', to: 'CBI', fare: 35 }] }, at).pass;
  const one = new Date('2026-09-10T13:00:00+05:30').getTime();
  const halfPast = new Date('2026-09-10T13:30:00+05:30').getTime();
  // she is not on the 13:00. Nothing happens to the ticket: it was never that bus.
  assert.strictEqual(p.status, 'valid');
  assert.strictEqual(JY.nextLeg(p, 'bmtc').to, 'CBI');
  const r = JY.scan(p, { by: 'conductor', mode: 'bmtc' }, halfPast);
  assert.ok(r.ok, 'the half past is the same ticket as the one she missed');
  assert.strictEqual(r.spent, true, 'and it gets her there, so it is over');
  assert.ok(one < halfPast);
});

t('a double tap at one gate does not burn a leg of the trip', () => {
  const p = JY.newTripPass({ id: 't4', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'bus', from: 'a', to: 'b', fare: 35 },
      { mode: 'metro', from: 'c', to: 'd', fare: 80 }] }, at).pass;
  const day = new Date('2026-09-10T09:00:00+05:30').getTime();
  JY.scan(p, { by: 'gate', mode: 'metro', where: 'KGWA' }, day);
  const again = JY.scan(p, { by: 'gate', mode: 'metro', where: 'KGWA' }, day + 20000);
  assert.strictEqual(again.repeat, true);
  assert.strictEqual(p.rides.length, 1);
  assert.strictEqual(p.legs.filter(l => l.ridden).length, 1, 'one tap, one leg crossed off');
  assert.strictEqual(p.status, 'valid', 'the bus is still to come');
});

t('the fare on a trip pass is khaali’s, not the phone’s', () => {
  const r = JY.priceTripLegs([
    { mode: 'metro', fromId: 'KDGD', toId: 'KGWA', from: 'lies', to: 'more lies', fare: 1 },
    { mode: 'bus', id: 'V-335E', name: 'BMTC V-335E', from: 'Hope Farm', to: 'Kempegowda Bus Station', fare: 1 },
  ]);
  assert.ok(r.ok);
  assert.strictEqual(r.legs[0].fare, 80, 'the metro fare is the published one');
  assert.ok(r.legs[0].from.includes('Kadugodi'), 'the stop names come from the line, not the body');
  assert.ok(r.legs[1].fare > 1, 'a bus fare of one rupee was not believed');
  assert.strictEqual(r.legs.reduce((n, l) => n + l.fare, 0), JY.newTripPass({ id: 'q', who: 'h', date: '2026-09-10', legs: r.legs }).pass.fare);
});

t('a bus khaali does not run is left off the pass, and said so', () => {
  const r = JY.priceTripLegs([
    { mode: 'bus', id: 'KSRTC BNG-BLR', name: 'KSRTC', from: 'Bangarpet Bus Stand', to: 'Whitefield / Hope Farm' },
    { mode: 'metro', fromId: 'KDGD', toId: 'KGWA' },
  ]);
  assert.ok(r.ok);
  assert.strictEqual(r.legs.length, 1, 'only the metro is on the pass');
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(r.skipped[0].why, 'not-bmtc');
  // and a journey that is ONLY that bus has no pass to sell at all
  const only = JY.priceTripLegs([{ mode: 'bus', id: 'KSRTC BNG-BLR', from: 'a', to: 'b' }]);
  assert.strictEqual(only.ok, false);
  assert.ok(/counter/.test(only.error));
});

t('a platform is not a different bus station', () => {
  JY.useBmtc(BM);                       // the server does this at boot
  // "Kempegowda Bus Station - Platform 30" is how a BMTC leg names the place a
  // bus actually leaves from. khaali used to say it had never heard of it.
  const s = BM.stopNamed('Kempegowda Bus Station - Platform 30');
  assert.ok(s, 'the station with thirty platforms is still the station');
  assert.strictEqual(s.name, 'Kempegowda Bus Station');
  const r = JY.priceTripLegs([{ mode: 'bus', name: 'BMTC KIA-9',
    from: 'Kempegowda Bus Station - Platform 30', to: 'CBI' }]);
  assert.ok(r.ok, 'and a ride from it can be priced');
  assert.ok(r.legs[0].fare > 0);
});

t('a bus leg is priced off its own route, not off two names', () => {
  const opts = BM.directBus({ fromLat: 12.97751, fromLng: 77.57141, toLat: 12.99191, toLng: 77.7158, after: 600, limit: 1 });
  assert.ok(opts.length, 'the city has a bus from Majestic to Hoodi');
  const l = opts[0].legs.find(x => x.mode === 'bus');
  const found = BM.legFound({ route: l.id, boardIdx: l.boardIdx, nStops: l.nStops, stops: l.stops });
  assert.ok(found, 'the route and its two indices find the leg again');
  assert.strictEqual(found.fare, l.fare, 'and price it exactly as the planner did');
  const r = JY.priceTripLegs([{ mode: 'bus', id: l.id, name: l.name,
    from: 'nonsense', to: 'more nonsense', boardIdx: l.boardIdx, nStops: l.nStops, stops: l.stops }]);
  assert.ok(r.ok);
  assert.strictEqual(r.legs[0].fare, l.fare);
  assert.strictEqual(r.legs[0].from, found.from.name, 'the stop names came from BMTC, not from the body');
  // indices that are not in the pattern find nothing at all
  assert.strictEqual(BM.legFound({ route: l.id, boardIdx: 9999, nStops: l.nStops, stops: 1 }), null);
  assert.strictEqual(BM.legFound({ route: 'NO-SUCH-ROUTE', boardIdx: 0, stops: 1 }), null);
});

t('a leg khaali cannot place is refused, never guessed at', () => {
  assert.strictEqual(JY.priceTripLegs([{ mode: 'metro', fromId: 'NOPE', toId: 'KGWA' }]).ok, false);
  assert.strictEqual(JY.priceTripLegs([{ mode: 'metro', fromId: 'KGWA', toId: 'KGWA' }]).ok, false);
  assert.strictEqual(JY.priceTripLegs([{ mode: 'bus', from: 'Nowhere At All Road', to: 'Also Nowhere' }]).ok, false);
  assert.strictEqual(JY.priceTripLegs([{ mode: 'train', from: 'a', to: 'b' }]).ok, false);
  assert.strictEqual(JY.priceTripLegs([]).ok, false);
});

t('a trip pass refuses a leg it cannot price, and a train it does not sell', () => {
  assert.strictEqual(JY.newTripPass({ id: 'x', who: 'h', date: '2026-09-10', legs: [] }).reason, 'no-legs');
  assert.strictEqual(JY.newTripPass({ id: 'x', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'train', from: 'a', to: 'b', fare: 110 }] }).reason, 'bad-leg');
  assert.strictEqual(JY.newTripPass({ id: 'x', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'bus', from: 'a', to: 'b' }] }).reason, 'unpriced-leg');
  assert.strictEqual(JY.newTripPass({ id: 'x', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'walk', from: 'a', to: 'b', fare: 0 }] }).reason, 'bad-leg');
});

t('the wrong day and a cancelled pass still refuse a trip pass', () => {
  const p = JY.newTripPass({ id: 't5', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'metro', from: 'c', to: 'd', fare: 80 }] }, at).pass;
  const day = new Date('2026-09-10T09:00:00+05:30').getTime();
  assert.strictEqual(JY.scan(p, { mode: 'metro' }, day + 86400000).reason, 'wrong-day');
  JY.cancelPass(p, day);
  assert.strictEqual(JY.scan(p, { mode: 'metro' }, day).reason, 'cancelled');
});

console.log('\nallocation: which way, and why - on a network that does not exist');

// A -> B -> C -> D. A direct train A->D, a bus A->B, a train B->D. Every
// number here is made up on purpose: the allocator must be right about a
// network it has never seen, or it is not right about Bengaluru either.
function golden({ directOcc = 0.2, busOcc = 0.2, feederOcc = 0.2, directMin = 60, viaMin = 66,
  directSeat = 'yes', busSeat = 'yes', feederSeat = 'yes', unknownDirect = false } = {}) {
  const seat = w => ({ yes: { word: 'yes', rank: 3 }, likely: { word: 'likely', rank: 2 },
    maybe: { word: 'maybe', rank: 1 }, standing: { word: 'standing', rank: 0 } })[w];
  const cap = (occ, q, unk) => ({ occupancy: unk ? null : occ, capacity: 100,
    quality: unk ? 'unknown' : q, source: 'golden' });
  const direct = { kind: 'train', legs: [{ mode: 'train', name: 'Direct', from: 'A', to: 'D', min: directMin,
      seat: seat(directSeat), cap: cap(directOcc, 'exact', unknownDirect) }],
    dep: 480, arr: 480 + directMin, totalMin: directMin, fare: 100, changes: 0, modes: ['train'],
    seat: seat(directSeat), depText: '08:00', arrText: '09:00' };
  const worst = [seat(busSeat), seat(feederSeat)].reduce((p, c) => c.rank < p.rank ? c : p);
  const via = { kind: 'bus+train', legs: [
      { mode: 'bus', name: 'Bus AB', from: 'A', to: 'B', min: 30, seat: seat(busSeat), cap: cap(busOcc, 'estimated') },
      { mode: 'train', name: 'Feeder', from: 'B', to: 'D', min: viaMin - 30, seat: seat(feederSeat), cap: cap(feederOcc, 'exact') }],
    dep: 480, arr: 480 + viaMin, totalMin: viaMin, fare: 80, changes: 1, modes: ['bus', 'train'],
    seat: worst, depText: '08:00', arrText: '09:06' };
  return [direct, via];
}
const recOf = (chains, opts) => { const a = AL.allocate(chains, opts); return a.chains[a.recommended].kind; };

t('an empty direct train wins over a change', () => {
  assert.strictEqual(recOf(golden()), 'train');
  const a = AL.allocate(golden());
  assert.strictEqual(a.reason.primary, 'FASTEST');
  assert.ok(a.chains[0].alloc.labels.includes('recommended'));
});

t('a full direct train loses to a bus and an emptier train, six minutes slower', () => {
  const g = golden({ directOcc: 0.92, directSeat: 'standing', busOcc: 0.4, feederOcc: 0.5 });
  assert.strictEqual(recOf(g), 'bus+train');
  const a = AL.allocate(g);
  assert.ok(a.reason.reasons.includes('LOWER_CROWDING'));
  assert.ok(a.reason.reasons.includes('BETTER_SEAT'));
  assert.strictEqual(a.reason.facts.timeDifferenceMinutes, 6);
  assert.strictEqual(a.reason.facts.crowdingDifference, 'lower');
  assert.match(AL.sentence(a.reason), /6 minutes slower/);
  assert.match(AL.sentence(a.reason), /seat/);
});

t('but never more than the limit slower, however full the train', () => {
  const g = golden({ directOcc: 0.95, directSeat: 'standing', viaMin: 100 });
  assert.strictEqual(recOf(g), 'train', 'forty minutes of her morning are not the network to spend');
  const a = AL.allocate(g);
  assert.ok(a.chains[1].alloc.overLimit.includes('SLOWER_THAN_LIMIT'));
  const b = AL.allocate(g, { limits: { extraMin: 60 } });
  assert.ok(b.chains[1].alloc.candidate, 'with the limit raised it is at least a candidate');
  assert.strictEqual(b.chains[b.recommended].kind, 'train', 'and still loses: forty minutes is forty minutes');
});

t('when the bus is full too, the direct train is back', () => {
  const g = golden({ directOcc: 0.9, directSeat: 'standing', busOcc: 0.95, busSeat: 'standing', feederOcc: 0.9, feederSeat: 'standing' });
  assert.strictEqual(recOf(g), 'train');
});

t('five minutes faster is not enough to stand for an hour', () => {
  const g = golden({ directOcc: 0.9, directSeat: 'standing', busOcc: 0.3, feederOcc: 0.3, viaMin: 65 });
  assert.strictEqual(recOf(g), 'bus+train');
  assert.strictEqual(recOf(g, { profile: 'fastest' }), 'train', 'unless she only cares about the clock');
});

t('a hard constraint is not a preference', () => {
  const g = golden({ directOcc: 0.95, directSeat: 'standing', busOcc: 0.2, feederOcc: 0.2 });
  assert.strictEqual(recOf(g, { maxChanges: 0 }), 'train');
  const a = AL.allocate(g, { maxChanges: 0 });
  assert.ok(a.chains[1].alloc.broken.includes('TOO_MANY_CHANGES'));
});

t('unknown is not zero, and the confidence says so', () => {
  const g = golden({ unknownDirect: true });
  const a = AL.allocate(g);
  const p = a.chains[0].alloc.pressure;
  assert.strictEqual(a.chains[0].legs[0].cap.occupancy, null);
  assert.ok(p.value > 0.2, 'an unknown leg is scored as half full, not empty: ' + p.value);
  assert.strictEqual(p.word, 'LOW');
  assert.match(AL.sentence(a.reason), /unknown/);
});

t('leave after eight means the clock starts at eight', () => {
  const g = golden();
  const late = { ...g[0], kind: 'late-train', dep: 630, arr: 690, totalMin: 60 };   // 10:30, same 60 min
  const early = { ...g[0], kind: 'early-train', dep: 480, arr: 585, totalMin: 105 };
  const a = AL.allocate([late, early], { after: 480 });
  assert.strictEqual(a.chains[a.recommended].kind, 'early-train', 'she is there at 9:45, not 11:30');
  assert.ok(a.chains[1].alloc.labels.includes('fastest'));
  assert.strictEqual(AL.span(late, { after: 480 }), 210);
  const b = AL.allocate([late, early], { by: 720 });
  assert.strictEqual(b.chains[b.recommended].kind, 'late-train', 'reach by noon: leave as late as you can');
});

t('the profile moves the line, but there is always a line', () => {
  const g = golden({ directOcc: 0.95, directSeat: 'standing', busOcc: 0.2, feederOcc: 0.2, viaMin: 100 });
  assert.strictEqual(recOf(g), 'train');
  assert.strictEqual(recOf(g, { profile: 'cheapest' }), 'bus+train', 'sixty minutes is allowed when money is the point');
  assert.ok(AL.allocate(golden({ viaMin: 200 }), { profile: 'cheapest' }).chains[1].alloc.overLimit.length);
});

t('capacity snapshots say what they know and how', () => {
  const tr = CAP.snapshot({ mode: 'train' }, { free: 10, total: 100 });
  assert.strictEqual(tr.quality, 'exact'); assert.strictEqual(tr.occupancy, 0.9);
  const bus = CAP.snapshot({ mode: 'bus', source: 'timetable' }, { boardIdx: 2, nStops: 37 });
  assert.strictEqual(bus.quality, 'estimated'); assert.ok(bus.occupancy < 0.1);
  const late = CAP.snapshot({ mode: 'bus' }, { boardIdx: 30, nStops: 37 });
  assert.ok(late.occupancy >= 0.99);
  const m = CAP.snapshot({ mode: 'metro' }, { level: 0.8 });
  assert.strictEqual(m.quality, 'predicted');
  const u = CAP.snapshot({ mode: 'train' }, {});
  assert.strictEqual(u.quality, 'unknown'); assert.strictEqual(u.occupancy, null);
  const sim = CAP.snapshot({ mode: 'bus', source: 'simulated' }, { boardIdx: 0, nStops: 18 });
  assert.ok(sim.simulated); assert.match(sim.source, /simulated/);
});

t('one more passenger moves the number, and the move is shown', () => {
  const g = golden({ directOcc: 0.9 });
  const im = CAP.impact(g[0]);
  assert.strictEqual(im[0].before, 90); assert.strictEqual(im[0].after, 91);
  const a = AL.allocate(g);
  assert.ok(Array.isArray(a.reason.impact) && a.reason.impact.length, 'and the recommendation carries its own');
});

t('the real corridor: Bangarpet to Majestic gets a recommendation with a reason', () => {
  const r = JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' }, after: 480,
    counts: () => 5 });                                     // every train nearly full
  CAP.annotate(r.chains, { trainCap: () => ({ free: 5, total: 72 }) });
  const a = AL.allocate(r.chains);
  assert.ok(a.recommended != null);
  assert.ok(a.reason.reasons.length);
  const rec = a.chains[a.recommended];
  assert.ok(rec.totalMin - Math.min(...r.chains.map(c => c.totalMin)) <= AL.LIMITS.extraMin);
  assert.ok(AL.trace(a.chains).every(x => typeof x.total === 'number'));
  assert.ok(r.chains.every(c => c.legs.filter(l => l.mode !== 'walk').every(l => l.cap && CAP.QUALITY.includes(l.cap.quality))));
});

console.log('\nintelligence: it reads, it phrases, it never invents');

t('a sentence becomes a request without any model at all', async () => {
  const r = await IN.parseIntent('I need to reach Majestic by 9 from Bangarpet, not much walking');
  assert.strictEqual(r.provider, 'local');
  assert.deepStrictEqual(r.resolved.to, { kind: 'metro', id: 'KGWA', name: 'Nadaprabhu Kempegowda Station, Majestic' });
  assert.strictEqual(r.resolved.from.id, 'BWT');
  assert.deepStrictEqual(r.request.timeConstraint, { type: 'ARRIVE_BY', value: '09:00' });
  assert.strictEqual(r.request.preferences.minimizeWalking, true);
  assert.strictEqual(r.request.profile, 'comfortable');
  assert.deepStrictEqual(r.unresolved, []);
  assert.match(r.understood, /reach by 09:00/);
});

t('modes, changes, seats, lifts and evenings are all read', async () => {
  let r = await IN.parseIntent('only trains from whitefield to majestic after 5 pm');
  assert.deepStrictEqual(r.request.modes, ['train']);
  assert.deepStrictEqual(r.request.timeConstraint, { type: 'LEAVE_AFTER', value: '17:00' });
  assert.strictEqual(r.resolved.from.id, 'WFD');
  r = await IN.parseIntent('to Indiranagar by 6, no bus, at most one change, I want a seat');
  assert.deepStrictEqual(r.request.modes, ['train', 'metro']);
  assert.strictEqual(r.request.timeConstraint.value, '18:00', 'six is the evening unless she says am');
  assert.strictEqual(r.request.maxChanges, 1);
  assert.strictEqual(r.request.preferences.wantSeat, true);
  r = await IN.parseIntent('I am travelling with my grandmother to MG Road, cheapest');
  assert.deepStrictEqual(r.request.needs, ['step-free']);
  assert.strictEqual(r.request.profile, 'cheapest');
  assert.strictEqual(r.resolved.to.id, 'MAGR');
});

t('what it cannot place, it says, rather than guessing', async () => {
  const r = await IN.parseIntent('get me to Hebbal by 10');
  assert.strictEqual(r.resolved.to, null);
  assert.ok(r.unresolved.some(u => /Hebbal/.test(u)));
});

t('a model may fill gaps; it may not override what was read, and junk is dropped', async () => {
  const llm = async () => JSON.stringify({ origin: { text: 'Bangarpet' }, destination: { text: 'Majestic' },
    timeConstraint: { type: 'ARRIVE_BY', value: '25:99' }, modes: ['train', 'rocket'], maxTransfers: 9,
    preferences: { minimizeWalking: 'yes', wantSeat: true }, profile: 'network' });
  const r = await IN.parseIntent('by 9 to majestic', { llm });
  assert.strictEqual(r.provider, 'model');
  assert.strictEqual(r.resolved.from.id, 'BWT', 'the model filled the origin the sentence lacked');
  assert.strictEqual(r.request.timeConstraint.value, '09:00', 'the sentence said nine; the model said nonsense');
  assert.deepStrictEqual(r.request.modes, ['train'], 'rockets are not a mode');
  assert.strictEqual(r.request.maxChanges, null, 'nine changes is not a constraint');
  assert.strictEqual(r.request.preferences.minimizeWalking, undefined, 'a string is not a boolean');
  assert.strictEqual(r.request.preferences.wantSeat, true);
  const broken = await IN.parseIntent('to majestic by 9', { llm: async () => 'not json at all' });
  assert.strictEqual(broken.provider, 'local', 'a model that fails costs nothing');
  assert.strictEqual(broken.resolved.to.id, 'KGWA');
});

t('an explanation may phrase the facts and may not add a number', async () => {
  const reason = { reasons: ['LOWER_CROWDING', 'BETTER_SEAT', 'ONLY_MINUTES_SLOWER'], confidence: 0.8,
    facts: { timeDifferenceMinutes: 6, recommendedMinutes: 66, fastestMinutes: 60, fareDifference: -20, recommendedFare: 80,
      cheapestFare: 80, changes: 1, seat: 'yes', seatWhy: 'you board where the bus starts', fastestSeat: 'standing',
      crowdingDifference: 'lower', networkPressure: 0.2, fastestPressure: 0.85, capacityConfidence: 'HIGH', simulated: false, modes: ['bus', 'train'] },
    impact: [] };
  const none = await IN.explain(reason);
  assert.strictEqual(none.provider, 'template');
  assert.match(none.text, /6 minutes slower/);
  const good = await IN.explain(reason, { llm: async () => 'It is 6 minutes slower but you get a seat and avoid the crowded train.' });
  assert.strictEqual(good.provider, 'model');
  const liar = await IN.explain(reason, { llm: async () => 'It is 6 minutes slower and the train is 95% full.' });
  assert.strictEqual(liar.provider, 'template', '95 is in none of the facts, so the sentence is thrown away');
  const dead = await IN.explain(reason, { llm: async () => { throw new Error('quota'); } });
  assert.strictEqual(dead.provider, 'template');
});

t('a question is answered from the journey, with or without a model', async () => {
  const r = JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' }, after: 480, counts: () => 50 });
  CAP.annotate(r.chains, { trainCap: () => ({ free: 50, total: 72 }) });
  const a = AL.allocate(r.chains, { after: 480 });
  const chain = a.chains[a.recommended];
  const seat = await IN.ask('will I get a seat?', { chain, reason: a.reason });
  assert.strictEqual(seat.provider, 'template');
  assert.ok(/seat|stand|likely|yes/i.test(seat.text));
  const crowd = await IN.ask('how crowded is it', { chain, reason: a.reason });
  assert.match(crowd.text, /% full/);
  const why = await IN.ask('why this way?', { chain, reason: a.reason });
  assert.ok(why.text.length > 10);
  const m = await IN.ask('why?', { chain, reason: a.reason, llm: async () => 'Because it arrives at ' + chain.arrText + ' and the fare is ' + chain.fare + ' rupees.' });
  assert.strictEqual(m.provider, 'model');
  const liar = await IN.ask('why?', { chain, reason: a.reason, llm: async () => 'Because train 99999 is faster.' });
  assert.strictEqual(liar.provider, 'template', 'a train the facts never mentioned is an invention');
  const empty = await IN.ask('why?', {});
  assert.match(empty.text, /Plan a journey first/);
});

t('places resolve the way people say them', () => {
  assert.strictEqual(IN.resolvePlace('Majestic').id, 'KGWA');
  assert.strictEqual(IN.resolvePlace('bangarapet').id, 'BWT');
  assert.strictEqual(IN.resolvePlace('KR Puram').id, 'KJM');
  assert.strictEqual(IN.resolvePlace('Mysore').id, 'MYS');
  assert.strictEqual(IN.resolvePlace('ITPL').kind, 'metro');
  assert.strictEqual(IN.resolvePlace('Timbuktu'), null);
});

console.log('\nsimulation: ten thousand people, twice');

// the golden network again, but now with vehicles: a direct train that is
// already busy, and a bus + feeder that are not
function goldenCandidates({ directOcc = 0.8, busOcc = 0.1, feederOcc = 0.2 } = {}) {
  return t => {
    const seat = w => ({ yes: { word: 'yes', rank: 3 }, standing: { word: 'standing', rank: 0 } })[w];
    const cap = (occ, q, capacity) => ({ occupancy: occ, capacity, quality: q, source: 'golden' });
    const dep = t + 10;
    return [
      { kind: 'train', legs: [{ mode: 'train', id: 'D', name: 'Direct', from: 'A', to: 'D', min: 60, depMin: dep, seat: seat(directOcc > 0.7 ? 'standing' : 'yes'), cap: cap(directOcc, 'exact', 400) }],
        dep, arr: dep + 60, totalMin: 60, fare: 100, changes: 0, modes: ['train'], seat: seat(directOcc > 0.7 ? 'standing' : 'yes'), depText: 'x', arrText: 'y' },
      { kind: 'bus+train', legs: [
          { mode: 'bus', id: 'B1', name: 'Bus AB', from: 'A', to: 'B', min: 30, depMin: dep, seat: seat('yes'), cap: cap(busOcc, 'estimated', 75) },
          { mode: 'train', id: 'F', name: 'Feeder', from: 'B', to: 'D', min: 36, depMin: dep + 35, seat: seat('yes'), cap: cap(feederOcc, 'exact', 400) }],
        dep, arr: dep + 71, totalMin: 71, fare: 80, changes: 1, modes: ['bus', 'train'], seat: seat('yes'), depText: 'x', arrText: 'y' },
    ];
  };
}

t('the baseline piles everyone onto the fastest way; the allocator spreads them', () => {
  const r = SIM.simulate({ candidates: goldenCandidates(), n: 1000, start: 480, end: 540 });
  assert.strictEqual(r.baseline.assigned, 1000);
  assert.strictEqual(r.baseline.modeSplit.bus || 0, 0, 'nobody takes a bus when only the clock counts');
  assert.ok((r.allocated.modeSplit.bus || 0) > 20, 'the allocator moves a real share to the bus: ' + JSON.stringify(r.allocated.modeSplit));
  assert.ok(r.allocated.peakOccupancy <= r.baseline.peakOccupancy, 'and the worst vehicle is no fuller');
  assert.ok(r.allocated.trainOccupancy < r.baseline.trainOccupancy, 'the trains are emptier: ' + r.allocated.trainOccupancy + ' vs ' + r.baseline.trainOccupancy);
  assert.ok(r.allocated.overloadedVehicles <= r.baseline.overloadedVehicles);
  assert.ok(r.delta.averageMinutes <= AL.LIMITS.extraMin, 'at a cost that stays inside the line');
  assert.match(r.finding, /1,000 people/);
});

t('the allocator does not empty the train either - it fills the bus until the bus is the crowd', () => {
  const r = SIM.simulate({ candidates: goldenCandidates({ directOcc: 0.9 }), n: 1200, start: 480, end: 540 });
  assert.ok((r.allocated.modeSplit.train || 0) > 0);
  assert.ok((r.allocated.modeSplit.bus || 0) > 0);
  assert.ok(r.allocated.busOccupancy <= 100);
  assert.ok(r.baseline.peakOccupancy <= 100, 'nobody is put on a vehicle that cannot take them: ' + r.baseline.peakOccupancy);
  // and when there is simply not enough room, it says so rather than hiding it
  const crush = SIM.simulate({ candidates: goldenCandidates({ directOcc: 0.9 }), n: 5000, start: 480, end: 540 });
  assert.ok(crush.baseline.peakOccupancy > 100, 'five thousand an hour do not fit, and the number shows it');
  assert.ok(crush.allocated.peakOccupancy >= 100);
});

t('an empty direct train needs no allocator, and the finding says so', () => {
  const r = SIM.simulate({ candidates: goldenCandidates({ directOcc: 0.05 }), n: 500, start: 480, end: 500 });
  assert.strictEqual(r.allocated.modeSplit.bus || 0, 0);
  assert.match(r.finding, /changes nothing/);
});

t('it is deterministic, and it does not run the same minute twice', () => {
  let calls = 0;
  const c = goldenCandidates(); const counting = t => { calls++; return c(t); };
  const a = SIM.simulate({ candidates: counting, n: 3000, start: 480, end: 540 });
  const b = SIM.simulate({ candidates: counting, n: 3000, start: 480, end: 540 });
  assert.deepStrictEqual(a.allocated, b.allocated);
  assert.strictEqual(calls, 24, 'twelve five-minute buckets per simulate, cached across baseline and allocated');
});

t('the real corridor: a morning at Bangarpet', () => {
  const candidates = t => {
    const r = JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'metro', id: 'KGWA' }, after: t, counts: () => 30 });
    return CAP.annotate(r.chains, { trainCap: () => ({ free: 30, total: 432 }) });
  };
  const r = SIM.simulate({ candidates, n: 10000, start: 480, end: 540 });
  assert.strictEqual(r.baseline.assigned + r.baseline.unserved, 10000);
  assert.ok(r.baseline.assigned > 0);
  assert.ok(r.allocated.peakOccupancy <= r.baseline.peakOccupancy + 0.01);
  assert.ok(typeof r.finding === 'string' && r.finding.length > 20);
});

console.log('\nanywhere: a place on the map, and the words people actually use');

const HEBBAL = { lat: 13.0358, lng: 77.5970 };
const fakeGeo = async q => /hebbal/i.test(q) ? { ...HEBBAL, name: 'Hebbal, Bengaluru' } : null;

t('"I need to go from Bangarpet to Hebbal" is Bangarpet to Hebbal, not to "go"', async () => {
  const r = await IN.parseIntent('I need to go from Bangarpet to Hebbal', { geocode: fakeGeo });
  assert.strictEqual(r.resolved.from.id, 'BWT');
  assert.strictEqual(r.resolved.to.kind, 'place');
  assert.strictEqual(r.resolved.to.lat, HEBBAL.lat);
  assert.deepStrictEqual(r.unresolved, []);
  assert.match(r.understood, /Hebbal, Bengaluru \(on the map\)/);
  const noGeo = await IN.parseIntent('I need to go from Bangarpet to Hebbal');
  assert.ok(noGeo.unresolved.some(u => /hebbal/i.test(u)), 'without a map it says what it could not place');
  assert.strictEqual(noGeo.request.destination.text, 'hebbal', 'and never "go"');
});

t('names with or without their spaces', () => {
  assert.strictEqual(IN.resolvePlace('Indira Nagar').id, 'IDN');
  assert.strictEqual(IN.resolvePlace('indiranagar').id, 'IDN');
  assert.strictEqual(IN.resolvePlace('M.G. Road').id, 'MAGR');
  assert.strictEqual(IN.resolvePlace('White field').id, 'WFD');
});

t('leave after and reach by are two separate things, and both are read', async () => {
  const r = await IN.parseIntent('from Bangarpet to Indira Nagar after 8 by 10');
  assert.strictEqual(r.request.leaveAfter, '08:00');
  assert.deepStrictEqual(r.request.timeConstraint, { type: 'ARRIVE_BY', value: '10:00' });
  assert.match(r.understood, /leave after 08:00 .* reach by 10:00/);
  const one = await IN.parseIntent('I need to reach Majestic by 9');
  assert.strictEqual(one.resolved.to.id, 'KGWA');
  assert.strictEqual(one.request.leaveAfter, null);
});

t('a place off the network is reached by a named BMTC bus from a station that has one', async () => {
  JY.useBmtc(await import('./bmtc.mjs'));
  const near = JY.nearestNode(HEBBAL.lat, HEBBAL.lng);
  assert.strictEqual(near.id, 'BNC');
  const r = JY.journeysAnywhere({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'place', ...HEBBAL, name: 'Hebbal' }, after: 480 });
  assert.ok(r.ok && r.chains.length, JSON.stringify(r).slice(0, 200));
  assert.ok(r.chains.every(c => !c.legs.some(l => l.mode === 'auto')), 'never an auto');
  const c = r.chains[0];
  const bus = c.legs.filter(l => l.mode === 'bus').pop();
  assert.ok(bus && /^BMTC /.test(bus.name), 'a real route: ' + (bus && bus.name));
  assert.ok(bus.boardIdx >= 0 && bus.nStops > bus.boardIdx, 'with a boarding position');
  assert.strictEqual(bus.source, 'timetable');
  assert.ok(['yes', 'likely', 'maybe', 'standing'].includes(bus.seat.word));
  const last = c.legs[c.legs.length - 1];
  assert.ok(last.mode === 'walk' || last.mode === 'bus');
  assert.strictEqual(c.arr, last.arrMin, 'the bus and its walks are in the arrival');
  assert.ok(c.via.to && ['BNC', 'BNCE', 'SBC', 'KGWA', 'VDSA', 'CBPK'].includes(c.via.to.id), 'through a station with a bus: ' + c.via.to.id);
  assert.ok(r.chains.some(x => x.via.to.id !== near.id) || r.chains.every(x => x.via.to.id === near.id), 'more than one station was tried');
});

t('a bus follows its road, not a straight line between its ends', async () => {
  const B = await import('./bmtc.mjs');
  const pts = B.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepStrictEqual(pts.map(p => p.map(x => Math.round(x * 1e5) / 1e5)), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  const o = B.directBus({ fromLat: 12.97567, fromLng: 77.57281, toLat: 13.0382, toLng: 77.5919, after: 585 });
  const bus = o[0].legs.find(l => l.mode === 'bus');
  assert.ok(Array.isArray(bus.path) && bus.path.length >= 5, 'the road has bends: ' + (bus.path && bus.path.length));
  const first = bus.path[0], last = bus.path[bus.path.length - 1];
  assert.ok(Math.abs(first[0] - bus.fromLat) < 0.01 && Math.abs(last[0] - bus.toLat) < 0.01, 'and it runs from the boarding stop to the alighting stop');
  assert.strictEqual(bus.fromKind, 'bus station');
  assert.ok(['bus stop', 'bus station'].includes(bus.toKind));
  const kbs = B.pathForRoute('KBS-1K', 12.98273, 77.75223, 12.97749, 77.57327);
  assert.ok(kbs && kbs.length > 20, 'the Hope Farm route from buses.mjs finds its road too: ' + (kbs && kbs.length));
});

t('the bus index answers in milliseconds and knows the city', async () => {
  const B = await import('./bmtc.mjs');
  const st = B.stats();
  assert.ok(st.stops > 9000 && st.routes > 4000);
  const t0 = Date.now();
  const o = B.directBus({ fromLat: 12.97567, fromLng: 77.57281, toLat: 13.0382, toLng: 77.5919, after: 585 });
  assert.ok(Date.now() - t0 < 200);
  assert.ok(o.length >= 2);
  const b = o[0].legs.find(l => l.mode === 'bus');
  assert.match(b.from, /Kempegowda Bus Station/);
  assert.match(b.to, /Hebbal/i);
  assert.ok(b.every > 0 && b.min > 0 && b.fare >= 6);
  assert.strictEqual(B.directBus({ fromLat: 12.97567, fromLng: 77.57281, toLat: 12.0, toLng: 77.0, after: 585 }).length, 0, 'nothing is invented for nowhere');
});

t('a place that is close enough is walked to; one too far is refused', () => {
  const r = JY.journeysAnywhere({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'place', lat: 12.9760, lng: 77.5740, name: 'Near Majestic' }, after: 480 });
  const last = r.chains[0].legs[r.chains[0].legs.length - 1];
  assert.strictEqual(last.mode, 'walk');
  // khaali now LOOKS as far as it would ever travel and lets the last mile
  // decide, so the refusal names the wall that was actually hit: no bus runs
  // there, rather than a radius nobody outside the code knows about.
  const far = JY.journeysAnywhere({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'place', lat: 13.4, lng: 77.9, name: 'Chikkaballapur' }, after: 480 });
  assert.strictEqual(far.ok, false);
  assert.ok(['no-bus', 'to-too-far'].includes(far.reason), far.reason);
  // a place a bus does not reach from any nearby station is a "no", not an auto
  const nowhere = JY.journeysAnywhere({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'place', lat: 12.90, lng: 78.05, name: 'A field near Bangarpet' }, after: 480 });
  if (!nowhere.ok) assert.ok(['no-bus', 'to-too-far'].includes(nowhere.reason), nowhere.reason);
  assert.ok(!nowhere.ok || nowhere.chains.every(c => !c.legs.some(l => l.mode === 'auto')));
});

t('a journey may start on the map too, and the allocator still ranks it', () => {
  const r = JY.journeysAnywhere({ from: { kind: 'place', lat: 12.9925, lng: 78.1760, name: 'Bangarpet Bus Stand' }, to: { kind: 'metro', id: 'KGWA' }, after: 480 });
  assert.ok(r.ok && r.chains.length);
  assert.ok(['walk', 'auto'].includes(r.chains[0].legs[0].mode));
  CAP.annotate(r.chains, { trainCap: () => ({ free: 50, total: 432 }) });
  const a = AL.allocate(r.chains, { after: 480 });
  assert.ok(a.recommended != null);
  assert.ok(r.chains.every(c => c.legs.filter(l => l.mode === 'walk').every(l => l.cap.occupancy === 0)));
});

console.log('\nwhere is it now: the same question, asked of a bus');

t('a bus has a stop list and a minute at each, like a train always has', () => {
  const opts = BM.directBus({ fromLat: 12.97751, fromLng: 77.57141, toLat: 12.99191, toLng: 77.7158, after: 600, limit: 1 });
  assert.ok(opts.length, 'no bus from Majestic to Hoodi');
  const l = opts[0].legs.find(x => x.mode === 'bus');
  const r = BM.legStops({ route: l.id, boardIdx: l.boardIdx, nStops: l.nStops, stops: l.stops, depMin: l.depMin });
  assert.ok(r, 'khaali could not place its own bus leg');
  assert.ok(r.stops.length > 2, 'a stretch of ' + r.stops.length + ' stops');
  assert.strictEqual(r.stops[0].n, l.from, 'the list starts where she boards');
  assert.strictEqual(r.stops[r.stops.length - 1].n, l.to, 'and ends where she gets off');
  // the minutes must rise, or "which stop has it passed" is meaningless
  r.stops.forEach((s, i, a) => { if (i) assert.ok(s.min >= a[i - 1].min, 'time went backwards at ' + s.n); });
  // and they are HER times, not the first bus of the day's
  assert.strictEqual(r.stops[0].min, l.depMin);
  assert.ok(r.stops.every(s => s.n && s.lat && s.lng), 'a stop with no name or no place');
});

t('the bus khaali cannot place is refused, not guessed at', () => {
  assert.strictEqual(BM.legStops({ route: 'NO-SUCH-ROUTE', boardIdx: 0, stops: 2 }), null);
  assert.strictEqual(BM.legStops({ route: '304-Z', boardIdx: 9999, stops: 2 }), null);
  assert.strictEqual(BM.legStops({}), null);
});

t('a train that runs down the corridor still knows where it is', () => {
  // `visited` is indexed west-to-east; three of the six trains run the other
  // way. Taking the last hit out of the raw array returned the HIGHEST index
  // visited - which for a down train is where it started, so the dot never
  // moved for half the fleet.
  const ST_N = ST.length;
  const down = [...Array(ST_N).keys()].reverse();          // a dir:-1 stop list
  const visited = ST.map(() => false);
  down.slice(0, 5).forEach(i => { visited[i] = true; });   // it has done five stops
  const oldWay = visited.map((v, i) => v ? i : -1).filter(i => i >= 0).pop();
  const newWay = down.filter(i => visited[i]).pop();
  assert.strictEqual(oldWay, ST_N - 1, 'the old reading was its origin');
  assert.strictEqual(newWay, ST_N - 5, 'the new reading is its latest stop');
  assert.notStrictEqual(newWay, oldWay);
});

console.log('\ntracking: where it should have got to by now');

t('a ride reports its stage from the booking and the clock, not from a store', () => {
  const r = HR.newRide({ id: 'abcdef000000', who: 'h', date: '2026-09-10', kind: 'car',
    from: 'Majestic', to: 'Hoodi', km: 18, pickupMin: 9 * 60 }).ride;
  const at = m => HR.statusOf(r, m, { today: '2026-09-10' });
  assert.strictEqual(at(9 * 60 - 60).stage, 'booked');
  assert.strictEqual(at(9 * 60 - 12).stage, 'assigned');
  assert.strictEqual(at(9 * 60 - 2).stage, 'arriving');
  const mid = at(9 * 60 + Math.floor(r.min / 2));
  assert.strictEqual(mid.stage, 'riding');
  assert.ok(mid.progress > 20 && mid.progress < 80, mid.progress + '% through');
  assert.strictEqual(at(9 * 60 + r.min + 5).stage, 'arrived');
  assert.strictEqual(at(9 * 60 + r.min + 5).progress, 100);
  // nothing here pretends khaali can see a car
  Object.values([at(9 * 60 - 60), mid]).forEach(s => {
    assert.strictEqual(s.simulated, true);
    assert.ok(/runs no cars/.test(s.source), s.source);
  });
});

t('a ride on another day is not tracked as if it were happening', () => {
  const r = HR.newRide({ id: 'abcdef000001', who: 'h', date: '2026-09-11', kind: 'bike',
    from: 'a', to: 'b', km: 5, pickupMin: 9 * 60 }).ride;
  const s = HR.statusOf(r, 9 * 60 + 3, { today: '2026-09-10' });
  assert.strictEqual(s.notToday, true);
  assert.strictEqual(s.progress, 0);
  assert.ok(/Booked for/.test(s.label), s.label);
  // and a cancelled one says so whatever the clock says
  HR.cancelRide(r);
  assert.strictEqual(HR.statusOf(r, 9 * 60 + 3, { today: '2026-09-11' }).stage, 'cancelled');
});

console.log('\na journey she draws herself');

t('a named vehicle can be a whole hop, which the guided planner will not do', () => {
  const A = { name: 'Majestic', lat: 12.97567, lng: 77.57281 };
  const B = { name: 'Hoodi', lat: 12.9902, lng: 77.7181 };
  const c = JY.rideChain('car', A, B, 9 * 60);
  assert.ok(c, 'she asked for a car and khaali refused to understand');
  assert.strictEqual(c.legs.length, 1);
  assert.strictEqual(c.legs[0].mode, 'car');
  assert.strictEqual(c.changes, 0);
  assert.ok(c.fare > 0 && c.legs[0].fareMin < c.legs[0].fareMax, 'still a range, still an estimate');
  assert.strictEqual(c.legs[0].source, 'estimated');
  // ...but the limits she is not asked about still hold
  const far = { name: 'far', lat: 13.60, lng: 78.20 };
  assert.strictEqual(JY.rideChain('car', A, far, 9 * 60), null, 'a 90 km taxi is not a hop');
  assert.strictEqual(JY.rideChain('bike', A, B, 9 * 60, { pax: 3 }), null, 'three on a bike');
  assert.strictEqual(JY.rideChain('bike', A, B, 9 * 60, { needs: ['step-free'] }), null);
  assert.strictEqual(JY.rideChain('rocket', A, B, 9 * 60), null);
});

t('a hop she drew still obeys the hour', () => {
  const A = { name: 'Majestic', lat: 12.97567, lng: 77.57281 };
  const B = { name: 'Hoodi', lat: 12.9902, lng: 77.7181 };
  const peak = JY.rideChain('car', A, B, 9 * 60), night = JY.rideChain('car', A, B, 22 * 60);
  assert.ok(peak.totalMin > night.totalMin,
    'peak ' + peak.totalMin + ' vs night ' + night.totalMin + ' - the road model is not reaching a custom hop');
});

t('the walk from a platform to the line is not a mode she has to enable', () => {
  // somebody standing at Whitefield asking for the metro used to be told
  // nothing runs, because every metro chain began with a train
  const r = JY.journeys({ from: { kind: 'rail', id: 'WFD' }, to: { kind: 'metro', id: 'KGWA' },
    after: 8 * 60, modes: ['metro'] });
  assert.ok(r.ok && r.chains.length, 'no metro-only way off the Whitefield platform');
  const c = r.chains.find(x => x.kind === 'metro-from-rail');
  assert.ok(c, r.chains.map(x => x.kind).join(','));
  assert.ok(c.legs.some(l => l.mode === 'walk'), 'the 1.7 km nobody mentions');
  assert.ok(c.legs.some(l => l.mode === 'metro'));
  assert.ok(!c.legs.some(l => l.mode === 'train'), 'she is already at the station');
});

console.log('\nthe road: measured where khaali can measure, declared where it cannot');

t('the city has a speed, and it was measured, not typed', () => {
  const st = RD.stats();
  assert.ok(st.samples > 100000, 'only ' + st.samples + ' timed segments');
  assert.ok(st.cells > 300, 'only ' + st.cells + ' cells');
  assert.ok(st.cityKmh > 12 && st.cityKmh < 30, st.cityKmh + ' km/h city median');
  // a city where every road is the same speed has not been measured
  assert.ok(st.fastest > st.slowest * 1.8,
    'slowest ' + st.slowest + ' vs fastest ' + st.fastest + ' - no spatial signal');
  assert.ok(/BMTC/.test(st.source), 'a speed with no source is an invented number');
});

t('a cell nobody has driven says unknown, not a confident guess', () => {
  const far = RD.speedAt(20.5, 80.5);                   // nowhere near Bengaluru
  assert.strictEqual(far.quality, 'unknown');
  assert.strictEqual(far.samples, 0);
  assert.strictEqual(far.kmh, RD.stats().cityKmh, 'it falls back to the measured median');
  const known = RD.speedAt(12.97567, 77.57281);         // Majestic
  assert.strictEqual(known.quality, 'estimated');
  assert.ok(known.samples >= RD.MIN_SAMPLES);
});

t('the middle of the city is slower than the edge of it', () => {
  const majestic = RD.speedAt(12.97567, 77.57281);
  const outer = RD.speedAt(13.0997, 77.3934);           // Nelamangala
  assert.strictEqual(majestic.quality, 'estimated');
  assert.strictEqual(outer.quality, 'estimated');
  assert.ok(outer.kmh > majestic.kmh,
    'Nelamangala ' + outer.kmh + ' should beat Majestic ' + majestic.kmh);
});

t('speed over a route averages by distance, not by cell', () => {
  // two halves at 10 and 30 km/h is 15 km/h overall, never 20 - the harmonic
  // mean is the only correct one for a speed averaged over ground
  const key = (a, b) => Math.round(a / RD.CELL) + ':' + Math.round(b / RD.CELL);
  const fake = { cells: new Map(), cityKmh: 20, samples: 999 };
  fake.cells.set(key(12.90, 77.50), { kmh: 10, samples: 100 });
  fake.cells.set(key(13.10, 77.50), { kmh: 30, samples: 100 });
  RD.useField(fake);
  const r = RD.speedBetween(12.90, 77.50, 13.10, 77.50, 2);
  RD.useField(null);
  assert.ok(r.kmh > 12 && r.kmh < 18, r.kmh + ' km/h is not the harmonic mean of 10 and 30');
  assert.ok(RD.stats().samples > 100000, 'the real field came back');
});

t('the hour is declared, and never claims to be measured', () => {
  assert.strictEqual(TR.QUALITY, 'simulated');
  assert.ok(/not a measurement/.test(TR.SOURCE), TR.SOURCE);
  const p = TR.peak();
  assert.ok(p.worstFactor < 0.7, 'a peak that is not a peak');
  assert.ok(p.bestFactor > 1.0);
  assert.ok([8, 9, 17, 18, 19].includes(p.worstHour), 'worst hour is ' + p.worstHour);
  // and it interpolates rather than falling off a cliff at the hour mark
  const a = TR.factorAt(8 * 60 + 59).factor, b = TR.factorAt(9 * 60).factor;
  assert.ok(Math.abs(a - b) < 0.1, a + ' -> ' + b + ' is a cliff');
});

t('a measurement times an assumption is an assumption', () => {
  const measured = RD.speedAt(12.97567, 77.57281);
  assert.strictEqual(measured.quality, 'estimated');
  const withHour = TR.apply(measured, 9 * 60);
  assert.strictEqual(withHour.quality, 'simulated', 'the hour must taint the quality');
  assert.ok(withHour.kmh < measured.kmh, 'nine in the morning is not free-flow');
  // ...but unknown stays unknown; it is the worst thing to be
  assert.strictEqual(TR.apply(RD.speedAt(20.5, 80.5), 9 * 60).quality, 'unknown');
});

t('the same ride takes longer at nine than at ten at night', () => {
  const from = { name: 'Majestic', lat: 12.97567, lng: 77.57281 };
  const to = { name: 'Hoodi', lat: 12.9902, lng: 77.7181 };
  const at = h => HR.leg('car', from, to, h * 60, 18, x => String(x), x => x);
  const peak = at(9), night = at(22);
  assert.ok(peak.min > night.min * 1.4,
    'peak ' + peak.min + ' min vs night ' + night.min + ' min - traffic is not biting');
  assert.ok(peak.kmh < night.kmh);
  assert.strictEqual(peak.speedQuality, 'simulated');
  assert.ok(/BMTC/.test(peak.speedSource) && /not a measurement/.test(peak.speedSource),
    'the leg must carry the whole provenance chain: ' + peak.speedSource);
  // a bike filters through what a car queues in
  const bike = HR.leg('bike', from, to, 9 * 60, 18, x => String(x), x => x);
  assert.ok(bike.min < peak.min, 'a bike should beat a car in peak traffic');
});

t('no vehicle khaali hires travels at an impossible speed', () => {
  const from = { name: 'a', lat: 13.0997, lng: 77.3934 }, to = { name: 'b', lat: 13.11, lng: 77.40 };
  const s = HR.speedFor('bike', { at: 3 * 60, from, to });   // 3am, the fastest road, a bike
  assert.ok(s.kmh <= HR.MAX_KMH, s.kmh + ' km/h through Bengaluru');
});

console.log('\nthe switch: ride each vehicle for the stretch it has room on');

// khaali's own idea, one level up. Seat hop chains two partial berths on one
// train because a berth taken Bangarpet->Whitefield can be free onward. The
// same fact makes the bus worth taking first: she boards it where it STARTS so
// she sits, and by the time she reaches the corridor the berth that was
// occupied behind her has come free in front of her.
const iOf = c => ST.findIndex(x => x.c === c);
const WFD_I = iOf('WFD');
// nothing free before Whitefield, plenty after: the interval model as a fixture
const fullEarly = (no, f) => (f < WFD_I ? 0 : 120);
const capEarly = (no, fi) => ({ free: fi < WFD_I ? 0 : 120, total: 432 });
const plainly = () => 200, capPlain = () => ({ free: 200, total: 432 });
const ride = (to, counts) => JY.journeys({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'rail', id: to }, after: 420, counts });

t('the bus for the stretch it has seats on, the train for the stretch it does', () => {
  const sw = ride('BNC', fullEarly).chains.filter(c => c.kind === 'bus+train');
  assert.ok(sw.length, 'khaali never offered the switch');
  const c = sw[0];
  const bus = c.legs.find(l => l.mode === 'bus'), train = c.legs.find(l => l.mode === 'train');
  assert.ok(bus && train);
  assert.ok(c.legs.indexOf(bus) < c.legs.indexOf(train), 'the bus comes first or it is not this journey');
  assert.strictEqual(bus.seat.word, 'yes', 'she boards where the bus starts, so she sits');
  assert.strictEqual(train.seat.word, 'yes', 'and takes a berth free on the stretch she rides');
  assert.strictEqual(c.seat.word, 'yes', 'the chain carries the worst seat on it; both are good');
  const walk = c.legs.find(l => l.mode === 'walk');
  assert.ok(walk && walk.km > 0, 'the bus does not stop on the platform, and khaali says so');
});

t('the switch wins when standing is long, and loses when it buys nothing', () => {
  const long = ride('SBC', fullEarly);
  CAP.annotate(long.chains, { trainCap: capEarly });
  const a = AL.allocate(long.chains, { profile: 'comfortable', after: 420 });
  assert.ok(a.recommended != null);
  const rec = long.chains[a.recommended];
  assert.strictEqual(rec.kind, 'bus+train', 'Comfortable should switch rather than stand for hours');
  assert.strictEqual(rec.seat.word, 'yes');
  assert.ok(a.reason.reasons.includes('SWITCHED_WHERE_IT_FILLS'), a.reason.reasons.join(','));
  assert.ok(/crowd does/.test(AL.sentence(a.reason)), AL.sentence(a.reason));

  // ...and the same journey when the train has berths all the way: no reason to move
  const easy = ride('SBC', plainly);
  CAP.annotate(easy.chains, { trainCap: capPlain });
  ['balanced', 'comfortable', 'fastest', 'network'].forEach(profile => {
    const b = AL.allocate(easy.chains, { profile, after: 420 });
    assert.notStrictEqual(easy.chains[b.recommended].kind, 'bus+train',
      profile + ' changed vehicles for nothing');
  });
});

t('standing two hours is not the imposition standing ten minutes is', () => {
  const of = min => ({ legs: [{ mode: 'train', min, seat: { word: 'standing', rank: 0 } }],
    seat: { word: 'standing', rank: 0 }, fare: 10, changes: 0, totalMin: min, dep: 0, arr: min });
  const w = AL.WEIGHTS.comfortable, ref = { minFare: 10, after: null, by: null };
  assert.ok(AL.score(of(130), w, ref).passenger.seat > AL.score(of(12), w, ref).passenger.seat * 2,
    'a long stand must cost more than a short one');
});

t('a seat buys extra minutes only on the profile that asked for one', () => {
  // the old rule stands whole on the default profile: forty minutes of her
  // morning are not the network to spend
  assert.ok(AL.LIMITS.seatProfileMin > AL.WEIGHTS.balanced.seat, 'balanced must not get the allowance');
  assert.ok(AL.WEIGHTS.comfortable.seat >= AL.LIMITS.seatProfileMin, 'comfortable must');
});

t('the simulated bus stays labelled all the way through the switch', () => {
  const c = ride('BNC', fullEarly).chains.find(x => x.kind === 'bus+train');
  assert.strictEqual(c.legs.find(l => l.mode === 'bus').source, 'simulated');
  assert.ok(c.simulated, 'and the chain carries it too');
});

t('a bus that overshoots or doubles back is not a leg of this journey', () => {
  ride('BNC', fullEarly).chains.filter(c => c.kind === 'bus+train').forEach(c => {
    const mid = ST.findIndex(x => x.n === c.legs.find(l => l.mode === 'train').from);
    assert.ok(mid > iOf('BWT') && mid < iOf('BNC'),
      'switched at ' + ST[mid].n + ', which is not between Bangarpet and Cantt');
  });
});

console.log('\nhiring: a car and a bike for the miles the network does not cover');

// The point from the screenshot: 20 km north of Majestic, where nothing runs.
const NOWHERE = { kind: 'place', lat: 13.1556, lng: 77.5730, name: 'A point 20 km N of Majestic' };
const REACHED = { kind: 'place', lat: 12.9902, lng: 77.7181, name: 'Hoodi' };   // a bus does go here
const BWT = { kind: 'rail', id: 'BWT' };
const anyHire = c => c.legs.some(l => l.mode === 'car' || l.mode === 'bike');
const plan = (to, modes, extra = {}) => JY.journeysAnywhere({ from: BWT, to, after: 480, modes, ...extra });

t('nothing is hired unless she asks: the default is the network, and it always was', () => {
  // the regression guard for the whole feature. If this fails, hiring has
  // leaked into every search khaali does.
  [NOWHERE, REACHED].forEach(to => {
    const r = plan(to, undefined);                       // no modes at all: the default
    if (r.ok) assert.ok(r.chains.every(c => !anyHire(c)), 'a default search hired something');
    const m = plan(to, ['train', 'metro', 'bus']);
    if (m.ok) assert.ok(m.chains.every(c => !anyHire(c)), 'an explicit network search hired something');
  });
  // A place khaali can reach by bus it now DOES reach by bus, wide search or
  // not - what must never happen is hiring something to get there.
  const net = plan(NOWHERE, ['train', 'metro', 'bus']);
  if (net.ok) assert.ok(net.chains.every(c => !anyHire(c)));
  // and somewhere nothing runs at all is still a no
  assert.strictEqual(plan({ kind: 'place', lat: 12.90, lng: 78.05, name: 'A field' }, ['train', 'metro', 'bus']).ok, false);
});

t('turned on, a car reaches the place a bus never could', () => {
  const r = plan(NOWHERE, ['train', 'metro', 'bus', 'car']);
  assert.ok(r.ok, 'a car should reach 20 km north of Majestic');
  const withCar = r.chains.filter(anyHire);
  assert.ok(withCar.length, 'no chain used the car');
  const l = withCar[0].legs.find(x => x.mode === 'car');
  assert.strictEqual(l.name, 'Car');
  assert.ok(l.km > 0 && l.min > 0);
  assert.strictEqual(l.source, 'estimated', 'a hired fare is an estimate and says so');
});

t('a named bus still beats a car over the same ground', () => {
  // Hoodi has a BMTC bus. mile() must reach it by that bus, not by hiring -
  // the order in mile() is the whole promise of commit afa6eeb.
  const gap = JY.mile({ name: 'Kempegowda Bus Station', lat: 12.97751, lng: 77.57141 },
    { name: 'Hoodi', lat: 12.99191, lng: 77.7158 }, 600, 15.7, { hire: ['car', 'bike'] });
  assert.ok(gap, 'the gap is closable');
  assert.ok(gap.bus, 'a bus runs it, so a bus is what khaali used');
  assert.ok(!gap.ride, 'khaali hired something anyway');
});

t('a hired fare is a range, never a single figure khaali cannot know', () => {
  const f = HR.fareFor('car', 10);
  assert.ok(f.min < f.mid && f.mid < f.max, JSON.stringify(f));
  assert.strictEqual(f.estimated, true);
  assert.ok(f.source.length, 'a fare with no source is an invented number');
  const bike = HR.fareFor('bike', 10);
  assert.ok(bike.mid < f.mid, 'a bike undercuts a car');
  assert.strictEqual(HR.fareFor('helicopter', 10), null);
});

t('a bike carries one person and is never step-free', () => {
  assert.strictEqual(HR.pick(['car', 'bike'], { pax: 1 }), 'bike', 'cheapest when it is allowed');
  assert.strictEqual(HR.pick(['car', 'bike'], { pax: 3 }), 'car', 'three people do not fit on a bike');
  assert.strictEqual(HR.pick(['car', 'bike'], { pax: 1, needs: ['step-free'] }), 'car');
  assert.strictEqual(HR.pick(['bike'], { pax: 2 }), null, 'and khaali says no rather than squeezing them on');
  assert.strictEqual(HR.pick(['bike'], { pax: 1, needs: ['step-free'] }), null);
  assert.strictEqual(HR.pick([], { pax: 1 }), null);
  // and the planner honours both
  const three = plan(NOWHERE, ['train', 'metro', 'bus', 'car', 'bike'], { pax: 3 });
  assert.ok(three.ok && three.chains.some(anyHire));
  assert.ok(three.chains.every(c => !c.legs.some(l => l.mode === 'bike')), 'a bike was offered to three people');
});

t('khaali will not be driven to the next district', () => {
  const farOff = { kind: 'place', lat: 13.75, lng: 77.20, name: 'A long way off' };
  const r = plan(farOff, ['train', 'metro', 'bus', 'car']);
  assert.ok(!r.ok, 'khaali planned a ride past its own limit');
  assert.ok(/too-far/.test(r.reason), r.reason);
  assert.strictEqual(HR.newRide({ id: 'x', who: 'h', date: '2026-09-10', kind: 'car', km: 200 }).reason, 'too-far');
});

t('no profile hands out a free taxi where a bus runs - not even the fastest', () => {
  const r = plan(REACHED, ['train', 'metro', 'bus', 'car', 'bike']);
  assert.ok(r.ok);
  CAP.annotate(r.chains, { trainCap: () => ({ free: 50, total: 432 }) });
  // `fastest` and `comfortable` are ALLOWED to hire - one asked for speed, the
  // other asked for comfort, and a car is the comfortable thing in this city.
  // The three that exist to fill the network must not.
  ['balanced', 'cheapest', 'network'].forEach(profile => {
    const a = AL.allocate(r.chains, { profile, after: 480 });
    assert.ok(!anyHire(r.chains[a.recommended]),
      profile + ' recommended a hired ride where a bus reaches');
  });
  // and whoever does hire is still paying for it, not getting it for nothing
  assert.ok(AL.hireWeight(AL.WEIGHTS.fastest, 'car') > 0, 'fastest hires a car for free');
  assert.ok(AL.hireWeight(AL.WEIGHTS.fastest, 'bike') > 0, 'fastest hires a bike for free');
});

t('a hired ride is charged for, and a long one is refused outright', () => {
  const r = plan(NOWHERE, ['train', 'metro', 'bus', 'car']);
  CAP.annotate(r.chains, { trainCap: () => ({ free: 50, total: 432 }) });
  const a = AL.allocate(r.chains, { profile: 'balanced', after: 480 });
  const hired = r.chains.filter(anyHire);
  assert.ok(hired.every(c => c.alloc.passenger.hire > 0), 'a hired leg cost the score nothing');
  assert.ok(r.chains.every(c => AL.rideKm(c) <= AL.LIMITS.maxRideKm
    || c.alloc.overLimit.includes('LONGER_RIDE_THAN_LIMIT')),
    'a ride past the limit was still a candidate');
  // and the recommendation says why the car is there
  const rec = r.chains[a.recommended];
  if (anyHire(rec)) {
    assert.ok(a.reason.reasons.some(x => /^RIDE_/.test(x)), a.reason.reasons.join(','));
    assert.ok(/estimate|quote/.test(AL.sentence(a.reason)), AL.sentence(a.reason));
  }
});

t('Comfortable means a car, and Cheapest means a bike', () => {
  // A car is the most comfortable thing in the city; a bike is a helmet in
  // traffic. The two are not one offer, so they are not one penalty.
  const W = AL.WEIGHTS;
  assert.ok(AL.hireWeight(W.comfortable, 'car') < AL.hireWeight(W.comfortable, 'bike'),
    'Comfortable should prefer a car to a bike');
  assert.ok(AL.hireWeight(W.cheapest, 'bike') < AL.hireWeight(W.cheapest, 'car'),
    'Cheapest should prefer a bike to a car');
  // and Comfortable should be willing to hire at all, which it is not if the
  // penalty is above what a seat is worth to it
  assert.ok(AL.hireWeight(W.comfortable, 'car') < W.comfortable.seat);
  // network stays reluctant about both: neither carries anybody else
  assert.ok(AL.hireWeight(W.network, 'car') > AL.hireWeight(W.balanced, 'car'));
});

t('khaali does not claim no bus runs there when a bus runs there', () => {
  // The honesty case. NOWHERE is reachable by bus, just two hours slower. If a
  // hired ride wins on time, the reason must say SO - not invent an absence.
  const r = plan(NOWHERE, ['train', 'metro', 'bus', 'car', 'bike']);
  assert.ok(r.ok);
  CAP.annotate(r.chains, { trainCap: () => ({ free: 50, total: 432 }) });
  const a = AL.allocate(r.chains, { profile: 'balanced', after: 480 });
  const rec = r.chains[a.recommended];
  const net = r.chains.filter(c => !anyHire(c));
  assert.ok(net.length, 'this place should be reachable without hiring');
  if (anyHire(rec)) {
    assert.ok(a.reason.reasons.includes('RIDE_IS_FASTER_THAN_THE_NETWORK'),
      'khaali said nothing runs there while a bus was in its own results');
    assert.ok(!a.reason.reasons.includes('RIDE_BECAUSE_NOTHING_RUNS'));
    assert.ok(a.reason.facts.networkAlternative, 'the alternative is not in the facts');
    const said = AL.sentence(a.reason);
    assert.ok(!/no bus khaali knows runs/.test(said), said);
    assert.ok(/gets there for/.test(said), said);
  }
  // and where genuinely nothing runs, the other code is used
  const none = plan({ kind: 'place', lat: 13.30, lng: 77.85, name: 'A far point' }, ['train', 'metro', 'bus', 'car']);
  if (none.ok) {
    CAP.annotate(none.chains, { trainCap: () => ({ free: 50, total: 432 }) });
    const b = AL.allocate(none.chains, { profile: 'balanced', after: 480 });
    if (anyHire(none.chains[b.recommended]))
      assert.ok(b.reason.reasons.includes('RIDE_BECAUSE_NOTHING_RUNS'), b.reason.reasons.join(','));
  }
});

t('a hired vehicle is not network capacity, in either direction', () => {
  const car = { mode: 'car', name: 'Car', km: 8, min: 25 };
  const snap = CAP.snapshot(car, {});
  assert.strictEqual(snap.occupancy, 0);
  assert.strictEqual(snap.capacity, null);
  assert.strictEqual(snap.quality, 'exact');
  // the important half: an empty car must not make a journey look kind to the
  // network. Pressure over a full train is the same with or without the car.
  const train = { mode: 'train', name: 'X', min: 60, cap: { occupancy: 0.95, capacity: 432, quality: 'exact' } };
  const alone = CAP.pressure({ legs: [train] });
  const withCar = CAP.pressure({ legs: [train, { ...car, cap: snap }] });
  assert.strictEqual(alone.value, withCar.value, 'the car diluted network pressure');
  assert.ok(!CAP.impact({ legs: [train, { ...car, cap: snap }] }).some(x => x.mode === 'car'));
});

t('ten thousand people do not share one car', () => {
  const a = { mode: 'car', id: 'c', name: 'Car', depMin: 500 };
  assert.notStrictEqual(SIM.vehicleKey(a), SIM.vehicleKey(a), 'two riders got the same car');
  assert.strictEqual(SIM.crushOf(a), Infinity);
  assert.strictEqual(SIM.seatsOf(a), Infinity);
});

t('a ride is booked, not scanned - and priced by khaali, not by the phone', () => {
  const r = HR.newRide({ id: 'abcdef123456', who: 'her@x', date: '2026-09-10',
    kind: 'car', from: 'Majestic', to: 'A field', km: 12, holder: 'Achina' });
  assert.ok(r.ok);
  assert.strictEqual(r.ride.status, 'booked');
  assert.strictEqual(r.ride.simulated, true, 'khaali books nothing real and says so');
  assert.strictEqual(r.ride.code, 'ABCDEF');
  assert.deepStrictEqual(r.ride.fare, HR.fareFor('car', 12));
  assert.strictEqual(HR.publicOf(r.ride).simulated, true);
  HR.cancelRide(r.ride);
  assert.strictEqual(r.ride.status, 'cancelled');
  assert.strictEqual(HR.newRide({ id: 'a', who: 'h', date: '2026-09-10', kind: 'rocket', km: 4 }).reason, 'bad-kind');
  assert.strictEqual(HR.newRide({ id: 'a', who: 'h', date: '2026-09-10', kind: 'car', km: 0 }).reason, 'no-distance');
});

t('a trip pass skips the hired leg instead of refusing the whole pass', () => {
  const r = JY.priceTripLegs([
    { mode: 'car', from: 'Majestic', to: 'A field', km: 12 },
    { mode: 'metro', fromId: 'KDGD', toId: 'KGWA' },
  ]);
  assert.ok(r.ok, 'the car killed the pass');
  assert.strictEqual(r.legs.length, 1, 'only the metro belongs on a pass');
  assert.ok(r.skipped.some(x => x.why === 'booked-separately'));
  // a journey that is ONLY a hired ride has no pass to sell, and says so
  const only = JY.priceTripLegs([{ mode: 'bike', from: 'a', to: 'b', km: 5 }]);
  assert.strictEqual(only.ok, false);
  assert.ok(/booked on its own/.test(only.error), only.error);
});


console.log('\nwhat khaali will not say out loud');

t('a free answer carrying a fare, a time or a route number is dropped', () => {
  // No action ran, so there are no facts - every one of these is memory.
  assert.ok(IN.invents('Take bus 500D, it is ₹35.'));
  assert.ok(IN.invents('It costs 40 rupees.'));
  assert.ok(IN.invents('The 6:40 PM leaves from platform two.'));
  assert.ok(IN.invents('Take 16022 from Bangarpet.'));
  assert.ok(IN.invents('Catch route 314.'));
  assert.ok(IN.invents('The KBS-1K goes there.'));
  assert.ok(IN.invents('Take the 304-A.'));
});

t('ordinary numbers are not inventions - khaali still talks like a person', () => {
  assert.ok(!IN.invents('Two changes, about ten minutes of walking.'));
  assert.ok(!IN.invents('Ask me to plan it and I will look it up properly.'));
  assert.ok(!IN.invents(''));
  assert.ok(!IN.invents(null));
});

t('khaali says it does not know in the language it was asked in', () => {
  assert.ok(IN.CANNOT_SAY['en-IN'] && IN.CANNOT_SAY['hi-IN'] && IN.CANNOT_SAY['kn-IN']);
  // and what it says instead must not itself trip the guard
  for (const s of Object.values(IN.CANNOT_SAY)) assert.ok(!IN.invents(s), 'the refusal invents: ' + s);
});

t('a named bus stand is a place, not a demand for buses only', async () => {
  // This line carried two literal backspaces where \b belonged, so the regex
  // matched nothing and the guard never fired. It is live behaviour, so it
  // gets a test.
  const llm = async () => JSON.stringify({ origin: { text: 'Shivajinagar bus station' }, destination: { text: 'Whitefield' }, modes: ['bus'] });
  const r = await IN.parseIntent('Shivajinagar bus station to Whitefield', { llm });
  const m = r.request.modes || [];
  assert.ok(!(m.length === 1 && m[0] === 'bus'), 'a bus STAND was read as bus ONLY: ' + JSON.stringify(m));
});

t('nothing khaali can say to a chatbot changes a booking', () => {
  // The dispatch is a hand-rolled if-chain, and it stays read-only: chat plans
  // and shows. Booking, paying, holding and cancelling are the app's, not the
  // model's.
  const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const chat = src.slice(src.indexOf('SAARTHI_SYS'));
  const types = [...new Set([...chat.matchAll(/act(?:ion)?\s*&&\s*act(?:ion)?\.type === '([a-z]+)'/g)].map(m => m[1]))].sort();
  assert.deepStrictEqual(types, ['cancellations', 'mybookings', 'odds', 'plan', 'search']);
});

t('a chatbot hands out a car only when the traveller asked for one', () => {
  // The chat planner falls back to the NETWORK, never to a vehicle. A car or a
  // bike reaches the answer only through the modes she named, and those are
  // filtered against ALL_MODES before use.
  const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const i = src.indexOf("act.type === 'plan'");
  const plan = src.slice(i, src.indexOf("act.type === 'mybookings'"));
  assert.ok(/use = modes\.length \? modes : \[\.\.\.journey\.MODES\]/.test(plan), 'the fallback is not the network');
  assert.ok(!/'car'|'bike'/.test(plan), 'the chat planner names a vehicle of its own');
  for (const h of JY.HIRE_MODES) assert.ok(!JY.MODES.includes(h), h + ' is in the default modes');
});

console.log('\nmidnight: the hour that made every evening answer wrong');

t('a journey that crosses midnight arrives AFTER it leaves', () => {
  const after = 17 * 60 + 6;                       // she asks a little after five
  const r = JY.journeysAnywhere({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'rail', id: 'SBC' }, after, modes: [...JY.MODES] });
  assert.ok(r.ok && r.chains.length, 'no way from Bangarpet to Majestic at all');
  for (const c of r.chains) {
    assert.ok(c.arr >= c.dep, c.depText + ' -> ' + c.arrText + ' arrives before it leaves');
    assert.ok(AL.span(c, { after }) > 0, c.depText + ' costs her ' + AL.span(c, { after }) + ' minutes');
  }
});

t('the evening answer is the next train, not the last one of the night', () => {
  // The 22:55 train arrived at minute 30, so span() read it as costing minus
  // sixteen hours and it beat every train that actually left sooner. Asked at
  // five in the afternoon, khaali offered a departure six hours away.
  const after = 17 * 60 + 6;
  const r = JY.journeysAnywhere({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'rail', id: 'SBC' }, after, modes: [...JY.MODES] });
  CAP.annotate(r.chains, { trainCap: () => null });
  const a = AL.allocate(r.chains, { after });
  const rec = r.chains[a.recommended != null ? a.recommended : 0];
  assert.ok(rec.dep - after < 180, 'she is asked to wait ' + (rec.dep - after) + ' minutes: ' + rec.depText);
  const soonest = Math.min(...r.chains.map(c => c.dep));
  assert.ok(rec.dep - soonest <= 120, 'a train left at ' + Math.floor(soonest/60)+':'+String(soonest%60).padStart(2,'0') + ' and khaali chose ' + rec.depText);
});

t('an overnight train is still offered, and still sorts last', () => {
  const after = 21 * 60;                           // nine at night: the 22:55 is the sensible one
  const r = JY.journeysAnywhere({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'rail', id: 'SBC' }, after, modes: [...JY.MODES] });
  assert.ok(r.chains.some(c => c.arr > 1440), 'no journey crosses midnight, so this proves nothing');
  const arrs = r.chains.map(c => c.arr);
  assert.deepStrictEqual(arrs, [...arrs].sort((x, y) => x - y), 'the list is not in arrival order');
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
