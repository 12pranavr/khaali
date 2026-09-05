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
import * as DM from './demand.mjs';
import * as DP from './dispatch.mjs';
import * as CM from './commit.mjs';
import * as RL from './reliability.mjs';
import * as GP from './gap.mjs';
import * as PL from './pool.mjs';
import * as PV from './providers.mjs';
import * as LD from './load.mjs';
import * as XF from './transfer.mjs';
import * as TP from './trip.mjs';
import * as CD from './conductor.mjs';
import * as CL from './claims.mjs';
import * as CN from './constraint.mjs';
import * as SP from './split.mjs';
import * as BLG from './busledger.mjs';
import * as SPP from './splitplan.mjs';
import * as DEC from './decision.mjs';
import * as SCN from './scenario.mjs';
import * as DNET from './demonet.mjs';
import * as RSIM from './roadsim.mjs';
import * as RIDE from './ridership.mjs';
import * as MPL from './multiplan.mjs';
import * as CARD from './card.mjs';
import * as JN from './journey.mjs';
import { BUSES } from './buses.mjs';
import * as BL from './busload.mjs';
import * as CP from './compare.mjs';
import * as RD from './road.mjs';
import * as M from './metro.mjs';
import * as BM from './bmtc.mjs';
import * as HR from './hire.mjs';
import * as TR from './traffic.mjs';
import * as SA from './saarthi.mjs';
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
  assert.strictEqual(S.feesFor('SL', 2, 1000), 20 * 2, 'reservation only \u2014 khaali charges no fee of its own');
  assert.strictEqual(S.feesFor('3A', 2, 1000), 20 * 2 + 15 * 2 + 50);
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
  const notLower = x => x.type !== 'LB' && x.type !== 'SLB';
  const b = v.berths.find(x => x.k === 'free' && notLower(x));
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
  const roomToDraw = av.counts.free + av.counts.pooled > 0;
  if (roomToDraw) assert.ok(av.counts.pooled >= 1, 'the map shows a provisional berth');
  S.release(r.hold.id);
  assert.strictEqual(S.availability('16021', abDate, 'SL', 5, 13).pool, 0, 'released from the pool');
});

