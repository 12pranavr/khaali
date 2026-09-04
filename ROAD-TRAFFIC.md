# Road traffic — the plan

*Companion to [NETWORK-INTELLIGENCE.md](NETWORK-INTELLIGENCE.md), which does
this for the transit network. This is the same pipeline pointed at roads.*

---

## I was wrong to say a flat no

What I refused was inventing a number and presenting it as a fact. That refusal
was right. Extending it to "khaali cannot model traffic" was not, because khaali
already has a doctrine for exactly this and uses it everywhere:

| Quality | What it means | Already used for |
|---|---|---|
| `exact` | counted | berths for a stretch, from real inventory |
| `estimated` | arithmetic on a structural fact | a bus boarded at stop 3 of 37 |
| `predicted` | history | metro crowding, from BMRCL hourly ridership |
| `simulated` | declared, labelled, not measured | the KSRTC leg, seeded berth occupancy |
| `unknown` | we do not know — never zero | anything else |

A traffic model in the `estimated` or `simulated` band, labelled, is not a fake.
**What ships today is worse than a simulation:** `hire.mjs` says a car does
22 km/h and a bike 26, with no source, no label and no variation. Those two
numbers are the least honest thing in the feature, and this plan deletes them.

## What the data actually supports

I measured it before proposing anything. `bmtc.json` — already in the repo,
already loaded — carries 4,358 routes whose patterns give **196,354 timed
stop-to-stop segments**. Those are buses on real roads with real scheduled
times. Buses are traffic probes.

**Space: a real signal.** Binned onto a ~2 km grid, 518 cells have 20+ samples:

```
slowest cell   11.8 km/h        10th pct  15.6
city median    19.2 km/h        90th pct  22.7
fastest cell   31.9 km/h
```

A factor of 2.7 between the worst and best parts of Bengaluru, from the
operator's own timetable. **This is sourced and can ship as `estimated`.**

**Time: not in this data.** Bucketing patterns by hour gives only ±7 % around
the median (15.6 km/h at 09:00, 17.9 at 19:00) — and that is an artifact, not a
rush hour: `p.f` is a pattern's *first* departure, so an all-day route lands
entirely in one bucket. Real Bengaluru peak is far worse than 7 %.

So the honest split is:

- **Where** a road is slow → sourced, `estimated`, ships now.
- **When** a road is slow → **not derivable from what khaali has.** It is a
  declared, labelled, configurable curve — `simulated`, exactly like the KSRTC
  leg — until a live feed exists.

That distinction is the whole plan. Both are useful; they must not be confused
with each other, and neither may be labelled `measured`.

---

## The build

### 1. `road.mjs` — the speed field

Built once at boot from `bmtc.json`, the way `bmtc.mjs` already builds its stop
grid.

```js
export const GRID_KM = 2;                        // ~0.02° cells
export function speedAt(lat, lng)  → { kmh, samples, quality: 'estimated'|'unknown', source }
export function speedAlong(path)   → { kmh, cells, quality, source }   // distance-weighted
export const CITY_MEDIAN_KMH = 19.2;             // the fallback, and it says so
```

A cell with fewer than `MIN_SAMPLES` (20) returns `unknown` and falls back to
the city median — **not to a confident guess**. Unknown is carried, as it is in
`capacity.mjs`.

Cost: one pass over the patterns at boot, a Map of ~500 cells. No new
dependency, no new file to ship.

### 2. `traffic.mjs` — the hour, declared as simulated

```js
// Peak multipliers on the free-flow speed. NOT MEASURED. Bengaluru's morning
// and evening peaks, stated as an assumption so a reviewer can argue with the
// number instead of guessing at it.
export const CURVE = { 8: 0.62, 9: 0.58, 10: 0.72, ..., 18: 0.55, 19: 0.60 };
export const QUALITY = 'simulated';
export function factorAt(minute, { weekday = true }) → { factor, quality, source }
```

