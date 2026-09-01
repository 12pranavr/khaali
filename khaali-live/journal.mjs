// The journal: what happened, one line per event, appended as it happens and
// replayed at boot.
//
// Memory stays the authority. The compare-and-swap in store.hold() is real
// because there is no await between the check and the set, and putting a
// database inside it would break that. So the store keeps deciding in memory
// and this file just remembers: every confirmed booking, every Tatkal win,
// every deliberate reset. On boot the server seeds inventory exactly as it
// always has, then replays this on top, and the world is back.
//
// Pending holds are not written. They live five minutes; a restart releasing
// them is the correct outcome, not a loss.
//
// Where it lives: DATA_DIR if set, else khaali-live/data/. On Railway the
// filesystem is ephemeral, so without a volume the journal survives a restart
// but not a redeploy. Mount a volume, point DATA_DIR at it, and it survives
// everything.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let file = null;

/** Choose the file. Returns its path. Creates the folder if needed. */
export function open(dir = process.env.DATA_DIR || path.join(DIR, 'data')) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'khaali-journal.jsonl');
  return file;
}

/** One event, one line, written before append() returns. */
export function append(rec) {
  if (!file) return false;
  try { fs.appendFileSync(file, JSON.stringify({ ...rec, at: rec.at || Date.now() }) + '\n'); return true; }
  catch (e) { console.error('journal: append failed:', e.message); return false; }
}

/** Every record in order. A line that will not parse is skipped, not fatal. */
export function readAll() {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line after a crash */ }
  }
  return out;
}

export const where = () => file;