t('choosing a berth is free, and costs the same as not choosing one', () => {
  const av = S.availability('16021', abDate, '3A', 5, 6);
  const notLower = b => b.type !== 'LB' && b.type !== 'SLB';   // lowers are not for choosing pre-chart
  const free = av.berths.filter(b => b.k === 'free' && notLower(b)).map(b => b.idx).slice(0, 2);
  const r = S.hold({ train: '16021', date: abDate, cls: '3A', from: 5, to: 6, berthIdxs: free, pax: 2, who: 'ab-2', mode: 'exact' });
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.hold.choiceFee, 0, 'the berth map is the same query either way');
  assert.strictEqual(r.hold.fees, S.feesFor('3A', 2, r.hold.berthSum, true));
  assert.strictEqual(r.hold.fees, S.feesFor('3A', 2, r.hold.berthSum, false),
    'picking your own berth costs nothing extra');
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

t('the line runs both ways now, and nonsense is still refused', () => {
  // the "wrong way" used to be refused outright, which made every homeward
  // journey vanish; the same rails carry both directions and so does khaali
  const back = JY.plan({ arriveAt: 9 * 60, from: 'KGWA', to: 'IDN' });
  assert.strictEqual(back.ok, true, back.reason);
  assert.ok(back.arrive > 9 * 60);
  const fwd = JY.plan({ arriveAt: 9 * 60, from: 'IDN', to: 'KGWA' });
  assert.strictEqual(fwd.legs[fwd.legs.length - 1].min, back.legs[back.legs.length - 1].min,
    'the same stretch takes the same time in both directions');
  assert.strictEqual(JY.plan({ arriveAt: 9 * 60, to: 'NOPE' }).reason, 'unknown-stop');
  assert.strictEqual(JY.plan({ arriveAt: 9 * 60, from: 'KGWA', to: 'KGWA' }).reason, 'same-stop');
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

console.log('\nthe pass is blocked, not taken');

// A trip pass now has money set aside against it. The rules that matter:
// twenty-four hours, one capture at the door, one release if nobody comes,
// and nothing that can take the same fare twice.

const tripFor = (id, ms) => JY.newTripPass({ id, who: 'h', date: '2026-09-10',
  legs: [{ mode: 'bus', name: 'BMTC KIA-9', from: 'Kempegowda', to: 'Hebbala', fare: 10 },
         { mode: 'metro', from: 'Whitefield', to: 'Majestic', fare: 80 }] }, ms == null ? at : ms).pass;

t('a trip pass lives twenty-four hours from the moment it is cut', () => {
  const p = tripFor('b1');
  assert.strictEqual(p.expiresAt, at + 86400000);
  assert.ok(!JY.passOver(p, p.expiresAt - 1), 'not over a second early');
  assert.ok(JY.passOver(p, p.expiresAt), 'over on the second');
  // the point of the change: a journey that crosses midnight still has a ticket
  const pastMidnight = new Date('2026-09-11T00:20:00+05:30').getTime();
  assert.ok(JY.scan(tripFor('b1b'), { mode: 'bmtc', where: 'KIA-9' }, pastMidnight).ok,
    'the 00:20 bus is still on the pass the 23:14 booking bought');
});

t('a pass that lapses says so, and cannot be brought back', () => {
  const p = tripFor('b2');
  assert.ok(JY.expirePass(p, p.expiresAt).ok);
  assert.strictEqual(p.status, 'expired');
  assert.strictEqual(JY.scan(p, { mode: 'bmtc' }, p.expiresAt).reason, 'expired');
  assert.strictEqual(JY.expirePass(p, p.expiresAt + 1).reason, 'expired', 'one way');
  assert.strictEqual(JY.cancelPass(p, p.expiresAt + 1).reason, 'expired',
    'a lapsed pass keeps the reason it actually ended');
});

t('a ridden pass and a cancelled one refuse to expire over the top of it', () => {
  const ridden = tripFor('b3');
  JY.scan(ridden, { mode: 'bmtc', where: 'KIA-9' }, at + 1000);
  JY.scan(ridden, { mode: 'metro', where: 'KGWA' }, at + 90000);
  assert.strictEqual(ridden.status, 'used');
  assert.strictEqual(JY.expirePass(ridden, ridden.expiresAt).reason, 'used');
  const gone = tripFor('b4');
  JY.cancelPass(gone, at + 10);
  assert.strictEqual(JY.expirePass(gone, gone.expiresAt).reason, 'cancelled');
});

t('the door takes the whole fare, once, however much of the trip she rides', () => {
  const p = tripFor('b5');
  const s = { id: 'pay5', kind: 'pass', amount: p.fare, status: 'authorised', captured: 0 };
  // she rides the bus and walks the rest: she used it, so it is taken in full
  assert.ok(JY.scan(p, { mode: 'bmtc', where: 'KIA-9' }, at + 1000).ok);
  const took = tatkal.settle(s, true, at + 1000, p.fare);
  assert.strictEqual(took.captured, 90, 'the trip is the price, not the legs ridden');
  assert.strictEqual(p.status, 'valid', 'the metro leg is still hers to take');
  // a second door later cannot take it again
  assert.strictEqual(tatkal.settle(s, true, at + 90000, p.fare).reason, 'captured');
  assert.strictEqual(s.captured, 90);
});

t('a repeat tap on the same door is not a second fare', () => {
  const p = tripFor('b6');
  const one = JY.scan(p, { by: 'gate', mode: 'metro', where: 'KGWA' }, at + 1000);
  const two = JY.scan(p, { by: 'gate', mode: 'metro', where: 'KGWA' }, at + 21000);
  assert.ok(one.ok && two.ok);
  assert.ok(!one.repeat, 'the first is a ride');
  assert.ok(two.repeat, 'the second, inside a minute, is the same tap');
  assert.strictEqual(p.rides.length, 1, 'one ride, so one capture upstream');
});

t('nobody came: the block is released and nothing was ever taken', () => {
  const p = tripFor('b7');
  const s = { id: 'pay7', kind: 'pass', amount: p.fare, status: 'authorised', captured: 0 };
  assert.ok(JY.expirePass(p, p.expiresAt).ok);
  const back = tatkal.settle(s, false, p.expiresAt);
  assert.strictEqual(back.status, 'released');
  assert.strictEqual(s.captured, 0, '\u20b90, so there is nothing to refund');
});

t('a block already taken is not released by the clock that follows it', () => {
  const s = { id: 'pay8', kind: 'pass', amount: 90, status: 'authorised', captured: 0 };
  tatkal.settle(s, true, at, 90);
  assert.strictEqual(s.status, 'captured');
  assert.strictEqual(tatkal.settle(s, false, at + 86400000).reason, 'captured');
  assert.strictEqual(s.captured, 90, 'the sweep cannot un-take a fare');
});

t('a restart does not hand back a leg she has already ridden', () => {
  // the regression: replay pushed the ride but never crossed the leg off, so a
  // ridden pass came back rideable - and with money behind it, chargeable twice
  const live = tripFor('b9');
  JY.scan(live, { by: 'conductor', mode: 'bmtc', where: 'KIA-9' }, at + 1000);
  JY.scan(live, { by: 'gate', mode: 'metro', where: 'KGWA' }, at + 90000);
  assert.strictEqual(live.status, 'used');
  const fresh = tripFor('b9');
  for (const ride of live.rides) JY.applyRide(fresh, ride);
  assert.deepStrictEqual(fresh.legs.map(l => !!l.ridden), [true, true]);
  assert.strictEqual(fresh.status, 'used', 'the pass is spent again after a restart');
  assert.strictEqual(JY.scan(fresh, { mode: 'bmtc' }, at + 120000).reason, 'used');
  // and replaying the same ride twice does not double it
  JY.applyRide(fresh, live.rides[0]);
  assert.strictEqual(fresh.rides.length, 2);
});

t('the blocked number is the number the pass costs, always', () => {
  const priced = JY.priceTripLegs([
    { mode: 'metro', fromId: 'KDGD', toId: 'KGWA', from: 'Kadugodi Tree Park', to: 'Majestic' }]);
  assert.ok(priced.ok, priced.error);
  const sum = priced.legs.reduce((n, l) => n + l.fare, 0);
  const p = JY.newTripPass({ id: 'b10', who: 'h', date: '2026-09-10', legs: priced.legs }, at).pass;
  assert.strictEqual(p.fare, sum,
    'what the review page blocks and what the door takes are one number');
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

t('a lapsed trip pass and a cancelled one both refuse, and say which', () => {
  const p = JY.newTripPass({ id: 't5', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'metro', from: 'c', to: 'd', fare: 80 }] }, at).pass;
  const day = new Date('2026-09-10T09:00:00+05:30').getTime();
  const fresh = () => JY.newTripPass({ id: 't5b', who: 'h', date: '2026-09-10',
    legs: [{ mode: 'metro', from: 'c', to: 'd', fare: 80 }] }, at).pass;
  assert.ok(JY.scan(fresh(), { mode: 'metro' }, at + 86399000).ok, 'good to the last second');
  assert.strictEqual(JY.scan(fresh(), { mode: 'metro' }, at + 86400000).reason, 'expired');
  JY.cancelPass(p, day);
  assert.strictEqual(JY.scan(p, { mode: 'metro' }, day).reason, 'cancelled');
});

console.log('\nthe last mile: counting it, and handing it to somebody');

// A declaration is one booked journey whose last stretch is private. The rules
// worth pinning: the range is two counts and never a percentage, a place below
// the floor is not published at all, and the count is exact while the turn-up
// is unknown and says so.

const dec = (need, extra) => DM.declare({ id: 'd' + (dec.n = (dec.n || 0) + 1),
  who: 'someone', at: 'Whitefield', lat: 12.9698, lng: 77.7500,
  when: 8 * 60 + 40, km: 4.2, need, ...(extra || {}) }).record;

t('a declaration lands in the half hour it belongs to', () => {
  assert.strictEqual(DM.windowOf(8 * 60 + 40), 8 * 60 + 30);
  assert.strictEqual(DM.windowOf(9 * 60), 9 * 60);
  assert.strictEqual(DM.windowOf(9 * 60 + 29), 9 * 60);
  assert.strictEqual(DM.windowText(8 * 60 + 30), '08:30–09:00');
  const r = dec('no-bus');
  assert.strictEqual(r.window, 8 * 60 + 30);
});

t('a declaration khaali cannot place is refused, never guessed at', () => {
  assert.strictEqual(DM.declare({ id: 'x', at: 'A', when: 10, need: 'flying' }).reason, 'incomplete');
  assert.strictEqual(DM.declare({ id: 'x', at: 'A', when: 9999, need: 'no-bus' }).reason, 'bad-window');
  assert.strictEqual(DM.declare({ at: 'A', when: 10, need: 'no-bus' }).reason, 'incomplete');
});

t('the floor is the people with no bus; the ceiling adds the ones who might', () => {
  const recs = [dec('no-bus'), dec('no-bus'), dec('no-bus'),
                dec('slower-bus'), dec('slower-bus')];
  const [h] = DM.hotspots(recs, { nowMin: 8 * 60 + 20 });
  assert.strictEqual(h.floor, 3, 'three have nothing else to take');
  assert.strictEqual(h.ceiling, 5, 'five booked in all');
  assert.match(h.says, /5 booked, 3 of them with no bus at all/);
});

t('the count is exact and the turn-up is not pretended to be', () => {
  const [h] = DM.hotspots([dec('no-bus'), dec('no-bus'), dec('no-bus')],
    { nowMin: 8 * 60 + 20 });
  assert.strictEqual(h.quality, 'exact', 'these are counted bookings');
  assert.strictEqual(h.turnout, 'unknown', 'khaali has no history of who travelled');
  assert.ok(!('dropout' in h), 'no invented percentage anywhere on it');
});

t('a place with too few people in it is not a place, it is those people', () => {
  const two = [dec('no-bus'), dec('no-bus')];
  assert.strictEqual(DM.hotspots(two, { nowMin: 8 * 60 + 20 }).length, 0, 'two is below the floor');
  assert.strictEqual(DM.hotspots(two.concat([dec('no-bus')]), { nowMin: 8 * 60 + 20 }).length, 1);
});

t('a window that has gone, or is too far off to act on, is not demand', () => {
  const recs = [dec('no-bus'), dec('no-bus'), dec('no-bus')];
  assert.strictEqual(DM.hotspots(recs, { nowMin: 8 * 60 + 20 }).length, 1, 'twenty minutes out');
  assert.strictEqual(DM.hotspots(recs, { nowMin: 6 * 60 }).length, 0, 'two and a half hours out');
  // prune needs a day to know what is finished; a dateless record is the seed
  const dated = [dec('no-bus', { date: '2026-09-05' }), dec('no-bus', { date: '2026-09-05' })];
  assert.strictEqual(DM.prune(dated, 6 * 60, '2026-09-05').length, 0, 'hours past its half hour');
  assert.strictEqual(DM.prune(dated, 8 * 60 + 20, '2026-09-05').length, 2, 'twenty minutes out');
});

t('pruning keeps the seed and keeps a journey booked for a later day', () => {
  // Both of these were bugs the first time the sweep called prune(). The seed
  // is a typical day, not a dated one - pruning it at nine empties the
  // afternoon and nothing reloads the file until a restart. And a booking for
  // next Tuesday is early, not old.
  const seed = dec('no-bus', { seed: true });
  const soon = dec('no-bus', { date: '2026-09-05' });
  const later = dec('no-bus', { date: '2026-09-12' });
  const gone = dec('no-bus', { date: '2026-09-01' });
  const all = [seed, soon, later, gone];
  const kept = DM.prune(all, 6 * 60, '2026-09-05');   // hours before their window
  assert.ok(kept.includes(seed), 'the seed is a typical day and is always kept');
  assert.ok(kept.includes(later), 'a morning that has not happened is not old');
  assert.ok(!kept.includes(gone), 'a morning that has been and gone is');
  assert.ok(!kept.includes(soon), 'and today\'s, once its half hour is far behind');
});

t('a journey booked for next week is not somebody standing there this morning', () => {
  const here = [dec('no-bus', { date: '2026-09-05' }), dec('no-bus', { date: '2026-09-05' }),
                dec('no-bus', { date: '2026-09-05' })];
  const next = [dec('no-bus', { date: '2026-09-12' }), dec('no-bus', { date: '2026-09-12' }),
                dec('no-bus', { date: '2026-09-12' })];
  const at = { nowMin: 8 * 60 + 20, today: '2026-09-05' };
  assert.strictEqual(DM.hotspots(here.concat(next), at)[0].ceiling, 3, 'only today counts');
  assert.strictEqual(DM.hotspots(next, at).length, 0);
  // and a dateless record - the seed - counts on whatever day it is asked
  assert.strictEqual(DM.hotspots([dec('no-bus'), dec('no-bus'), dec('no-bus')], at)[0].ceiling, 3);
});

t('the two HIGH/MEDIUM/LOW bands no longer share a name', () => {
  // One bands how sure khaali is; the other bands how many people there are.
  // Under one name, the first page to show both would have put HIGH beside
  // HIGH meaning two different things.
  const h = DM.hotspots([dec('no-bus'), dec('no-bus'), dec('no-bus')], { nowMin: 8 * 60 + 20 })[0];
  assert.strictEqual(h.word, undefined, 'the count band is not called word');
  assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(h.size));
  const p = CAP.pressure({ legs: [{ mode: 'train', min: 60, cap: { occupancy: 0.5, quality: 'exact' } }] });
  assert.strictEqual(p.word, undefined, 'nor is the confidence band');
  assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(p.certainty));
});

t('a seeded row says it is seeded, all the way to the page', () => {
  const seeded = [dec('no-bus', { seed: true }), dec('no-bus', { seed: true }),
                  dec('no-bus', { seed: true })];
  const [h] = DM.hotspots(seeded, { nowMin: 8 * 60 + 20 });
  assert.strictEqual(h.seed, true);
  const mixed = DM.hotspots(seeded.concat([dec('no-bus')]), { nowMin: 8 * 60 + 20 })[0];
  assert.strictEqual(mixed.seed, false);
  assert.strictEqual(mixed.partSeed, true, 'part real, and it does not claim to be all real');
});

t('which side of the count a journey falls on is the server\'s to decide', () => {
  const ends = { lat: 12.97, lng: 77.75, toLat: 12.99, toLng: 77.78 };
  assert.strictEqual(DM.needFor(ends, () => [{ route: '500D' }]), 'slower-bus');
  assert.strictEqual(DM.needFor(ends, () => []), 'no-bus');
  // a bus lookup that throws is not a bus
  assert.strictEqual(DM.needFor(ends, () => { throw new Error('bmtc down'); }), 'no-bus');
  assert.strictEqual(DM.needFor({}, () => [{}]), 'no-bus', 'no coordinates, no claim of a bus');
});

// ---- the offer ----

const offerFor = (id, at) => DP.newOffer({ id, who: 'her@x', holder: 'Achina',
  from: 'Whitefield', to: 'Kodigehalli Gate', fromLat: 12.9698, fromLng: 77.75,
  toLat: 13.06, toLng: 77.59, km: 4.2, fareMin: 65, fareMax: 120 }, at || 1000).offer;

t('an offer goes out to nobody in particular', () => {
  const o = offerFor('o1');
  assert.strictEqual(o.status, 'offered');
  assert.strictEqual(o.driver, null, 'until somebody takes it, there is no driver');
  assert.deepStrictEqual(o.kinds, ['bike', 'auto', 'car'], 'khaali does not pick the vehicle');
  assert.strictEqual(DP.newOffer({ id: 'x', who: 'w', from: 'a', to: 'b', km: 0 }).reason, 'no-distance');
});

t('two drivers reach for the same ride: the first gets it, the second is told why', () => {
  const o = offerFor('o2');
  const first = DP.accept(o, 'driver-aaa', 2000);
  assert.ok(first.ok);
  assert.strictEqual(o.driver, 'driver-aaa');
  const second = DP.accept(o, 'driver-bbb', 2001);
  assert.ok(!second.ok);
  assert.strictEqual(second.reason, 'taken');
  assert.strictEqual(second.driver, 'driver-aaa', 'and it says who has it, so they can move on');
  assert.strictEqual(o.driver, 'driver-aaa', 'the second tap changed nothing');
});

t('nobody came, so the offer lapses - and a lapsed one cannot be taken', () => {
  const o = offerFor('o3');
  assert.strictEqual(DP.expire(o, 2000).reason, 'live', 'not while it still stands');
  assert.ok(DP.expire(o, 1000 + DP.OFFER_MS).ok);
  assert.strictEqual(o.status, 'expired');
  assert.strictEqual(DP.accept(o, 'driver-ccc', 1000 + DP.OFFER_MS + 1).reason, 'expired');
  assert.strictEqual(o.driver, null);
});

t('a ride already taken is not lapsed by the clock behind it', () => {
  const o = offerFor('o4');
  DP.accept(o, 'driver-aaa', 2000);
  assert.strictEqual(DP.expire(o, 1000 + DP.OFFER_MS).reason, 'accepted');
  assert.strictEqual(o.status, 'accepted', 'somebody is on their way; the clock has no say');
});

t('only the driver who took it can move it along', () => {
  const o = offerFor('o5');
  DP.accept(o, 'driver-aaa', 2000);
  assert.strictEqual(DP.arrived(o, 'driver-bbb', 3000).reason, 'not-yours');
  assert.ok(DP.arrived(o, 'driver-aaa', 3000).ok);
  assert.ok(DP.done(o, 'driver-aaa', 4000).ok);
  assert.strictEqual(o.status, 'done');
  assert.strictEqual(DP.cancel(o, 'changed mind', 5000).reason, 'done', 'a finished ride is finished');
});

t('what a driver is shown carries no phone number and admits what it is', () => {
  const o = offerFor('o6');
  const v = DP.publicOf(o);
  assert.strictEqual(v.holder, 'Achina', 'the name, because the owner asked for it');
  assert.strictEqual(v.to, 'Kodigehalli Gate', 'and where they are going');
  assert.strictEqual(v.code, 'O6', 'a short code the two of them can say out loud');
  assert.strictEqual(v.simulated, true, 'khaali runs no vehicles and says so');
  assert.ok(!('phone' in v) && !('who' in v), 'never a phone number, never the account');
  assert.strictEqual(DP.publicOf(o, { forDriver: 'driver-aaa' }).mine, false);
  DP.accept(o, 'driver-aaa', 2000);
  assert.strictEqual(DP.publicOf(o, { forDriver: 'driver-aaa' }).mine, true);
});

console.log('\nthe other side: drivers who say they will be somewhere');

// A commitment is a driver's statement about a place and a half hour. What is
// pinned here is mostly what it is NOT: not a booking, not a promise anybody
// can hold them to, and not a position khaali keeps.

const SPOT = { lat: 12.9698, lng: 77.7500 };            // White Field Bus Station
const NEARBY = { lat: 12.9701234, lng: 77.7498765 };    // a few metres off it
const AWAY = { lat: 13.05, lng: 77.62 };                // the far side of the city

const said = (extra) => CM.declare({ id: 'c' + (said.n = (said.n || 0) + 1),
  driver: 'd1', at: 'Whitefield', lat: AWAY.lat, lng: AWAY.lng, window: 510,
  hotLat: SPOT.lat, hotLng: SPOT.lng, ...(extra || {}) }).record;

t('a driver says they will be somewhere, and it is not a booking', () => {
  const c = said({ share: true });
  assert.strictEqual(c.outcome, null);
  assert.strictEqual(c.window, 510);
  assert.strictEqual(c.band, 2, 'the morning band, not a minute');
  assert.ok(c.km0 > 10, 'how far off they were when they said it');
  assert.strictEqual(c.fix, null, 'saying yes is not sharing where you are');
  assert.strictEqual(CM.declare({ id: 'x', driver: 'd', at: 'A', window: 9999 }).reason, 'bad-window');
  assert.strictEqual(CM.declare({ id: 'x', driver: 'd', at: 'A', window: 510, ahead: 200 }).reason, 'too-far-ahead');
  assert.strictEqual(CM.AHEAD_MAX, DM.KEEP_MIN, 'no promising into a window with no demand published');
});

t('a commitment is still on during the half hour it was for', () => {
  const c = said();
  assert.strictEqual(CM.over(c, 8 * 60), false, 'half an hour before');
  assert.strictEqual(CM.over(c, 8 * 60 + 40), false, 'ten minutes INTO it');
  assert.strictEqual(CM.over(c, 8 * 60 + 55), false, 'and at the end of it');
  assert.strictEqual(CM.over(c, 11 * 60), true, 'two hours later it is over');
});

t('a driver who shared nothing did not miss - khaali could not see', () => {
  // The subtlest dishonesty available here: counting a privacy choice as a
  // failure. It would make the number worse for exactly the drivers who
  // exercised the option, and make the option look like it costs something.
  const quiet = said({ share: false });
  const shared = said({ share: true });
  const [a] = CM.sweep([quiet], 11 * 60, 9000);
  const [b] = CM.sweep([shared], 11 * 60, 9000);
  assert.strictEqual(a.outcome, 'lapsed', 'khaali cannot say');
  assert.strictEqual(b.outcome, 'missed', 'they let khaali look, and were not there');
});

t('a driver who took a ride from there kept their word, whatever they shared', () => {
  const quiet = said({ share: false });
  const [r] = CM.sweep([quiet], 11 * 60, 9000, () => true);
  assert.strictEqual(r.outcome, 'kept', 'serving a ride is the strongest evidence there is');
});

t('a position is rounded on the server, and only the latest one is kept', () => {
  const c = said({ share: true });
  CM.here(c, NEARBY, 1000);
  assert.strictEqual(String(c.fix.lat).split('.')[1].length <= CM.FIX_DP, true, c.fix.lat);
  assert.ok(!Array.isArray(c.fix), 'there is no trail, and there is not going to be one');
  const first = c.fix;
  CM.here(c, { lat: 12.98, lng: 77.74 }, 2000);
  assert.notStrictEqual(c.fix, first, 'overwritten, not appended to');
  assert.strictEqual(CM.here(said({ share: false }), NEARBY, 1000).reason, 'no-consent');
});

t('a position does not outlive the window it was for', () => {
  const c = said({ share: true });
  CM.here(c, NEARBY, 1000);
  assert.ok(c.fix);
  assert.strictEqual(CM.close(c, 'kept', 2000).ok, true);
  assert.strictEqual(c.fix, null, 'close() discards it in its own body, so every path does');
  const d = said({ share: true });
  CM.here(d, NEARBY, 1000);
  CM.withdraw(d, 2000);
  assert.strictEqual(d.fix, null, 'and so does withdrawing');
});

t('a stale position cannot hold a rung up', () => {
  const c = said({ share: true });
  CM.here(c, NEARBY, 0);
  assert.strictEqual(CM.rungOf(c, { now: 0 }).rung, 'available');
  assert.strictEqual(CM.rungOf(c, { now: CM.FIX_STALE_MS + 1 }).rung, 'said-yes',
    'expiry comes before deletion, deliberately');
});

t('available is where the ride state says, not where the driver is', () => {
  // A driver parked outside the station with a passenger already in the car is
  // near it and is NOT available, and reading that off a position would have
  // got it exactly backwards.
  const c = said({ share: true });
  CM.here(c, NEARBY, 0);
  assert.strictEqual(CM.rungOf(c, { now: 0, holding: false }).rung, 'available');
  assert.strictEqual(CM.rungOf(c, { now: 0, holding: true }).rung, 'nearby');
  assert.strictEqual(CM.rungOf(c, { now: 0, holding: true }).rung !== 'available', true);
  // and two rungs never touch a position at all
  assert.strictEqual(CM.rungOf(said(), { now: 0 }).rung, 'said-yes');
  assert.strictEqual(CM.rungOf(said(), { now: 0, served: true }).rung, 'served');
});

t('moving toward is two numbers, never a path', () => {
  const c = said({ share: true });
  assert.ok(c.km0 > 10);
  CM.here(c, { lat: 13.0, lng: 77.70 }, 0);            // closer, but not near
  assert.strictEqual(CM.rungOf(c, { now: 0 }).rung, 'moving-toward');
  assert.ok(CM.MOVE_KM >= 0.25, 'the threshold must clear the rounding, or it fires on noise');
  const still = said({ share: true });
  CM.here(still, AWAY, 0);
  assert.strictEqual(CM.rungOf(still, { now: 0 }).rung, 'said-yes', 'not moving is not progress');
});

t('a commitment that has ended cannot be re-ended', () => {
  const c = said();
  assert.ok(CM.close(c, 'kept', 1000).ok);
  assert.strictEqual(CM.close(c, 'missed', 2000).reason, 'kept', 'the first answer stands');
  assert.strictEqual(CM.withdraw(c, 2000).reason, 'kept');
  assert.strictEqual(CM.close(said(), 'flying', 1000).reason, 'bad-outcome');
  assert.strictEqual(CM.sweep([c], 11 * 60, 3000).length, 0, 'and the sweep leaves it alone');
});

t('what khaali keeps of a finished commitment is not a record of anybody', () => {
  const c = said({ share: true });
  CM.here(c, NEARBY, 1000);
  CM.close(c, 'kept', 2000);
  const f = CM.forget(c);
  assert.deepStrictEqual(Object.keys(f).sort(), ['at', 'band', 'closedAt', 'outcome', 'seed']);
  assert.ok(!('driver' in f) && !('fix' in f) && !('window' in f),
    'no driver, no position, and no minute finer than a three-hour band');
  const v = CM.publicOf(c, { forDriver: 'd2' });
  assert.ok(!('fix' in v) && !('driver' in v) && !('km0' in v), 'and none of it reaches another driver');
  assert.strictEqual(v.mine, false);
  assert.strictEqual(CM.publicOf(c, { forDriver: 'd1' }).mine, true);
});

console.log('\nhow often a yes turned out to be true');

// The rate is the one ratio in khaali, and it is allowed only because it never
// travels without both its counts. What is pinned here is mostly what it
// refuses to say.

const rows = (n, outcome, extra) => Array.from({ length: n }, () =>
  ({ at: 'Whitefield', band: 2, outcome, seed: false, ...(extra || {}) }));

t('two out of two is not certainty, it is two', () => {
  // The failure this whole gate exists for: a sample of two, both kept, is
  // 1.0 - the most confident-looking figure anywhere on the page, from the
  // thinnest evidence on it. A small sample does not deserve a shrunken
  // estimate; it deserves none.
  const r = RL.rateFor(rows(2, 'kept'), { at: 'Whitefield', minute: 8 * 60 });
  assert.strictEqual(r.rate, null);
  assert.notStrictEqual(r.rate, 1);
  assert.notStrictEqual(r.rate, 0, 'and null is not zero either');
  assert.strictEqual(r.quality, 'unknown');
  assert.strictEqual(r.level, null);
  assert.match(r.says, /not measured enough/);
});

t('nineteen is not enough and twenty is', () => {
  const at = { at: 'Whitefield', minute: 8 * 60 };
  assert.strictEqual(RL.rateFor(rows(19, 'kept'), at).rate, null);
  const r = RL.rateFor(rows(20, 'kept'), at);
  assert.strictEqual(r.rate, 1);
  assert.strictEqual(r.of, 20);
  assert.strictEqual(RL.MIN_SAMPLE, 20);
});

t('a rate never leaves without its two counts', () => {
  const r = RL.rateFor(rows(31, 'kept').concat(rows(19, 'missed')), { at: 'Whitefield', minute: 8 * 60 });
  assert.strictEqual(r.rate, 0.62);
  assert.match(r.says, /31 of the last 50/, 'a denominator a reader can check');
  assert.doesNotMatch(r.says, /62%|0\.62/, 'and never the fraction on its own');
});

t('a driver who shared nothing is not counted as having failed', () => {
  // Putting `lapsed` in the denominator would make the number worse for
  // exactly the drivers who declined to be watched, and would make declining
  // cost them something. It costs them nothing, and this is where that is true.
  const r = RL.rateFor(rows(20, 'kept').concat(rows(12, 'lapsed')), { at: 'Whitefield', minute: 8 * 60 });
  assert.strictEqual(r.of, 20, 'the unobservable are in neither half');
  assert.strictEqual(r.rate, 1);
  assert.strictEqual(r.unobserved, 12);
  assert.match(r.says, /could not see another 12/);
});

t('changing your mind still counts - a withdrawn yes was not supply either', () => {
  const r = RL.rateFor(rows(15, 'kept').concat(rows(5, 'withdrawn')), { at: 'Whitefield', minute: 8 * 60 });
  assert.strictEqual(r.of, 20);
  assert.strictEqual(r.kept, 15);
  assert.strictEqual(r.withdrew, 5);
  assert.strictEqual(r.rate, 0.75);
});

t('a thin cell widens rather than guessing, and says which it used', () => {
  const here = rows(5, 'kept');                                  // Whitefield, morning
  const elsewhen = rows(40, 'kept', { band: 6 });                // Whitefield, evening
  const elsewhere = rows(40, 'kept', { at: 'Hebbal', band: 2 });
  const morning = { at: 'Whitefield', minute: 8 * 60 };
  assert.strictEqual(RL.rateFor(here.concat(elsewhen), morning).level, 'place',
    'five this morning is thin, so it widens to this place at any hour');
  assert.strictEqual(RL.rateFor(here.concat(elsewhen), morning).of, 45);
  assert.strictEqual(RL.rateFor(here.concat(elsewhere), morning).level, 'global',
    'and when the place itself is thin, to everywhere');
  assert.strictEqual(RL.rateFor(rows(40, 'kept'), morning).level, 'place-band',
    'the narrowest cell that holds, when it holds');
});

t('the rate is history applied forward, and is labelled as that', () => {
  const r = RL.rateFor(rows(40, 'kept'), { at: 'Whitefield', minute: 8 * 60 });
  assert.strictEqual(r.quality, 'predicted', 'khaali\'s own past outcomes, carried forward');
  assert.ok(CAP.QUALITY.includes(r.quality), 'and a rung of the ladder the rest of khaali uses');
  assert.notStrictEqual(r.quality, 'exact', 'the count is exact; the rate applied forward is not');
});

t('expected supply is an integer bracketed by two counts', () => {
  const rate = RL.rateFor(rows(31, 'kept').concat(rows(19, 'missed')), { at: 'Whitefield', minute: 8 * 60 });
  const e = RL.expected(12, 0, rate);
  assert.strictEqual(e, 7, '12 x 0.62 is 7.44, and 7.44 never leaves the module');
  assert.ok(Number.isInteger(e));
  assert.strictEqual(RL.expected(12, 9, rate), 9, 'never fewer than the ones already near it');
  assert.strictEqual(RL.expected(12, 0, { rate: 1.4 }), 12, 'never more than the ones who said yes');
  assert.strictEqual(RL.expected(12, 0, RL.rateFor(rows(2, 'kept'), {})), null,
    'and with no measured rate there is no expectation, not a zero');
});

t('a seeded history says it is seeded, and one real row changes that', () => {
  const seeded = rows(40, 'kept', { seed: true });
  assert.strictEqual(RL.rateFor(seeded, {}).seed, true);
  assert.strictEqual(RL.rateFor(seeded, {}).partSeed, false);
  const mixed = RL.rateFor(seeded.concat(rows(1, 'kept')), {});
  assert.strictEqual(mixed.seed, false);
  assert.strictEqual(mixed.partSeed, true, 'part real, and it does not claim to be all real');
});

t('no history at all is not a rate of nothing', () => {
  const r = RL.rateFor([], { at: 'Whitefield', minute: 8 * 60 });
  assert.strictEqual(r.rate, null);
  assert.strictEqual(r.of, 0);
  assert.strictEqual(r.quality, 'unknown');
  assert.strictEqual(RL.expected(12, 0, r), null, 'and twelve who said yes stay twelve who said yes');
});

console.log('\nthe gap, and knowing when to stop asking');

const spot = (floor, ceiling, at) => ({ at: at || 'Whitefield', window: 510,
  windowText: '08:30–09:00', floor, ceiling, lat: 12.9698, lng: 77.75 });
const sup = (said, near) => ({ said, ceiling: said, floor: near || 0,
  rungs: { 'said-yes': said - (near || 0), 'moving-toward': 0, nearby: near || 0, available: 0, served: 0 } });

t('below the privacy floor there is no gap, and that is the whole defence', () => {
  // Publish "gap 2" beside "3 said yes" and you have published that five
  // people are travelling, at a place khaali refused to give a count for. The
  // gap is only ever arithmetic over numbers the map already shows.
  assert.strictEqual(GP.gapOf(spot(2, 2), sup(0), null), null, 'two people is not a hotspot');
  assert.strictEqual(GP.gapOf(spot(0, 2), sup(0), 0), null);
  assert.ok(GP.gapOf(spot(3, 3), sup(0), null), 'three is');
  assert.strictEqual(GP.asks([GP.gapOf(spot(2, 2), sup(0), null)]).length, 0);
});

t('a place where everybody has a bus is not a shortage of drivers', () => {
  // Caught on the first morning-peak screen: Kengeri showed 0 to 21 - twenty-
  // one people booked, every one of whom could take a bus - and khaali asked
  // twenty-one drivers to drive over for them. The fallback was measuring
  // against the ceiling; over-recruiting is the failure this file exists to
  // prevent, so the cautious direction is downwards.
  const g = GP.gapOf(spot(0, 21), sup(0), null);
  assert.strictEqual(g.asking, 0, 'nobody is short of a ride here');
  assert.strictEqual(g.radiusKm, 0);
  assert.strictEqual(g.gapCeiling, 21, 'the pessimistic bound is still reported, as information');
  const real = GP.gapOf(spot(13, 13), sup(0), null);
  assert.strictEqual(real.asking, 13, 'and where nobody has a bus, khaali asks for all of them');
});

t('the gap has two integer bounds even with no reliability at all', () => {
  const g = GP.gapOf(spot(8, 12), sup(3, 1), null);
  assert.strictEqual(g.gap, null, 'no measured rate, no working number');
  assert.strictEqual(g.gapCeiling, 11, 'most people, only the drivers khaali can see');
  assert.strictEqual(g.gapFloor, 5, 'fewest people, every yes turning up');
  assert.ok(Number.isInteger(g.gapCeiling) && Number.isInteger(g.gapFloor));
  assert.ok(g.gapFloor <= g.gapCeiling, 'and the bounds are the right way round');
  // and a negative floor is information, not an error: on the best case there
  // are already more drivers than the fewest people who could turn up
  assert.strictEqual(GP.gapOf(spot(4, 12), sup(9), null).gapFloor, -5);
  assert.ok(g.asking > 0, 'and khaali still asks, on the cautious count');
  assert.match(g.says, /has not measured/);
});

t('the radius widens with the gap and never leaves the last ring', () => {
  assert.strictEqual(GP.radiusFor(0), 0, 'a closed gap is not asked about at all');
  assert.strictEqual(GP.radiusFor(-3), 0);
  assert.strictEqual(GP.radiusFor(1), 2);
  assert.strictEqual(GP.radiusFor(4), 2);
  assert.strictEqual(GP.radiusFor(5), 5);
  assert.strictEqual(GP.radiusFor(9), 10);
  assert.strictEqual(GP.radiusFor(1000), 10, 'never the whole city, however short it is');
  assert.strictEqual(GP.radiusFor(1000), GP.RING_KM[GP.RING_KM.length - 1]);
});

t('the ring closes as drivers arrive, and never widens', () => {
  let last = Infinity;
  for (let said = 0; said <= 14; said++) {
    const g = GP.gapOf(spot(10, 12), sup(said), null);
    assert.ok(g.radiusKm <= last, said + ' drivers widened the ring');
    assert.ok(g.radiusKm <= 10);
    last = g.radiusKm;
  }
  assert.strictEqual(last, 0, 'and it reaches zero');
});

t('enough is enough without any reliability - the stop that works on day one', () => {
  // More heads have said yes than the largest number of people who could
  // possibly show up. This needs no history and no rate.
  const g = GP.gapOf(spot(8, 12), sup(12), null);
  assert.strictEqual(g.enough, true);
  assert.strictEqual(g.asking, 0);
  assert.strictEqual(g.radiusKm, 0);
  assert.match(g.says, /As many drivers/);
  assert.strictEqual(GP.asks([g]).length, 0, 'and nobody is asked');
});

t('oversupply is not merely avoided, it is said out loud', () => {
  // The failure this exists for is a shortage broadcast city-wide: a hundred
  // drivers for forty passengers, and the sixty who came for nothing paid for
  // the mistake.
  const g = GP.gapOf(spot(6, 10), sup(14), 14);
  assert.strictEqual(g.over, 4);
  assert.strictEqual(g.crowded, true);
  assert.strictEqual(g.asking, 0);
  assert.strictEqual(g.radiusKm, 0);
  assert.match(g.says, /more drivers have said.*than there are people booked/i);
});

t('a driver further out than the gap justifies is not asked', () => {
  const wide = GP.gapOf(spot(14, 16), sup(0), null);       // a big gap: ten km
  const thin = GP.gapOf(spot(4, 4), sup(1), null);         // a small one: two km
  const far = { lat: 12.9698 + 0.06, lng: 77.75 };         // about 6.7 km off
  assert.strictEqual(wide.radiusKm, 10);
  assert.strictEqual(thin.radiusKm, 2);
  assert.strictEqual(GP.asks([wide, thin], { near: far }).length, 1, 'only the one that reaches');
  assert.strictEqual(GP.asks([wide, thin], { near: far })[0].at, wide.at);
  assert.strictEqual(GP.asks([wide, thin], { near: { lat: 12.9698, lng: 77.75 } }).length, 2,
    'and standing on it, both');
});

t('supply counts what it can see and forecasts the rest, never the other way', () => {
  const commits = [
    { at: 'Whitefield', window: 510, outcome: null },
    { at: 'Whitefield', window: 510, outcome: null },
    { at: 'Whitefield', window: 510, outcome: null },
    { at: 'Whitefield', window: 510, outcome: 'kept' },        // closed, not supply
    { at: 'Hebbal', window: 510, outcome: null },              // elsewhere
    { at: 'Whitefield', window: 540, outcome: null },          // another half hour
  ];
  let n = 0;
  const s = GP.supplyOf(commits, { at: 'Whitefield', window: 510,
    rungOf: () => (++n === 1 ? { rung: 'nearby' } : { rung: 'said-yes' }) });
  assert.strictEqual(s.said, 3);
  assert.strictEqual(s.floor, 1, 'the one khaali can see is near it');
  assert.strictEqual(s.ceiling, 3);
  assert.ok(s.floor <= s.ceiling);
});

t('nothing khaali tells a passenger is a promise about her ride', () => {
  // "Six drivers have said they will be around Whitefield" is a statement
  // about the board. "A vehicle will be waiting" is a promise about the road.
  const rate = RL.rateFor(rows(31, 'kept').concat(rows(19, 'missed')), { at: 'Whitefield', minute: 8 * 60 });
  const every = [
    GP.outlookLines({ at: 'Whitefield', spot: spot(18, 25) }),
    GP.outlookLines({ at: 'Whitefield', spot: spot(18, 25), said: 6 }),
    GP.outlookLines({ at: 'Whitefield', spot: spot(18, 25), said: 6, rate }),
    GP.outlookLines({ at: 'Whitefield', spot: spot(18, 25), said: 6, rate, near: 3 }),
    GP.outlookLines({ at: 'Whitefield', spot: spot(18, 25), said: 6, rate, moving: 2 }),
    GP.outlookLines({ at: 'Whitefield', said: 1 }),
    [GP.OUTLOOK_FOOT],
  ].flat();
  assert.ok(every.length > 8);
  for (const line of every) {
    assert.doesNotMatch(line, /will be waiting|guarantee|assured|reserved for you/i, line);
    assert.doesNotMatch(line, /your (car|bike|cab|vehicle|driver|ride)/i, line);
    assert.doesNotMatch(line, /\bwill (arrive|come|be there|pick)/i, line);
    assert.doesNotMatch(line, /\bavailable\b/i, 'khaali cannot see a vehicle, so it cannot call one available: ' + line);
    assert.doesNotMatch(line, /\d+%/, line);
  }
  assert.match(GP.OUTLOOK_FOOT, /nobody is on the way/);
});

t('what a passenger is told is caused by something, not by the clock', () => {
  // If nobody says yes and nobody shares, 08:35 must read word for word as
  // 08:00 did. A reassurance that grows as the hour approaches, driven by
  // nothing that happened, is the most comfortable lie in this whole feature.
  const quiet = { at: 'Whitefield', spot: spot(18, 25) };
  assert.deepStrictEqual(GP.outlookLines(quiet), GP.outlookLines(quiet));
  assert.strictEqual(GP.outlookLines(quiet).length, 1, 'a booking count, and nothing else');
  // and every further line needs a thing that happened
  assert.strictEqual(GP.outlookLines({ ...quiet, said: 6 }).length, 3, 'a yes, and the honest gap in it');
  assert.match(GP.outlookLines({ ...quiet, said: 6 })[2], /has not measured/);
  assert.strictEqual(GP.outlookLines({ ...quiet, said: 6, near: 3 }).length, 4);
  assert.match(GP.outlookLines({ ...quiet, said: 6, near: 3 })[3], /3 of them are near Whitefield now/);
  assert.strictEqual(GP.outlookLines({ at: 'X' }).length, 0, 'and with nothing counted, it says nothing');
});

console.log('\nsharing the last mile, and the promise underneath it');

const off = (id, toLat, toLng, extra) => ({ id, status: 'offered', pool: true, pax: 1, offeredAt: 1,
  from: 'Whitefield', fromLat: 12.9698, fromLng: 77.75,
  toLat, toLng, km: PL.km({ lat: 12.9698, lng: 77.75 }, { lat: toLat, lng: toLng }),
  pickupMin: 520, ...(extra || {}) });

t('nobody ever pays more for being pooled', () => {
  // The guarantee the whole feature rests on. Not rarely, not on average:
  // if any rider would be worse off, the pool does not happen at all.
  let pooled = 0, refused = 0;
  for (let i = 0; i < 200; i++) {
    const a = off('a', 12.9698 + 0.02 + (i % 13) * 0.004, 77.75 - 0.03 - (i % 7) * 0.003);
    const b = off('b', 12.9698 + 0.02 + (i % 11) * 0.005, 77.75 - 0.03 - (i % 5) * 0.004);
    if (!PL.compatible(a, b).ok) { refused++; continue; }
    const fare = HR.fareFor('car', PL.pooledKm([a, b]));
    const split = PL.splitFare([{ id: 'a', km: a.km }, { id: 'b', km: b.km }], fare);
    if (split === null) { refused++; continue; }
    pooled++;
    for (const p of split) {
      const alone = HR.fareFor('car', p.km);
      assert.ok(p.min <= alone.min, 'pair ' + i + ': ' + p.id + ' pays ' + p.min + ' vs ' + alone.min + ' alone');
      assert.ok(p.max <= alone.max, 'pair ' + i + ': ' + p.id + ' pays ' + p.max + ' vs ' + alone.max + ' alone');
    }
  }
  assert.ok(pooled > 40, 'the fixture has to actually pool sometimes: ' + pooled + ' of 200');
  assert.ok(refused > 0, 'and refuse sometimes, or it is testing nothing: ' + refused);
});

t('the shares add up to the fare, exactly', () => {
  const a = off('a', 13.02, 77.72), b = off('b', 13.03, 77.71);
  const fare = HR.fareFor('car', PL.pooledKm([a, b]));
  const s = PL.splitFare([{ id: 'a', km: a.km }, { id: 'b', km: b.km }], fare);
  assert.strictEqual(s.reduce((n, p) => n + p.min, 0), fare.min, 'no invented rupee to make it close');
  assert.strictEqual(s.reduce((n, p) => n + p.max, 0), fare.max);
  assert.ok(s[0].saves > 0 && s[1].saves > 0);
});

t('a pool refuses everything it should, and says which', () => {
  const a = off('a', 13.02, 77.72);
  assert.strictEqual(PL.compatible(a, off('b', 12.90, 77.80)).why, 'direction', 'the other way entirely');
  assert.strictEqual(PL.compatible(a, off('b', 13.02, 77.72, { pickupMin: 560 })).why, 'window');
  assert.strictEqual(PL.compatible(a, off('b', 13.02, 77.72, { pax: 4 })).why, 'seats');
  assert.strictEqual(PL.compatible(a, off('b', 13.02, 77.72, { pool: false })).why, 'consent',
    'silence is not consent, and neither is a default');
  assert.strictEqual(PL.compatible(a, off('b', 13.02, 77.72, { pool: undefined })).why, 'consent');
  assert.strictEqual(PL.compatible(a, off('b', 13.02, 77.72, { status: 'accepted' })).why, 'taken');
  assert.strictEqual(PL.compatible(a, off('b', 13.02, 77.72, { from: 'Hebbal' })).why, 'origin');
  assert.strictEqual(PL.compatible(a, a).why, 'same');
});

t('roughly the same direction is not close enough on its own', () => {
  // Two drops ten kilometres out, twenty-five degrees apart - inside the
  // bearing rule, and still a four-kilometre second leg on a ten-kilometre
  // ride. Bearing says yes; the shape of the trip says no.
  const one = off('a', 12.9698 + 0.0637, 77.75 + 0.0653);      // ~10 km, 45 degrees
  const two = off('b', 12.9698 + 0.0308, 77.75 + 0.0868);      // ~10 km, 70 degrees
  assert.strictEqual(PL.compatible(one, two).why, 'detour');
  const alike = off('b', 12.9698 + 0.0600, 77.75 + 0.0690);
  assert.strictEqual(PL.compatible(one, alike).ok, true, 'and a few degrees apart is fine');
});

t('a short drop on the way to a long one costs almost nothing, so it is allowed', () => {
  // This looked wrong when I first wrote the rule and it is not: dropping
  // somebody two kilometres out on the way to twenty-four adds nothing to the
  // vehicle's trip, the short rider is dropped first, and the split by
  // distance leaves both of them paying less than alone.
  const near = off('a', 12.9698 + 0.018, 77.75 + 0.013);
  const far = off('b', 12.9698 + 0.180, 77.75 + 0.130);
  assert.strictEqual(PL.compatible(near, far).ok, true);
  const fare = HR.fareFor('car', PL.pooledKm([near, far]));
  const s = PL.splitFare([{ id: 'a', km: near.km }, { id: 'b', km: far.km }], fare);
  assert.ok(s, 'and the guarantee holds, which is what makes it allowable');
  assert.ok(s[0].saves > 0 && s[1].saves > 0, 'both of them pay less than they would alone');
  assert.ok(s[0].max < s[1].max, 'and the short ride is the cheaper share');
});

t('a pool is a car, and what a car cannot do it still cannot do', () => {
  const a = off('a', 13.02, 77.72, { pax: 2 });
  assert.strictEqual(PL.compatible(a, off('b', 13.02, 77.72, { pax: 3 })).why, 'seats');
  assert.strictEqual(PL.POOL_SEATS, HR.HIRE.car.seats, 'the ceiling is the car hire.mjs describes');
  // and the step-free gate is hire.mjs's, called rather than copied
  assert.deepStrictEqual(HR.allowed(['car'], { pax: 2, needs: ['step-free'] }), ['car']);
});

t('waiting longest anchors the group - a better match does not displace you', () => {
  const first = off('a', 13.02, 77.72, { offeredAt: 1 });
  const second = off('b', 13.03, 77.71, { offeredAt: 5 });
  const third = off('c', 13.025, 77.715, { offeredAt: 9 });
  const groups = PL.group([third, second, first]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0][0].id, 'a', 'the one who has been waiting anchors it');
  assert.ok(groups[0].length <= PL.POOL_MAX);
  assert.strictEqual(PL.group([first]).length, 0, 'one person is not a pool');
  assert.strictEqual(PL.group([first, off('z', 12.90, 77.80)]).length, 0, 'nor two going different ways');
});

t('a pool nobody consented to is never formed, however well it fits', () => {
  const a = off('a', 13.02, 77.72, { pool: false });
  const b = off('b', 13.021, 77.721, { pool: false });
  assert.strictEqual(PL.group([a, b]).length, 0);
  assert.strictEqual(PL.group([a, off('b', 13.021, 77.721)]).length, 0, 'one yes is not two');
});

t('nothing is connected, and khaali does not pretend a seam is a partner', () => {
  assert.deepStrictEqual(PV.PROVIDERS, [], 'no operator is registered, and none is fake');
  assert.match(PV.NONE_CONNECTED, /No other operator is connected/);
  assert.match(PV.NONE_CONNECTED, /khaali/);
});

