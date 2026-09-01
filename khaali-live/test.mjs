// Locking, payment and expiry tests. Run: node test.mjs
import assert from 'assert';
import * as S from './store.mjs';
import { journeyMask, seedOccupancy, berthState, packPlan, serves, journeyKm, stationByCode, liveOf, stopIdxs, sMin, oddsOf2 } from './engine.mjs';
import { TRAINS, ST } from './data.mjs';
import * as sentinel from './sentinel.mjs';
import * as limits from './limits.mjs';
import * as activity from './activity.mjs';
import * as journal from './journal.mjs';
import * as tatkal from './tatkal.mjs';
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
  assert.strictEqual(r.hold.fees, S.feesFor('SL', 1, r.hold.berthSum));
  assert.notStrictEqual(r.hold.fees, 1999);
  assert.strictEqual(r.hold.amount, r.hold.berthSum + r.hold.fees);
  S.release(r.hold.id);
});

t('AC fares carry superfast and GST, sleeper does not', () => {
  assert.strictEqual(S.feesFor('SL', 2, 1000), 20 * 2 + 12);
  assert.strictEqual(S.feesFor('3A', 2, 1000), 20 * 2 + 15 * 2 + 50 + 12);
});

t('an identity may keep at most two holds open', () => {
  const v = S.availability('16021', capDate, 'SL', 5, 6);
  const free = v.berths.filter(b => b.k === 'free').map(b => b.idx);
  const mk = i => S.hold({ train: '16021', date: capDate, cls: 'SL', from: 5, to: 6,
    berthIdxs: [free[i]], pax: 1, who: 'cap-5' });
  const a = mk(0), b = mk(1), c = mk(2);
  assert.ok(a.ok && b.ok, 'first two succeed');
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.reason, 'too-many-open-holds');
  S.release(a.hold.id);
  assert.ok(mk(2).ok, 'releasing one frees a slot');
  S.release(b.hold.id);
  for (const h of [a, b]) {}
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


console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
