// Fair Tatkal, the round itself: open a window, take entries, allot.
//
// This used to live inline in the server's route handler, which meant the
// only way to test it was to stand up HTTP and a Supabase token. Everything
// here is a pure function over a round object. The server keeps what belongs
// to the server: who is asking, the journal, the monthly counter. This module
// keeps what a round is.
//
// Determinism is the point. A round is seeded from who opened it, its number
// and its date; the simulated population, the shuffle and therefore the
// winners follow from that seed alone. Anyone with the seed can replay the
// allotment and get the same answer, which is what makes it auditable.

import * as sentinel from './sentinel.mjs';

export const TKN = '16021';        // the demo round runs on tomorrow's Kaveri
export const TKC = 'SL';
export const TKF = 0, TKT = 13;    // Bangarpet to Mysuru, the whole run
export const TKB = 40;             // berths in the window
export const CAP_CHITS = 4;        // what identity + monthly cap alone allow a farm
export const FARE = 175;

/** Tomorrow's date in the server's local calendar. */
export function tkIso(now = Date.now()) {
  const d = new Date(now + 864e5);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** FNV-1a, the same hash the engine uses for dates and cancellations. */
export function fnv(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/** mulberry32: a small seeded PRNG, so a shuffle can be replayed. */
export function mulb(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * The simulated population for a round: three farms and a crowd of ordinary
 * travellers, each carrying the signals Sentinel will read. A farm arrives in
 * the first instants, fires many requests at machine-regular intervals from
 * dozens of accounts, and never looked at a train. A person arrives whenever,
 * browsed first, and taps like a person.
 */
export function simOf(seed) {
  const r = mulb(seed);
  const agents = [{ id: 'A', tries: 180 + Math.floor(r() * 80) },
    { id: 'B', tries: 110 + Math.floor(r() * 70) },
    { id: 'C', tries: 60 + Math.floor(r() * 60) }];
  const humans = 120 + Math.floor(r() * 30);
  const arrivals = [];
  agents.forEach(a => {
    a.atMs = 3 + Math.floor(r() * 40);
    a.accounts = 22 + Math.floor(r() * 30);
    const base = 12 + Math.floor(r() * 9);
    a.gaps = [];
    for (let g = 0; g < 6; g++) a.gaps.push(base + Math.floor(r() * 3));
    a.signals = { atMs: a.atMs, tries: a.tries, accounts: a.accounts,
      payReuse: true, actions: 0, gaps: a.gaps };
    arrivals.push({ kind: 'agent', id: a.id, tries: a.tries, atMs: a.atMs });
  });
  const hpeople = [];
  for (let h = 0; h < humans; h++) {
    const atMs = 500 + Math.floor(r() * 40000);
    const gaps = [900 + Math.floor(r() * 5200), 1400 + Math.floor(r() * 9000),
      700 + Math.floor(r() * 3100), 2600 + Math.floor(r() * 11000)];
    hpeople.push({ id: 'h' + h,
      signals: { atMs, tries: 1, accounts: 1, payReuse: false,
        actions: 3 + Math.floor(r() * 9), gaps } });
    arrivals.push({ kind: 'human', id: 'h' + h, atMs });
  }
  return { agents, humans, hpeople, arrivals };
}

/** A fresh round for this identity. */
export function newRound(who, id, iso = tkIso(), now = Date.now()) {
  const seed = fnv('tk|' + who + '|' + id + '|' + iso);
  return { id, seed, openedAt: now, state: 'open', real: [], sim: simOf(seed), result: null };
}

/**
 * Put a real person into the window. One entry per identity per round; the
 * window must be open. The caller has already verified who this is and that
 * the fare is locked.
 */
export function enter(R, { who, name, signals }, now = Date.now()) {
  if (!R || R.state !== 'open') return { ok: false, reason: 'closed' };
  if (R.real.some(e => e.who === who)) return { ok: false, reason: 'duplicate' };
  R.real.push({ who, name: String(name || 'Traveller').slice(0, 60), at: now, signals: signals || {} });
  return { ok: true, chit: R.sim.humans + R.real.length };
}

/**
 * Close the window and allot. `av` is the availability of the round's train
 * for the round's date, as the store reports it; the caller passes it in so
 * this stays pure.
 *
 * Sentinel scores every entrant - farms, simulated people and real people
 * through the same function. It can only take chits away from an entry that
 * behaves like a farm, never below one, never above what the cap allowed.
 * Then one seeded shuffle, the first TKB draw berths, and a real winner is
 * pointed at a berth that is genuinely free, full-way first.
 */
export function allot(R, av, now = Date.now()) {
  if (!R || R.state !== 'open') return { ok: false, reason: 'closed' };
  R.state = 'done'; R.closedAt = now;

  const scored = sentinel.scoreRound([
    ...R.sim.agents.map(a => ({ id: a.id, kind: 'bot', signals: a.signals })),
    ...(R.sim.hpeople || []).map(h => ({ id: h.id, kind: 'human', signals: h.signals })),
    ...R.real.map(e => ({ id: e.who, kind: 'real', name: e.name, signals: e.signals || {} })),
  ]);
  const byId = new Map(scored.map(x => [x.id, x]));
  R.scored = scored;

  const chitsFor = id => {
    const sc = byId.get(id);
    return Math.max(1, Math.min(CAP_CHITS, sc ? sc.chits : CAP_CHITS));
  };
  const bowl = [];
  R.sim.agents.forEach(a => { const n = chitsFor(a.id);
    for (let c = 0; c < n; c++) bowl.push({ kind: 'bot', id: a.id }); });
  for (let h = 0; h < R.sim.humans; h++) bowl.push({ kind: 'human', id: 'h' + h });
  R.real.forEach((e, i) => bowl.push({ kind: 'real', id: e.who, name: e.name, ix: i }));

  const r = mulb(R.seed ^ 0x9e3779b9);
  for (let i = bowl.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = bowl[i]; bowl[i] = bowl[j]; bowl[j] = t;
  }
  const winners = bowl.slice(0, Math.min(TKB, bowl.length));
  const realWinners = winners.filter(w => w.kind === 'real');

  // full-way berths first; on a sold-out day the winner gets the best
  // partly-free berth instead, priced for the stretch that is theirs
  const freeIdx = av.berths.filter(x => x.k === 'free').map(x => x.idx)
    .concat(av.berths.filter(x => x.k === 'part' && x.price != null)
      .sort((a2, b2) => b2.price - a2.price).map(x => x.idx));
  realWinners.forEach((w, i) => { w.berthIdx = freeIdx[i] != null ? freeIdx[i] : null; });

  const botChits = R.sim.agents.reduce((a2, a) => a2 + chitsFor(a.id), 0);
  R.result = {
    chits: bowl.length,
    sentinel: {
      model: sentinel.MODEL.version,
      capChits: R.sim.agents.length * CAP_CHITS,
      botChits,
      stripped: R.sim.agents.length * CAP_CHITS - botChits,
      flagged: scored.filter(x => x.band !== 'clear').length,
      cleared: scored.filter(x => x.band === 'clear').length,
    },
    counts: { free: av.counts.free, part: av.counts.part },
    winners: { bots: winners.filter(w => w.kind === 'bot').length,
      humans: winners.filter(w => w.kind === 'human').length,
      real: realWinners.map(w => ({ who: w.id, name: w.name, berthIdx: w.berthIdx })) },
  };
  return { ok: true, realWinners, winners, scored, bowl };
}

// ---------------------------------------------------------------------------
// The fare is blocked, never taken up front.
//
// A Tatkal entry is a bet on an allotment, so charging for it is the wrong
// shape: most entrants lose, and every loser then waits on a refund. Instead
// the payment session works the way a bank block does - an IPO mandate on UPI,
// an authorisation on a card, a hold in the wallet. The bank sets the money
// aside and nothing moves. When the window closes, a winner's block is taken
// and every other block is released. There is no refund because there was no
// debit.
//
//   pending -> authorised -> captured   (allotted: the fare is now taken)
//                         -> released   (not allotted: nothing was ever taken)
//   pending -> cancelled | expired      (the bank never approved: nothing blocked)

export const PAY_STATES = ['pending', 'authorised', 'captured', 'released', 'cancelled', 'expired'];

/** The bank approved the block. Only a pending, unexpired session can move here. */
export function authorise(s, now = Date.now()) {
  if (!s) return { ok: false, reason: 'missing' };
  if (s.status !== 'pending') return { ok: false, reason: s.status };
  if (now > s.expiresAt) { s.status = 'expired'; return { ok: false, reason: 'expired' }; }
  s.status = 'authorised'; s.authorisedAt = now; s.captured = 0;
  return { ok: true, status: s.status };
}

/**
 * Allotment decides what happens to a block: a winner's is captured, a loser's
 * is released. Anything that is not an approved block is left exactly as it
 * is, so settling twice, or settling a session the bank never approved, does
 * nothing.
 */
export function settle(s, won, now = Date.now(), amount = null) {
  if (!s) return { ok: false, reason: 'missing' };
  if (s.status !== 'authorised') return { ok: false, reason: s.status };
  s.status = won ? 'captured' : 'released';
  // an order blocks the most the traveller would pay and takes what the
  // berth actually cost; never more than was blocked
  s.captured = won ? Math.min(s.amount, amount == null ? s.amount : amount) : 0;
  s.settledAt = now;
  return { ok: true, status: s.status, captured: s.captured };
}

/** Every approved block in this round, settled against the round's result. */
export function settleRound(sessions, R, now = Date.now()) {
  const wins = (R && R.result && R.result.winners && R.result.winners.real) || [];
  const out = [];
  for (const s of sessions) {
    if (!s || s.round !== R.id || s.status !== 'authorised') continue;
    const w = wins.find(x => x.who === s.who) || null;
    settle(s, !!w, now);
    if (w) s.berthIdx = w.berthIdx;
    out.push(s);
  }
  return out;
}

/** The round was abandoned: every approved block goes back untouched. */
export function releaseAll(sessions, roundId, now = Date.now()) {
  const out = [];
  for (const s of sessions) {
    if (!s || s.round !== roundId || s.status !== 'authorised') continue;
    settle(s, false, now);
    out.push(s);
  }
  return out;
}
