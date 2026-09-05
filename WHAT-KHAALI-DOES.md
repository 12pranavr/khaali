# khaali — what it does, from start to end

khaali is a working prototype of a rail booking system that treats a train the way
the train actually works: as a sequence of stretches, each with its own empty and
occupied berths — and then keeps going, planning the bus, the metro, the walk and
the last mile around that train, until the answer is a whole journey rather than a
ticket. It runs live at **khaali-production.up.railway.app**.

One rule governs everything below: **khaali never claims to know something it does
not.** Every number on every screen says what it is — counted, estimated, predicted,
or simulated — and the prototype's own About page grades its data honestly. That
grading, in short:

| Data | Status |
|---|---|
| Station names, codes, arrival/departure times | **Real** — data.gov.in timetable extract |
| Distances along the route | **Derived** from the real rows |
| BMTC bus network (9,875 stops, 4,358 routes, run times) | **Real** — BMTC GTFS (via Vonter, ODbL) |
| Namma Metro Purple Line (23 stations) and hourly station entries | **Real** — BMRCL data released under RTI |
| Coaches, berth layouts, who is booked where, fares, PNRs | **Invented** — booking data is not public |
| Bus passenger demand, road delay timing, conductor events | **Simulated**, and labelled so wherever they appear |

Nothing here is official. No approval, no endorsement, no connection to Indian
Railways or IRCTC.

---

## 1. Booking a train

**The corridor.** khaali sells berths on the Bangarpet ⇄ Mysuru corridor through
KSR Bengaluru — 14 stations, 208 km — and knows the full real timetable around it.

**The core idea: berths are counted per stretch, not per train.** A berth booked
Bangarpet → Bengaluru sits empty for the rest of the run to Mysuru. Every berth in
khaali's inventory is a bitmask over the corridor's thirteen legs, so "is there
room?" is always asked about *your two stations*, never about the train as a whole.
The seat-availability page, the calendar, the planner and the booking flow all read
the same count — one world, one number.

**Searching.** The header bar finds trains, stations, cities and quotas instantly,
client-side. The results page lists every train serving your pair with per-stretch
counts: *free* (empty your whole way), *partial* (empty for part of it), *taken*,
and *locked* (held by someone at the payment screen right now).

**Picking a berth.** The berth picker draws every coach and bay. You can take "any
berth" (khaali assigns at charting) or pin specific berths — with lower berths
reserved first for declared needs (senior, disabled, expecting), provable via the
mock document-locker flow rather than self-declared. A **hold locks berths for five
minutes** while you pay; holds are real inventory locks, visible to every other
shopper as *locked*, and they expire on their own.

**Paying.** The wallet is a simulated balance in your browser (nothing real moves),
but it models money honestly: block → authorise → capture or release, with a ₹0
ledger line written even when nothing was taken, so "nothing happened" is visible.

**The ticket.** A booking gets a PNR (a mock string — no reservation exists), a QR,
and appears under My bookings. Four hours before departure the **chart prepares**:
"any berth" passengers are packed into physical berths, lower-berth needs are
honoured first, and after charting no more assignment-time promises are made —
picking is just picking.

**The calendar** shows availability heat for up to 62 days, computed by literally
re-asking the inventory for every date — not a model.

## 2. When there is no whole berth

