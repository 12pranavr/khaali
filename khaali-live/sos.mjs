// Marking the moment, when speaking up is the thing you cannot do.
//
// A woman alone at 11pm being stared at does not want to file a complaint.
// Filing means being seen doing it, being asked to explain, and being
// disbelieved. What she wants is for the moment not to disappear.
//
// So this module holds the STAMP and never the footage. Her phone keeps the
// photograph or the video; khaali keeps only what turns it into evidence -
// which train, which coach, which berth, what time, and where that train was
// at that minute. She booked the journey, so khaali already knows all of it
// and she has to type none of it.
//
// The one exception is the moment she hands it to the police herself. Then,
// and only then, the recording is uploaded with the stamp - because a report
// an officer cannot watch is a much weaker thing than one they can. Sending it
// to a friend does not do this; keeping it does not do this; and deleting takes
// it back off the server again.
//
// Two consequences follow, and both are the point:
//   - khaali holds no picture of anybody's face except one that its owner
//     deliberately filed with the RPF. Nothing else is here to leak.
//   - She can record nothing at all and still mark the moment. A stamp with
//     no footage is silent, invisible, and still says she was in S4/31 on the
//     16021 at 23:14 and something happened.
//
// Capturing is not reporting. An alert is HELD until she decides otherwise,
// and khaali hands it to the real channel only when she says so. khaali
// prepares a report. It does not send anyone to her coach, and it must never
// say that it has.

import { ST, TRAINS } from './data.mjs';
import { GEO } from './geo.mjs';
import { serves, sMin, hhmm, stopIdxs } from './engine.mjs';

export const KINDS = ['mark', 'photo', 'video'];
export const CHANNELS = ['rpf', 'trusted'];

