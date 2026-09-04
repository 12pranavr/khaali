# khaali — how it is put together

khaali is a multimodal public-transport journey planner, passenger allocator
and network-utilisation tool for Bengaluru, built on the rail booking product
it started as. The rule that shapes everything below:

> The backend owns reality. A language model may interpret and explain. The
> UI is never the source of truth. Routing is not allocation. Booking is not
> routing.

One Node process, no framework, no database server. The modules below are
logical boundaries, not services - they can be split later without a rewrite
because nothing reaches across them except through their exported functions.

## The layers

```
                         USER
                          │
                          ▼
              Rail Booking Flow.dc.html   (one file; Trains, Plan, Map, SOS…)
                          │
                          ▼
                     server.mjs           (routes, auth, journal, rate limits)
                          │
          ┌───────────────┼────────────────────┐
          │               │                    │
          ▼               ▼                    ▼
   intel.resolvePlace  journey.journeys     intel.*           ← OpenAI / Sarvam
   (places, aliases)   ROUTING ENGINE       (intent, explain, ask)
                          │                    │
                          ▼                    │
                  CANDIDATE JOURNEYS           │
                          │                    │
                          ▼                    │
                 capacity.annotate             │
             (exact / estimated / predicted /  │
              unknown, per leg)                │
                          │                    │
                          ▼                    │
                 allocate.allocate             │
              ALLOCATION ENGINE                │
          (passenger cost + network cost,      │
           hard limits, reasons as codes)      │
                          │                    │
                          └──── JOURNEY RESULT ◄┘
                                   │
                      ┌────────────┼─────────────┐
                      ▼            ▼             ▼
                  ROUTE MAP    JOURNEY CARDS   BOOK (class modal → store)
```

The map and the cards read the same `Journey` object. Nothing is computed
twice.

## Data

```
Indian Railways timetable ─┐
BMRCL GTFS (Vonter) ───────┤
BMRCL ridership RTI ───────┼──►  data.mjs / metro.mjs / buses.mjs / geo.mjs
BMTC GTFS (Vonter) ────────┤     (static: stations, stops, routes, run times,
KSRTC — none published ────┘      headways, fares, hourly crowd; every record
      (one leg SIMULATED, labelled)  says its source)
                          │
                          ▼
             journey.mjs  (train / metro / bus chains, transfers, walks)
                          │
   store.mjs ────────────►│  live berth inventory for the train legs
   (booked / held / free) │
                          ▼
             capacity.mjs (snapshot per leg, with quality)
                          │
                          ▼
             allocate.mjs (rank, recommend, explain in codes)
                          │
                          ▼
             sim.mjs      (baseline vs allocated, N passengers)
```

Static data is never mutated to represent live state. Live state (berths,
delays, the demo clock) is read at request time and attached to the journey.

## The language model

```
User sentence
     │
     ▼
intel.parseLocally      khaali's own grammar: places, "by nine", "only trains",
     │                  "no bus", "one change", "grandmother"
     ▼
OpenAI (json mode)      may FILL what the grammar left empty
     │                  may NOT override a time or mode the grammar found
     ▼
intel.validateIntent    schema; a rocket is not a mode, nine changes is not
     │                  a constraint; unknown places are reported, not guessed
     ▼
JourneyRequest ──► journey.journeys ──► capacity ──► allocate
                                                        │
                                       reason: codes + verified numbers
                                                        │
                                                        ▼
                                   OpenAI  ──► one sentence, number-checked:
                                               a figure in none of the facts
                                               throws the sentence away
                                                        │
                                   Sarvam  ──► answers questions from the
                                               journey facts (same check)
```

Provider choice lives in one function in the server (`llmFor(job)`). With no
key the grammar, the template sentence and the template answers run instead.
The route result never waits for a model.

## Modules

| Module | Answers | Talks to |
|---|---|---|
| `data.mjs`, `metro.mjs`, `buses.mjs`, `geo.mjs` | what services exist | nothing |
| `engine.mjs`, `store.mjs` | berths, holds, fares, inventory | journal |
| `journey.mjs` | what journeys are physically possible | data modules |
| `capacity.mjs` | how full each leg is, and how well we know | store (via server) |
| `allocate.mjs` | which journey to prefer, and why | capacity |
| `intel.mjs` | what the person meant; the reason in words | allocate (sentence) |
| `sim.mjs` | what N people would do to the network | allocate, capacity |
| `sos.mjs`, `digilocker.mjs` | safety and identity | journal |
| `server.mjs` | routes, auth, limits, providers | all of the above |

## Routes for the planner

| Route | Does |
|---|---|
| `GET /api/plan` | fromKind, fromId, toKind, toId, after, by, date, modes, needs, profile, maxChanges, trace |
| `POST /api/intent` | `{text}` → validated request, resolved places, what was understood |
| `POST /api/explain` | `{reason}` → one sentence (model or template), cached |
| `POST /api/ask` | `{question, chain, reason, alternatives}` → answer from the facts |
| `GET /api/simulate` | n, start, end, profile → baseline vs allocated |
| `GET /api/metro`, `/api/geo` | the line and the coordinates the map draws from |
| `GET /api/place` | at=lat,lng → what that point is called and what khaali can plan through near it. Named from khaali's own data; no reverse geocoder |
| `POST /api/pass` | a day pass, or `kind:'trip'` + the journey's bus/metro legs. A trip pass is priced here from BMTC's coordinates and the published metro fare, and is spent after one ride on each mode it covers |

## Tests

`node khaali-live/test.mjs`. The allocator and the simulator are tested on a
network that does not exist (A-B-C-D, made-up capacities) before they are
trusted on one that does. The intelligence layer is tested with fake models
that lie, fail, and return junk; each must cost the product nothing.

## Not built yet, by design

Live replanning (the journey state machine is an enum away), partial
booking across operators, an external routing engine, ONDC, a database
server. None of these require changing a boundary above; that was the point
of drawing them.
