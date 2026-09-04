// ---------------------------------------------------------------------------
// Two days of drivers having said they would be somewhere, and what happened.
//
// Run:  node seed-commit.mjs        (writes seed-commit.json)
//
// khaali has no history of anything. It has never run, so nobody has ever said
// they would be at Whitefield at nine and then either been there or not. Which
// means the kept-rate - the number that turns "twelve said yes" into "khaali
// expects seven" - has nothing to count.
//
// So this makes the history, the same way seed-demand.mjs makes the map: not by
// writing a rate, but by writing the EVENTS a rate is counted from. Nothing in
// this file decides that 62% of drivers turn up. It places drivers, and
// reliability.mjs counts what became of them.
//
// WHAT IS REAL HERE AND WHAT IS NOT.
//
// Real: the places, resolved through khaali's own BMTC data and refused
// outright if khaali cannot find them. The distances - every outcome is decided
// by whether a driver's position was within commit.NEAR_KM of the stop, which
// is the same test the live code applies. The shape of the day, which follows
// the same commute curve the demand seed uses. And the arithmetic, which is
// reliability.mjs's, unmodified.
//
// Not real: that anybody said any of it. Every row carries seed:true and
// carries it all the way to the driver's screen, which says so.
//
// Because the outcome is geometry rather than a coin toss, the kept-rate comes
// out DIFFERENT AT EACH PLACE - a driver who commits to a stop with housing
// spread thinly around it is further away on average than one at a tight
// interchange. That difference is a fact about the map. It is not a number
// anybody chose, and it is why this is worth doing properly rather than
// writing six percentages into an array.
//
// Delete seed-commit.json and khaali says "not measured enough to say".

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as bmtc from './bmtc.mjs';
import * as commit from './commit.mjs';
import { windowOf } from './demand.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// The same six the demand map is seeded from, so the two sides describe the
// same city. Each carries the directions its drivers actually come in from -
// a driver waits where there is somewhere to wait, not on the platform.
// The offsets are small on purpose: a driver who says they will be around a
// stop waits at the stand, the junction, the tea shop across the road - a few
// hundred metres to a couple of kilometres, not five. commit.NEAR_KM is 1.5, so
// the nearest ring is always inside it, the middle ring straddles it, and the
// outer ring is mostly outside - which is what makes the kept-rate come out of
// the geometry rather than out of a number somebody picked.
const PLACES = [
  { q: 'Whitefield',      wait: [[0.004, 0.003], [0.007, -0.005], [0.013, 0.009]] },
  { q: 'Electronic City', wait: [[0.005, -0.002], [0.008, 0.006], [0.015, -0.008]] },
  { q: 'Marathahalli',    wait: [[0.003, 0.004], [0.006, -0.006], [0.011, 0.010]] },
  { q: 'Yelahanka',       wait: [[0.006, 0.004], [0.009, 0.007], [0.016, -0.007]] },
  { q: 'Kengeri',         wait: [[0.002, -0.003], [0.006, 0.005], [0.012, -0.011]] },
  { q: 'Hebbal',          wait: [[0.004, 0.005], [0.008, -0.004], [0.014, 0.008]] },
];

// How many drivers say yes to a half hour - the same commute curve the demand
// seed runs on, because drivers work when passengers travel.
const SHAPE = (w) => {
  const h = w / 60;
  const peak = (c, s) => Math.exp(-((h - c) ** 2) / (2 * s * s));
  return 0.9 * peak(9, 1.1) + 0.8 * peak(19, 1.3) + 0.28 * peak(14, 3.2) + 0.12;
};

const day = (back) => {
  const d = new Date(); d.setDate(d.getDate() - back);
  return d.toISOString().slice(0, 10);
};

const out = [];
let refused = 0;

for (const place of PLACES) {
  const stop = bmtc.stopNamed(place.q) || (bmtc.searchStops(place.q, 1) || [])[0];
  if (!stop || stop.lat == null) {
    console.log('refused: khaali cannot resolve ' + place.q + ' - not seeding a place it does not know');
    refused++; continue;
  }
  const at = stop.name || place.q;
  let kept = 0, missed = 0, withdrew = 0, lapsed = 0;

  for (const back of [1, 2]) {
    const date = day(back);
    for (let w = 0; w < 24 * 60; w += 30) {
      const window = windowOf(w);
      const many = Math.round(SHAPE(w) * 6) + ((w + at.length) % 3) - 1;
      for (let i = 0; i < many; i++) {
        const n = out.length;
        // Where this driver was waiting. The offsets are the directions
        // drivers actually come from; which one they took is deterministic in
        // the index, so re-running the script produces the same history.
        const [dLat, dLng] = place.wait[n % place.wait.length];
        const scale = 0.6 + ((n % 5) * 0.35);
        const lat = stop.lat + dLat * scale, lng = stop.lng + dLng * scale;

        // Some of them changed their mind before the window - that is an
        // ordinary thing to do and khaali counts it, because a commitment that
        // is withdrawn did not become supply either.
        const changedMind = (n % 11) === 0;
        // And some never let khaali look, which is free and is why `lapsed`
        // exists. Roughly a fifth, by index rather than by chance.
        const share = (n % 5) !== 0;

        const d = commit.declare({
          id: 'seed-c-' + n.toString(36).padStart(4, '0'),
          driver: 'seed-' + place.q.toLowerCase().replace(/\W+/g, '') + '-' + (n % 40),
          at, window, date, share, seed: true,
          lat, lng, hotLat: stop.lat, hotLng: stop.lng,
        }, Date.parse(date + 'T00:00:00+05:30') + window * 60000);
        if (!d.ok) continue;
        const c = d.record;

        if (changedMind) {
          commit.withdraw(c, c.saidAt + 600000);
          withdrew++;
        } else {
          // The outcome is the same test the live code applies: was this
          // driver's position within NEAR_KM of the stop. Nothing is drawn from
          // a hat; the geometry decides, and it decides differently per place.
          if (share) commit.here(c, { lat, lng }, c.saidAt + 900000);
          const outcome = c.wasNear ? 'kept' : share ? 'missed' : 'lapsed';
          commit.close(c, outcome, c.saidAt + 1800000);
          if (outcome === 'kept') kept++; else if (outcome === 'missed') missed++; else lapsed++;
        }
        out.push(commit.forget(c));
      }
    }
  }
  const of = kept + missed + withdrew;
  console.log(at + ': ' + kept + ' of ' + of + ' were there'
    + ' (' + Math.round(kept / of * 100) + '%)'
    + ', and ' + lapsed + ' khaali could not see');
}

fs.writeFileSync(path.join(DIR, 'seed-commit.json'), JSON.stringify(out));
console.log('\nwrote ' + out.length + ' closed commitments'
  + (refused ? ' (' + refused + ' places refused)' : ''));