/** Kilometres between two points on the earth. */
function hav(a, b) {
  const r = Math.PI / 180, R = 6371;
  const dla = (b.lat - a.lat) * r, dln = (b.lng - a.lng) * r;
  const s = Math.sin(dla / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dln / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Where the phone actually is, in the language of this railway line: which two
 * stations it lies between, and how far along.
 *
 * This is the answer for somebody who never booked through khaali. It needs no
 * ticket, no PNR and nothing typed - the phone knows where it is, khaali knows
 * where the line runs, and between them that is a place on a railway.
 */
export function placeOf(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const k = Math.cos(12.7 * Math.PI / 180);        // this corridor's latitude
  const flat = p => ({ x: p.lng * k, y: p.lat });
  const P = flat({ lat, lng });
  let best = null;
  for (let i = 0; i < GEO.length - 1; i++) {
    const A = flat(GEO[i]), B = flat(GEO[i + 1]);
    const dx = B.x - A.x, dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const on = { lat: A.y + t * dy, lng: (A.x + t * dx) / k };
    const off = hav({ lat, lng }, on);
    if (!best || off < best.off) best = { i, t, off };
  }
  const a = best.i, b = best.i + 1;
  const km = ST[a].km + (ST[b].km - ST[a].km) * best.t;
  const onLine = best.off <= 3;                     // a train is not 3km wide
  let text;
  if (!onLine) text = Math.round(best.off) + ' km off the line, nearest ' +
    ST[best.t < 0.5 ? a : b].n;
  else if (best.t < 0.05) text = 'at ' + ST[a].n;
  else if (best.t > 0.95) text = 'at ' + ST[b].n;
  else text = 'between ' + ST[a].n + ' and ' + ST[b].n;
  return { after: a, before: b, km: Math.round(km * 10) / 10,
    offKm: Math.round(best.off * 10) / 10, onLine, text };
}

/** Which way she is travelling, from where she has been. +1 up-line, -1 down. */
export function headingOf(trail) {
  const pts = (trail || []).filter(p => p && isFinite(p.km));
  if (pts.length < 2) return 0;
  const d = pts[pts.length - 1].km - pts[0].km;
  return Math.abs(d) < 0.4 ? 0 : (d > 0 ? 1 : -1);  // standing still says nothing
}

/**
 * The next station she will reach, and when. This is the whole reason live
 * location is worth anything to the RPF: not a dot on a map, but somewhere to
 * be standing before the train gets there.
 */
export function nextStopOf(place, dir, train, minute) {
  if (!place || !dir) return null;
  const t = TRAINS.find(x => x.no === String(train));
  const pick = list => dir > 0
    ? list.filter(i => i >= place.before).sort((x, y) => x - y)
    : list.filter(i => i <= place.after).sort((x, y) => y - x);
  const all = ST.map((_, i) => i);
  let j = t ? pick(stopIdxs(t))[0] : undefined;
  // The ticket says one train; the phone says she is somewhere that train does
  // not go, or is going the other way. Both can be true - she may have moved -
  // and the RPF still needs a platform, so fall back to the line itself and
  // say plainly that the two do not agree.
  const offRoute = !!(t && j == null);
  if (j == null) j = pick(all)[0];
  if (j == null) return null;
  let at = null, inMin = null;
  if (t && !offRoute) {
    const m = sMin(t, j, 'a') ?? sMin(t, j, 'd');
    if (m != null) {
      at = hhmm(((m % 1440) + 1440) % 1440);
      inMin = Math.round(((m % 1440) + 1440) % 1440) - minute;
      if (inMin < -720) inMin += 1440;
    }
  }
  return { idx: j, station: ST[j].n, code: ST[j].c, pf: ST[j].pf, at, inMin, offRoute };
}

/** Where a train is on its run at a given minute, in plain words. */
export function whereIs(train, minute) {
  const t = TRAINS.find(x => x.no === String(train));
  if (!t) return null;
  const idxs = stopIdxs(t);
  let last = null, next = null;
  for (const i of idxs) {
    const a = sMin(t, i, 'a') ?? sMin(t, i, 'd');
    if (a == null) continue;
    const m = ((a % 1440) + 1440) % 1440;
    if (m <= minute) last = i; else { next = i; break; }
  }
  if (last == null) return { after: null, before: idxs[0], text: 'before ' + ST[idxs[0]].n };
  if (next == null) return { after: last, before: null, text: 'after ' + ST[last].n };
  return { after: last, before: next, text: 'between ' + ST[last].n + ' and ' + ST[next].n };
}

/**
 * What gets attached to the moment. Everything here khaali already knew
 * because she booked the journey; she types none of it, which matters when
 * her hands are shaking.
 */
export function stampOf(j, now = Date.now()) {
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  const t = TRAINS.find(x => x.no === String(j.train));
  return {
    train: t ? t.no : null,
    trainName: t ? t.name : null,
    date: j.date || null,
    cls: j.cls || null,
    coach: j.coach || null,
    berth: j.berth || null,
    pnr: j.pnr || null,
    from: j.from == null ? null : j.from,
    to: j.to == null ? null : j.to,
    at: now,
    clock: hhmm(minute),
    where: t ? whereIs(t.no, minute) : null,
    // where the phone says she is, which needs no ticket at all
    place: j.fix ? placeOf(j.fix.lat, j.fix.lng) : null,
    fix: j.fix || null,
    // whether khaali could confirm this journey is really hers, or is only
    // repeating what the phone claimed. An unverified stamp is still worth
    // having; pretending it was checked would not be.
    verified: !!j.verified,
  };
}

/** Disbelieve the request, then make the alert. Nothing here takes media. */
export function newAlert({ id, who, kind, journey }, now = Date.now()) {
  if (!KINDS.includes(kind)) return { ok: false, reason: 'bad-kind' };
  const j = journey || {};
  if (j.train != null) {
    const t = TRAINS.find(x => x.no === String(j.train));
    if (!t) return { ok: false, reason: 'unknown-train' };
    if (j.from != null && j.to != null && !serves(t, +j.from, +j.to))
      return { ok: false, reason: 'not-served' };
  }
  return { ok: true, alert: {
    id, who, kind, status: 'held', createdAt: now,
    stamp: stampOf(j, now),
    // where she has been since the moment she pressed it. Cheap to keep, and
    // it is what says which way the train is going.
    trail: j.fix ? [{ ...j.fix, at: now, km: (placeOf(j.fix.lat, j.fix.lng) || {}).km }] : [],
    // the footage lives on her device and is named here only so she can find
    // it again. khaali receives it only if she files it with the RPF.
    media: kind === 'mark' ? null : { onDevice: true, ref: id, onServer: false },
  } };
}

/**
 * She decided to hand it on. khaali prepares the report and gives her a
 * reference; the footage still never leaves her phone, and khaali does not
 * claim anybody has been dispatched.
 */
export function handOver(a, channel, now = Date.now()) {
  if (!a) return { ok: false, reason: 'missing' };
  if (a.status === 'deleted') return { ok: false, reason: 'deleted' };
  if (!CHANNELS.includes(channel)) return { ok: false, reason: 'bad-channel' };
  a.status = 'sent';
  a.channel = channel;
  a.sentAt = now;
  a.ref = 'KH-' + String(a.stamp.train || '0000') + '-' + String(now).slice(-6);
  return { ok: true, ref: a.ref, channel };
}

/**
 * A new fix from her phone. The trail is capped: this is a record of a journey,
 * not a life.
 */
export function moved(a, fix, now = Date.now()) {
  if (!a || a.status === 'deleted') return { ok: false, reason: 'gone' };
  if (!fix || !isFinite(fix.lat) || !isFinite(fix.lng)) return { ok: false, reason: 'bad-fix' };
  const p = placeOf(fix.lat, fix.lng);
  const point = { lat: fix.lat, lng: fix.lng, acc: fix.acc || null, at: now, km: p ? p.km : null };
  a.trail = (a.trail || []).concat([point]).slice(-180);
  a.fix = point;
  if (a.stamp) { a.stamp.fix = point; a.stamp.place = p; }
  return { ok: true, place: p };
}

/** Deleted means deleted: the stamp, the footage, and everywhere she has been. */
export function remove(a, now = Date.now()) {
  if (!a) return { ok: false, reason: 'missing' };
  a.status = 'deleted';
  a.deletedAt = now;
  a.stamp = null;
  a.media = null;
  a.trail = [];
  a.fix = null;
  a.contact = null;
  return { ok: true };
}

/**
 * What the RPF is handed. A stamp with a name and a number attached is a person
 * they can meet; a stamp on its own is only a report. khaali gives them the
 * first when it honestly knows who she is, and says so plainly when it does not.
 */
export function forRpf(a, now = Date.now()) {
  if (!a || a.status === 'deleted' || !a.stamp) return null;
  const s = a.stamp;
  const dir = headingOf(a.trail);
  const minute = (() => { const d = new Date(now); return d.getHours() * 60 + d.getMinutes(); })();
  const next = nextStopOf(s.place, dir, s.train, minute);
  const last = a.fix || null;
  return {
    ref: a.ref || null,
    at: a.createdAt,
    kind: a.kind,
    hasMedia: !!a.media,
    // whether the officer can actually watch it, or only knows it exists
    evidence: (a.media && a.media.onServer)
      ? { type: a.media.type || '', bytes: a.media.bytes || 0 } : null,
    line: lineOf(a),
    train: s.train, trainName: s.trainName, coach: s.coach, berth: s.berth,
    pnr: s.pnr, date: s.date, verified: !!s.verified,
    // Where she is, in stations rather than in numbers. The console needs
    // "between Ramanagara and Channapatna" to put someone on a platform; it has
    // never needed her coordinates, so they are not handed out.
    place: s.place || null,
    // how old that is, so nobody stands on a platform trusting a position that
    // stopped moving twenty minutes ago
    fixAgeSec: last ? Math.max(0, Math.round((now - last.at) / 1000)) : null,
    heading: dir,
    next,
    contact: a.contact || null,
  };
}

/** What the app is allowed to see. A deleted alert has nothing left to show. */
export function publicOf(a) {
  if (!a) return null;
  if (a.status === 'deleted')
    return { id: a.id, status: 'deleted', createdAt: a.createdAt, kind: a.kind };
  return {
    id: a.id, kind: a.kind, status: a.status, createdAt: a.createdAt,
    stamp: a.stamp, hasMedia: !!a.media,
    filed: !!(a.media && a.media.onServer),
    fix: a.fix || null, trailN: (a.trail || []).length,
    contact: a.contact || null,
    channel: a.channel || null, ref: a.ref || null, sentAt: a.sentAt || null,
  };
}

/** One line a person can read out, or hand to somebody, or read in court. */
export function lineOf(a) {
  if (!a || !a.stamp) return '';
  const s = a.stamp;
  // read out loud, handed to a constable, or read back in court - so the date
  // is written the way a person says it, not the way a database stores it
  let day = s.date;
  try {
    if (day) day = new Date(day + 'T00:00:00').toLocaleDateString('en-GB',
      { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch { /* keep the iso string */ }
  return [
    s.train ? (s.train + (s.trainName ? ' ' + s.trainName : ''))
      : (s.place ? null : 'No train attached'),
    day,
    s.coach && s.berth ? (s.coach + '/' + s.berth) : s.cls,
    s.clock,
    // what the phone reports beats what the timetable predicts, because one of
    // them is a measurement
    s.place ? s.place.text : (s.where ? s.where.text : null),
    s.pnr ? ('PNR ' + s.pnr) : null,
  ].filter(Boolean).join(' · ') || 'A moment with nothing attached';
}
