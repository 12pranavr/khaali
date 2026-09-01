// Locking, payment and expiry tests. Run: node test.mjs
import assert from 'assert';
import * as S from './store.mjs';
import { journeyMask, seedOccupancy, berthState, packPlan, serves, journeyKm, stationByCode, liveOf, stopIdxs, sMin } from './engine.mjs';
import { TRAINS, ST } from './data.mjs';
import * as sentinel from './sentinel.mjs';
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


console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