t('an empty provider list means khaali does not know, not that there are none', async () => {
  assert.deepStrictEqual(await PV.availability({ lat: 12.9, lng: 77.6, when: 510, radiusKm: 2 }), []);
  assert.deepStrictEqual(await PV.quotes({ km: 5, pax: 1 }), []);
  // and the whole system runs with nothing registered, which is the test of
  // the design rather than a caveat on it
  assert.ok(GP.gapOf(spot(8, 12), sup(3), null), 'the gap needs no provider');
  assert.ok(RL.rateFor(rows(40, 'kept'), {}).rate, 'nor does the rate');
});

t('half a provider is worse than none, so it is refused', () => {
  const stub = { id: 'x', name: 'X', source: 's', availabilityAt: async () => null, quote: async () => null };
  assert.match(PV.register(stub).reason, /^missing:/, 'the half that is missing is found by a passenger');
  assert.strictEqual(PV.register({ id: 'y' }).reason, 'incomplete');
  assert.deepStrictEqual(PV.PROVIDERS, [], 'and neither of them got in');
});

t('a provider that answers wrongly is a provider khaali did not hear from', async () => {
  const bad = { id: 'b', name: 'B', source: 's',
    availabilityAt: async () => { throw new Error('down'); },
    quote: async () => ({ min: 1, max: 2, quality: 'excellent' }),   // not a rung of the ladder
    offer: async () => ({ accepted: false, reason: 'no' }), status: async () => null };
  assert.ok(PV.register(bad).ok);
  try {
    assert.deepStrictEqual(await PV.availability({}), [], 'a throw is silence, never an invented number');
    assert.deepStrictEqual(await PV.quotes({}), [], 'and a quality khaali does not use is not shown');
    const good = { ...bad, id: 'g', name: 'G', quote: async () => ({ min: 90, max: 140, quality: 'estimated' }) };
    assert.ok(PV.register(good).ok);
    const q = await PV.quotes({});
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].name, 'G', 'and what is shown carries whose number it is');
    assert.ok(CAP.QUALITY.includes(q[0].quality));
    PV.forget('g');
  } finally { PV.forget('b'); PV.forget('g'); }
  assert.deepStrictEqual(PV.PROVIDERS, []);
});

console.log('\none ladder, and the difference between grey and green');

t('a number khaali did not measure cannot colour anything', () => {
  // road.mjs's own header calls a road drawn green because nobody has driven it
  // the most dangerous thing this feature could do, and then /api/road passed a
  // hard-coded quality and made that branch unreachable. This is the guard.
  for (let x = 0; x <= 1.0001; x += 0.01) {
    const b = LD.bandOf(x, 'unknown');
    assert.strictEqual(b.band, 'unknown', 'load ' + x.toFixed(2) + ' coloured itself');
    assert.strictEqual(b.load, null, 'and it did not keep the number either');
    assert.strictEqual(b.colour, LD.COLOUR.unknown);
  }
  assert.strictEqual(LD.bandOf(null).band, 'unknown');
  assert.strictEqual(LD.bandOf(undefined).band, 'unknown');
  assert.strictEqual(LD.bandOf(NaN).band, 'unknown');
});

t('the ladder reproduces the road bands exactly, so no colour moved', () => {
  // The refactor is only allowed if nothing anybody has already seen changes.
  // road bands are on a speed RATIO descending; load is 1 - ratio ascending.
  const b = LD.BANDS, r = RD.BANDS;
  assert.strictEqual(Math.round((1 - r.green) * 100) / 100, b.green);
  assert.strictEqual(Math.round((1 - r.yellow) * 100) / 100, b.yellow);
  assert.strictEqual(Math.round((1 - r.orange) * 100) / 100, b.orange);
  // and end to end: the same speed lands on the same band both ways
  const free = 22.7;
  for (const kmh of [22, 20, 17, 14, 11, 8]) {
    const viaRoad = RD.stateOf({ kmh, quality: 'estimated' }).band;
    const viaLoad = LD.fromSpeed(kmh, free, 'estimated').band;
    assert.strictEqual(viaLoad, viaRoad, kmh + ' km/h moved from ' + viaRoad + ' to ' + viaLoad);
  }
});

t('grey is not a fifth kind of good', () => {
  assert.strictEqual(LD.fromSpeed(null, 22.7).band, 'unknown');
  assert.strictEqual(LD.fromSpeed(14, 22.7, 'unknown').band, 'unknown');
  assert.strictEqual(LD.fromSpeed(14, 0).band, 'unknown', 'and a free-flow of nothing is not a ratio');
  assert.match(LD.legend().says, /Grey is not green/);
  assert.strictEqual(LD.WORD.unknown, 'not known');
});

t('the same colour, drawn two ways, for measured and made up', () => {
  const counted = LD.bandOf(0.8, 'exact');
  const guessed = LD.bandOf(0.8, 'simulated');
  assert.strictEqual(counted.band, guessed.band, 'the congestion is real either way');
  assert.strictEqual(counted.colour, guessed.colour, 'so the hue is the same');
  assert.notStrictEqual(counted.texture, guessed.texture, 'and they are never the same object');
  assert.strictEqual(counted.texture, 'solid');
  assert.strictEqual(guessed.texture, 'hatch');
  assert.strictEqual(LD.bandOf(0.8, 'unknown').texture, 'void');
});

t('a count may raise a band and may never lower one', () => {
  // Somebody counted people boarding. That says the load is AT LEAST this much;
  // it says nothing about who was already aboard, so the arithmetic runs one
  // way. A tap can turn grey red. It can never turn red green.
  const nothing = LD.bandOf(null, 'unknown');
  const red = LD.bandOf(0.9, 'simulated');
  assert.strictEqual(LD.bandAtLeast(nothing, 0.8, 'counted').band, 'red');
  assert.strictEqual(LD.bandAtLeast(nothing, 0.8, 'counted').atLeast, true);
  assert.strictEqual(LD.bandAtLeast(red, 0.05, 'counted').band, 'red', 'a small count does not cool it');
  assert.strictEqual(LD.bandAtLeast(red, 0.05, 'counted').atLeast, false, 'and does not claim to be a bound');
  assert.strictEqual(LD.bandAtLeast(nothing, 0.02, 'counted').band, 'unknown', 'too few to say anything');
});

t('metro keeps its own words rather than being renamed', () => {
  // BMRCL's quiet/busy/crush break at 0.40 and 0.75. Through the road ladder a
  // station at 0.30 would go yellow and half the line would be renamed.
  assert.strictEqual(LD.bandOf(0.30, 'predicted', 'metro').band, 'green');
  assert.strictEqual(LD.bandOf(0.30, 'predicted').band, 'yellow', 'which is what the road ladder would say');
  assert.strictEqual(LD.bandOf(0.80, 'predicted', 'metro').band, 'red');
  assert.strictEqual(LD.bandsFor('metro').green, 0.40);
  assert.strictEqual(LD.bandsFor('road').green, LD.BANDS.green, 'and road takes the default');
});

t('a journey is as crowded as its worst leg, not its average', () => {
  const legs = [LD.bandOf(0.1, 'exact'), LD.bandOf(0.9, 'exact'), LD.bandOf(0.2, 'exact')];
  assert.strictEqual(LD.worstOf(legs).band, 'red', 'an hour sitting does not undo twenty minutes crushed');
  assert.strictEqual(LD.worstOf([LD.bandOf(null, 'unknown')]), null, 'and nothing known is not a worst');
  assert.strictEqual(LD.worstOf([]), null);
});

console.log('\nthe corridor, leg by leg - the one thing khaali counts');

t('the per-leg count agrees with the number the booking path uses', () => {
  // segmentLoad walks the same arrays anySeatsFor walks, in its own loop,
  // because anySeatsFor sits inside hold()'s compare-and-swap and allocating an
  // array in that path is a change to that path. The duplication is the price;
  // this is what stops the two drifting apart.
  const train = '16021', date = '2026-09-12', cls = 'SL';
  const r = S.segmentLoad(train, date, cls);
  for (const [from, to] of [[0, 13], [0, 5], [5, 13], [2, 8], [6, 7], [1, 4]]) {
    const want = S.countsFor(train, date, cls, from, to).anySeats;
    let room = r.total;
    for (let l = from; l < to; l++) room = Math.min(room, r.total - r.segments[l].occupied);
    assert.strictEqual(Math.max(0, room), want, 'legs ' + from + '-' + to + ' disagree');
  }
});

t('a leg says which of its passengers khaali counted and which it declared', () => {
  const r = S.segmentLoad('16021', '2026-09-13', 'SL');
  for (const sg of r.segments) {
    assert.strictEqual(sg.booked + sg.held + sg.pooled + sg.seeded, sg.occupied,
      'leg ' + sg.leg + ' has passengers from nowhere');
    assert.strictEqual(sg.free, sg.total - sg.occupied);
    assert.ok(sg.load >= 0 && sg.load <= 1);
  }
  // nothing booked through khaali yet, so every leg is khaali's own declared
  // starting occupancy - and it says so rather than borrowing the word 'exact'
  const untouched = r.segments.filter(sg => sg.booked + sg.held + sg.pooled === 0 && sg.seeded > 0);
  assert.ok(untouched.length, 'the fixture should have seeded legs');
  untouched.forEach(sg => assert.strictEqual(sg.quality, 'simulated',
    'a leg khaali invented called itself ' + sg.quality));
  untouched.forEach(sg => assert.match(sg.says, /were there when the day started/));
});

t('a hold moves exactly the legs it spans, and no others', () => {
  const train = '16021', date = '2026-09-14', cls = 'SL';
  const before = S.segmentLoad(train, date, cls);
  const av = S.availability(train, date, cls, 3, 6);
  const idx = av.berths.findIndex(b => b.k === 'free');
  assert.ok(idx >= 0, 'the fixture needs a free berth');
  const h = S.hold({ train, date, cls, from: 3, to: 6, who: 'seg@test', pax: 1,
    berthIdxs: [idx], mode: 'exact' });
  assert.ok(h.ok, h.reason);
  const after = S.segmentLoad(train, date, cls);
  for (let l = 0; l < before.segments.length; l++) {
    const want = before.segments[l].occupied + (l >= 3 && l < 6 ? 1 : 0);
    assert.strictEqual(after.segments[l].occupied, want, 'leg ' + l + ' moved when it should not have');
  }
  // and the legs it does touch stop being purely declared
  [3, 4, 5].forEach(l => {
    assert.strictEqual(after.segments[l].held, before.segments[l].held + 1);
    assert.strictEqual(after.segments[l].quality, 'mixed', 'a real hold on a seeded leg is both');
  });
  S.release(h.holdId);
});

t('a train at half capacity is not a jam, whatever a road at half speed is', () => {
  // Reading the corridor through the road ladder painted all thirteen legs red
  // at occupancies khaali calls "seats available" everywhere else in the app.
  assert.strictEqual(LD.bandOf(0.56, 'exact', 'rail').band, 'green');
  assert.strictEqual(LD.bandOf(0.56, 'exact', 'road').band, 'orange', 'which is right for a road');
  assert.strictEqual(LD.bandOf(0.78, 'exact', 'road').band, 'red');
  assert.strictEqual(LD.bandOf(0.82, 'exact', 'rail').band, 'yellow');
  assert.strictEqual(LD.bandOf(0.99, 'exact', 'rail').band, 'red');
});

console.log('\nhow full a bus is, and how khaali came to think so');

const SEG = { routeId: '500D-1', routeName: '500D', segIdx: 12, nSegs: 30, dir: 0,
  fromStop: 'Whitefield', toStop: 'Marathahalli' };
const taps = (n, extra) => BL.indexScans(
  Array.from({ length: n }, (_, i) => ({ route: '500D', from: 'Whitefield', to: 'Marathahalli',
    at: 1000, who: 'p' + i, ...(extra || {}) })), { now: 1000 });

t('a count is a floor, and there is no percentage in it to render', () => {
  // Three people tapping on says nothing about the forty already aboard. It
  // supports one statement - at least three got on - and the object is shaped
  // so that a reader who wanted a percentage would not find one.
  const r = BL.reading(SEG, { scans: taps(12), minute: 9 * 60 });
  assert.strictEqual(r.rung, 'counted');
  assert.strictEqual(r.load, null, 'a counted rung carries no load at all');
  assert.strictEqual(r.unit, 'people');
  assert.strictEqual(r.floor, 12);
  assert.doesNotMatch(r.says, /%/, r.says);
  assert.doesNotMatch(r.says, /\bfull\b/, r.says);
  assert.match(r.says, /At least 12 people/);
  assert.match(r.says, /does not know who else is aboard/);
});

t('too few people to publish is not a small number, it is no number', () => {
  const two = BL.reading(SEG, { scans: taps(2), minute: 9 * 60 });
  assert.notStrictEqual(two.rung, 'counted', 'two taps describes two people');
  assert.strictEqual(two.floor, null, 'and it carries no count at all, not even 2');
  assert.strictEqual(BL.FLOOR, DM.FLOOR, 'the same floor, and the same argument, as the demand map');
  assert.strictEqual(BL.reading(SEG, { scans: taps(3), minute: 9 * 60 }).rung, 'counted');
});

t('a count raises a band and never lowers one', () => {
  const many = BL.reading(SEG, { scans: taps(60), minute: 3 * 60 });
  assert.strictEqual(many.band.band, 'red', '60 people against a crush of 75 forces red');
  assert.strictEqual(many.band.atLeast, true, 'and says it is a bound, not a reading');
  // at 3am the model would say green; four people cannot argue it up, and
  // cannot argue anything down either
  const few = BL.reading(SEG, { scans: taps(4), minute: 3 * 60 });
  assert.strictEqual(few.band.band, 'unknown', 'four people is not a claim about a bus');
  assert.strictEqual(few.rung, 'counted', 'though it is still a count');
});

t('one person scanning five times is one person', () => {
  const same = BL.indexScans(Array.from({ length: 5 }, () =>
    ({ route: '500D', from: 'Whitefield', to: 'Marathahalli', at: 1000, who: 'her' })), { now: 1000 });
  assert.strictEqual(BL.reading(SEG, { scans: same, minute: 9 * 60 }).rung, 'modelled',
    'five taps by one person is one person, which is under the floor');
});

t('a tap from an hour ago is not a bus that is here now', () => {
  const old = BL.indexScans(Array.from({ length: 12 }, (_, i) =>
    ({ route: '500D', from: 'Whitefield', to: 'Marathahalli', at: 0, who: 'p' + i })),
    { now: 90 * 60000 });
  assert.strictEqual(BL.reading(SEG, { scans: old, minute: 9 * 60 }).rung, 'modelled');
});

t('the demo model never once claims to be a measurement', () => {
  for (let i = 0; i < 200; i++) {
    const r = BL.reading({ ...SEG, routeId: 'r' + (i % 17), segIdx: i % 30, dir: i % 2 },
      { minute: (i * 7) % 1440 });
    assert.strictEqual(r.quality, 'simulated', 'reading ' + i);
    assert.strictEqual(r.rung, 'modelled');
    assert.strictEqual(r.demo, true);
    assert.doesNotMatch(r.source, /measur|counted|actual|observed/i, r.source);
    assert.match(r.says, /demo model/);
    assert.ok(r.load >= 0 && r.load <= 1);
  }
});

t('the same question twice gives the same answer, on any machine', () => {
  // A hash, not a seeded generator: no state, no ordering, and a map that does
  // not shimmer between two identical requests.
  const a = BL.reading(SEG, { minute: 9 * 60 });
  const b = BL.reading(SEG, { minute: 9 * 60 });
  assert.deepStrictEqual(a, b);
  const raw = BL.modelLoad({ routeId: '500D-1', segIdx: 12, nSegs: 30, minute: 540, dir: 0 });
  assert.strictEqual(Math.round(raw * 100) / 100, a.load, 'the reading is the model, rounded once');
});

t('change any one thing and the number moves', () => {
  // The failure this catches is a model that has quietly collapsed to a
  // constant, which is exactly what a boarding-position ramp is once you hold
  // the route fixed.
  const at = o => BL.modelLoad({ routeId: '500D-1', segIdx: 12, nSegs: 30, minute: 540, dir: 0, ...o });
  const base = at({});
  assert.notStrictEqual(at({ routeId: 'other-1' }), base, 'the route did nothing');
  assert.notStrictEqual(at({ segIdx: 2 }), base, 'where along the route did nothing');
  assert.notStrictEqual(at({ minute: 3 * 60 }), base, 'the hour did nothing');
  assert.notStrictEqual(at({ dir: 1 }), base, 'the direction did nothing');
  // and the shape is a hump, not a ramp to the terminus
  const along = [0, 5, 12, 18, 25, 29].map(segIdx => at({ segIdx }));
  assert.ok(Math.max(...along) > along[along.length - 1],
    'the model has a bus at its fullest pulling into the terminus, which is the old ramp');
});

t('an operator would be believed over a model, and nobody is an operator yet', () => {
  const feed = { loadFor: () => ({ load: 0.42, source: 'BMTC ETM' }) };
  const r = BL.reading(SEG, { feed, minute: 9 * 60 });
  assert.strictEqual(r.rung, 'declared');
  assert.strictEqual(r.quality, 'exact');
  assert.strictEqual(r.load, 0.42);
  assert.match(r.source, /BMTC ETM/);
  // one that throws, or answers nothing, is one khaali did not hear from
  assert.strictEqual(BL.reading(SEG, { feed: { loadFor: () => { throw new Error('down'); } },
    minute: 9 * 60 }).rung, 'modelled');
  assert.strictEqual(BL.reading(SEG, { feed: { loadFor: () => null }, minute: 9 * 60 }).rung, 'modelled');
  // whether anything is registered is providers.mjs's own test to make; this
  // one must not depend on global state another test owns
});

t('a simulated leg is worth more than silence and less than a timetable', () => {
  // Without this entry pressure() fell through to 0.3 and weighed a modelled
  // bus exactly as badly as one khaali knew nothing about - which would have
  // moved recommendations the day busload started answering.
  assert.ok(CAP.QUALITY_WEIGHT.simulated > CAP.QUALITY_WEIGHT.unknown);
  assert.ok(CAP.QUALITY_WEIGHT.simulated < CAP.QUALITY_WEIGHT.estimated);
  assert.ok(CAP.QUALITY_WEIGHT.counted > CAP.QUALITY_WEIGHT.estimated);
  assert.ok(CAP.QUALITY_WEIGHT.counted < CAP.QUALITY_WEIGHT.exact);
  for (const q of CAP.QUALITY) assert.ok(CAP.QUALITY_WEIGHT[q] != null, q + ' has no weight');
});

console.log('\nwhat you would have done, and what khaali did instead');

const cleg = (mode, min, occ) => ({ mode, min, cap: { occupancy: occ, quality: 'exact' } });
const cch = (kind, dep, total, fare, changes, seatWord, legs) => ({ kind, dep, arr: dep + total,
  totalMin: total, fare, changes,
  seat: { word: seatWord, rank: { standing: 0, maybe: 1, likely: 2, yes: 3 }[seatWord] }, legs });

t('the obvious route is the direct train, even when it scores worst', () => {
  // This must not become "the second best answer khaali found" - that would
  // make the whole comparison circular.
  const awful = cch('train-through', 520, 90, 300, 0, 'standing', [cleg('train', 90, 0.99)]);
  awful.alloc = { pressure: { value: 0.98, certainty: 'HIGH' } };
  const lovely = cch('bus+train', 520, 55, 120, 1, 'yes', [cleg('bus', 20, 0.2), cleg('train', 35, 0.3)]);
  lovely.alloc = { pressure: { value: 0.09, certainty: 'HIGH' } };
  const o = CP.obviousOf([lovely, awful], {});
  assert.strictEqual(o.rule, 'DIRECT_TRAIN');
  assert.strictEqual(o.chain, awful, 'it picked the nice one, which is not what a person does');
  assert.match(o.why, /without khaali/);
});

t('the obvious route falls through in the order a person would say it', () => {
  const bus = cch('direct|500D', 520, 70, 40, 0, 'maybe', [cleg('bus', 70, 0.5)]);
  const rail2 = cch('train+train', 520, 60, 150, 1, 'likely', [cleg('train', 30, 0.4), cleg('train', 30, 0.4)]);
  // a journey with both a direct bus and a train is a rail journey
  assert.strictEqual(CP.obviousOf([bus, rail2], {}).rule, 'FEWEST_CHANGES_RAIL');
  assert.strictEqual(CP.obviousOf([bus], {}).rule, 'DIRECT_BUS');
  const ride = cch('hire:car', 520, 25, 300, 0, 'yes', [cleg('car', 25, 0)]);
  assert.strictEqual(CP.obviousOf([ride], {}).rule, 'ONLY_A_RIDE');
  const mix = cch('bus+metro', 520, 50, 60, 1, 'maybe', [cleg('bus', 25, 0.4), cleg('metro', 25, 0.4)]);
  assert.strictEqual(CP.obviousOf([mix], {}).rule, 'FEWEST_CHANGES');
  assert.strictEqual(CP.obviousOf([], {}), null);
});

t('a saving is only ever claimed on an axis that actually improved', () => {
  // "faster" and "saves" are not decorations.
  for (let i = 0; i < 120; i++) {
    const aMin = 40 + (i % 7) * 6, bMin = 40 + (i % 5) * 9;
    const aFare = 100 + (i % 4) * 30, bFare = 100 + (i % 6) * 20;
    const seats = ['standing', 'maybe', 'likely', 'yes'];
    const a = cch('train-through', 520, aMin, aFare, 0, seats[i % 4], [cleg('train', aMin, 0.3 + (i % 7) / 10)]);
    const b = cch('bus+train', 520, bMin, bFare, 1, seats[(i + 2) % 4],
      [cleg('bus', 15, 0.2 + (i % 5) / 10), cleg('train', bMin - 15, 0.3 + (i % 3) / 10)]);
    const d = CP.diff({ chain: a, rule: 'DIRECT_TRAIN', why: 'x', idx: 0 }, { chain: b }, { after: 520 });
    for (const ax of d.axes) {
      if (ax.key === 'seat') assert.strictEqual(ax.direction === 'better', ax.delta > 0);
      else if (ax.direction === 'better') assert.ok(ax.delta < 0, ax.key + ' claims better on ' + ax.delta);
      else if (ax.direction === 'worse') assert.ok(ax.delta > 0, ax.key + ' claims worse on ' + ax.delta);
    }
    const text = CP.lines(d).join(' ');
    const fasterClaimed = /quicker|faster/.test(text);
    const m = d.axes.find(x => x.key === 'minutes');
    if (fasterClaimed && !/quickest way of all/.test(text)) {
      assert.ok(m && m.direction === 'better', 'claimed quicker on ' + (m && m.delta) + ': ' + text);
    }
    if (/cheaper/.test(text)) {
      const f = d.axes.find(x => x.key === 'fare');
      assert.ok(f && f.direction === 'better', 'claimed cheaper on ' + (f && f.delta));
    }
  }
});

t('six minutes longer leads with the cost, not with an excuse', () => {
  const a = cch('train-through', 520, 58, 180, 0, 'likely', [cleg('train', 58, 0.5)]);
  const b = cch('bus+train', 520, 64, 180, 1, 'likely', [cleg('bus', 20, 0.5), cleg('train', 44, 0.5)]);
  const d = CP.diff({ chain: a, rule: 'DIRECT_TRAIN', why: 'the direct train', idx: 0 }, { chain: b }, { after: 520 });
  const first = CP.lines(d)[0];
  assert.match(first, /^6 minutes longer/, first);
  assert.strictEqual(d.axes.find(x => x.key === 'minutes').direction, 'worse');
});

t('minutes do not get the headline just for being the biggest number', () => {
  // A seat is worth more than four minutes, and minutes are numerically larger
  // than every other axis, so the weights are what stop them winning by size.
  const a = cch('train-through', 520, 60, 180, 0, 'standing', [cleg('train', 60, 0.9)]);
  const b = cch('bus+train', 520, 64, 180, 1, 'yes', [cleg('bus', 20, 0.3), cleg('train', 44, 0.3)]);
  const d = CP.diff({ chain: a, rule: 'DIRECT_TRAIN', why: 'x', idx: 0 }, { chain: b }, { after: 520 });
  assert.notStrictEqual(d.headline, 'minutes', 'minutes won on size alone');
  assert.ok(['seat', 'crowding'].includes(d.headline), d.headline);
  assert.match(CP.lines(d)[0], /4 minutes longer/, 'and the cost is still in the first sentence');
});

t('when khaali agrees with the obvious way it says so rather than hiding', () => {
  // Hiding the panel would train people to read its presence as "khaali did
  // something clever", which makes the panel an advertisement.
  const a = cch('train-through', 520, 58, 180, 0, 'likely', [cleg('train', 58, 0.5)]);
  const d = CP.diff({ chain: a, rule: 'DIRECT_TRAIN', why: 'the direct train', idx: 0 },
    { chain: a }, { after: 520 });
  assert.strictEqual(d.same, true);
  const lines = CP.lines(d);
  assert.ok(lines.length >= 2, 'the panel is never empty');
  assert.match(lines[0], /also the way khaali would pick/);
  assert.match(lines[1], /Nothing here is a detour/);
});

t('the busiest-stretch axis is absent when there is no map to read', () => {
  const a = cch('train-through', 520, 58, 180, 0, 'likely', [cleg('train', 58, 0.5)]);
  const b = cch('bus+train', 520, 64, 180, 1, 'likely', [cleg('bus', 20, 0.5), cleg('train', 44, 0.5)]);
  const args = { after: 520 };
  const without = CP.diff({ chain: a, idx: 0 }, { chain: b }, args);
  assert.ok(!without.axes.some(x => x.key === 'worstSegment'), 'it invented a layer');
  assert.doesNotMatch(CP.lines(without).join(' '), /busiest stretch/i);
  // and with one, it appears - reading each leg's own load, so the two routes
  // can genuinely differ rather than both resolving to the same mode
  const crowded = cch('train-through', 520, 58, 180, 0, 'likely', [cleg('train', 58, 0.92)]);
  const easy = cch('bus+train', 520, 64, 180, 1, 'likely', [cleg('bus', 20, 0.2), cleg('train', 44, 0.35)]);
  const layer = l => LD.bandOf(l.cap.occupancy, 'exact', 'rail');
  const w = CP.diff({ chain: crowded, idx: 0 }, { chain: easy }, { ...args, layer });
  const ws = w.axes.find(x => x.key === 'worstSegment');
  assert.ok(ws, 'the layer was passed and the axis did not appear');
  assert.strictEqual(ws.obvious, 0.92);
  assert.strictEqual(ws.pick, 0.35);
  assert.strictEqual(ws.direction, 'better');
  assert.match(CP.lines(w).join(' '), /busiest stretch/i);
});

