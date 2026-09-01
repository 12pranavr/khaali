// What a caller did before they entered the Tatkal window, as the server saw
// it. Sentinel's behavioural signals used to come from the browser's own
// report of itself, which meant a script could claim to have browsed for ten
// minutes with human-looking pauses. Now the server keeps a short log per
// caller of the requests that mean "a person is looking at trains", and the
// signals are read off that log at the moment of entry. Nothing here is
// asked; all of it was observed.
//
// Keyed by caller address rather than identity on purpose: most looking
// happens before sign-in, and the point is to see the looking.

const WINDOW_MS = 30 * 60 * 1000;         // half an hour of memory per caller
const CAP = 60;                            // entries kept per caller

const log = new Map();                     // caller -> [{ p, at }]
const seen = new Map();                    // caller -> Map(email -> lastAt)

/** The requests that mean somebody is actually looking, not polling. */
export const INTENT = new Set([
  'page', '/api/search', '/api/availability', '/api/counts', '/api/calendar',
  '/api/odds', '/api/odds2', '/api/chat', '/api/live', '/api/stt', '/api/tts',
]);

/** Also logged, for rhythm only: a farm's two hundred entry attempts are its
    cadence, but they are not evidence that anyone was looking at trains. */
export const RHYTHM = new Set(['/api/tatkal/paysession', '/api/hold']);

function prune(list, now) {
  const from = now - WINDOW_MS;
  let i = 0;
  while (i < list.length && list[i].at < from) i++;
  if (i) list.splice(0, i);
  if (list.length > CAP) list.splice(0, list.length - CAP);
}

/** Record one intent request from a caller. Anything else is ignored. */
export function note(caller, path, now = Date.now()) {
  if (!caller || !(INTENT.has(path) || RHYTHM.has(path))) return;
  let list = log.get(caller);
  if (!list) { list = []; log.set(caller, list); }
  list.push({ p: path, at: now });
  prune(list, now);
}

/** A verified identity was seen behind this caller. */
export function identity(caller, email, now = Date.now()) {
  if (!caller || !email) return;
  let m = seen.get(caller);
  if (!m) { m = new Map(); seen.set(caller, m); }
  m.set(email, now);
}

/**
 * The behavioural signals for a caller at this instant: how many intent
 * requests preceded it and the gaps between them, in the order they happened.
 */
export function signalsFor(caller, now = Date.now()) {
  const list = log.get(caller) || [];
  prune(list, now);
  // actions: only the looking. gaps: everything, because the rhythm of a
  // caller's requests is the signal whatever those requests were for.
  const actions = list.reduce((n, e) => n + (INTENT.has(e.p) ? 1 : 0), 0);
  const gaps = [];
  for (let i = 1; i < list.length; i++) gaps.push(list[i].at - list[i - 1].at);
  return { actions, gaps: gaps.slice(-12) };
}

/** Distinct verified identities seen behind this caller in the window. */
export function accountsFor(caller, now = Date.now()) {
  const m = seen.get(caller);
  if (!m) return 0;
  const from = now - WINDOW_MS;
  let n = 0;
  for (const [email, at] of m) { if (at < from) m.delete(email); else n++; }
  return n;
}

/** Test helper. */
export function reset() { log.clear(); seen.clear(); }
