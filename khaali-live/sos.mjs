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
// Two consequences follow, and both are the point:
//   - khaali never holds a picture of anybody's face. There is nothing here
//     to leak, subpoena, or misuse.
//   - She can record nothing at all and still mark the moment. A stamp with
//     no footage is silent, invisible, and still says she was in S4/31 on the
//     16021 at 23:14 and something happened.
//
// Capturing is not reporting. An alert is HELD until she decides otherwise,
// and khaali hands it to the real channel only when she says so. khaali
// prepares a report. It does not send anyone to her coach, and it must never
// say that it has.

import { ST, TRAINS } from './data.mjs';
import { serves, sMin, hhmm, stopIdxs } from './engine.mjs';

export const KINDS = ['mark', 'photo', 'video'];
export const CHANNELS = ['rpf', 'trusted'];

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
    // the footage lives on her device and is named here only so she can find
    // it again; khaali never receives it
    media: kind === 'mark' ? null : { onDevice: true, ref: id },
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

/** Deleted means deleted: the stamp goes too, not just the footage. */
export function remove(a, now = Date.now()) {
  if (!a) return { ok: false, reason: 'missing' };
  a.status = 'deleted';
  a.deletedAt = now;
  a.stamp = null;
  a.media = null;
  return { ok: true };
}

/** What the app is allowed to see. A deleted alert has nothing left to show. */
export function publicOf(a) {
  if (!a) return null;
  if (a.status === 'deleted')
    return { id: a.id, status: 'deleted', createdAt: a.createdAt, kind: a.kind };
  return {
    id: a.id, kind: a.kind, status: a.status, createdAt: a.createdAt,
    stamp: a.stamp, hasMedia: !!a.media,
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
    s.train ? (s.train + (s.trainName ? ' ' + s.trainName : '')) : 'No train attached',
    day, s.coach && s.berth ? (s.coach + '/' + s.berth) : s.cls,
    s.clock, s.where ? s.where.text : null,
    s.pnr ? ('PNR ' + s.pnr) : null,
  ].filter(Boolean).join(' · ');
}