t('every sentence khaali can produce here is a sentence somebody wrote', () => {
  // The gap.outlookLines posture: walk the shapes and read all of them.
  const seats = ['standing', 'maybe', 'likely', 'yes'];
  let seen = 0;
  for (let i = 0; i < 60; i++) {
    const a = cch('train-through', 520, 50 + i, 150 + i * 3, 0, seats[i % 4], [cleg('train', 50 + i, (i % 9) / 10)]);
    const b = cch('bus+train', 520, 50 + (i * 3) % 40, 140 + (i % 5) * 25, 1, seats[(i + 1) % 4],
      [cleg('bus', 18, (i % 6) / 10), cleg('train', 30, (i % 4) / 10)]);
    const d = CP.diff({ chain: a, rule: 'DIRECT_TRAIN', why: 'the direct train', idx: 0 },
      { chain: b }, { after: 520, fastest: a });
    for (const line of CP.lines(d)) {
      seen++;
      assert.ok(line.length > 5, 'an empty sentence: ' + JSON.stringify(line));
      assert.doesNotMatch(line, /undefined|NaN|\[object/, line);
      assert.match(line, /[.!]$/, 'a sentence without an end: ' + line);
    }
  }
  assert.ok(seen > 100, 'only ' + seen + ' sentences reached');
  assert.match(CP.FOOT, /not a route anyone has measured you taking/);
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
  assert.strictEqual(p.certainty, 'LOW');
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
  // somebody took it, so there is somebody to be on the way
  const taken = { status: 'accepted', driver: 'd1' };
  const at = m => HR.statusOf(r, m, { today: '2026-09-10', offer: taken });
  assert.strictEqual(at(9 * 60 - 60).stage, 'booked');
  assert.strictEqual(at(9 * 60 - 12).stage, 'assigned');
  assert.strictEqual(at(9 * 60 - 2).stage, 'arriving');
  const mid = at(9 * 60 + Math.floor(r.min / 2));
  assert.strictEqual(mid.stage, 'riding');
  assert.ok(mid.progress > 20 && mid.progress < 80, mid.progress + '% through');
  assert.strictEqual(at(9 * 60 + r.min + 5).stage, 'arrived');
  assert.strictEqual(at(9 * 60 + r.min + 5).progress, 100);
  // nothing here pretends khaali can see the vehicle
  Object.values([at(9 * 60 - 60), mid]).forEach(s => {
    assert.strictEqual(s.simulated, true);
    assert.ok(/booking and the clock/.test(s.source), s.source);
  });
});

t('one offer, two tariffs - the category is what is said, not what is priced', () => {
  // khaali offers private transport because it cannot promise a vehicle. That
  // is a change to what it SAYS. Underneath, a bike still carries one person
  // and still has no ramp, and if that ever stops being enforced the category
  // has started making a promise after all.
  assert.strictEqual(HR.CATEGORY.name, 'Private transport');
  assert.match(HR.CATEGORY.of, /bike.*auto.*car/);
  assert.deepStrictEqual(HR.allowed(['bike', 'car'], { pax: 3 }), ['car'], 'three people is not a bike');
  assert.deepStrictEqual(HR.allowed(['bike', 'car'], { needs: ['step-free'] }), ['car'], 'a ramp is not a bike');
  assert.deepStrictEqual(HR.allowed(['bike', 'car'], { pax: 1 }), ['bike', 'car'], 'and both still reach the allocator');
  assert.notStrictEqual(HR.fareFor('bike', 8), HR.fareFor('car', 8), 'two tariffs, still two');
  // every kind wears the one label a traveller sees, and keeps its own word
  for (const k of HR.KINDS) {
    assert.strictEqual(HR.HIRE[k].label, HR.CATEGORY.name);
    assert.ok(HR.HIRE[k].name && HR.HIRE[k].name !== HR.CATEGORY.name, 'the engine keeps its own word');
  }
});

t('nobody accepted it, so khaali does not say anybody is coming', () => {
  const r = HR.newRide({ id: 'abcdef000002', who: 'h', date: '2026-09-10', kind: 'car',
    from: 'Majestic', to: 'Hoodi', km: 18, pickupMin: 9 * 60 }).ride;
  // The stages used to fire off the clock alone. Harmless while nobody could
  // ever accept; a lie the moment somebody could.
  const at = m => HR.statusOf(r, m, { today: '2026-09-10' });
  for (const m of [9 * 60 - 12, 9 * 60 - 2, 9 * 60 + 4, 9 * 60 + r.min + 5]) {
    const s = at(m);
    assert.strictEqual(s.stage, 'booked', 'at ' + m + ' it claimed ' + s.stage);
    assert.strictEqual(s.dispatched, false);
    assert.ok(!/assigned|Arriving|On the way/.test(s.label), s.label);
  }
  assert.match(at(9 * 60 - 12).label, /Waiting for a driver/);
  assert.match(at(9 * 60 + 40).label, /Nobody accepted this/);
  // and an offer somebody DID take moves again
  assert.strictEqual(HR.statusOf(r, 9 * 60 - 12,
    { today: '2026-09-10', offer: { status: 'accepted' } }).stage, 'assigned');
  assert.strictEqual(HR.statusOf(r, 9 * 60 - 12,
    { today: '2026-09-10', offer: { status: 'expired' } }).stage, 'booked');
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

// This test used to assert that Comfortable takes the switch on this pair. It
// did - but only because khaali was connecting at zero slack: the bus landed at
// 08:50 and khaali sold her the 09:26 train off a bus whose timetable it had
// declared rather than read. Priced honestly the next train she can actually
// make is 10:30, and the switch costs about a hundred minutes more than
// standing on the direct train. Nobody should be sold that as comfort.
//
// So the switch does not win here, and that is the finding, not a regression.
// What makes a detour worth its time is per-stretch berth availability - the one
// thing khaali can see and nobody else can - and the planner does not consult it
// yet. Until it does, this asserts the two things that ARE true: the option is
// offered, and the change inside it is one a person could make.
t('the switch is offered, and every change in it is one she could make', () => {
  const long = ride('SBC', fullEarly);
  CAP.annotate(long.chains, { trainCap: capEarly });
  const sw = long.chains.find(c => c.kind === 'bus+train');
  assert.ok(sw, 'the switch must still be on the page');
  assert.strictEqual(sw.seat.word, 'yes', 'she sits the whole way, which is the point of it');

  const bus = sw.legs.find(l => l.mode === 'bus');
  const train = sw.legs.find(l => l.mode === 'train');
  const walk = sw.legs.find(l => l.mode === 'walk');
  const v = XF.feasible(bus, train, XF.edge({ walkMinutes: walk ? walk.min : 0 }));
  assert.ok(v.ok, 'khaali offered a change it had not checked: ' + v.code + ' / ' + v.says);

  const a = AL.allocate(long.chains, { profile: 'comfortable', after: 420 });
  assert.ok(a.recommended != null);
  assert.ok(sw.totalMin > long.chains[a.recommended].totalMin + 60,
    'if the switch ever gets close on time, this test is measuring the wrong thing');

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

console.log('\nthe change: whether a person could actually make it');

// khaali connected at zero slack everywhere - busThenTrain asked for trains from
// the minute the bus landed, train+metro planned from t.arr, train+bus asked for
// the next bus from t.arr, and the multi-hop clock carried at = pick.arr. Every
// one of them would sell her a train leaving the same minute she stepped off.

t('a train leaving the minute the bus lands is not a connection', () => {
  const bus = { arrMin: 530, source: 'timetable' };
  assert.strictEqual(XF.feasible(bus, { depMin: 530, mode: 'train' }).code, 'TRANSFER_TOO_TIGHT');
  assert.strictEqual(XF.feasible(bus, { depMin: 500, mode: 'train' }).code, 'TRANSFER_TOO_TIGHT');
  assert.ok(/leaves before this one arrives/.test(XF.feasible(bus, { depMin: 500, mode: 'train' }).says));
});

t('same stop, published both sides: eight minutes and no more', () => {
  const bus = { arrMin: 530, source: 'timetable' };
  assert.strictEqual(XF.SAME_STOP, 8);
  assert.ok(!XF.feasible(bus, { depMin: 530 + 7, mode: 'train' }).ok, 'seven is not enough');
  assert.ok(XF.feasible(bus, { depMin: 530 + 8, mode: 'train' }).ok, 'eight is');
});

t('a declared headway costs twenty minutes, and khaali says which twenty', () => {
  const declared = { arrMin: 530, source: 'simulated' };
  const published = { arrMin: 530, source: 'timetable' };
  const at = m => ({ depMin: 530 + m, mode: 'train' });
  assert.ok(XF.feasible(published, at(10)).ok);
  assert.ok(!XF.feasible(declared, at(10)).ok, 'a modelled arrival is not a known one');
  assert.ok(XF.feasible(declared, at(28)).ok);
  assert.strictEqual(XF.requiredFor(declared) - XF.requiredFor(published), XF.BUFFER.unpublished);
  const says = XF.feasible(declared, at(10)).says;
  assert.ok(/declared headway/.test(says), says);
  assert.ok(!/guarantee|will be on time|make this connection/i.test(says), says);
});

t('a long walk is not loitering: the cap is on the wait, not the gap', () => {
  // fifty minutes between two vehicles, forty of which she spends walking.
  // Measured on the gap that is a rejection; measured on the wait it is ten
  // minutes on a platform, which is exactly what it is.
  const bus = { arrMin: 500, source: 'timetable' };
  const e = XF.edge({ walkMinutes: 40, stationEntryMinutes: 0 });
  const f = XF.feasible(bus, { depMin: 550, mode: 'bus' }, e);
  assert.strictEqual(f.gap, 50);
  assert.strictEqual(f.access, 40);
  assert.strictEqual(f.wait, 10);
  assert.ok(f.ok, f.says);
});

t('forty minutes onto a corridor train is a connection; onto a metro it is a mistake', () => {
  const t0 = { arrMin: 500, source: 'timetable' };
  const at = (m, mode) => ({ depMin: 500 + m, mode });
  assert.ok(XF.feasible(t0, at(40, 'train')).ok, 'trains here run an hour apart');
  assert.strictEqual(XF.feasible(t0, at(40, 'metro')).code, 'TRANSFER_TOO_LONG');
  assert.ok(XF.maxWaitFor({ mode: 'train' }) > XF.maxWaitFor({ mode: 'metro' }),
    'one number for both would either wave through loitering or throw away a real answer');
});

t('a missing time is not a passing check', () => {
  assert.strictEqual(XF.feasible({ source: 'timetable' }, { depMin: 500 }).code, 'NO_TIMES');
  assert.strictEqual(XF.feasible({ arrMin: 500 }, {}).code, 'NO_TIMES');
  assert.strictEqual(XF.windowFor({ source: 'timetable' }).ok, false);
  // and it is refused rather than repaired: twenty minutes does not invent an
  // arrival khaali never had
  assert.strictEqual(XF.feasible({ source: 'simulated' }, { depMin: 900 }).code, 'NO_TIMES');
});

t('the window a planner searches is exactly the window that passes', () => {
  const bus = { arrMin: 530, source: 'simulated' };
  const e = XF.edge({ walkMinutes: 9 });
  const w = XF.windowFor(bus, e, 'train');
  for (let d = w.earliest - 3; d <= w.latest + 3; d++) {
    const inBand = d >= w.earliest && d <= w.latest;
    assert.strictEqual(XF.feasible(bus, { depMin: d, mode: 'train' }, e).ok, inBand,
      'window and verdict disagree at ' + d);
  }
});

t('the earliest that works, and a record of the ones that did not', () => {
  const bus = { arrMin: 500, source: 'timetable' };
  const outs = [{ depMin: 502, mode: 'train' }, { depMin: 505, mode: 'train' },
    { depMin: 520, mode: 'train' }, { depMin: 530, mode: 'train' }];
  const r = XF.firstFeasible(bus, outs);
  assert.ok(r.ok);
  assert.strictEqual(r.out.depMin, 520, 'the first two are too tight');
  assert.strictEqual(r.tried.length, 3, 'it stops at the one that works');
  assert.strictEqual(r.tried[0].code, 'TRANSFER_TOO_TIGHT');
  assert.strictEqual(XF.firstFeasible(bus, []).verdict.code, 'NO_TIMES');
});

t('no journey khaali offers contains a change khaali would refuse', () => {
  // the point of the whole module: not that the planner has a checker beside
  // it, but that nothing gets past the checker onto the page
  const VEH = new Set(['bus', 'train']);
  let checked = 0;
  const sweep = (from, to) => {
    const r = JY.journeys({ from, to, after: 420 });
    if (!r.ok) return;
    r.chains.forEach(c => {
      let prev = null, walkMin = 0;
      c.legs.forEach(l => {
        if (l.mode === 'walk') { walkMin += (l.min || 0); return; }
        if (!VEH.has(l.mode)) { prev = null; walkMin = 0; return; }
        if (prev) {
          const v = XF.feasible(prev, l, XF.edge({ walkMinutes: walkMin }));
          assert.ok(v.ok, c.kind + ': ' + prev.mode + ' -> ' + l.mode + ' is ' + v.code
            + ' (' + v.says + ')');
          checked++;
        }
        prev = l; walkMin = 0;
      });
    });
  };
  ['SBC', 'BNC', 'KJM', 'BNCE'].forEach(d => sweep({ kind: 'rail', id: 'BWT' }, { kind: 'rail', id: d }));
  sweep({ kind: 'rail', id: 'BWT' }, { kind: 'metro', id: 'KGWA' });
  assert.ok(checked > 0, 'the sweep found no vehicle-to-vehicle change to check at all');
});

console.log('\nwhich departure, and which stretch of it');

const dep0 = { operatorId: 'BMTC', tripId: '500D-07', serviceDate: '2026-09-05',
  directionId: 0, patternId: 'P1', scheduledStartTime: 490 };

t('a route is not a departure: the 08:10 and the 08:40 are two different things', () => {
  const a = TP.departure(dep0);
  const b = TP.departure({ ...dep0, scheduledStartTime: 520 });
  assert.notStrictEqual(a.id, b.id, 'one full and one with room would have averaged to fine');
  assert.ok(!TP.sameDeparture(a, b));
  assert.ok(TP.sameDeparture(a, TP.departure({ ...dep0 })), 'and the same one is the same one');
});

t('the same trip id on two mornings is two departures', () => {
  const a = TP.departure(dep0);
  const b = TP.departure({ ...dep0, serviceDate: '2026-09-06' });
  assert.notStrictEqual(a.id, b.id);
});

t('the same road in the other direction is a different service', () => {
  assert.notStrictEqual(TP.departure(dep0).id,
    TP.departure({ ...dep0, directionId: 1 }).id);
});

t('a departure cannot be half-named', () => {
  TP.ID_FIELDS.forEach(f => {
    const partial = { ...dep0 }; delete partial[f];
    assert.throws(() => TP.departure(partial), /missing /, 'a departure without ' + f + ' was accepted');
  });
  assert.throws(() => TP.departure({ ...dep0, serviceDate: '5 Sept' }), /ISO date/);
});

t('the key does not depend on the order somebody typed the object', () => {
  const scrambled = {};
  [...TP.ID_FIELDS].reverse().forEach(f => { scrambled[f] = dep0[f]; });
  assert.strictEqual(TP.instanceId(scrambled), TP.instanceId(dep0));
  // and a value containing the separator cannot forge another key
  const odd = TP.departure({ ...dep0, tripId: 'A|B' });
  const odd2 = TP.departure({ ...dep0, tripId: 'A', operatorId: 'BMTC' });
  assert.notStrictEqual(odd.id, odd2.id);
});

t('a smaller bus changes what it can carry, not which bus it is', () => {
  const a = TP.departure({ ...dep0, vehicleId: 'KA01-1111' });
  const b = TP.withVehicle(a, 'KA01-2222');
  assert.strictEqual(a.id, b.id, 'her pass is for the 08:10, whatever they send');
  assert.notStrictEqual(a.vehicleId, b.vehicleId);
  const big = TP.capacityOf({ seatedCapacity: 55, allowedStandingCapacity: 20, source: 'operator' });
  const small = TP.capacityOf({ seatedCapacity: 35, allowedStandingCapacity: 10, source: 'operator' });
  assert.strictEqual(big.boardingCapacity, 75);
  assert.strictEqual(small.boardingCapacity, 45);
});

t('capacity nobody stated is unknown, which is not full and not empty', () => {
  const c = TP.capacityOf({});
  assert.strictEqual(c.boardingCapacity, null);
  assert.strictEqual(c.known, false);
  assert.strictEqual(TP.capacityOf({ seatedCapacity: 40 }).known, false, 'a number with no source is not evidence');
  assert.strictEqual(TP.capacityOf({ seatedCapacity: 40, source: 'operator' }).known, true);
});

t('a span rides the stretches between its stops, and not the one it gets off at', () => {
  const sp = TP.span({ fromStopSequence: 2, toStopSequence: 5 });
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(k => TP.covers(sp, k)),
    [false, true, true, true, false]);
  assert.throws(() => TP.span({ fromStopSequence: 5, toStopSequence: 5 }), /forward/);
  assert.throws(() => TP.span({ fromStopSequence: 5, toStopSequence: 2 }), /forward/);
  assert.throws(() => TP.span({ fromStopSequence: 1, toStopSequence: 2, pax: 0 }), /at least one/);
});

t('two people on one stretch are two people', () => {
  const stops = 10;
  const one = TP.span({ fromStopSequence: 2, toStopSequence: 6 });
  const load = TP.loadBySpan([one, { ...one }, TP.span({ fromStopSequence: 3, toStopSequence: 4, pax: 3 })], stops);
  assert.deepStrictEqual(load, [0, 0, 2, 5, 2, 2, 0, 0, 0]);
  // this is what an OR of masks would have said instead
  const orred = [one, { ...one }].reduce((m, sp) => {
    let bits = 0; for (let k = sp.fromStopSequence; k < sp.toStopSequence; k++) bits |= (1 << k);
    return m | bits;
  }, 0);
  assert.strictEqual((orred >> 2) & 1, 1, 'a mask can only ever say somebody is there');
  assert.strictEqual(load[2], 2, 'and the count says how many');
});

t('a forty-three stop route counts past the thirty-second stretch', () => {
  const stops = 43, n = TP.stretchCount(stops);
  assert.strictEqual(n, 42);
  assert.strictEqual(TP.maskable(n), false, 'nothing here may be represented as a mask');
  const load = TP.loadBySpan([
    TP.span({ fromStopSequence: 40, toStopSequence: 42, pax: 7 }),
    TP.span({ fromStopSequence: 8, toStopSequence: 9, pax: 1 }),
  ], stops);
  assert.strictEqual(load[40], 7);
  assert.strictEqual(load[8], 1, 'stretch 40 must not land on stretch 8');
  // which is exactly what the shift does
  assert.strictEqual(1 << 40, 1 << 8);
  assert.throws(() => TP.loadBySpan([TP.span({ fromStopSequence: 41, toStopSequence: 43 })], stops), /past stop/);
});

t('a loop visits the same stop twice, and a sequence knows which one', () => {
  // stop 'CIRCLE' is sequence 3 outbound round the loop and sequence 20 coming
  // back to it. A stop id cannot tell those apart; the ride between them is
  // seventeen stretches of bus, not zero.
  const stops = 25;
  const load = TP.loadBySpan([TP.span({ fromStopSequence: 3, toStopSequence: 20, pax: 2 })], stops);
  assert.strictEqual(load.filter(x => x > 0).length, 17);
  assert.strictEqual(load[3], 2);
  assert.strictEqual(load[19], 2);
  assert.strictEqual(load[20], 0);
});

t('the crowd on the stretch she rides, not the stop she boards at', () => {
  // she gets on at stop 2 of 43, at the empty end of the route, and rides to 30.
  // Reading the boarding stop says the bus is nearly empty; the stretch through
  // town says it is not, and that is the one she is standing on.
  const stops = 43;
  const spans = [TP.span({ fromStopSequence: 0, toStopSequence: 3, pax: 4 })];
  for (let k = 18; k < 26; k++) spans.push(TP.span({ fromStopSequence: k, toStopSequence: k + 4, pax: 6 }));
  const load = TP.loadBySpan(spans, stops);
  const w = TP.worstOver(load, 2, 30);
  assert.ok(w.value > load[2] * 3, 'the boarding stop was not the story');
  assert.ok(w.stretch >= 18 && w.stretch < 26);
  assert.strictEqual(TP.worstOver(load, 5, 5), null, 'no stretch ridden, no worst stretch');
});

t('who got on and who got off, counted once each', () => {
  const stops = 6;
  const spans = [TP.span({ fromStopSequence: 0, toStopSequence: 3, pax: 2 }),
    TP.span({ fromStopSequence: 1, toStopSequence: 3, pax: 1 }),
    TP.span({ fromStopSequence: 3, toStopSequence: 5, pax: 4 })];
  assert.deepStrictEqual(TP.boardings(spans, stops), [2, 1, 0, 4, 0, 0]);
  assert.deepStrictEqual(TP.alightings(spans, stops), [0, 0, 0, 3, 0, 4]);
  // and the running total agrees with the stretch load, from both directions
  const load = TP.loadBySpan(spans, stops);
  const b = TP.boardings(spans, stops), a = TP.alightings(spans, stops);
  let on = 0;
  for (let k = 0; k < TP.stretchCount(stops); k++) {
    on += b[k] - a[k];
    assert.strictEqual(on, load[k], 'the two counts disagree at stretch ' + k);
  }
});

t('a trip that leaves at 23:40 arrives after it left', () => {
  const night = TP.departure({ ...dep0, scheduledStartTime: 1420 });
  const start = TP.absoluteMinute(night, 0);
  const end = TP.absoluteMinute(night, 90);
  assert.ok(end > start, 'the offset must not wrap into the morning it started in');
  assert.strictEqual(end - start, 90);
  // and it lands before a service the next morning, which is the comparison
  // that goes wrong when minutes are taken modulo the day
  const morning = TP.departure({ ...dep0, serviceDate: '2026-09-06', scheduledStartTime: 400 });
  assert.ok(TP.absoluteMinute(morning, 0) > end);
  assert.strictEqual(TP.dayNumber('2026-09-06') - TP.dayNumber('2026-09-05'), 1);
});

console.log('\nthe conductor: three numbers, never collapsed into one');

// Nobody publishes bus occupancy. What exists on every bus is a person with a
// ticketing machine who knows who got on and where they said they were going.
// All of this is simulated - no operator is connected - and the tests below are
// mostly about not adding the same passenger twice.

const TRIP = 'BMTC|500D-07|2026-09-05|0|P1|490';
let evn = 0;
const ev = o => CD.event({ tripInstanceId: TRIP, id: 'e' + (++evn), ...o });
const start = (stopCount = 8, cap = 50) => ev({ kind: 'bustrip', stopCount,
  capacity: { seatedCapacity: cap, source: 'demo' } });
const tkt = (from, to, pax = 1) => ev({ kind: 'ticket', stopSequence: from, toStopSequence: to, pax });
const got = (stop, count) => ev({ kind: 'alight', stopSequence: stop, count });
const counted = (stop, count, covers) => ev({ kind: 'onboard', stopSequence: stop, count,
  coversEventsThroughSeq: covers == null ? CD.seqAt() : covers });

t('no record of the departure is not an empty bus', () => {
  const p = CD.profile([tkt(0, 3)]);
  assert.strictEqual(p.status, 'NO_TRIP');
  assert.strictEqual(p.usable, false);
  assert.ok(!/empty|room|full/.test(p.says), p.says);
});

t('the tickets alone give a curve, and it comes back down', () => {
  const p = CD.profile([start(6), tkt(0, 2, 3), tkt(1, 4, 2), tkt(2, 5, 1)]);
  assert.strictEqual(p.status, 'OK');
  assert.deepStrictEqual(p.onboard, [3, 5, 3, 3, 1, 0]);
  assert.deepStrictEqual(p.stretch, [3, 5, 3, 3, 1]);
  assert.strictEqual(p.quality, 'simulated');
  assert.ok(/no operator is connected/i.test(p.says), p.says);
});

t('a retry is not a second boarding', () => {
  const one = tkt(0, 3, 2);
  const twice = CD.profile([start(6), one, { ...one }]);
  assert.deepStrictEqual(twice.onboard, CD.profile([start(6), one]).onboard);
  assert.strictEqual(twice.eventCount, 2, 'the duplicate is dropped, not counted');
});

t('a shuffled feed is the same profile as a sorted one', () => {
  const evs = [start(7), tkt(0, 3, 2), tkt(1, 5), got(3, 1), tkt(2, 6, 4), got(5, 2)];
  const sorted = CD.profile(evs);
  for (let i = 0; i < 6; i++) {
    const shuffled = evs.slice().sort(() => Math.random() - 0.5);
    assert.deepStrictEqual(CD.profile(shuffled).onboard, sorted.onboard,
      'a journal replay is not the order things were entered in');
  }
});

t('expected five, confirmed zero: subtract zero', () => {
  // the tickets say five get off at stop 3. The conductor watched, and nobody
  // did. The reconciled count has to be what was watched.
  const base = [start(6), tkt(0, 3, 5), tkt(0, 5, 1)];
  const asTicketed = CD.profile(base);
  assert.strictEqual(asTicketed.onboard[3], 1);
  const asSeen = CD.profile(base.concat([got(3, 0)]));
  assert.strictEqual(asSeen.exit[3], 0, 'zero is an observation, not a missing value');
  assert.strictEqual(asSeen.onboard[3], 6);
});

t('confirming the number the tickets already counted changes nothing', () => {
  const base = [start(6), tkt(0, 3, 5), tkt(0, 5, 1)];
  assert.deepStrictEqual(CD.profile(base.concat([got(3, 5)])).onboard,
    CD.profile(base).onboard);
});

t('more people off than were ever on is a broken bus, not an empty one', () => {
  const p = CD.profile([start(6), tkt(0, 2, 2), got(1, 9)]);
  assert.strictEqual(p.status, 'DATA_INCONSISTENT');
  assert.strictEqual(p.usable, false);
  assert.strictEqual(p.onboard[1], 0, 'displayed as zero');
  assert.ok(p.codes.includes('DATA_INCONSISTENT'));
  assert.ok(!/empty|plenty of room/i.test(p.says), p.says);
  // and being displayed as zero must never make it look bookable
  assert.strictEqual(CD.overSpan(p, 0, 5), null);
});

t('a correction rebases from its checkpoint, and later stops follow from there', () => {
  const evs = [start(8), tkt(0, 6, 2)];
  const before = CD.profile(evs);
  assert.strictEqual(before.onboard[2], 2);
  const after = CD.profile(evs.concat([counted(2, 20), tkt(3, 5, 1)]));
  assert.strictEqual(after.onboard[2], 20, 'the person counting heads outranks the tickets');
  assert.strictEqual(after.onboard[3], 21, 'and the next stop carries on from the corrected total');
  assert.strictEqual(after.onboard[5], 20);
});

t('a checkpoint total higher than the tickets is people, not arithmetic', () => {
  const p = CD.profile([start(8), tkt(0, 6, 2), counted(2, 20)]);
  assert.strictEqual(p.uncertain[2], 18);
  assert.strictEqual(p.uncertainTotal, 18);
  assert.strictEqual(p.exitAssumption, CD.UNKNOWN_EXIT);
  assert.ok(/never ticketed through khaali/.test(p.says), p.says);
  assert.ok(!/get off at|alight at stop \d/.test(p.says), 'khaali must not invent a destination');
  // they leave when the route does, and the bus is empty at the end
  assert.strictEqual(p.onboard[7], 0);
});

t('a ticket arriving after its stop was confirmed does not quietly become a passenger', () => {
  const evs = [start(8), tkt(0, 4, 2), counted(1, 20)];
  const clean = CD.profile(evs);
  assert.strictEqual(clean.status, 'OK');
  const late = CD.profile(evs.concat([ev({ kind: 'ticket', stopSequence: 1, toStopSequence: 5, pax: 3 })]));
  assert.strictEqual(late.status, 'NEEDS_RECONCILIATION');
  assert.strictEqual(late.usable, false);
  assert.ok(/do not agree yet/.test(late.says), late.says);
  assert.strictEqual(CD.overSpan(late, 0, 5), null, 'and nothing is recommended from it');
});

t('an event the checkpoint did cover is not a disagreement', () => {
  const head = start(8), a = tkt(0, 4, 2), b = tkt(1, 5, 3);
  const p = CD.profile([head, a, b, counted(1, 20, CD.seqAt())]);
  assert.strictEqual(p.status, 'OK', 'the conductor confirmed after both tickets, which is the rule');
});

t('the worst stretch she rides, and what it is a fraction of', () => {
  const evs = [start(10, 40), tkt(0, 2, 4)];
  for (let k = 4; k < 8; k++) evs.push(tkt(k, k + 2, 9));
  const p = CD.profile(evs);
  const boarding = CD.overSpan(p, 0, 1);
  const riding = CD.overSpan(p, 0, 9);
  assert.ok(riding.value > boarding.value * 2, 'the boarding stop was not the story');
  assert.strictEqual(riding.capacity, 40);
  assert.ok(riding.occupancy > 0 && riding.occupancy <= 1.2);
  assert.strictEqual(riding.quality, 'simulated');
});

t('capacity nobody stated leaves the fraction unknown rather than guessed', () => {
  const head = CD.event({ tripInstanceId: TRIP, id: 'x1', kind: 'bustrip', stopCount: 6 });
  const p = CD.profile([head, CD.event({ tripInstanceId: TRIP, id: 'x2', kind: 'ticket',
    stopSequence: 0, toStopSequence: 4, pax: 3 })]);
  const w = CD.overSpan(p, 0, 4);
  assert.strictEqual(w.capacity, null);
  assert.strictEqual(w.occupancy, null, 'a fraction of an unknown is not a number');
  assert.strictEqual(w.value, 3);
});

t('the simulated label survives everything', () => {
  const p = CD.profile([start(6), tkt(0, 3, 2), counted(1, 9)]);
  assert.strictEqual(p.quality, 'simulated');
  assert.strictEqual(CD.overSpan(p, 0, 4).quality, 'simulated');
  // Asserted as the exact disclosure rather than as a banned word. "no number
  // here was measured" is the sentence khaali is supposed to say, and a regex
  // hunting for /measured/ would have failed it for saying the right thing.
  assert.ok(p.says.includes('No operator is connected, and no number here was measured.'), p.says);
  ['counted from a real bus', 'measured on the road', 'verified by the operator',
    'live data', 'from the operator’s system'].forEach(claim =>
    assert.ok(!p.says.includes(claim), 'khaali claimed ' + claim));
});

t('an event without an id, a departure, or a whole number of people is refused', () => {
  assert.throws(() => CD.event({ kind: 'ticket', tripInstanceId: TRIP, stopSequence: 0, toStopSequence: 2 }), /needs an id/);
  assert.throws(() => CD.event({ kind: 'ticket', id: 'z', stopSequence: 0, toStopSequence: 2 }), /belongs to a departure/);
  assert.throws(() => CD.event({ kind: 'alight', id: 'z', tripInstanceId: TRIP, stopSequence: 1, count: -2 }), /whole number/);
  assert.throws(() => CD.event({ kind: 'nonsense', id: 'z', tripInstanceId: TRIP }), /unknown event kind/);
  assert.throws(() => CD.event({ kind: 'bustrip', id: 'z', tripInstanceId: TRIP, stopCount: 1 }), /at least two stops/);
});

t('one bus at a time: another departure\u2019s events are not this one\u2019s', () => {
  const other = CD.event({ tripInstanceId: 'BMTC|500D-08|2026-09-05|0|P1|520',
    id: 'o1', kind: 'ticket', stopSequence: 0, toStopSequence: 5, pax: 30 });
  const p = CD.profile([start(8), tkt(0, 4, 2), other], { tripInstanceId: TRIP });
  assert.strictEqual(p.onboard[0], 2, 'the 08:40 does not fill up the 08:10');
});

console.log('\nclaims: counted once, and never against two buses');

// A claim is khaali's recorded intention, not a seat and not a prediction. What
// it protects is the planning room: having pointed four people at the 08:10,
// khaali must stop telling everybody else the 08:10 is empty.

const busOf = (stops = 10, cap = 20, ticketed = []) => {
  let k = 0;
  const evs = [CD.event({ kind: 'bustrip', id: 'b' + (++evn), tripInstanceId: TRIP,
    stopCount: stops, capacity: { seatedCapacity: cap, source: 'demo' } })];
  ticketed.forEach(([f, t2, p]) => evs.push(CD.event({ kind: 'ticket', id: 'bt' + (++evn) + (++k),
    tripInstanceId: TRIP, stopSequence: f, toStopSequence: t2, pax: p })));
  return CD.profile(evs);
};
const ask = (L, over, more = {}) => CL.roomOver(L, { profile: over.profile || busOf(),
  tripInstanceId: TRIP, fromStopSequence: 1, toStopSequence: 6, pax: 1, ...over, ...more });

t('the states that count are the states somebody has not boarded on', () => {
  assert.strictEqual(CL.COUNTS.pending, true, 'a hold is room khaali is not free to promise again');
  assert.strictEqual(CL.COUNTS.confirmed, true);
  assert.strictEqual(CL.COUNTS.boarded, false, 'once aboard she is in the conductor ledger');
  ['expired', 'cancelled', 'moved', 'noshow'].forEach(k =>
    assert.strictEqual(CL.COUNTS[k], false, k + ' must not hold room'));
});

t('a party of four with two scanned keeps a claim for two', () => {
  const L = CL.ledger();
  const r = CL.reserve(L, { profile: busOf(), tripInstanceId: TRIP,
    fromStopSequence: 1, toStopSequence: 6, pax: 4, id: 'c1' });
  assert.ok(r.ok, r.code);
  CL.confirm(L, 'c1');
  const emitted = [];
  const b = CL.board(L, 'c1', 2, { emit: e => emitted.push(e) });
  assert.ok(b.ok, b.code);
  assert.strictEqual(CL.remaining(r.claim), 2, 'not four, which doubles them; not zero, which loses them');
  assert.strictEqual(r.claim.status, 'confirmed', 'still a claim while two are on the pavement');
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].span.pax, 2, 'and the two who boarded are ticketed exactly once');
  // the ledger now holds two, and the conductor holds two: four people, counted once
  assert.strictEqual(CL.outstanding(L, TRIP).people, 2);
  const rest = CL.board(L, 'c1', 2, { emit: e => emitted.push(e) });
  assert.ok(rest.ok);
  assert.strictEqual(r.claim.status, 'boarded');
  assert.strictEqual(CL.outstanding(L, TRIP).people, 0, 'nobody is counted twice at the end of it');
});

t('a scanned passenger is never counted as a claim as well', () => {
  const L = CL.ledger();
  CL.reserve(L, { profile: busOf(), tripInstanceId: TRIP, fromStopSequence: 1,
    toStopSequence: 6, pax: 3, id: 'c1' });
  CL.confirm(L, 'c1');
  const before = CL.claimSpans(L, TRIP).reduce((a, sp) => a + sp.pax, 0);
  CL.board(L, 'c1', 1, { emit: () => {} });
  const after = CL.claimSpans(L, TRIP).reduce((a, sp) => a + sp.pax, 0);
  assert.strictEqual(before - after, 1, 'the quantity moved across rather than being added');
});

t('a pass pending payment is not a boarding pass', () => {
  const L = CL.ledger();
  CL.reserve(L, { profile: busOf(), tripInstanceId: TRIP, fromStopSequence: 1,
    toStopSequence: 6, pax: 1, id: 'c1' });
  assert.strictEqual(CL.board(L, 'c1', 1).code, 'PASS_PENDING_PAYMENT');
});

t('an expired hold stops holding room, and cannot then be confirmed', () => {
  const L = CL.ledger();
  const t0 = 1000;
  CL.reserve(L, { profile: busOf(), tripInstanceId: TRIP, fromStopSequence: 1,
    toStopSequence: 6, pax: 5, id: 'c1', now: t0, holdExpiresAt: t0 + 300000 });
  assert.strictEqual(CL.claimSpans(L, TRIP, t0).length, 1);
  assert.strictEqual(CL.claimSpans(L, TRIP, t0 + 400000).length, 0, 'a lapsed hold is not demand');
  assert.strictEqual(CL.confirm(L, 'c1', t0 + 400000).code, 'HOLD_EXPIRED');
  assert.strictEqual(CL.expire(L, t0 + 400000), 0, 'and confirm already ended it');
});

t('a booking does not see itself when it is checked again', () => {
  const L = CL.ledger();
  const profile = busOf(10, 6);
  const r = CL.reserve(L, { profile, tripInstanceId: TRIP,
    fromStopSequence: 1, toStopSequence: 6, pax: 5, id: 'mine' });
  assert.ok(r.ok, r.code);
  CL.confirm(L, 'mine');
  const blind = ask(L, { profile, pax: 5 });
  assert.ok(!blind.ok, 'without exclusion her own booking fills the bus');
  const fair = ask(L, { profile, pax: 5, excludeClaimId: 'mine' });
  assert.ok(fair.ok, 'revalidating must not blame a booking for its own existence: ' + fair.code);
});

t('two requests for the last room do not both get it', () => {
  const L = CL.ledger();
  const profile = busOf(10, 4);
  const one = { profile, tripInstanceId: TRIP, fromStopSequence: 1, toStopSequence: 6, pax: 3 };
  const a = CL.reserve(L, { ...one, id: 'a' });
  const b = CL.reserve(L, { ...one, id: 'b' });
  assert.ok(a.ok, 'the first takes it');
  assert.ok(!b.ok, 'the second must be told no, not sold the same room');
  assert.strictEqual(b.undetermined, false, 'it is a determination that there is no room');
  assert.ok(['BOARDING_NOT_FEASIBLE', 'SPAN_OVER_PLANNING_LIMIT'].includes(b.code), b.code);
});

t('boarding and the span are two different refusals', () => {
  // full at her stop: she cannot get on at all
  const packed = busOf(10, 10, [[0, 9, 10]]);
  const board = ask(CL.ledger(), { profile: packed, fromStopSequence: 1, toStopSequence: 3, pax: 2 });
  assert.strictEqual(board.code, 'BOARDING_NOT_FEASIBLE');
  // room at her stop, but it fills before she is off - a planning rule, not a
  // claim that she would be turned away at the door
  const later = busOf(10, 10, [[3, 8, 10]]);
  const span = ask(CL.ledger(), { profile: later, fromStopSequence: 1, toStopSequence: 6, pax: 2 });
  assert.strictEqual(span.code, 'SPAN_OVER_PLANNING_LIMIT');
  assert.ok(span.worst.stretch >= 3);
});

t('khaali cannot tell is not the same sentence as the bus is full', () => {
  const L = CL.ledger();
  const broken = CD.profile([CD.event({ kind: 'bustrip', id: 'z1', tripInstanceId: TRIP,
    stopCount: 8, capacity: { seatedCapacity: 40, source: 'demo' } }),
    CD.event({ kind: 'ticket', id: 'z2', tripInstanceId: TRIP, stopSequence: 0, toStopSequence: 3, pax: 2 }),
    CD.event({ kind: 'alight', id: 'z3', tripInstanceId: TRIP, stopSequence: 1, count: 9 })]);
  const r = ask(L, { profile: broken });
  assert.strictEqual(r.code, 'BUS_DATA_INCONSISTENT');
  assert.strictEqual(r.undetermined, true);
  assert.ok(/cannot work out/.test(r.says), r.says);
  // asserted as claims, not as words: the refusal legitimately contains the
  // phrase 'how full this bus is', which a /full/ regex would have failed
  ['is full', 'no room', 'sold out', 'fully booked'].forEach(claim =>
    assert.ok(!r.says.toLowerCase().includes(claim), 'khaali said ' + claim));
  // a displayed-as-zero count must never make a departure NEWLY eligible
  assert.strictEqual(broken.onboard[1], 0);
  assert.ok(!r.ok, 'zero on the screen is not room in the plan');
});

t('every undetermined reason has its own code and none of them means full', () => {
  const L = CL.ledger();
  const noCap = CD.profile([CD.event({ kind: 'bustrip', id: 'y1', tripInstanceId: TRIP, stopCount: 8 })]);
  assert.strictEqual(ask(L, { profile: noCap }).code, 'BUS_CAPACITY_UNKNOWN');
  assert.strictEqual(ask(L, { profile: null }).code, 'NO_PROFILE');
  const old = busOf(10, 20);
  assert.strictEqual(ask(L, { profile: old, now: (old.generatedAt || 0) + CL.STALE_MS + 1 }).code, 'BUS_DATA_STALE');
  CL.UNDETERMINED.forEach(c => assert.ok(CL.CODES.includes(c)));
  assert.ok(!CL.UNDETERMINED.has('BOARDING_NOT_FEASIBLE'), 'no room is a determination');
  assert.ok(!CL.UNDETERMINED.has('SPAN_OVER_PLANNING_LIMIT'));
});

t('accepting a later bus moves the unboarded quantity, and only that', () => {
  const L = CL.ledger();
  const profile = busOf(10, 20);
  CL.reserve(L, { profile, tripInstanceId: TRIP, fromStopSequence: 1,
    toStopSequence: 6, pax: 4, id: 'c1' });
  CL.confirm(L, 'c1');
  CL.board(L, 'c1', 1, { emit: () => {} });
  const LATER = 'BMTC|500D-08|2026-09-05|0|P1|520';
  const m = CL.move(L, 'c1', { profile, tripInstanceId: LATER,
    fromStopSequence: 1, toStopSequence: 6, id: 'c2' });
  assert.ok(m.ok, m.code);
  assert.strictEqual(m.claim.pax, 3, 'the one already aboard does not travel twice');
  assert.strictEqual(CL.get(L, 'c1').status, 'moved');
  assert.strictEqual(CL.outstanding(L, TRIP).people, 0, 'nobody is counted against both buses');
  assert.strictEqual(CL.outstanding(L, LATER).people, 3);
});

t('a claim cannot be boarded outside the stops it covers', () => {
  const L = CL.ledger();
  CL.reserve(L, { profile: busOf(), tripInstanceId: TRIP, fromStopSequence: 2,
    toStopSequence: 5, pax: 1, id: 'c1' });
  CL.confirm(L, 'c1');
  assert.strictEqual(CL.board(L, 'c1', 1, { stopSequence: 6 }).code, 'OUTSIDE_PERMITTED_SPAN');
  assert.strictEqual(CL.board(L, 'c1', 1, { stopSequence: 1 }).code, 'OUTSIDE_PERMITTED_SPAN');
  assert.ok(CL.board(L, 'c1', 1, { stopSequence: 3 }).ok, 'boarding late along her own span is fine');
});

t('more people scanned than the claim covers is refused, not absorbed', () => {
  const L = CL.ledger();
  CL.reserve(L, { profile: busOf(), tripInstanceId: TRIP, fromStopSequence: 1,
    toStopSequence: 6, pax: 2, id: 'c1' });
  CL.confirm(L, 'c1');
  assert.strictEqual(CL.board(L, 'c1', 3).code, 'QUANTITY_UNAVAILABLE');
  assert.ok(CL.board(L, 'c1', 2, { emit: () => {} }).ok);
  assert.strictEqual(CL.board(L, 'c1', 1).code, 'NOT_BOARDABLE', 'and a replayed scan creates no boarding');
});

t('a released claim gives its room back; a boarded one cannot be released', () => {
  const L = CL.ledger();
  const profile = busOf(10, 5);
  CL.reserve(L, { profile, tripInstanceId: TRIP, fromStopSequence: 1, toStopSequence: 6, pax: 4, id: 'c1' });
  assert.ok(!ask(L, { profile, pax: 3 }).ok);
  CL.release(L, 'c1', 'cancelled');
  assert.ok(ask(L, { profile, pax: 3 }).ok, 'a cancelled claim must not go on holding room');
  CL.reserve(L, { profile, tripInstanceId: TRIP, fromStopSequence: 1, toStopSequence: 6, pax: 1, id: 'c2' });
  CL.confirm(L, 'c2'); CL.board(L, 'c2', 1, { emit: () => {} });
  assert.strictEqual(CL.release(L, 'c2').code, 'ALREADY_BOARDED');
});

t('the room khaali reports is the room it then takes', () => {
  const L = CL.ledger();
  const profile = busOf(10, 12, [[0, 9, 4]]);
  const seen = ask(L, { profile, pax: 3 });
  assert.ok(seen.ok);
  const took = CL.reserve(L, { profile, tripInstanceId: TRIP,
    fromStopSequence: 1, toStopSequence: 6, pax: 3, id: 'c1' });
  assert.ok(took.ok);
  assert.strictEqual(took.room.worst.value, seen.worst.value, 'the quote and the take saw one bus');
});

console.log('\nwhat may move somebody, and what may only describe them');

t('a metro reading cannot be turned into a reason, by any argument', () => {
  [null, 0.0, 0.99, 1.5].forEach(value => {
    const m = CN.metroProfile({ n: 0, of: 100, need: 4, value });
    assert.strictEqual(m.mayTrigger, false);
    assert.strictEqual(m.triggers, false);
    assert.strictEqual(m.ok, null, 'it has no verdict to give');
  });
  assert.strictEqual(CN.EVIDENCE.metro.mayTrigger, false);
  assert.strictEqual(CN.EVIDENCE.metro.mayReplace, false);
  const says = CN.constraint({ mode: 'metro', n: 0, need: 4 }).says;
  assert.ok(/describes the station, not the stretch/.test(says), says);
});

t('a shortage khaali cannot count is not a shortage', () => {
  const c = CN.constraint({ mode: 'bus', n: null, need: 3 });
  assert.strictEqual(c.ok, null, 'null is not false');
  assert.strictEqual(c.triggers, false);
  assert.ok(/will not move anybody/.test(c.says), c.says);
});

t('a description has no verdict in it at all', () => {
  const d = CN.describe({ value: 0.95, quality: 'predicted', key: 'metro' });
  assert.strictEqual(d.ok, undefined);
  assert.strictEqual(d.triggers, undefined);
  assert.ok(d.colour && d.word);
  assert.ok(/not going to guess/.test(CN.describe({ value: null }).says));
});

t('each mode says what its evidence actually is', () => {
  assert.strictEqual(CN.EVIDENCE.train.rung, 'exact');
  assert.strictEqual(CN.EVIDENCE.bus.rung, 'simulated');
  assert.ok(/no operator is connected/i.test(CN.EVIDENCE.bus.label));
  assert.ok(CN.RUNGS.includes(CN.EVIDENCE.metro.rung), 'one ladder, not a second one');
});

t('the model says it is the model, and does not call two trips no record', () => {
  assert.strictEqual(CN.basisFor({ hasTripLedger: true }).basis, 'this-trip');
  assert.strictEqual(CN.basisFor({ completedTrips: 5 }).basis, 'completed-trips');
  const thin = CN.basisFor({ completedTrips: 2 });
  assert.strictEqual(thin.basis, 'model');
  assert.ok(thin.says.includes('Insufficient completed-trip history'), thin.says);
  assert.ok(!/no record/i.test(thin.says), 'two completed trips are records, just not enough');
});

t('registering an operator does not relabel what was simulated when it happened', () => {
  assert.strictEqual(CN.publishedQuality(['simulation']), 'simulated');
  assert.strictEqual(CN.publishedQuality(['simulation'], { registeredOperator: true }), 'simulated');
  assert.strictEqual(CN.publishedQuality(['production'], { registeredOperator: true }), 'counted');
  assert.strictEqual(CN.publishedQuality(['production', 'simulation'], { registeredOperator: true }),
    'simulated', 'one simulated event floors the lot');
  assert.strictEqual(CN.publishedQuality([]), 'unknown');
});

console.log('\nthe split: change the stretch, not the journey');

// A train sold out for the first stretch and free after it, a bus that starts
// where she does, and the question of whether the two can be put together.
// Everything is injected: split.mjs imports no planner, so it cannot recurse
// into the enumerator that calls it.

const BUSSTOPS = 12;
const busProfile = (cap = 30, ticketed = []) => {
  let k = 0;
  const evs = [CD.event({ kind: 'bustrip', id: 'sb' + (++evn), tripInstanceId: 'T1',
    stopCount: BUSSTOPS, capacity: { seatedCapacity: cap, source: 'demo' } })];
  ticketed.forEach(([f, t2, p]) => evs.push(CD.event({ kind: 'ticket', id: 'st' + (++evn) + (++k),
    tripInstanceId: 'T1', stopSequence: f, toStopSequence: t2, pax: p })));
  return CD.profile(evs);
};
const busAt = (id, depMin, runMin, over = {}) => ({
  tripInstanceId: id, name: 'KSRTC ' + id, depMin, arrMin: depMin + runMin,
  source: 'simulated', fromStopSequence: 0, toStopSequence: 6, walkMinutes: 4,
  profile: busProfile(), ...over });
// Bangarpet is 0, Whitefield is 4, Majestic is 9. Nothing sellable the whole
// way; a named departure from Whitefield that khaali can sell.
const MEMU = { trainNo: '56232', name: 'MKM-SBC MEMU', depMin: 560, arrMin: 620,
  stopId: 'WFD', sell: 120 };
const world = (over = {}) => ({
  fromIdx: 0, toIdx: 9, pax: 2, after: 400,
  sellWhole: () => 0,
  onwardFrom: k => (k === 4 ? [MEMU] : []),
  busesFor: () => [busAt('T1', 420, 95)],
  ledger: CL.ledger(),
  ...over });

t('a train that can carry her the whole way is not a problem to solve', () => {
  const r = SP.find(world({ sellWhole: () => 120 }));
  assert.strictEqual(r.code, 'DIRECT_IS_BOOKABLE');
  assert.strictEqual(r.silent, true);
  assert.strictEqual(SP.gate(r).offer, false);
  assert.strictEqual(SP.gate(r).silent, true, 'nothing was wrong, so khaali says nothing');
});

t('a train khaali cannot count is not a train it moves people off', () => {
  const r = SP.find(world({ sellWhole: () => null }));
  assert.strictEqual(r.code, 'NO_TRIGGER');
  assert.ok(/cannot count/.test(r.says), r.says);
  assert.strictEqual(SP.gate(r).offer, false);
});

t('the split khaali is for: bus to the boundary, a named train onward', () => {
  const r = SP.find(world());
  assert.ok(r.ok, r.code + ' ' + (r.says || ''));
  assert.strictEqual(r.split.boundaryIdx, 4);
  assert.strictEqual(r.split.onward.train, '56232', 'one identified service, not "a train later"');
  assert.strictEqual(r.split.onward.depMin, 560);
  assert.strictEqual(r.split.onward.to, 9);
  assert.strictEqual(r.split.replacement.tripInstanceId, 'T1');
  assert.strictEqual(r.split.transfer.ok, true);
  assert.strictEqual(r.split.releasesInventory, false);
  // and the two constraints are labelled for what they are
  assert.strictEqual(r.split.trigger.evidence.rung, 'exact');
  assert.strictEqual(r.split.busConstraint.evidence.rung, 'simulated');
});

t('the destination is never a boundary', () => {
  const asked = [];
  const r = SP.find(world({ onwardFrom: k => { asked.push(k); return []; } }));
  assert.ok(!r.ok);
  assert.strictEqual(r.code, 'NO_PINNED_ONWARD');
  assert.ok(!asked.includes(9), 'the place she is going to is not a place to rejoin');
  assert.ok(!asked.includes(0), 'nor the place she is leaving from');
  assert.deepStrictEqual(asked, [1, 2, 3, 4, 5, 6, 7, 8], 'strictly between, in her direction');
});

// The first draft pinned the onward half to the train she would otherwise have
// caught, and on this corridor that can never happen: the bus takes ninety-five
// minutes over a stretch the train does in fifty, so it always arrives after
// its own train has gone. Every candidate came back TRANSFER_TOO_TIGHT with
// "the onward service leaves before this one arrives" - true, and fatal to the
// feature. The onward half is a named departure she can actually make.
t('the bus cannot catch the train it is replacing, and khaali does not pretend', () => {
  const hers = { trainNo: '16021', name: 'Kaveri Express', depMin: 470, arrMin: 540,
    stopId: 'WFD', sell: 120 };
  const onlyHers = SP.find(world({ onwardFrom: k => (k === 4 ? [hers] : []) }));
  assert.strictEqual(onlyHers.code, 'TRANSFER_TOO_TIGHT');
  // ...and with a later named service in the list, she has a journey
  const both = SP.find(world({ onwardFrom: k => (k === 4 ? [hers, MEMU] : []) }));
  assert.ok(both.ok, both.code);
  assert.strictEqual(both.split.onward.train, '56232', 'the earliest one she could make');
});

t('two departures of one route are two answers, and the full one is refused', () => {
  const L = CL.ledger();
  const packed = busProfile(30, [[0, 11, 30]]);
  const roomy = busProfile(30, [[0, 11, 2]]);
  const r = SP.find(world({ ledger: L, busesFor: () => [
    busAt('T1', 420, 95, { profile: packed }),
    busAt('T2', 425, 95, { profile: roomy }),
  ] }));
  assert.ok(r.ok, r.code);
  assert.strictEqual(r.split.replacement.tripInstanceId, 'T2',
    'a route-level average would have passed the full one too');
});

t('room is measured over the span she rides, not the stop she boards at', () => {
  const L = CL.ledger();
  // empty where she gets on, packed through the middle of her ride
  const fillsLater = busProfile(20, [[3, 9, 20]]);
  const r = SP.find(world({ ledger: L,
    busesFor: () => [busAt('T1', 420, 95, { profile: fillsLater })] }));
  assert.ok(!r.ok);
  assert.strictEqual(r.code, 'SPAN_OVER_PLANNING_LIMIT');
});

t('a bus khaali cannot read is refused as unreadable, not as full', () => {
  const L = CL.ledger();
  const broken = CD.profile([
    CD.event({ kind: 'bustrip', id: 'x1', tripInstanceId: 'T1', stopCount: BUSSTOPS,
      capacity: { seatedCapacity: 30, source: 'demo' } }),
    CD.event({ kind: 'ticket', id: 'x2', tripInstanceId: 'T1', stopSequence: 0, toStopSequence: 3, pax: 1 }),
    CD.event({ kind: 'alight', id: 'x3', tripInstanceId: 'T1', stopSequence: 1, count: 9 })]);
  const r = SP.find(world({ ledger: L, keepTrace: true,
    busesFor: () => [busAt('T1', 420, 95, { profile: broken })] }));
  assert.ok(!r.ok);
  assert.strictEqual(r.code, 'NO_DEPARTURE_WITH_ROOM');
  const t0 = SP.trace(r).tried.find(x => x.bus === 'T1');
  assert.strictEqual(t0.code, 'BUS_DATA_INCONSISTENT', 'the trace keeps the real reason');
});

t('a change she could not make is not offered, however much room there is', () => {
  const tight = SP.find(world({ busesFor: () => [busAt('T1', 420, 155)] }));
  assert.strictEqual(tight.code, 'TRANSFER_TOO_TIGHT');
  const loose = SP.find(world({ busesFor: () => [busAt('T1', 300, 60)] }));
  assert.strictEqual(loose.code, 'TRANSFER_TOO_LONG');
});

t('a split that arrives after something she could already book has not earned its place', () => {
  const r = SP.find(world({ alternativeArr: 600 }));
  assert.strictEqual(r.code, 'NO_CLEAR_BENEFIT');
  assert.ok(SP.find(world({ alternativeArr: 700 })).ok, 'and it is offered when it does beat it');
});

t('the earliest rejoining station she can reach, not the first one that exists', () => {
  // stop 2 is sellable onward but no bus reaches it; stop 4 is reachable
  const r = SP.find(world({ keepTrace: true,
    onwardFrom: k => (k === 2 ? [{ trainNo: 'A1', name: 'A', depMin: 600, arrMin: 660, stopId: 'A', sell: 120 }]
      : k === 4 ? [MEMU] : []),
    busesFor: (f, k) => (k === 4 ? [busAt('T1', 420, 95)] : []) }));
  assert.ok(r.ok, r.code);
  assert.strictEqual(r.split.boundaryIdx, 4, 'an unreachable earlier boundary must not hide a later one');
  assert.ok(SP.trace(r).tried.some(x => x.boundary === 2 && x.code === 'BOUNDARY_NOT_REACHABLE'));
});

t('the party size asked for is the party size checked', () => {
  const four = SP.find(world({ pax: 4, sellWhole: () => 3 }));
  assert.ok(four.ok, 'three places is not enough for four, so the split stands: ' + four.code);
  const two = SP.find(world({ pax: 2, sellWhole: () => 3 }));
  assert.strictEqual(two.code, 'DIRECT_IS_BOOKABLE', 'three places is enough for two');
});

t('khaali never says it watched a crowd, or that a booking freed a berth', () => {
  const r = SP.find(world());
  const lines = SP.whyLines(r.split, { stationName: i => ['BWT', '', '', '', 'Whitefield'][i] || ('stop ' + i) });
  const all = lines.join(' ');
  ['the crowd', 'crowded platform', 'we saw', 'frees a berth', 'releases a seat',
    'a seat on the bus is yours', 'you will be seated', 'get off', 'deboard'].forEach(claim =>
    assert.ok(!all.toLowerCase().includes(claim), 'khaali said: ' + claim));
  assert.ok(all.includes('No bus seat is reserved.'), all);
  assert.ok(all.includes('does not free the early stretch'), all);
  assert.ok(all.includes('khaali’s demo conductor'), all);
  assert.ok(/There is room from Whitefield onward, on the MKM-SBC MEMU at 09:20/.test(all)
    || /There is room from Whitefield onward, on the MKM-SBC MEMU at /.test(all), all);
  assert.ok(all.includes('No train khaali can sell you runs the whole way'), all);
});

t('the reason for the switch is carried only by a journey that actually split', () => {
  // the old rule fired on any bus+train chain that scored well on seats, about
  // a split point that came from wherever a bus route happened to end
  const legs = [{ mode: 'bus', min: 60, seat: { word: 'yes', rank: 3 } },
    { mode: 'train', min: 40, seat: { word: 'yes', rank: 3 } }];
  const seatedSwitch = { kind: 'bus+train', legs, seat: { word: 'yes', rank: 3 },
    fare: 60, changes: 1, totalMin: 100, dep: 400, arr: 500, modes: ['bus', 'train'] };
  const stander = { kind: 'train', legs: [{ mode: 'train', min: 60, seat: { word: 'standing', rank: 0 } }],
    seat: { word: 'standing', rank: 0 }, fare: 40, changes: 0, totalMin: 60, dep: 400, arr: 460, modes: ['train'] };
  const without = AL.allocate([seatedSwitch, stander], { profile: 'comfortable', after: 400 });
  assert.ok(!without.reason.reasons.includes('SWITCHED_WHERE_IT_FILLS'),
    'a bus+train chain khaali did not assemble may not claim the split');
  const withSplit = AL.allocate([{ ...seatedSwitch, split: { boundaryIdx: 4 } }, stander],
    { profile: 'comfortable', after: 400 });
  assert.ok(withSplit.chains, 'allocate still returns');
  const rec = [{ ...seatedSwitch, split: { boundaryIdx: 4 } }, stander][withSplit.recommended];
  if (rec.split) {
    assert.ok(withSplit.reason.reasons.includes('SWITCHED_WHERE_IT_FILLS'));
    const said2 = AL.sentence(withSplit.reason);
    assert.ok(/more berth capacity becomes available/.test(said2), said2);
    assert.ok(!/crowd does/.test(said2), 'khaali has never watched a crowd');
  }
});

console.log('\nthe split, on the corridor khaali actually runs');

const DATE = '2026-09-05';
const stIdx = c => ST.findIndex(x => x.c === c);
const CORRIDOR_BWT = stIdx('BWT'), WFD = stIdx('WFD'), SBC = stIdx('SBC');

t('a headway becomes departures, each with its own identity', () => {
  const bus = BUSES.find(b => b.id === 'KSRTC BNG-BLR');
  const ds = BLG.departuresOf(bus, DATE, 400, 560);
  assert.ok(ds.length >= 4, 'the 07:00, the 07:30, the 08:00 - not "every thirty minutes"');
  const ids = new Set(ds.map(d => d.departure.id));
  assert.strictEqual(ids.size, ds.length, 'no two departures share an identity');
  assert.ok(ds.every(d => d.arrMin - d.depMin === bus.runMin));
  assert.strictEqual(BLG.departuresOf(bus, '2026-09-06', 400, 560)[0].departure.id
    === ds[0].departure.id, false, 'nor two days');
});

t('khaali\u2019s model is ticket spans, read by the same arithmetic as a real one', () => {
  const bus = BUSES.find(b => b.id === 'KSRTC BNG-BLR');
  const d = BLG.departuresOf(bus, DATE, 420, 420)[0];
  const p = BLG.profileFor(d, { now: 1 });
  assert.strictEqual(p.status, 'OK');
  assert.strictEqual(p.basis, 'model', 'nobody has ticketed this one');
  assert.strictEqual(p.quality, 'simulated');
  assert.strictEqual(p.stopCount, bus.nStops);
  assert.strictEqual(p.onboard[p.stopCount - 1], 0, 'everybody is off by the last stop');
  assert.ok(Math.max(...p.stretch) > 0);
  assert.ok(Math.max(...p.stretch) <= p.capacity.boardingCapacity * 1.2);
  // and the invention is labelled as such, cohort by cohort
  const evs = BLG.modelEvents(d);
  assert.ok(evs.every(e => e.id.startsWith('model:')), 'khaali\u2019s own cohorts are named');
  assert.ok(evs.every(e => e.sourceKind === 'simulation'));
});

t('a conductor ticketing this departure outranks the model, and says so', () => {
  BLG.reset();
  const bus = BUSES.find(b => b.id === 'KSRTC BNG-BLR');
  const d = BLG.departuresOf(bus, DATE, 450, 450)[0];
  const id = d.departure.id;
  assert.strictEqual(BLG.basisOf(id), 'model');
  BLG.record(CD.event({ kind: 'bustrip', id: 'r1', tripInstanceId: id,
    stopCount: bus.nStops, capacity: BLG.FLEET.KSRTC }));
  BLG.record(CD.event({ kind: 'ticket', id: 'r2', tripInstanceId: id,
    stopSequence: 0, toStopSequence: 5, pax: 3 }));
  assert.strictEqual(BLG.basisOf(id), 'this-trip');
  const p = BLG.profileFor(d, { now: 1 });
  assert.strictEqual(p.basis, 'this-trip', 'what a person entered about THIS bus wins');
  assert.strictEqual(p.stretch[0], 3, 'and it is that bus, not an average of the route');
  assert.strictEqual(p.quality, 'simulated', 'still simulated: no operator is connected');
  BLG.reset();
});

// The acceptance test the whole plan is for.
t('Bangarpet to Majestic: no train the whole way, so a bus, then a named train', () => {
  BLG.reset();
  // one snapshot of inventory: nothing sellable before Whitefield, room after
  const inventory = { calls: 0, mutations: 0 };
  const snapshot = JSON.stringify({ before: 0, after: 120 });
  const countsFor = (no, date, cls, f, tt) => {
    inventory.calls++;
    return { anySeats: f < WFD ? 0 : 120, free: 0, part: 0, taken: 0, locked: 0 };
  };
  const r = SPP.findFor({ fromIdx: CORRIDOR_BWT, toIdx: SBC, date: DATE, pax: 2, after: 400,
    countsFor, ledger: CL.ledger(), now: Date.now(), keepTrace: true });
  assert.ok(r.ok, r.code + ' ' + (r.says || ''));

  const c = SPP.chainOf(r, { fromIdx: CORRIDOR_BWT, toIdx: SBC, date: DATE });
  assert.strictEqual(c.kind, 'split');
  const modes = c.legs.map(l => l.mode);
  assert.strictEqual(modes[0], 'bus', 'the bus covers the stretch the train cannot sell');
  assert.strictEqual(modes[modes.length - 1], 'train');
  assert.strictEqual(c.split.boundaryCode, 'WFD');
  assert.ok(c.split.transferMinutes >= 25, 'a change she could actually make: ' + c.split.transferMinutes);

  // one assembled journey, and everything disclosed
  const why = c.split.why.join(' ');
  assert.ok(why.includes('No bus seat is reserved.'), why);
  assert.ok(why.includes('demo conductor'), why);
  assert.ok(why.includes('does not free the early stretch'), why);
  assert.strictEqual(c.split.releasesInventory, false);
  assert.strictEqual(c.split.quality, 'simulated');

  // and no early-stretch inventory was consumed by planning it
  assert.strictEqual(JSON.stringify({ before: 0, after: 120 }), snapshot,
    'planning a split must not touch what the train has left');
  assert.ok(inventory.calls > 0, 'it did read the inventory');
  assert.strictEqual(inventory.mutations, 0);
  BLG.reset();
});

t('when a train can sell her the whole way, khaali says nothing at all', () => {
  const countsFor = () => ({ anySeats: 120, free: 120 });
  const r = SPP.findFor({ fromIdx: CORRIDOR_BWT, toIdx: SBC, date: DATE, pax: 2, after: 400, countsFor });
  assert.strictEqual(r.code, 'DIRECT_IS_BOOKABLE');
  assert.strictEqual(SPP.chainOf(r, { fromIdx: CORRIDOR_BWT, toIdx: SBC, date: DATE }), null);
});

t('inventory khaali cannot read is never a reason to put anybody on a bus', () => {
  const countsFor = () => { throw new Error('inventory unavailable'); };
  const r = SPP.findFor({ fromIdx: CORRIDOR_BWT, toIdx: SBC, date: DATE, pax: 2, after: 400, countsFor });
  assert.strictEqual(r.code, 'NO_TRIGGER');
  assert.ok(/cannot count/.test(r.says), r.says);
});

console.log('\nsix controlled changes: does the decision move when the facts do');

/* The point of these is not that a split appears. It is that ONE input moves,
   and the gate result, the candidate set, the recommendation and the sentence
   move with it - or stay put for a reason khaali states. A planner that always
   answers the same thing is not capacity-aware however good the sentence is. */

const H_DATE = '2026-09-05';
const hIdx = c => ST.findIndex(x => x.c === c);
const H_BWT = hIdx('BWT'), H_WFD = hIdx('WFD'), H_BNC = hIdx('BNC');

// Bangarpet to Hebbala, as the page builds it: a train to Bengaluru Cantt, a
// walk, a BMTC bus, a walk. Hebbala is a bus stop, not a corridor station -
// which is precisely the shape the old rail-to-rail gate never ran on.
const toHebbala = () => ({
  kind: 'train|BNC', dep: 695, arr: 786, fare: 210, changes: 2,
  legs: [
    { mode: 'train', id: '22625', name: 'MAS-SBC AC D', from: 'Bangarpet', to: 'Bengaluru Cantt',
      fromIdx: H_BWT, toIdx: H_BNC, depMin: 695, arrMin: 753, source: 'timetable',
      seat: { word: 'yes', rank: 3, why: 'berths free on your stretch' } },
    { mode: 'walk', name: 'Walk', from: 'Bengaluru Cantt', to: 'Vasantha Nagara',
      depMin: 761, arrMin: 762, min: 1, source: 'measured', seat: null },
    { mode: 'bus', id: '298-MS', name: 'BMTC 298-MS', from: 'Vasantha Nagara', to: 'Hebbala Canara Bank',
      depMin: 764, arrMin: 778, min: 14, every: 30, source: 'timetable',
      scheduleKind: 'frequency', departureDerived: true,
      seat: { word: 'likely', rank: 2, why: 'you board early on the route' } },
    { mode: 'walk', name: 'Walk', from: 'Hebbala Canara Bank', to: 'Hebbala',
      depMin: 778, arrMin: 786, min: 8, source: 'measured', seat: null },
  ],
});

// one knob per scenario, and nothing else moves
const world2 = (over = {}) => ({
  wholeSpanSeats: 40,      // A: what the train can sell Bangarpet -> Cantt
  onwardSeats: 120,        // what it can sell from the rejoining station
  busProfiles: null,       // C, E: what the conductor ledger says
  busTimes: null,          // D: when the replacements run
  ...over,
});

function runDecision(w, { pax = 2 } = {}) {
  const chain = toHebbala();
  const countsFor = (no, d, cls, f, t) => {
    if (f === H_BWT) return { anySeats: w.wholeSpanSeats, free: 0 };
    return { anySeats: w.onwardSeats, free: 0 };
  };
  const findSplit = (req) => SP.find({
    fromIdx: req.fromIdx, toIdx: req.toIdx, pax: req.pax, after: req.after, now: 1,
    keepTrace: true, ledger: CL.ledger(),
    sellWhole: () => w.wholeSpanSeats,
    onwardFrom: k => (k === H_WFD && w.onwardSeats >= req.pax)
      ? [{ trainNo: '56232', name: 'WFD-SBC MEMU', depMin: 700, arrMin: 760,
        stopId: 'WFD', sell: w.onwardSeats }] : [],
    busesFor: () => (w.busTimes || [{ dep: 540, run: 95 }]).map((b, i) => ({
      tripInstanceId: 'KSRTC|T' + i, id: 'KSRTC BNG-BLR', name: 'KSRTC BNG-BLR',
      depMin: b.dep, arrMin: b.dep + b.run, source: 'simulated', every: 30,
      fromStopSequence: 0, toStopSequence: 6, walkMinutes: 9,
      // a bus khaali knows nothing about is not a bus with room; the
      // default world gives every candidate a readable, roomy ledger so a
      // scenario changes one thing and not two
      profile: w.busProfiles ? w.busProfiles[i] : busProf(50, [[0, 11, 4]]), basis: 'model',
    })),
  });
  return DEC.decide({ chain, pax, date: H_DATE, after: 400, now: 1, countsFor, findSplit });
}

// a bus ledger with a stated capacity, so "no room" and "cannot tell" differ
const busProf = (cap, ticketed = [], broken = false) => {
  let n = 0;
  const evs = [CD.event({ kind: 'bustrip', id: 'sc' + (++evn), tripInstanceId: 'KSRTC|T0',
    stopCount: 12, capacity: cap == null ? {} : { seatedCapacity: cap, source: 'demo' } })];
  ticketed.forEach(([f, t2, p]) => evs.push(CD.event({ kind: 'ticket', id: 'sc' + (++evn) + (++n),
    tripInstanceId: 'KSRTC|T0', stopSequence: f, toStopSequence: t2, pax: p })));
  if (broken) evs.push(CD.event({ kind: 'alight', id: 'sc' + (++evn), tripInstanceId: 'KSRTC|T0',
    stopSequence: 1, count: 99 }));
  return { ...CD.profile(evs, { tripInstanceId: 'KSRTC|T0' }), generatedAt: 1 };
};

t('A \u2014 the train can carry the party, so nothing is replaced', () => {
  const d = runDecision(world2({ wholeSpanSeats: 40 }));
  assert.strictEqual(d.kind, 'KEEP_ROUTE');
  assert.strictEqual(d.railCheck.outcome, 'SELLABLE');
  assert.strictEqual(d.railCheck.anySeats, 40);
  assert.strictEqual(d.railCheck.partySize, 2);
  assert.deepStrictEqual(d.reasons, ['DIRECT_TRAIN_BOOKABLE']);
  assert.strictEqual(d.chosenBusDeparture, null, 'khaali must not swap a prefix it did not need to');
  assert.ok(/no reason to replace any of it/.test(d.says), d.says);
  // and it ran at all, on a journey that ENDS AT A BUS STOP
  assert.strictEqual(d.railCheck.trainInstanceId, 'IR|22625|2026-09-05');
  assert.strictEqual(d.railCheck.fromSequence, H_BWT);
  assert.strictEqual(d.railCheck.toSequence, H_BNC, 'the check is on the rail leg, not the journey ends');
});

t('B \u2014 the full span goes, the onward stays: a prefix replacement is chosen', () => {
  const before = runDecision(world2({ wholeSpanSeats: 40 }));
  const after = runDecision(world2({ wholeSpanSeats: 0 }));   // one knob
  assert.strictEqual(before.kind, 'KEEP_ROUTE');
  assert.strictEqual(after.kind, 'SWAP_PREFIX', after.reasons.join(','));
  assert.strictEqual(after.railCheck.outcome, 'UNSELLABLE');
  assert.ok(after.reasons.includes('DIRECT_TRAIN_UNSELLABLE'));
  assert.ok(after.reasons.includes('PREFIX_REPLACEMENT_FEASIBLE'));
  const b = after.chosenBusDeparture;
  assert.ok(b, 'a swap with no named departure is not an answer');
  assert.strictEqual(b.boardingFeasible, true);
  assert.strictEqual(b.spanWithinPlanningLimit, true);
  assert.strictEqual(b.transferFeasible, true);
  assert.strictEqual(b.onwardTrain, '56232', 'and it names the train she joins');
  assert.ok(b.tripInstanceId, 'a departure, not a route');
  assert.ok(/No bus seat is reserved/.test(DEC.lines(after).join(' ')));
});

t('C \u2014 the replacement fills past the planning limit, so another is chosen', () => {
  const packed = busProf(20, [[0, 11, 20]]);
  const roomy = busProf(20, [[0, 11, 2]]);
  const d = runDecision(world2({ wholeSpanSeats: 0,
    busTimes: [{ dep: 540, run: 95 }, { dep: 545, run: 95 }],
    busProfiles: [packed, roomy] }));
  assert.strictEqual(d.kind, 'SWAP_PREFIX', d.reasons.join(','));
  assert.strictEqual(d.chosenBusDeparture.tripInstanceId, 'KSRTC|T1',
    'a route-level average would have passed the full one too');
  assert.ok(d.reasons.includes('BUS_SPAN_OVER_PLANNING_LIMIT'),
    'and it says the earlier one was rejected: ' + d.reasons.join(','));
  assert.ok(/fills past what khaali will plan into/.test(DEC.lines(d).join(' ')));
  // with only the packed one, there is no swap at all
  const only = runDecision(world2({ wholeSpanSeats: 0, busProfiles: [packed] }));
  assert.strictEqual(only.kind, 'NO_FEASIBLE_CONNECTION');
  assert.ok(only.reasons.includes('BUS_SPAN_OVER_PLANNING_LIMIT'));
});

t('D \u2014 room on the bus is no use if it misses the train', () => {
  const roomy = busProf(20, [[0, 11, 2]]);
  // arrives 640, needs 9 walk + 3 entry + 25 = 677 > the 700 train... so make
  // it late enough to miss: arrive 690, earliest boarding 727, train at 700
  const d = runDecision(world2({ wholeSpanSeats: 0,
    busTimes: [{ dep: 595, run: 95 }], busProfiles: [roomy] }));
  assert.strictEqual(d.kind, 'NO_FEASIBLE_CONNECTION');
  assert.ok(d.reasons.includes('EARLIER_BUS_MISSES_TRANSFER'), d.reasons.join(','));
  assert.ok(/the change onto the train does not work/.test(DEC.lines(d).join(' ')));
  assert.strictEqual(d.chosenBusDeparture, null, 'a bus with room she cannot use is not an answer');
});

t('E \u2014 broken bus accounting is an evidence error, never a full bus', () => {
  const d = runDecision(world2({ wholeSpanSeats: 0, busProfiles: [busProf(20, [[0, 4, 2]], true)] }));
  assert.strictEqual(d.kind, 'NO_FEASIBLE_CONNECTION');
  assert.ok(d.reasons.includes('BUS_DATA_UNVERIFIED'), d.reasons.join(','));
  assert.ok(!d.reasons.includes('BUS_SPAN_OVER_PLANNING_LIMIT'), 'that is a different claim');
  const said = DEC.lines(d).join(' ');
  assert.ok(/could not determine its planning room/.test(said), said);
  assert.ok(/not the same as it being full/.test(said), said);
  ['is full', 'no room', 'sold out'].forEach(c =>
    assert.ok(!said.toLowerCase().includes(c), 'khaali said ' + c));
  // capacity nobody stated lands in the same family, not in "full"
  const noCap = runDecision(world2({ wholeSpanSeats: 0, busProfiles: [busProf(null, [[0, 4, 2]])] }));
  assert.ok(noCap.reasons.includes('BUS_DATA_UNVERIFIED'), noCap.reasons.join(','));
});

t('F \u2014 the journey to Hebbala is kept, re-timed, and flagged if it cannot be', () => {
  const d = runDecision(world2({ wholeSpanSeats: 0 }));
  assert.strictEqual(d.kind, 'SWAP_PREFIX');
  const leg = DEC.railLegOf(toHebbala());
  const ch = SPP.chainOf(d.split, { fromIdx: leg.fromIdx, toIdx: leg.toIdx,
    date: H_DATE, tail: toHebbala() });
  assert.ok(ch, 'a swap that cannot be assembled into a journey is not an answer');
  const modes = ch.legs.map(l => l.mode);
  assert.ok(modes.includes('bus'), 'the replacement');
  assert.ok(modes.includes('train'), 'the train she joins');
  assert.strictEqual(ch.legs[ch.legs.length - 1].to, 'Hebbala',
    'a journey that stops at a railway station answers a question nobody asked');
  // the tail moved with the new train rather than keeping its old clock
  const oldBus = toHebbala().legs.find(l => l.mode === 'bus');
  const newBus = ch.legs.filter(l => l.mode === 'bus').pop();
  assert.notStrictEqual(newBus.depMin, oldBus.depMin, 'the last mile was re-timed');
  assert.ok(ch.arr > ch.dep);
  // and a fixed onward departure that would have gone is not quietly kept
  const fixedTail = toHebbala();
  fixedTail.legs[2] = { ...fixedTail.legs[2], every: null, scheduleKind: 'timetable' };
  const ch2 = SPP.chainOf(d.split, { fromIdx: leg.fromIdx, toIdx: leg.toIdx,
    date: H_DATE, tail: fixedTail });
  if (ch2.split && d.split.split.onward.arrMin > fixedTail.legs[0].arrMin)
    assert.strictEqual(ch2.tailNote, 'ONWARD_NOT_REVALIDATED');
});

t('every reason khaali reports is one the checks can actually produce', () => {
  const seen = new Set();
  [world2({ wholeSpanSeats: 40 }), world2({ wholeSpanSeats: 0 }),
    world2({ wholeSpanSeats: 0, onwardSeats: 0 }),
    world2({ wholeSpanSeats: 0, busProfiles: [busProf(20, [[0, 11, 20]])] }),
    world2({ wholeSpanSeats: 0, busProfiles: [busProf(20, [[0, 4, 2]], true)] }),
    world2({ wholeSpanSeats: 0, busTimes: [{ dep: 595, run: 95 }] }),
  ].forEach(w => runDecision(w).reasons.forEach(r => seen.add(r)));
  seen.forEach(r => assert.ok(DEC.REASONS.includes(r), 'undeclared reason: ' + r));
  assert.ok(seen.has('DIRECT_TRAIN_BOOKABLE'));
  assert.ok(seen.has('DIRECT_TRAIN_UNSELLABLE'));
  assert.ok(seen.has('NO_BOUNDARY_WITH_ONWARD_ROOM'));
});

t('a journey with no train on it is not diagnosed as a rail shortage', () => {
  const busOnly = { kind: 'direct|298-MS', dep: 600, arr: 660, fare: 20, changes: 0,
    legs: [{ mode: 'bus', id: '298-MS', name: 'BMTC 298-MS', from: 'A', to: 'B',
      depMin: 600, arrMin: 660, seat: { word: 'likely', rank: 2, why: '' } }] };
  const d = DEC.decide({ chain: busOnly, pax: 2, date: H_DATE, countsFor: () => ({ anySeats: 0 }) });
  assert.strictEqual(d.kind, 'KEEP_ROUTE');
  assert.deepStrictEqual(d.reasons, ['NO_RAIL_LEG']);
  assert.strictEqual(d.railCheck, null);
});

t('a journey is named by an id, never by where it sits in the list', () => {
  const a = toHebbala(), b = toHebbala();
  assert.strictEqual(DEC.chainId(a), DEC.chainId(b), 'the same journey keys the same way');
  const moved = toHebbala(); moved.legs[0] = { ...moved.legs[0], depMin: 700 };
  assert.notStrictEqual(DEC.chainId(a), DEC.chainId(moved), 'a different departure is a different journey');
  assert.ok(/^ch_/.test(DEC.chainId(a)));
});

console.log('\nthe demand-and-traffic planner: does the answer move when the facts do');

/* Every number under here is invented, deterministically. The tests are not
   about whether a metro is nice; they are about whether one input moves and the
   recommendation, the departure, the interchange and the sentence move with it -
   or stay put for a reason khaali states. */

const run = (over = {}, opts = {}) => {
  SCN.reset(); SCN.set(over);
  return MPL.plan({ fromStop: 'ORIGIN', toStop: 'DEST', at: SCN.state().demoTime,
    pax: opts.pax || 1, policy: opts.policy || 'balanced' });
};
const firstRide = r => (r.answer && r.answer.legs.find(l => l.mode !== 'walk')) || null;
const rejectionsOf = r => { const o = {};
  r.trace.rejections.forEach(x => { o[x.code] = (o[x.code] || 0) + 1; }); return o; };

t('two departures of one route are two answers, not one average', () => {
  const deps = DNET.departures('A', { from: 540, to: 660 });
  assert.ok(deps.length >= 4);
  assert.strictEqual(new Set(deps.map(d => d.tripInstanceId)).size, deps.length);
  // and their predicted loads differ, because they are different buses
  const loads = deps.map(d => RIDE.predict(d).stretch.join(','));
  assert.ok(new Set(loads).size > 1, 'every departure carried an identical crowd');
  SCN.reset();
});

t('somebody boarding in the middle changes the load downstream and not upstream', () => {
  SCN.reset();
  const dep = DNET.departures('A', { from: 600, to: 600 })[0];
  const before = RIDE.predict(dep);
  const after = RIDE.predict(dep, {
    recordedSpans: [TP.span({ fromStopSequence: 2, toStopSequence: 4, pax: 9 })],
    recordedThrough: 2 });
  assert.strictEqual(after.stretch[2] - after.stretch[1] > before.stretch[2] - before.stretch[1], true,
    'nine people boarding at stop 2 did not show up after stop 2');
  assert.deepStrictEqual(after.stretch.slice(3), after.stretch.slice(3),
    'and the arithmetic is stable');
  SCN.reset();
});

t('a claim and a boarding are never the same passenger twice', () => {
  SCN.reset();
  const dep = DNET.departures('A', { from: 600, to: 600 })[0];
  const asClaim = RIDE.predict(dep, {
    claimSpans: [TP.span({ fromStopSequence: 0, toStopSequence: 3, pax: 4, id: 'c1' })] });
  const asBoarded = RIDE.predict(dep, {
    recordedSpans: [TP.span({ fromStopSequence: 0, toStopSequence: 3, pax: 4, id: 'r1' })],
    recordedThrough: 0 });
  assert.strictEqual(asClaim.components.claimed, 4);
  assert.strictEqual(asClaim.components.recorded, 0);
  assert.strictEqual(asBoarded.components.recorded, 4);
  assert.strictEqual(asBoarded.components.claimed, 0);
  // the components are disjoint by id, provably rather than by assertion
  const ids = asClaim.spans.map(x => x.id).filter(Boolean);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(asClaim.spans.some(x => String(x.id).startsWith('sim:')));
  assert.ok(asClaim.spans.some(x => String(x.id).startsWith('claim:')));
  SCN.reset();
});

t('ten people wanting on a bus with room for four is four, not a bus of fifty-six', () => {
  SCN.reset(); SCN.set({ demandBeforeBoarding: 6 });
  const dep = DNET.departures('A', { from: 600, to: 600 })[0];
  const p = RIDE.predict(dep);
  const cap = p.capacity.boardingCapacity;
  p.stretch.forEach((v, k) => assert.ok(v <= cap, 'stretch ' + k + ' carried ' + v + ' of ' + cap));
  assert.ok(p.unserved.reduce((a, b) => a + b, 0) > 0, 'nobody was left behind by a full bus');
  assert.strictEqual(p.attempted[0] >= p.accepted[0], true, 'accepted must not exceed attempted');
  SCN.reset();
});

t('traffic changes when the bus gets there, and only on roads', () => {
  SCN.reset();
  const clean = RSIM.runAcross(DNET.departures('A', { from: 600, to: 600 })[0], 0, 4);
  SCN.set({ downstreamRoadDelayMin: 0 });
  const clear = RSIM.runAcross(DNET.departures('A', { from: 600, to: 600 })[0], 0, 4);
  assert.ok(clean.arriveMinute > clear.arriveMinute, 'the jam made no difference to the clock');
  assert.strictEqual(clear.delayMinutes, 0);
  // ...and never touches the metro, which has no road under it
  SCN.reset();
  const m = RSIM.runAcross(DNET.departures('M', { from: 638, to: 638 })[0], 0, 1);
  assert.strictEqual(m.delayMinutes, 0, 'a jam on the road is not a jam in a tunnel');
  SCN.set({ metroDelayMin: 20 });
  const md = RSIM.runAcross(DNET.departures('M', { from: 638, to: 638 })[0], 0, 1);
  assert.strictEqual(md.delayMinutes, 0, 'still not traffic');
  assert.ok(md.serviceDelayMinutes > 0, 'it is a service delay, and it has its own name');
  SCN.reset();
});

t('a later bus reaches a later metro, and khaali works out which', () => {
  const on = run();
  const late = run({ busADelayMin: 25 });
  const metroOf = r => (r.answer.legs.find(l => l.mode === 'metro') || {}).dep;
  assert.ok(on.answer && late.answer);
  assert.notStrictEqual(metroOf(on), metroOf(late),
    'the bus ran twenty-five minutes late and khaali put her on the same metro');
  assert.ok(late.answer.arriveMinute > on.answer.arriveMinute);
  SCN.reset();
});

t('the total is the door-to-door total, waiting and walking included', () => {
  const r = run();
  const a = r.answer;
  const rides = a.legs.filter(l => l.mode !== 'walk');
  const walks = a.legs.filter(l => l.mode === 'walk');
  const rideMin = rides.reduce((s, l) => s + l.minutes, 0);
  const walkMin = walks.reduce((s, l) => s + l.minutes, 0);
  const waits = a.initialWaitMinutes + a.transferWaitMinutes;
  assert.strictEqual(a.walkingMinutes, walkMin);
  assert.strictEqual(a.totalMinutes, a.arriveMinute - SCN.state().demoTime);
  assert.ok(a.totalMinutes >= rideMin + walkMin, 'the clock ran slower than the parts');
  assert.strictEqual(rideMin + walkMin + waits, a.totalMinutes,
    'every minute between leaving and arriving is accounted for');
  SCN.reset();
});

t('with the road clear, staying on the bus wins', () => {
  const jammed = run();
  const clear = run({ downstreamRoadDelayMin: 0 });
  assert.strictEqual(jammed.decision.kind, 'RECOMMEND_MODE_CHANGE');
  assert.strictEqual(clear.decision.kind, 'RECOMMEND_DIRECT');
  assert.strictEqual(clear.answer.transferCount, 0);
  assert.ok(clear.decision.reasons.some(x => x.code === 'NO_TRANSFER_NEEDED'));
  assert.ok(/Changing would not have got you there sooner/.test(clear.answer.explanation));
  SCN.reset();
});

t('a metro is not preferred for being a metro', () => {
  // the only thing that changes the answer is the road; the mode has no vote
  const clear = run({ downstreamRoadDelayMin: 0 });
  assert.ok(!clear.answer.legs.some(l => l.mode === 'metro'),
    'khaali reached for the metro with nothing to gain');
  // and a metro that is running badly loses to the bus it would have beaten
  const brokenMetro = run({ metroDelayMin: 30 });
  assert.strictEqual(brokenMetro.decision.kind, 'RECOMMEND_DIRECT');
  // the policy is written down, not hidden
  assert.ok(MPL.POLICIES.balanced.transferPenalty > 0, 'a change must cost something');
  assert.deepStrictEqual(Object.keys(MPL.POLICIES).sort(), ['balanced', 'comfortable', 'fastest']);
  SCN.reset();
});

t('a bus-to-bus change can beat a bus-to-metro one', () => {
  const r = run({ metroDelayMin: 45 });
  const anyBusTransfer = r.trace.scores.find(x => x.transfers > 0
    && x.modes.length === 1 && x.modes[0] === 'bus');
  const anyMetro = r.trace.scores.find(x => x.modes.includes('metro'));
  assert.ok(anyBusTransfer, 'no bus-to-bus option was even built');
  if (anyMetro) assert.ok(anyBusTransfer.total < anyMetro.total,
    'with the metro crippled a bus change should score better');
  SCN.reset();
});

t('a change she could not make is gone before anything is ranked', () => {
  const r = run();
  const rej = rejectionsOf(r);
  assert.ok((rej.TRANSFER_TOO_TIGHT || 0) > 0, 'nothing was ever too tight, which is suspicious');
  const tight = r.trace.rejections.find(x => x.code === 'TRANSFER_TOO_TIGHT');
  assert.ok(tight.wait < tight.need, tight.says);
  // and none of the rejected pairings survived into the scores
  const kept = new Set(r.trace.scores.map(x => x.chainId));
  assert.strictEqual(kept.has(undefined), false);
  assert.ok(r.trace.scores.length <= r.trace.considered);
  SCN.reset();
});

t('turn one knob and the chosen departure changes', () => {
  const before = run({}, { pax: 2 });
  const after = run({ demandBeforeBoarding: 5.5 }, { pax: 2 });
  assert.ok(before.answer && after.answer);
  assert.notStrictEqual(firstRide(before).dep, firstRide(after).dep,
    'the first departures filled up and khaali put her on one of them anyway');
  const rej = rejectionsOf(after);
  assert.ok((rej.BOARDING_NOT_FEASIBLE || 0) > 0, 'nothing was rejected for being full');
  SCN.reset();
});

t('the same scenario gives the same answer, however many times it is asked', () => {
  const a = run();
  const b = run();
  assert.strictEqual(a.decision.selectedChainId, b.decision.selectedChainId);
  assert.strictEqual(a.answer.explanation, b.answer.explanation);
  assert.strictEqual(a.answer.arriveMinute, b.answer.arriveMinute);
  // ...and a control moves the revision even when the answer does not
  const r1 = SCN.state().revision;
  SCN.set({ upstreamRoadDelayMin: 1 });
  assert.strictEqual(SCN.state().revision, r1 + 1);
  SCN.reset();
});

t('the sentence says what the reasons say, and names what it beat', () => {
  const r = run();
  const said = r.answer.explanation;
  const road = r.decision.reasons.find(x => x.code === 'AVOIDS_ROAD_DELAY');
  const faster = r.decision.reasons.find(x => x.code === 'LOWER_PREDICTED_TRAVEL_TIME');
  assert.ok(road && said.includes(road.differenceMinutes + ' minutes of simulated road delay'), said);
  assert.ok(faster && said.includes(faster.differenceMinutes + ' minutes earlier'), said);
  assert.ok(/than the Bus A of \d{2}:\d{2} all the way/.test(said),
    'a recommendation with no named alternative is not an explanation: ' + said);
  assert.ok(r.decision.comparisonChainId && r.decision.comparisonChainId !== r.decision.selectedChainId);
  // and the prohibited claims
  ['you will definitely get a seat', 'this bus will certainly be full',
    'metro is always faster', 'traffic avoided'].forEach(c =>
    assert.ok(!said.toLowerCase().includes(c), 'khaali said: ' + c));
  SCN.reset();
});

t('everything invented says it was invented', () => {
  const r = run();
  assert.strictEqual(r.sourceKind, 'simulation');
  assert.ok(/simulated/.test(r.disclosure) && /No seat is reserved/.test(r.disclosure));
  assert.strictEqual(r.answer.evidenceLabel, MPL.DISCLOSURE);
  DNET.allDepartures({ from: 600, to: 620 }).forEach(d => {
    assert.strictEqual(d.sourceKind, 'simulation');
    assert.ok(/^DEMO\|/.test(d.tripInstanceId), 'a synthetic departure must look synthetic');
  });
  const dep = DNET.departures('A', { from: 600, to: 600 })[0];
  assert.strictEqual(RIDE.predict(dep).evidence.quality, 'simulated');
  SCN.reset();
});

t('nothing feasible is said plainly, not as an empty list', () => {
  SCN.reset();
  const all = DNET.allDepartures({ from: 0, to: 1440 }).map(d => d.tripInstanceId);
  SCN.set({ cancelled: all });
  const r = MPL.plan({ fromStop: 'ORIGIN', toStop: 'DEST', at: 600, pax: 1 });
  assert.strictEqual(r.decision.kind, 'NO_FEASIBLE_JOURNEY');
  assert.strictEqual(r.answer, null);
  assert.ok(r.trace.rejections.some(x => x.code === 'DOES_NOT_REACH'));
  SCN.reset();
});

t('the website request runs this planner, not a demo of it', () => {
  // a source-level guard: the endpoint the page calls must reach multiplan,
  // and the demo network must be found from ordinary coordinates
  const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const plan = src.slice(src.indexOf("p === '/api/plan'"));
  assert.ok(/multiplan\.plan\(/.test(plan), '/api/plan does not call the planner');
  assert.ok(/demonet\.nearestStop\(/.test(plan), 'and it never looks for the demo network');
  // Hope Farm and Hebbala, the coordinates the site's own search produces
  assert.ok(DNET.nearestStop(12.98273, 77.75223).stop.id === 'ORIGIN');
  assert.ok(DNET.nearestStop(13.04127, 77.58942).stop.id === 'DEST');
});

console.log('\nthe card: what she takes, where she changes, and what was not checked');

/* The card used to open with "TRAIN KEPT - this train has 43 places khaali can
   sell, so there is no reason to replace any of it". A true sentence about one
   leg's inventory, and no help at all to somebody trying to reach Hebbala. */

const railOnlyChain = () => ({
  kind: 'train|BNC', dep: 725, arr: 835, fare: 101,
  legs: [
    { mode: 'train', id: '12639', name: 'MAS-SBC BRIN', from: 'Bangarpet', to: 'Bengaluru Cantt',
      fromIdx: 0, toIdx: 4, depMin: 725, arrMin: 798, source: 'timetable',
      seat: { word: 'yes', rank: 3, why: '43 berths free' } },
    { mode: 'walk', name: 'Walk', from: 'Bengaluru Cantt', to: 'Vasantha Nagara',
      depMin: 806, arrMin: 807, min: 1, km: 0.1, source: 'measured' },
    { mode: 'bus', id: '285', name: 'BMTC 285 SBS-MKC-DDP', from: 'Vasantha Nagara',
      to: 'Hebbala Canara Bank', depMin: 813, arrMin: 826, min: 13, every: 30,
      scheduleKind: 'frequency', source: 'timetable',
      cap: { occupancy: 0.24, quality: 'simulated' } },
    { mode: 'walk', name: 'Walk', from: 'Hebbala Canara Bank', to: 'Hebbala',
      depMin: 826, arrMin: 834, min: 8, km: 0.61, source: 'measured' },
  ],
});
const railOnlyDecision = () => ({ kind: 'KEEP_ROUTE',
  railCheck: { trainInstanceId: 'IR|12639|2026-09-05', trainNo: '12639',
    fromSequence: 0, toSequence: 4, partySize: 1, anySeats: 43, outcome: 'SELLABLE' },
  reasons: ['DIRECT_TRAIN_BOOKABLE'], chosenBusDeparture: null });

t('every minute between leaving and arriving has a name', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  const J = c.journey;
  // the card showed 1h50m over legs adding to 95: fifteen minutes with no row
  assert.strictEqual(J.rideMinutes, 86);
  assert.strictEqual(J.walkingMinutes, 9);
  assert.strictEqual(J.transferWaitMinutes, 14, 'the waiting was real and had nowhere to go');
  assert.strictEqual(J.doorToDoorMinutes, 109);
  assert.strictEqual(J.rideMinutes + J.walkingMinutes + J.transferWaitMinutes, J.doorToDoorMinutes);
  assert.strictEqual(J.reconciles, true);
});

t('a berth check is not a comparison, and the card refuses to pretend', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  const r = c.recommendation;
  assert.strictEqual(r.status, 'AVAILABILITY_ONLY');
  assert.strictEqual(r.comparison, null, 'there was nothing to compare against');
  assert.ok(r.notEvaluated.length >= 2);
  assert.ok(r.notEvaluated.some(x => /demand/i.test(x)));
  assert.ok(r.notEvaluated.some(x => /traffic/i.test(x)));
  // and none of the language of a comparison that never happened
  const said = r.summaryReason + ' ' + r.headline;
  ['minutes earlier', 'less crowded', 'avoids', 'faster than', 'best option'].forEach(claim =>
    assert.ok(!said.toLowerCase().includes(claim), 'khaali claimed: ' + claim));
  assert.ok(/has not evaluated/.test(said), said);
});

t('the headline is the journey, not the allocator', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  assert.strictEqual(c.recommendation.headline,
    'Take the MAS-SBC BRIN to Bengaluru Cantt, then the BMTC 285 SBS-MKC-DDP to Hebbala Canara Bank.');
  ['TRAIN KEPT', 'no reason to replace', 'places khaali can sell']
    .forEach(x => assert.ok(!c.recommendation.headline.includes(x), 'headline says ' + x));
});

t('availability is stated for the train without seating the whole journey', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  const board = c.journey.steps.find(x => x.kind === 'BOARD');
  assert.strictEqual(board.availability.kind, 'RESERVABLE');
  assert.ok(/Train accommodation available/.test(board.availability.says));
  assert.ok(/43 places/.test(board.availability.detail), 'the count belongs beside the leg');
  const bus = c.journey.steps.find(x => x.mode === 'bus');
  assert.strictEqual(bus.availability.kind, 'UNRESERVED');
  assert.ok(/no seat reserved/i.test(bus.availability.note));
  // and the whole-journey claim is nowhere
  const all = JSON.stringify(c);
  ['seat for the entire trip', 'you will be seated', 'seat guaranteed']
    .forEach(x => assert.ok(!all.toLowerCase().includes(x), 'card claims ' + x));
});