- **Seat hop.** If no berth is empty your whole way but partial berths exist,
  khaali stitches one journey out of two berths — each empty for part of your
  route — priced only for the stretch each one gives you. You get a guaranteed
  seat the entire way, plus a berth change mid-journey that the ticket says out
  loud. (The About page admits the real-world catch: that handover needs a rule
  the railways don't have yet.)
- **Waitlist odds.** A deterministic, published model — never a fake "AI
  prediction" — estimates your chance of confirmation and of at-least-boarding
  (RAC), from waitlist type (GNWL/RLWL/TQWL by boarding geometry), days to
  departure, festival and weekend demand, and cancelled parallel trains. Every
  verdict comes with its named reasons; a language model may word the sentence
  but never touches the number.
- **The order book.** A limit order for a berth: name your stations, window,
  classes, party and the most you'll pay; khaali books the first whole berth
  that appears, capturing only the actual fare. Pinning a train turns it into a
  waitlist, optionally with a one-shot fallback (other classes, a wider window,
  a rupee headroom) that fires only if the waitlist definitively fails.
- **Fair Tatkal.** Instead of a 10 am race that bot farms win, entry is a window
  and a draw. Entering blocks ₹175 but debits nothing unless you win; one entry
  per identity per round, four wins a month. Every entrant — you, and a seeded
  simulated population of bot farms and humans — is scored on six published
  behavioural signals measured server-side, farms lose draw weight (never below
  one), and a seeded shuffle draws the 40 berths. Losers pay nothing.

## 3. Planning a whole journey — any point to any point

The planner takes **any origin and any destination** — a railway station, a metro
station, or any pin on the map in Bengaluru — in all nine combinations, both
directions, and answers with complete journeys: train, metro, BMTC bus, walking,
and (only if you ask) a hired ride. Each answer is a chain of legs with one clock:
the walk nobody mentions is in the arithmetic.

**Ranking is a stated policy, not vibes.** Profiles — balanced, fastest, cheapest,
comfortable, network-smart — weigh time, fare, changes, walking, seating and
crowding with written-down weights. A deadline is enforced honestly: "reach
Majestic before 8 pm" excludes journeys that arrive after 8 pm, and when *nothing*
can make your hour, khaali says so and offers the soonest arrival rather than
dressing a miss up as a win. A refusal is always a named refusal ("no bus runs
there", "same stop twice") — never an empty page that claims success.

**Every journey card explains its own recommendation.** Each card carries:

- big departure and arrival times, duration, changes, fare per person, and a
  proportional strip of its legs;
- one sentence naming the choice — *"Stay on BMTC KIA-6 instead of taking BMTC
  G-9 then SBC-BWT EXP"* — computed against a real alternative from the same
  search, never copied from a global panel;
- **trade-off pills, costs included**: `25 min faster` · `₹62 cheaper` ·
  `2 fewer transfers` — but equally `6 min slower` · `Berth free` · `Avoids the
  busiest train`. khaali does not pretend it always saves time;
- a role label on alternatives (LOWER FARE, FEWER TRANSFERS, ARRIVES EARLIER,
  CALMER RIDE, BETTER SEAT ODDS) with a "choose this if…" sentence — only when
  the card's own numbers support it; a card worse on every axis wears no label;
- an evidence block naming one source per mode actually ridden, and a bus-load
  bar labelled *simulated* or *predicted* by what the number actually is.

**Comparisons only compare like with like.** A train's percentage is booked berth
inventory; a bus's is projected onboard load; the metro's is hourly entries at a
station. Across different bases khaali describes both sides and issues no
"less crowded" verdict. Seat claims are mode-honest too: only a train may say
*berth* (khaali allocates those); a bus gets *better seat odds* at most, and
nothing at all when khaali's own forecast says the bus is nearly full. **No bus
seat is ever promised.**

**The trip pass.** One pass covers the bus and metro legs of one specific journey
(the train is on the ticket). It lives 24 hours from purchase, is captured once on
first scan — half a journey is not half a price — and the scan never gates the
door: if validation fails, she still gets on the bus.

**The last mile.** When a walk is too far and no bus runs, khaali prices "Private
transport" — one category, never a named vehicle, because naming one is a promise
about what will turn up. Distance is measured server-side; over 50 km it refuses.

**The split.** The headline mechanism: when *no train can sell your whole span*,
but berths open up partway (commuters leave at Whitefield), khaali replaces the
journey's prefix with a specific bus departure — checked for boarding room, span
load, and a feasible transfer window — and rejoins **the same train** where room
begins. The card says exactly what this is: a feasible journey where there was
none, never a time saving over a train you couldn't take, and always with
*"booking this does not free the early stretch for anyone else; it only avoids
using it."*

## 4. Saarthi — ask in any Indian language

Saarthi is the assistant: type or speak, in 22 Indian languages (voice via
Sarvam). It turns sentences into actions — plan a journey, search trains, check
cancellations, read your bookings, waitlist odds — and answers with real numbers
from the planner, never from the model's imagination.

- It reads how people actually talk: *"I want to reach Majestic before 8 pm.
  I am from Hebbal"* (origin last, in its own sentence), *"I stay near
  Devanahalli"*, *"tomorrow morning"*, and multi-hop chains — *"Majestic to
  Nagasandra, and Nagasandra to Kodigehalli"* — planned hop by hop with the
  clock carried forward.
- **It works with no AI model at all.** A deterministic reader parses journey
  sentences directly, so a spent API quota degrades the poetry, not the product.
- Follow-ups change the question, not the subject: *"I want comfort instead of
  this"* re-ranks the same journey, compares the new answer against what you
  were shown before, and lists the other options with what each costs.
- Every recommendation names what it beat: *"Stay on BMTC 285-JB instead of
  Purple Line then BMTC KIA-14 — 20 min faster, ₹76 cheaper, 1 fewer transfer."*
- "Show me →" opens the planner with the search already run.

## 5. Along the way

- **Track / live.** Positions are derived from the timetable with fixed demo
  delays — no vehicle reports its location, and every screen says so. The bus
  version answers "where the bus is *scheduled* to be, not where it is."
- **SOS.** Pressing it records a stamp — train, coach, berth, the corridor
  position, verified against the booking — and **keeps all media on the phone**.
  Nothing uploads unless she explicitly files with the RPF; khaali never claims
  anyone has been dispatched. Deletion actually deletes.
- **The document locker.** A mock (explicitly *not* DigiLocker) showing the right
  shape: khaali asks for the *answer*, not the document — "is this person over
  60?" — and the Aadhaar, PAN and certificates never leave the locker.

## 6. The other side of the network

The passenger app is half of khaali; the other half shows why the network behaves
as it does.

- **The city, coloured** (`/network`): road speed in ~2 km cells from 196,000
  timed BMTC segments (*where* it's slow is measured; *when* is a declared,
  simulated hourly curve — and cells without enough samples draw grey, so
  silence reads as silence), beside metro entries and counted rail-berth load.
- **Where people are waiting** (`/drive`): last-mile demand aggregated with a
  privacy floor of three — below three people, a hotspot is not published at
  all, because two people at a stop is not a statistic. Drivers see hotspots and
  standing ride offers; a driver's "I'll be near X" commits nobody, and their
  positions are rounded, never journalled, deleted when the half-hour ends.
- **The conductor** (`/conduct`): a simulated bus conductor issuing tickets and
  boarding counts into a journal — the demand evidence the planner uses, with a
  strict accounting model (a claim and a boarding are never the same passenger
  twice; a correction is a checkpoint, not an adjustment).
- **The scenario controls** (`/scenario`): deterministic knobs — road delay,
  demand surges, cancellations, walking time — that genuinely change the
  planner's answer, reproducibly (same seed, same city). Remove the simulated
  jam and the direct bus wins again; surge demand and the chosen departure moves
  later, naming the bus that filled. A demo lever can even sell out a train's
  prefix using ordinary five-minute holds — honestly counted, fully reversible —
  to show the split fire on live inventory.

## 7. The honesty rules, everywhere

Every capacity figure carries its quality on a fixed ladder — **exact** (khaali's
own berth inventory), **counted** (its own ticket scans, reported as a floor,
never an occupancy), **estimated**, **predicted**, **simulated**, **unknown** —
and unknown is never rendered as zero, or as full. Standing prohibitions, enforced
by tests: never promise a seat on a bus; never claim khaali observed a crowd;
never compare station entries with onboard load; never state a fare or time the
planner didn't compute; never say help was dispatched; never invent a starting
point for a traveller who didn't name one.

## 8. Under the hood

- **One server** (Node, no frameworks): timetable, inventory, planner, allocator,
  Saarthi, simulation — ~40 modules, journal-backed state replayed at boot.
- **One client**: a single HTML file with a small reactive runtime — the whole
  app, responsive from a 320 px phone to desktop.
- **534 automated tests**, gated on exit code, covering the counting model, the
  planner's nine endpoint shapes, deadline honesty, the split's accounting, the
  comparability rules, and the sentences khaali is — and is not — allowed to say.
- **Deployed on Railway**, auto-deploying from `main`; the demo clock can shift
  and accelerate time so charting, expiry and departures can be watched happening.

## What khaali deliberately does not claim

- It does not add capacity — the same berths leave the platform; it shares the
  ones already leaving empty.
- The seat-hop handover and the extend-your-journey conflict need rules only the
  railways can set.
- Everything runs on invented bookings; the idea works for real only if the
  reservation system exposes stretch-level occupancy.
- Simulated demand and traffic stay labelled simulated until an operator is
  actually connected.