Configurable per the same rules as the utilisation bands: overridable by
corridor, by mode, by day type, by experiment. Nothing hardcoded at a call site.

### 3. The two combine, and carry their worst quality

```js
kmh = speedAlong(path).kmh × factorAt(minute).factor
quality = worst(spatial.quality, temporal.quality)     // simulated beats estimated
```

`hire.minutesFor(kind, km)` becomes
`hire.minutesFor(kind, km, { at, from, to })`, and the two bare constants go.
A car keeps a small edge over a bus on the same road (it does not stop), which
is a stated ratio, not a second invented speed.

### 4. Allocation — the main motive

This is the point, not the map. Road state feeds journey time, journey time
feeds `span()`, `span()` feeds the score. Concretely:

```
Bangarpet → a point 18 km past Whitefield, 09:00
  train + car   car leg 18 km @ 19.2 × 0.58 = 11 km/h → 98 min   ORANGE
  train + bus   ...                                     124 min   GREEN
→ the bus wins, because at nine in the morning the car is not faster
```

At 22:00 the same query flips to the car. **That is traffic allocation** — the
same query, a different answer, because the road changed. Today khaali gives the
identical answer at both hours, which is the bug.

It also feeds `sim.mjs`: ten thousand people routed onto one corridor should
degrade its speed, which is the road half of the network-balancing loop
`NETWORK-INTELLIGENCE.md` describes for vehicles.

### 5. The map — green / yellow / orange / red

Reuse `utilization.stateOf` from NETWORK-INTELLIGENCE.md rather than inventing a
second colour vocabulary. For roads the ratio is **speed against free-flow**,
not occupancy against capacity:

```
GREEN   ≥ 0.80 of free-flow      ORANGE  0.40–0.55
YELLOW  0.55–0.80                RED     < 0.40
```

Thresholds configurable per the same resolution order. Drawn as a translucent
overlay on the Leaflet map already there, with the cell's sample count and
quality in the tooltip — so a red road says *why* it is red and how well khaali
knows. **A cell below the sample floor draws grey, not green.**

### 6. Phone GPS — later, and under the rules already written

You mentioned deriving this from phone location. That is the `LocationObservation`
intake in NETWORK-INTELLIGENCE.md, pointed at roads instead of vehicles, and it
inherits every rule there without change: aggregate at the door, a k-anonymity
floor before any cell emits an app-derived speed, no trajectories, no identity in
the schema, short retention. A road segment may say "this is slow"; it may never
say "these people are slow."

Sequenced last on purpose: steps 1–5 need no consent flow and no personal data
at all, and they deliver most of the value.

---

## Order

1. `road.mjs` + tests. Nothing user-visible; the field exists and is queryable.
2. `hire.mjs` uses it. **The unsourced 22/26 km/h constants die here** — the
   single biggest honesty win, and it lands early.
3. `traffic.mjs`, labelled `simulated`, wired into the same call.
4. Allocator reads the new times. Journeys start changing with the hour.
5. Map overlay + the `stateOf` vocabulary.
6. GPS intake, behind consent.

## Tests

- The speed field is built from real data: 500+ cells, median within 1 km/h of
  19.2, slowest cell materially slower than the fastest.
- A cell under the sample floor returns `unknown`, and the caller falls back to
  the city median — never to a confident number.
- Quality composes to the **worst** of its inputs: spatial `estimated` +
  temporal `simulated` = `simulated`.
- The same journey at 09:00 and 22:00 gets different ride times, and the 09:00
  one is slower.
- A journey that a car wins at 22:00 is won by the bus at 09:00 — the
  allocation flip, which is the whole feature.
- Turning the temporal curve off leaves ride times equal to the spatial-only
  figure, so the simulated layer is separable and can be removed.
- A red cell never renders green when its sample count is below the floor.

## What this still will not do

- It will not call a `simulated` rush-hour curve a measurement. It is labelled
  wherever it is shown, like the KSRTC leg.
- It will not claim a live fare or a live road speed without a live feed.
- It will not put a person's location on a public map.