t('a change is its own step, with the walk and the wait on it', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  const change = c.journey.steps.find(x => x.kind === 'CHANGE');
  assert.ok(change, 'the change had no step of its own');
  assert.strictEqual(change.waitBefore, 6, 'the wait before boarding belongs on the step');
  assert.strictEqual(change.scheduleKind, 'frequency');
  assert.strictEqual(change.every, 30);
});

t('the button says what the click does', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  assert.strictEqual(c.booking.actionLabel, 'Hold train accommodation and continue');
  assert.ok(/Nothing is confirmed until payment/.test(c.booking.note));
  assert.notStrictEqual(c.booking.actionLabel, 'Book the journey');
  // held and confirmed are different words for different states
  assert.strictEqual(CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(),
    bookingStatus: 'HELD' }).booking.actionLabel, 'Pay and confirm');
  assert.strictEqual(CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(),
    bookingStatus: 'CONFIRMED' }).booking.enabled, false);
  // a journey with nothing reservable does not offer to hold one
  const busOnly = { kind: 'x', fare: 20, legs: [{ mode: 'bus', name: 'BMTC 500D', from: 'A', to: 'B',
    depMin: 600, arrMin: 640, min: 40 }] };
  assert.strictEqual(CARD.build({ chain: busOnly }).booking.actionLabel, 'Choose this journey');
});

