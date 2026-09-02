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
  const picks = freeIdx.slice(30, 80);
  const ok = picks.map(i => S.hold({ train: '16021', date: D, cls: 'SL', from: 5, to: 13, berthIdxs: [i], pax: 1, who: 'x' + i }));
  assert.strictEqual(ok.filter(r => r.ok).length, picks.length);
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


console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
