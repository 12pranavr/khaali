// ---------------------------------------------------------------------------
// Six places in Bengaluru, so the demand map is not blank on the first open.
//
// Run:  node seed-demand.mjs        (writes seed-demand.json)
//
// What this does NOT do is invent a hotspot. There is no list of counts here.
// Each place is resolved through khaali's own BMTC data - refused outright if
// khaali cannot find it - and then, for each of a handful of destinations a
// short way out of it, the SAME question the planner asks is asked again:
// does a bus run from here to there? The answer decides which side of the
// count that declaration falls on, exactly as it does for a real passenger.
//
// So the seeds are real statements about the real network. What is synthetic
// is only that nobody actually booked them, and every row says `seed: true`
// all the way to the driver's screen because of it.
//
// Delete seed-demand.json and the map goes empty. That is correct, and it
// is what proves the map is made of demand rather than of a hardcoded list.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as bmtc from './bmtc.mjs';
import * as demand from './demand.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// Places people already meet at - a station, a bus stand, an interchange. Never
// somebody's street. The offsets are the direction the housing actually runs in
// from each one, a couple of kilometres out, where the buses thin.
const PLACES = [
  { q: 'Whitefield',              spread: [[0.022, 0.016], [0.030, -0.010], [-0.018, 0.026]] },
  { q: 'Electronic City',         spread: [[0.026, 0.012], [-0.020, 0.022], [0.014, -0.028]] },
  { q: 'Marathahalli',            spread: [[0.018, 0.024], [0.028, -0.008], [-0.024, 0.014]] },
  { q: 'Yelahanka',               spread: [[0.024, 0.018], [-0.016, 0.026], [0.030, -0.012]] },
  { q: 'Kengeri',                 spread: [[-0.026, -0.016], [0.020, -0.024], [0.014, 0.028]] },
  { q: 'Hebbal',                  spread: [[0.020, 0.020], [-0.022, 0.018], [0.026, -0.014]] },
];

// Every half hour of the day, at the height a Bengaluru commute actually runs
// at: a morning peak around nine, an evening one around seven, a thin middle
// and almost nothing after midnight. Seeding only the two peaks left the map
// blank at three in the afternoon, which is not what the network looks like -
// people arrive at Whitefield all day, there are just fewer of them.
const SHAPE = (w) => {
  const h = w / 60;
  const peak = (c, s) => Math.exp(-((h - c) ** 2) / (2 * s * s));
  // The small hours are thin but they are not empty, and they are the worst
  // last mile there is: the 1 a.m. arrival is exactly the person with no bus.
  return 0.9 * peak(9, 1.1) + 0.8 * peak(19, 1.3) + 0.28 * peak(14, 3.2) + 0.12;
};
const WHEN = [];
for (let w = 0; w < 24 * 60; w += 30) WHEN.push(w);

const out = [];
let refused = 0;

for (const place of PLACES) {
  const stop = bmtc.stopNamed(place.q) || (bmtc.searchStops(place.q, 1) || [])[0];
  if (!stop || stop.lat == null) {
    console.log('refused: khaali cannot resolve ' + place.q + ' - not seeding a place it does not know');
    refused++; continue;
  }
  const at = stop.name || place.q;
  let n = 0;
  for (const when of WHEN) {
    // the height of the curve at this half hour, scaled by how busy the place
    // is, jittered so no window is a round number somebody chose. A window the
    // curve puts under the privacy floor is simply not seeded.
    const busy = 9 + (at.length % 5) * 3;
    const many = Math.round(SHAPE(when) * busy) + ((when + at.length) % 3) - 1;
    if (many < 1) continue;
    for (let i = 0; i < many; i++) {
      const [dLat, dLng] = place.spread[i % place.spread.length];
      const toLat = stop.lat + dLat * (0.8 + (i % 3) * 0.2);
      const toLng = stop.lng + dLng * (0.8 + (i % 3) * 0.2);
      // the real question, asked of the real timetable
      const need = demand.needFor({ lat: stop.lat, lng: stop.lng, toLat, toLng, when }, bmtc.directBus);
      const d = demand.declare({
        id: 'seed-' + out.length.toString(36).padStart(4, '0'),
        who: 'seed-' + place.q.toLowerCase().replace(/\W+/g, '') + '-' + i,
        at, lat: stop.lat, lng: stop.lng, when,
        km: Math.round(bmtc.km({ lat: stop.lat, lng: stop.lng }, { lat: toLat, lng: toLng }) * 10) / 10,
        pax: 1, need, seed: true,
      });
      if (!d.ok) continue;
      out.push(d.record); n++;
    }
  }
  const noBus = out.filter(r => r.at === at && r.need === 'no-bus').length;
  console.log(at + ': ' + n + ' declarations, ' + noBus + ' of them with no bus at all');
}

fs.writeFileSync(path.join(DIR, 'seed-demand.json'), JSON.stringify(out));
console.log('\nwrote ' + out.length + ' seeded declarations' + (refused ? ' (' + refused + ' places refused)' : ''));