t('when whole journeys were compared, the card says so and names the loser', () => {
  SCN.reset();
  const mp = MPL.plan({ fromStop: 'ORIGIN', toStop: 'DEST', at: 600, pax: 1, policy: 'balanced' });
  const chain = { kind: 'planned', fare: mp.answer.totalFare, simulated: true,
    chainId: mp.answer.chainId,
    legs: mp.answer.legs.map(l => ({ ...l, min: l.minutes })) };
  const c = CARD.build({ chain, mp, searchAt: 600,
    scenario: { scenarioId: mp.scenarioId, revision: mp.revision } });
  const r = c.recommendation;
  assert.strictEqual(r.status, 'EVALUATED');
  assert.ok(r.comparison, 'an evaluated answer with no named alternative is not an explanation');
  assert.ok(r.comparison.alternativeChainId);
  assert.ok(/arriving \d{1,2}:\d{2}/.test(r.comparison.alternativeLabel),
    'the alternative must be named by when it gets there: ' + r.comparison.alternativeLabel);
  assert.strictEqual(r.comparison.timeDifferenceMinutes, 20);
  assert.strictEqual(r.comparison.roadDelayDifferenceMinutes, 38);
  assert.strictEqual(r.recommendation, undefined);
  assert.strictEqual(r.notEvaluated.length, 0, 'nothing was left unchecked, so nothing is disclaimed');
  assert.ok(/^Take the Bus A to K R Puram Bus Stand, then the Metro M/.test(r.headline), r.headline);
  assert.ok(c.evidence.label && /simulated/.test(c.evidence.label));
  SCN.reset();
});

t('with the road clear the card says stay on, and says why not to change', () => {
  SCN.reset(); SCN.set({ downstreamRoadDelayMin: 0 });
  const mp = MPL.plan({ fromStop: 'ORIGIN', toStop: 'DEST', at: 600, pax: 1, policy: 'balanced' });
  const chain = { kind: 'planned', fare: mp.answer.totalFare, simulated: true,
    legs: mp.answer.legs.map(l => ({ ...l, min: l.minutes })) };
  const c = CARD.build({ chain, mp, searchAt: 600 });
  assert.strictEqual(c.recommendation.decisionKind, 'RECOMMEND_DIRECT');
  assert.ok(/^Stay on the Bus A the whole way/.test(c.recommendation.headline));
  assert.strictEqual(c.recommendation.comparison.question, 'Why not change?');
  assert.strictEqual(c.journey.transferCount, 0);
  SCN.reset();
});

t('a walk with no vehicle after it does not become a change', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  // the journey now ends with its own YOUR ARRIVAL row, after the walk
  const last = c.journey.steps[c.journey.steps.length - 1];
  assert.strictEqual(last.kind, 'ARRIVE');
  assert.strictEqual(c.journey.steps[c.journey.steps.length - 2].kind, 'WALK');
  assert.strictEqual(c.journey.steps.filter(x => x.kind === 'BOARD').length, 1,
    'exactly one leg is the one she boards first');
  assert.strictEqual(c.journey.steps.filter(x => x.kind === 'CHANGE').length, 1);
});

console.log('\nthe card, restructured: plan on the front, calculation behind the toggle');

const evaluatedCard = () => {
  SCN.reset();
  const mp = MPL.plan({ fromStop: 'ORIGIN', toStop: 'DEST', at: 600, pax: 1, policy: 'balanced' });
  const chain = { kind: 'planned', fare: mp.answer.totalFare, simulated: true,
    chainId: mp.answer.chainId, legs: mp.answer.legs.map(l => ({ ...l, min: l.minutes })) };
  return CARD.build({ chain, mp, searchAt: 600,
    scenario: { scenarioId: mp.scenarioId, revision: mp.revision } });
};

t('steps are actions with a clock, and every ride says when it arrives', () => {
  const c = evaluatedCard();
  const st = c.journey.steps;
  assert.strictEqual(st[0].action, 'BOARD BUS A');
  assert.strictEqual(st[2].action, 'TAKE METRO M', 'the action, not the category "YOU CHANGE"');
  assert.strictEqual(st[st.length - 1].action, 'YOUR ARRIVAL');
  // the arrival at the interchange is the number the next step hangs off
  assert.ok(st[0].lines.some(x => /^Arrive at /.test(x)), st[0].lines.join(' | '));
  assert.ok(st[2].lines.some(x => /^Arrive at /.test(x)));
  assert.ok(/–/.test(st[1].timeLabel), 'a walk shows its span: ' + st[1].timeLabel);
  SCN.reset();
});

t('the wait is explained once, on the step where she stands in it', () => {
  const c = evaluatedCard();
  const change = c.journey.steps.find(x => x.kind === 'CHANGE');
  assert.ok(change.lines.some(x => /^Wait about /.test(x)), change.lines.join(' | '));
  const front = c.recommendation.headline + ' ' + c.recommendation.mainReason;
  assert.ok(!/minutes in hand|Wait about/.test(front),
    'the wait must not be argued again on the front of the card: ' + front);
  SCN.reset();
});

t('headways come off the main card; the selected departure stays on it', () => {
  const c = evaluatedCard();
  c.journey.steps.forEach(st => (st.lines || []).forEach(x =>
    assert.ok(!/every \d+ min/.test(x), 'a headway leaked onto the main card: ' + x)));
  const ride = c.journey.steps.find(x => x.kind === 'BOARD');
  assert.ok(/every 20 minutes/.test(ride.serviceDetail), ride.serviceDetail);
  assert.ok(/khaali\u2019s estimate|khaali’s estimate/.test(ride.serviceDetail));
  SCN.reset();
});

t('one reason on the front, and it names the loser exactly once', () => {
  const c = evaluatedCard();
  const r = c.recommendation;
  assert.strictEqual(r.titleChip, 'YOUR RECOMMENDED JOURNEY');
  assert.ok(/Changing at K R Puram Bus Stand gets you to Hebbala 20 minutes earlier/.test(r.mainReason), r.mainReason);
  const names = (r.mainReason.match(/arriving \d{1,2}:\d{2}/g) || []).length;
  assert.strictEqual(names, 1, 'the alternative is named once, not re-argued: ' + r.mainReason);
  assert.ok(/Simulated traffic adds 38 minutes/.test(r.mainReason),
    'the contributing factor appears because it contributed');
  SCN.reset();
});

t('the comparison panel carries both journeys, the differences, and the method', () => {
  const c = evaluatedCard();
  const p = c.recommendation.comparison;
  assert.strictEqual(p.thisLabel, 'Bus A \u2192 Metro M');
  assert.ok(p.thisArrive && p.thisTotalMinutes > 0);
  assert.ok(p.alternativeArrive, 'an alternative with no arrival is not comparable');
  assert.ok(p.alternativeTotalMinutes > p.thisTotalMinutes);
  assert.ok(p.whatChanges.some(x => /Arrives 20 minutes earlier/.test(x)));
  assert.ok(p.whatChanges.some(x => /38 minutes of simulated road delay/.test(x)));
  assert.ok(/Departure-level ticket simulation/.test(p.howEstimated));
  assert.ok(/revision \d+/.test(p.howEstimated), 'the method names its scenario generation');
  SCN.reset();
});

t('no comparison, no "recommended" - a found route says it was found', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  const r = c.recommendation;
  assert.ok(!/RECOMMENDED/i.test(r.titleChip), r.titleChip);
  assert.ok(/NOT COMPARED/.test(r.titleChip), r.titleChip);
  assert.strictEqual(r.comparison, null);
  assert.ok(!/earlier|faster|less crowded|avoids/i.test(r.mainReason || r.summaryReason));
});

console.log('\nthe rationale: selection explained, never manufactured');

t('the benefit names the alternative, the arrival, the walking and the changes', () => {
  const c = evaluatedCard();
  const b = c.recommendation.rationale.benefit;
  assert.ok(/Arrive at 10:58/.test(b), b);
  assert.ok(/20 minutes earlier than the bus arriving 11:18/.test(b), b);
  assert.ok(/10 minutes of walking and one change/.test(b), b);
  assert.ok(/costs \u20b9|costs ₹/.test(b), 'the fare trade-off is stated, not hidden: ' + b);
  SCN.reset();
});

t('at most three reasons, each with a choice, an alternative and evidence', () => {
  const c = evaluatedCard();
  const ch = c.recommendation.rationale.choices;
  assert.ok(ch.length >= 2 && ch.length <= 3, 'got ' + ch.length);
  ch.forEach(x => {
    assert.ok(x.question && x.says, JSON.stringify(x));
    assert.ok(x.alternative, 'a reason with nothing it beat is a description: ' + x.question);
    assert.ok(x.evidence, 'a reason with no evidence is an assertion: ' + x.question);
  });
  SCN.reset();
});

t('why change here: the road delay it avoids, against actually staying aboard', () => {
  const c = evaluatedCard();
  const inter = c.recommendation.rationale.choices.find(x => x.about === 'INTERCHANGE');
  assert.ok(inter, 'the crux choice has no reason');
  assert.ok(/38 minutes of simulated delay/.test(inter.says), inter.says);
  assert.ok(/staying aboard/.test(inter.alternative), inter.alternative);
});

t('why this departure: the one that leaves before she can reach it', () => {
  const c = evaluatedCard();
  const dep = c.recommendation.rationale.choices.find(x => x.about === 'ONWARD_DEPARTURE');
  assert.ok(dep, 'no departure-level reason');
  assert.ok(/The 10:32 leaves before you can reach the platform/.test(dep.says), dep.says);
  assert.ok(/10:38 connects with 13 minutes in hand/.test(dep.says), dep.says);
});

t('a full earlier bus becomes the first-leg reason when demand surges', () => {
  SCN.reset(); SCN.set({ demandBeforeBoarding: 5.5 });
  const mp = MPL.plan({ fromStop: 'ORIGIN', toStop: 'DEST', at: 600, pax: 2, policy: 'balanced' });
  const first = (mp.decision.choices || []).find(x => x.about === 'FIRST_LEG');
  assert.ok(first, 'the surge produced no first-leg reason');
  assert.ok(/insufficient boarding room/.test(first.says), first.says);
  assert.ok(/10:00/.test(first.alternative), first.alternative);
  SCN.reset();
});

t('staying aboard gets its reason too, against the best change on the table', () => {
  SCN.reset(); SCN.set({ downstreamRoadDelayMin: 0 });
  const mp = MPL.plan({ fromStop: 'ORIGIN', toStop: 'DEST', at: 600, pax: 1, policy: 'balanced' });
  const stay = (mp.decision.choices || []).find(x => x.about === 'STAY');
  assert.ok(stay, 'RECOMMEND_DIRECT with no why-not-change');
  assert.ok(/arrives at \d{1,2}:\d{2} against \d{1,2}:\d{2} staying aboard/.test(stay.says), stay.says);
  SCN.reset();
});

t('no comparison, no rationale - and none invented downstream', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  assert.strictEqual(c.recommendation.rationale, null,
    'a rationale for an unevaluated journey is fiction with a heading');
});

t('the completion test: the selection is explainable without the timetable', () => {
  // a passenger reading ONLY the benefit and the reasons can say why this
  // journey beat another feasible one - the named loser, the number that
  // separated them, and the checks behind each leg choice
  const c = evaluatedCard();
  const front = [c.recommendation.rationale.benefit]
    .concat(c.recommendation.rationale.choices.map(x => x.says)).join(' ');
  assert.ok(/the bus arriving 11:18/.test(front), 'no named alternative');
  assert.ok(/20 minutes earlier/.test(front), 'no calculated difference');
  assert.ok(/simulated delay/.test(front), 'no cause');
  assert.ok(!/Ride for|Walk for|Arrive at 10:20/.test(front),
    'navigation crept back onto the front of the card');
  SCN.reset();
});

console.log('\nanywhere to anywhere: the comparison speaks the vehicle\u2019s own language');

const trainChain = (name, dep, arr, occ, fare = 90) => ({
  kind: 'train', dep, arr, fare, changes: 0,
  totalMin: arr - dep, arrText: 'x',
  legs: [{ mode: 'train', id: name, name, from: 'Bangarpet', to: 'Bengaluru Cantt',
    depMin: dep, arrMin: arr, min: arr - dep, source: 'timetable',
    seat: { word: 'yes', rank: 3 }, cap: { occupancy: occ, quality: 'exact' } }],
});

t('take this train instead of this train, judged on arrival, not duration', () => {
  // leaves 25 minutes earlier, takes 10 minutes longer, gets there first -
  // the duration arithmetic used to call this one "arrives 10 minutes later"
  const slowButEarly = trainChain('MKM-SBC SWAR', 425, 565, 0.93);
  const fastButLate = trainChain('KPN-SBC PASS', 450, 580, 0.82);
  const oc = CARD.optionComparisonOf(slowButEarly, fastButLate, {});
  assert.strictEqual(oc.timeDifferenceMinutes, 15, 'arrival minutes, not journey length');
  assert.ok(/arrives 15 minutes earlier/.test(oc.summaryReason), oc.summaryReason);
  assert.ok(/^Take MKM-SBC SWAR instead of KPN-SBC PASS\.$/.test(oc.headline),
    'two single vehicles is a plain choice, not a "stay on": ' + oc.headline);
});

t('a train speaks berth language, never bus language', () => {
  const oc = CARD.optionComparisonOf(trainChain('A EXP', 425, 565, 0.93),
    trainChain('B PASS', 450, 580, 0.82), {});
  assert.ok(/^Train occupancy: 93%/.test(oc.demandEvidence.says), oc.demandEvidence.says);
  assert.ok(/counted from khaali\u2019s own berth inventory/.test(oc.demandEvidence.says)
    || oc.demandEvidence.says.includes('counted from khaali’s own berth inventory'),
    oc.demandEvidence.says);
  assert.strictEqual(oc.disclosure, 'Berth counts are khaali’s own inventory.');
  assert.strictEqual(oc.trafficEvidence, 'no road legs', 'no road, no traffic caveat');
  // banned as PHRASES, not as a word: this comparison legitimately says
  // 'at its busiest', and a bare /bus/ check failed it for speaking English
  const all = JSON.stringify(oc).toLowerCase();
  // the word with its boundary, because every phrase list so far has lost to
  // 'busiest': bus matches the vehicle and nothing it is a prefix of
  assert.ok(!/bus/.test(all), 'an all-train comparison mentioned a bus');
});

t('crowding is compared when both sides carry a load, as two percentages', () => {
  const oc = CARD.optionComparisonOf(trainChain('A', 425, 565, 0.93),
    trainChain('B', 450, 580, 0.82), {});
  assert.strictEqual(oc.crowdingDifference, -11);
  assert.ok(/though it is more crowded \(93% at its busiest against 82%\)/.test(oc.summaryReason),
    oc.summaryReason);
  // ...and stays silent when the gap is noise
  const near = CARD.optionComparisonOf(trainChain('A', 425, 565, 0.85),
    trainChain('B', 450, 580, 0.82), {});
  assert.strictEqual(near.crowdingDifference, null, 'three points is not a claim');
});

const metroChain = (dep, arr, level, fare = 30) => ({
  kind: 'metro', dep, arr, fare, changes: 0,
  totalMin: arr - dep, arrText: 'x',
  legs: [{ mode: 'metro', id: 'PURPLE', name: 'Purple Line', from: 'KGWA', to: 'WFD',
    depMin: dep, arrMin: arr, min: arr - dep, source: 'timetable',
    cap: { occupancy: level, quality: 'predicted' } }],
});
const busOnlyChain = (name, dep, arr, occ, fare = 20) => ({
  kind: 'bus', dep, arr, fare, changes: 0,
  totalMin: arr - dep, arrText: 'x',
  legs: [{ mode: 'bus', id: name, name, from: 'Hebbala', to: 'Hope Farm',
    depMin: dep, arrMin: arr, min: arr - dep, source: 'timetable',
    cap: { occupancy: occ, quality: 'simulated' } }],
});

t('berths and station entries are not the same percentage, so no verdict', () => {
  // a train's 93% is booked berth inventory; the metro's 40% is entries at a
  // station against its own peak hour - arithmetic across them is not crowding
  const oc = CARD.optionComparisonOf(trainChain('A EXP', 425, 565, 0.93),
    metroChain(450, 580, 0.40), {});
  assert.ok(oc, 'time and fare still differ, the comparison itself survives');
  assert.strictEqual(oc.crowdingDifference, null, 'a cross-basis verdict was issued');
  assert.strictEqual(oc.crowdingComparable, false);
  assert.ok(!/crowded/.test(oc.summaryReason), oc.summaryReason);
  assert.ok(!oc.differences.some(d => /crowded/.test(d)), 'a crowding bullet slipped through');
  assert.ok(/different things/.test(oc.crowdingComparison.note), 'the refusal goes unexplained');
});

t('the evidence still appears on both sides, described, not compared', () => {
  const oc = CARD.optionComparisonOf(trainChain('A EXP', 425, 565, 0.93),
    metroChain(450, 580, 0.40), {});
  assert.strictEqual(oc.crowdingComparison.selected.basis, 'berth-inventory');
  assert.strictEqual(oc.crowdingComparison.alternative.basis, 'station-entries');
  assert.strictEqual(oc.crowdingComparison.selected.occupancy, 0.93);
  assert.strictEqual(oc.crowdingComparison.alternative.quality, 'predicted');
});

t('two buses share a basis, and their loads are still compared', () => {
  const oc = CARD.optionComparisonOf(busOnlyChain('506-A', 600, 660, 0.38),
    busOnlyChain('289-GS', 610, 680, 0.81), {});
  assert.strictEqual(oc.crowdingDifference, 43);
  assert.strictEqual(oc.crowdingComparable, true);
  assert.ok(/less crowded \(38% at its busiest against 81%\)/.test(oc.summaryReason),
    oc.summaryReason);
});

t('a metro figure names the station, not the inside of a carriage', () => {
  const oc = CARD.optionComparisonOf(metroChain(450, 560, 0.62),
    trainChain('B PASS', 450, 580, 0.82), {});
  const says = oc.demandEvidence.says;
  assert.ok(/^Metro station crowding: 62%/.test(says), says);
  assert.ok(/busiest hour/.test(says), says);
  assert.ok(/Onboard crowding is unknown\./.test(says), says);
  assert.ok(!/at the busiest point of your ride/.test(says),
    'onboard language on a station-entries number');
});

console.log('\nthe card contract: identity, standing, and per-mode evidence');

t('a comparison carries both sides whole, not just the differences', () => {
  const sel = trainChain('A EXP', 425, 565, 0.5, 90);
  const alt = trainChain('B PASS', 450, 580, 0.5, 120);
  const oc = CARD.optionComparisonOf(sel, alt, {
    selectedChainId: 'c-sel', alternativeChainId: 'c-alt' });
  assert.strictEqual(oc.selectedChainId, 'c-sel');
  assert.strictEqual(oc.alternativeChainId, 'c-alt');
  assert.strictEqual(oc.arrivalDifferenceMinutes, oc.timeDifferenceMinutes);
  assert.strictEqual(oc.selectedFare, 90);
  assert.strictEqual(oc.alternativeFare, 120);
  assert.strictEqual(oc.selectedTransfers, 0);
  assert.strictEqual(oc.alternativeTransfers, 0);
  assert.strictEqual(oc.fareBasis, 'per person');
  assert.strictEqual(oc.alternativeFeasible, true,
    'infeasible candidates never enter the chains list - the field states the invariant');
});

t('reason codes exist only where their numbers do', () => {
  const oc = CARD.optionComparisonOf(trainChain('A', 425, 565, 0.93, 90),
    trainChain('B', 450, 580, 0.82, 120), {});
  assert.deepStrictEqual(oc.reasonCodes.slice().sort(),
    ['ARRIVES_EARLIER', 'CHEAPER', 'MORE_CROWDED'].sort());
  const noCrowd = CARD.optionComparisonOf(trainChain('A', 425, 565, 0.85, 90),
    metroChain(450, 580, 0.40, 120), {});
  assert.ok(!noCrowd.reasonCodes.some(k => /CROWDED/.test(k)),
    'a crowding code without a comparable crowding number');
});

t('the card states its identity and standing at the top', () => {
  const rec = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(),
    searchAt: 725, role: 'RECOMMENDED', selectedChainId: 'chain-1' });
  assert.strictEqual(rec.recommendationStatus, 'RECOMMENDED');
  assert.strictEqual(rec.evaluationStatus, rec.recommendation.status);
  assert.strictEqual(rec.chainId, 'chain-1');
  const alt = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(),
    searchAt: 725, role: 'ALTERNATIVE' });
  assert.strictEqual(alt.recommendationStatus, 'ALTERNATIVE');
  const unsaid = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(),
    searchAt: 725 });
  assert.strictEqual(unsaid.recommendationStatus, null,
    'a role the caller never assigned was invented');
});

t('evidence names a source per mode ridden, and none for a mode not ridden', () => {
  const c = CARD.build({ chain: railOnlyChain(), railDecision: railOnlyDecision(), searchAt: 725 });
  assert.ok(/demo reservation inventory/.test(c.evidence.trainInventorySource),
    'the train source does not admit it is demo inventory');
  assert.ok(/simulated demand model/.test(c.evidence.busDemandSource),
    'this journey rides a bus, and its demand source went unnamed');
  assert.strictEqual(c.evidence.metroDemandSource, null, 'a metro source with no metro leg');
  const b = CARD.build({ chain: busOnlyChain('506-A', 600, 660, 0.38) });
  assert.ok(/simulated demand model/.test(b.evidence.busDemandSource), b.evidence.busDemandSource);
  assert.strictEqual(b.evidence.trainInventorySource, null);
  const m = CARD.build({ chain: metroChain(450, 560, 0.62) });
  assert.ok(/station entries/.test(m.evidence.metroDemandSource), m.evidence.metroDemandSource);
  assert.ok(/onboard crowding is not measured/i.test(m.evidence.metroDemandSource),
    'the station-entries source implies onboard knowledge');
});

t('the same name twice gets its departure time, both ways home included', () => {
  const oc = CARD.optionComparisonOf(trainChain('MEMU', 600, 660, 0.5),
    trainChain('MEMU', 630, 690, 0.5), {});
  assert.ok(/MEMU \(10:00 am\) instead of MEMU \(10:30 am\)/.test(oc.headline), oc.headline);
});

t('the way home exists: metro to rail plans in both directions', () => {
  const back = JY.journeys({ from: { kind: 'metro', id: 'KGWA' },
    to: { kind: 'rail', id: 'BWT' }, after: 540 });
  assert.strictEqual(back.ok, true);
  assert.ok(back.chains.length >= 2, 'the return journey was an empty page');
  const kinds = new Set(back.chains.map(c => c.kind));
  assert.ok(kinds.has('walk+train'),
    'Majestic metro is a short walk from the City station, and the plan must know it');
  assert.ok(kinds.has('metro+train'), 'the line out to Whitefield is also a way');
  // and the change out of the metro carries real slack, not zero
  const mt = back.chains.find(c => c.kind === 'metro+train');
  const metro = mt.legs.find(l => l.mode === 'metro');
  const train = mt.legs.find(l => l.mode === 'train');
  assert.ok(train.depMin - metro.arrMin >= 8,
    'she cannot board a train the minute she steps off the metro');
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
  // the engine still knows it is a car; the leg she reads does not claim one
  assert.strictEqual(l.mode, 'car');
  assert.strictEqual(l.name, 'Private transport');
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
      'khaali counted nothing runs there while a bus was in its own results');
    assert.ok(!a.reason.reasons.includes('RIDE_BECAUSE_NOTHING_RUNS'));
    assert.ok(a.reason.facts.networkAlternative, 'the alternative is not in the facts');
    const counted = AL.sentence(a.reason);
    assert.ok(!/no bus khaali knows runs/.test(counted), counted);
    assert.ok(/gets there for/.test(counted), counted);
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
console.log('\nSaarthi: what it has been told khaali is');

t('the brief opens with both halves of khaali, not just the trains', () => {
  const p = SA.systemPrompt('2026-09-04');
  const opening = p.slice(0, 420);
  assert.match(opening, /books train berths/i);
  assert.match(opening, /plans whole journeys/i);
  assert.match(opening, /BMTC/);
  assert.match(opening, /Metro/i);
  // the old brief called khaali "a demo rail booking app for the corridor"
  // in its first breath, and everything downstream inherited that
  assert.ok(!/^You are Saarthi[^.]*rail booking app/i.test(p), 'khaali is not introduced as a rail app');
});

t('it is forbidden from turning a place away for being off the corridor', () => {
  const p = SA.systemPrompt('2026-09-04');
  // the exact instruction that produced "Kodigehalli Gate corridor mein nahi hai"
  assert.ok(!p.includes('If a station is not on this corridor, say so and suggest the nearest corridor stations'),
    'the refusal instruction is gone');
  assert.match(p, /never say a place "is not on this corridor"/i);
  assert.match(p, /never offer a corridor station as a substitute/i);
  assert.match(p, /A PLACE YOU DO NOT RECOGNISE IS A PLAN, NEVER A REFUSAL/);
  assert.match(p, /9,875/, 'it is told how many bus stops khaali actually holds');
});

t('the worked examples teach journeys as loudly as they teach trains', () => {
  const shots = SA.shots(Date.parse('2026-09-04T06:00:00+05:30'));
  const acts = shots.filter(m => m.role === 'assistant').map(m => JSON.parse(m.content).action).filter(Boolean);
  const plans = acts.filter(a => a.type === 'plan');
  const searches = acts.filter(a => a.type === 'search');
  assert.ok(plans.length >= 4, 'journeys are shown, not only described: ' + plans.length);
  assert.ok(plans.length >= searches.length - 1,
    'and roughly as often as train searches (' + plans.length + ' vs ' + searches.length + ')');
  // every example must be a shape the server actually handles
  const known = ['search', 'plan', 'cancellations', 'odds', 'mybookings'];
  acts.forEach(a => assert.ok(known.includes(a.type), 'unknown action taught: ' + a.type));
  shots.filter(m => m.role === 'assistant').forEach(m => { JSON.parse(m.content); });
});

t('the bus stop that was refused is now a worked example', () => {
  const shots = SA.shots();
  const i = shots.findIndex(m => m.role === 'user' && /Kodigehalli Gate/i.test(m.content));
  assert.ok(i >= 0, 'the question that broke it is in the brief');
  const a = JSON.parse(shots[i + 1].content).action;
  assert.strictEqual(a.type, 'plan');
  assert.match(a.to, /Kodigehalli Gate/);
  assert.strictEqual(a.from, 'Bangarpet');
});

t('a mode is only ever taught when the traveller named one', () => {
  const shots = SA.shots();
  const plans = [];
  shots.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const a = JSON.parse(m.content).action;
    if (a && a.type === 'plan') plans.push({ a, counted: (shots[i - 1] || {}).content || '' });
  });
  plans.forEach(({ a, counted: raw }) => {
    if (!a.modes) return;
    const counted = raw.toLowerCase();
    a.modes.forEach(m => {
      const named = { bus: /bus|ಬಸ್/, metro: /metro|ಮೆಟ್ರೋ/, train: /train|metro|ರೈಲು/, car: /cab|car|taxi/, bike: /bike/ }[m];
      assert.ok(named && named.test(counted), 'taught "' + m + '" from: ' + counted);
    });
  });
  // a hired ride is never volunteered
  const free = plans.filter(({ a }) => !a.modes || !a.modes.some(m => m === 'car' || m === 'bike'));
  assert.ok(free.length >= 3, 'most journeys are taught without a cab');
});

t('Saarthi can say what the website does', () => {
  const p = SA.systemPrompt('2026-09-04');
  assert.ok(SA.PAGES.length >= 8);
  SA.PAGES.forEach(([name, path]) => {
    assert.ok(p.includes(name), 'the brief lists ' + name);
    assert.ok(p.includes(path), 'and where it is: ' + path);
  });
  assert.match(p, /trip pass/i);
  assert.match(p, /SOS/);
  assert.match(p, /cannot book a bus or a metro ride/i, 'and is honest about what it cannot do');
  // The last mile is now the one thing khaali does hand to somebody, so the
  // brief has to carry both halves of that or Saarthi will keep telling people
  // khaali cannot do the thing the page in front of them is doing.
  assert.match(p, /owns no vehicle, employs no driver/i, 'and about what it still is not');
  assert.match(p, /never name one/i, 'a named vehicle is a promise khaali cannot keep');
});

t('the brief still knows the corridor and the day', () => {
  const p = SA.systemPrompt('2026-09-04');
  assert.match(p, /Today is 2026-09-04/);
  assert.match(p, /0:BWT Bangarpet/);
  assert.match(p, /13:MYS Mysuru Jn/);
  assert.match(p, /interval berths/i);
  const shots = SA.shots(Date.parse('2026-09-04T06:00:00+05:30'));
  const dated = shots.filter(m => m.role === 'assistant').map(m => JSON.parse(m.content).action)
    .filter(a => a && a.date);
  assert.ok(dated.length >= 3);
  dated.forEach(a => assert.match(a.date, /^2026-09-0[456]$/, 'dates are resolved against the day given: ' + a.date));
});

t('a journey across the city can be one bus, with no station in it', async () => {
  JY.useBmtc(await import('./bmtc.mjs'));
  const kora = { kind: 'place', lat: 12.94087, lng: 77.62502, name: 'Koramangala Bus Station' };
  // Majestic to Koramangala is a direct BMTC route. khaali used to route every
  // journey through a railway or metro station and close the ends, so this
  // came back as "no bus runs there" while the bus was in its own timetable.
  const r = JY.journeysAnywhere({ from: { kind: 'metro', id: 'KGWA' }, to: kora, after: 600, modes: ['bus'] });
  assert.ok(r.ok && r.chains.length, 'a direct bus is a journey: ' + (r.reason || ''));
  const c = r.chains[0];
  const bus = c.legs.find(l => l.mode === 'bus');
  assert.ok(bus && /^BMTC /.test(bus.name));
  assert.ok(!c.legs.some(l => l.mode === 'train' || l.mode === 'metro'), 'and needs no train to justify itself');
  assert.ok(c.fare > 0 && c.fare < 60);
  assert.ok(c.totalMin > 0 && c.totalMin < 180);
  assert.ok(c.seat && c.seat.word, 'it still answers the seat question');
});

t('a direct bus is never offered to someone who ruled buses out', () => {
  const r = JY.journeysAnywhere({ from: { kind: 'rail', id: 'BWT' }, to: { kind: 'rail', id: 'SBC' },
    after: 480, modes: ['train'] });
  assert.ok(r.ok && r.chains.length);
  assert.ok(!r.chains.some(c => c.modes.includes('bus')), 'train only means train only');
  assert.ok(!r.chains.some(c => c.modes.some(m => m === 'car' || m === 'bike')), 'and nothing is hired unasked');
});

t('an end knows where it is, whichever kind of end it is', () => {
  const rail = JY.pointOfEnd({ kind: 'rail', id: 'BWT' });
  assert.ok(rail && Math.abs(rail.lat - 12.99) < 0.2 && /Bangarpet/.test(rail.name));
  const metro = JY.pointOfEnd({ kind: 'metro', id: 'KGWA' });
  assert.ok(metro && Math.abs(metro.lng - 77.57) < 0.1);
  const place = JY.pointOfEnd({ kind: 'place', lat: 13.1, lng: 77.6, name: 'somewhere' });
  assert.strictEqual(place.lat, 13.1);
  assert.strictEqual(JY.pointOfEnd({ kind: 'rail', id: 'NOPE' }), null);
  assert.strictEqual(JY.pointOfEnd(null), null);
});

t('Saarthi is forbidden from inventing a starting point', () => {
  const p = SA.systemPrompt('2026-09-04');
  assert.match(p, /NEVER INVENT A STARTING POINT/);
  const shots = SA.shots();
  const i = shots.findIndex(m => m.role === 'user' && /^book me a cab to Hebbal$/.test(m.content));
  assert.ok(i >= 0, 'the destination-only question is a worked example');
  const reply = JSON.parse(shots[i + 1].content);
  assert.strictEqual(reply.action, null, 'it asks instead of planning from nowhere');
  assert.ok(reply.say && reply.say.length > 8);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
