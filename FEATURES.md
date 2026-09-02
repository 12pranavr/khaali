# khaali, end to end

A complete reference for what this thing is and how every part of it works.
Written against the code as it stands, not against the pitch.

---

## 1. The one idea

Indian Railways sells a berth as one indivisible thing for the whole train
run. Somebody books Bengaluru to Mysuru, and that berth is gone for everyone,
including the person who only wants Maddur to Mandya after they have already
got off.

khaali stores occupancy per segment instead of per berth. The corridor has 14
stations, so 13 legs between them. Every berth carries a 13 bit integer. Bit
`i` is set when somebody is sitting on that berth for leg `i`.

Your journey is also a mask. Availability is one bitwise AND:

```
occupancy & journey == 0          nobody is on it while you travel      "free"
occupancy & journey == journey    somebody is on it the whole way       "taken"
anything else                     free for part of your stretch         "part"
```

That single operation is the whole product. Everything below is built on it.

---

## 2. The data

### Stations

14 stations on the Bangarpet to Mysuru corridor, in `khaali-live/data.mjs`,
each with a code, a distance in km from Bangarpet, and a platform number.

```
0  Bangarpet BWT      0 km        7  Bidadi BID          100 km
1  Whitefield WFD    47 km        8  Ramanagara RMGM     115 km
2  K R Puram KJM     56 km        9  Channapatna CPT     126 km
3  Bengaluru East    63 km       10  Maddur MAD          144 km
4  Bengaluru Cantt   66 km       11  Mandya MYA          163 km
5  Bengaluru KSR     70 km       12  Pandavapura PANP    189 km
6  Kengeri KGI       82 km       13  Mysuru Jn MYS       208 km
```

The km figures matter because fares are computed from them, not looked up.

### Classes

| Key | Class | Coaches | Berths each | Total | Base | Rate/km |
|---|---|---|---|---|---|---|
| SL | Sleeper | 6 (S1 to S6) | 72 | 432 | 60 | 0.55 |
| 3A | AC 3 Tier | 3 (B1 to B3) | 64 | 192 | 190 | 2.10 |
| 2A | AC 2 Tier | 2 (A1, A2) | 48 | 96 | 310 | 3.00 |

720 berths per train across all three classes.

### Trains

128 trains total. Six are the flagship services with full stop timetables,
photos and colours, and they are the bookable ones:

```
16021 / 16022  Kaveri Express             both directions
22682 / 22681  Chennai to Mysuru Express   both directions
22817 / 22818  Howrah to Mysuru Superfast  both directions
```

The other 122 come from `extra-trains.mjs`, extracted from the public
data.gov.in train details CSV and clipped to these 14 stations. They run on
the live map and appear in searches, but they exist to make the corridor feel
populated rather than to be booked.

---

## 3. The engine

`khaali-live/engine.mjs`, 446 lines, pure functions and no state.

### Masks

- `packInto(fixed, items, layout)` seats a set of journeys into the space
  fixed bookings leave. With nothing fixed it is optimal: berths used equals
  the busiest leg, because interval graphs are perfect. With pinned berths it
  is a best-fit that prefers already-used berths, keeps a family in one coach,
  and never overcommits. It is the feasibility check on every hold and the
  seating at charting.
- `journeyMask(from, to)` sets the bits for the legs a journey occupies. It is
  direction independent, so a down train and an up train share one geometry.
- `spanMask(s, e)` is the same thing for an arbitrary stretch.
- `popcount(x)` counts set bits.

### Berth state

`berthState(occMask, from, to)` returns `free`, `taken`, or `part`. For a
partial berth it also works out **where it changes hands**, in the traveller's
direction of travel, and returns `{ at, mode }` where mode is `from` or
`until`. That is what produces the label "empty till Mandya" rather than a
bare "partly available".

### Pricing

```
fare(cls, km) = round((base + rate * km) / 5) * 5
```

Fares round to the nearest 5 rupees, the way real fare tables do.

A partial berth is charged only for the distance it actually gives you:

```
priceFor = fare(full journey) * coveredKm / journeyKm, rounded to 5, min 5
```

`coveredKm` walks the legs and sums only the ones the berth is free on. A
partial berth is therefore always cheaper than a full one, and the tests
assert exactly that.

### Seeded occupancy

`seedOccupancy(cls, trainNo, dayIdx, seed)` builds the starting world. It is
deterministic, so the same train, class and date always produce the same
coach. The recipe:

1. Shuffle berth order with a seeded RNG keyed on train number, class and day.
2. Compute a demand factor from the day of the week. Weekends run 1.02 to
   1.35, Fridays 0.88 to 1.28, weekdays 0.5 to 0.95, with a 14% chance any
   date spikes like a festival.
3. Assign a number of completely untouched berths, which drops to zero on a
   hot date so genuinely sold-out days exist.
4. Assign a number of berths occupied only Bangarpet to Bengaluru, which is
   the pool of "empty after Bengaluru" inventory.
5. Fill the rest from a table of 14 realistic booking spans, biased toward
   end-to-end riders as demand rises.

There is one hand-placed case: on 16021 sleeper coach S4, today only, 52 of
the 72 berths are people who get off at Bengaluru KSR. That is the demo
coach, and every other date runs purely on the model.

### Cancellations

`cancelledOn(no, dateISO)` is an FNV-1a hash of the train number and date.
About 8% of services are cancelled on any given day, with a named reason from
four options. 16021 never cancels, so the demo path is stable.

### Waitlist odds

`oddsOf2()` is the honest one, and no model touches it.

**Quota type is derived from geometry, never asked.** Boarding at the train's
origin gives GNWL. Boarding mid-route gives RLWL. A Tatkal quota gives TQWL.

**The number is built from named parts:**

- A seeded per train, class and date heat factor between 0.55 and 1.35.
- Day of week multipliers. Friday adds 15%, Sunday 18%, Saturday 8%, and a
  month-end weekend adds another 6%.
- A festival calendar with five entries covering Raksha Bandhan, Ganesh
  Chaturthi, the Mysuru Dasara season, Deepavali, and Christmas to New Year.
  Dasara is the heaviest at 45%.
- Parallel cancellations. If another train serving the same pair is cancelled
  that day, its passengers are assumed to pile onto this one, 8% each up to
  three trains.
- Churn. Expected pre-chart cancellations rise with lead time, from 4% at
  departure to 14% at 45 days out, and fall as the date runs hot.
- A quota multiplier. GNWL clears at full rate, RLWL at 0.45, TQWL at 0.30.

A logistic curve on your position against expected clearances gives the
percentage. **RAC is returned as a separate number**, because "will I get a
full berth" and "will I board at all" are different questions and side berths
absorb the queue far deeper. RAC slots are 7 per coach in sleeper, 4 in 3A,
2 in 2A.

Every contributing factor is pushed onto a `why` array and shown to the
traveller by name. There is no black box in this number.

### Live train positions

`liveOf(tr, now)` interpolates a train's position along the corridor from the
current clock and its timetable, returns a state, the station it is at or
between, a delay drawn from a fixed cycle, and a fractional progress value the
map animates.

---

## 4. The store

`khaali-live/store.mjs`, the only stateful module.

Each train, date and class key holds two arrays of 13 bit masks: `booked`
(paid for) and `held` (somebody is at the payment screen right now). A berth
is available for a journey only if **both** are clear on every leg.

### Holds are a real compare and swap

`hold()` does its check and its set inside one synchronous function with no
`await` between them. Node runs one turn of the event loop at a time, so no
other request can interleave. Two phones racing for the same berth cannot both
win. This is not an approximation of a lock, it is one.

The hold is **all or nothing**. If any berth in the request conflicts, the
whole hold is rejected and nothing is locked.

A hold locks **exactly the legs the berth can give you**, not the whole berth.
So one physical berth can be held by two different people for two
non-overlapping stretches at the same time, and the tests assert that.

Holds last 5 minutes and release themselves on a timer.

### Any berth, or choose my berth

Indian Railways pins your berth number sixty days before you travel and then
cannot move it. Airlines assign your seat at check-in, once they know who is
coming. That one difference is why a coach fragments. On tomorrow's Kaveri
Express sleeper, 332 people at the busiest leg leave **one** berth sellable end
to end, when **100** could be.

So the seat page offers two ways to book:

**Any berth**, the default. You book the journey. khaali promises one whole
berth for your whole journey and tells you which one at charting, four hours
before departure. Priced at the through fare plus the standard charges.

**Choose my berth.** You pick S6/66 now and it is yours the moment you pay. It
carries a berth choice fee per traveller: ₹25 sleeper, ₹50 AC 3-tier, ₹75 AC
2-tier. The fee is the price of an obstacle: a pinned berth can cost the coach
packing room. Chosen berths are capped at 40% of a coach, which is what
airlines do with pre-assignable seats.

Every hold of either kind passes one test first: **can everyone already booked,
plus this one, still be seated?** The server runs the packer for real. A chosen
berth that would unseat someone already booked is refused. The pool is never
oversold. Two phones cannot both take the last seat, because the check and the
set are one synchronous step.

At charting, everyone who is not pinned is re-seated around the pinned
berths: the any-berth pool and the railway's own scattered bookings alike.
Each any-berth traveller gets a notification and their ticket updates. The
chart is journaled with the whole physical map, so a restart restores it
exactly. A demo button on the ticket prepares it on demand; a timer prepares
it on the demo clock.

Until charting, the seat map keeps showing the railway's scattered assignment,
because that is what is physically true, with hatched berths where any-berth
travellers would sit today. The headline beside it says what charting will
make of the coach.

### Confirm

`confirm(id)` re-checks under the same CAS discipline before moving bits from
`held` to `booked`, then issues a 10 digit PNR. Paying twice returns the same
booking rather than double booking. A released hold cannot be paid.

### Events

`subscribe()` feeds a server-sent events stream. Every hold, release and
booking is broadcast, so a second browser watching the same coach sees a berth
go blue the moment somebody else locks it.

---

## 5. The HTTP API

`khaali-live/server.mjs`, 1262 lines, no framework, plain `node:http`.

| Endpoint | Method | What it does |
|---|---|---|
| `/api/health` | GET | Liveness, used by Railway's healthcheck and an uptime pinger |
| `/api/meta` | GET | Stations, classes, trains, and which integrations have keys |
| `/api/search` | GET | Trains serving a pair, with counts, price, live state, cancellation |
| `/api/availability` | GET | Full berth map for one train, date and class |
| `/api/counts` | GET | Just the four counts, cheap enough to poll |
| `/api/calendar` | GET | Up to 62 days of free and partial counts for the date picker |
| `/api/odds2` | GET | Every serving train banded book / hop / odds / cancelled |
| `/api/odds` | GET | The older single-position odds call |
| `/api/odds/explain` | GET | OpenAI sentence about an odds result |
| `/api/live` | GET | Positions of all trains right now |
| `/api/sim` | GET | Drives the simulated clock |
| `/api/geo` | GET | Station coordinates for the map |
| `/api/hold` | POST | Locks berths. **Requires a verified identity.** |
| `/api/hold/:id` | GET / DELETE | Read or release a hold |
| `/api/pay/:id` | POST | Confirms payment, issues the PNR |
| `/api/qr` | GET | Renders a QR as SVG server side, so the phone needs no library |
| `/api/bookings` | GET | All bookings |
| `/api/events` | GET | SSE stream of holds, releases and bookings |
| `/api/stt` | POST | Speech to text via Sarvam `saaras:v3` |
| `/api/tts` | POST | Text to speech via Sarvam Bulbul, 11 languages |
| `/api/greet` | GET | Pre-warmed spoken greeting |
| `/api/chat` | POST | Saarthi |
| `/api/tatkal/*` | mixed | The Fair Tatkal window, see section 9 |
| `/api/stats` | GET | Store statistics |
| `/api/reset` | POST | Wipes inventory back to seed |

---

## 6. Identity

Supabase Auth, and only for identity. No application data lives there beyond
the user's own profile metadata.

The browser signs in against Supabase directly, so **khaali never sees the
password**. It gets back an access token and keeps it in `localStorage`.

Every request that costs somebody else something sends that token. The server
calls Supabase's `/auth/v1/user` to ask whose token it is, and caches the
answer for ten minutes so this costs one round trip per session rather than
one per tap.

Two endpoints are gated this way:

- `/api/hold`, because a hold takes a berth off the board for everyone else.
- `/api/tatkal/paysession`, because entries are capped per person.

The server uses the email **Supabase returns**, never one the request claims.
A client that sends `who: "anyone-i-like"` is overridden.

`/api/pay/:id` is deliberately **not** gated, because the scan-to-pay QR opens
on a second phone that is not signed in. The hold ID is the capability there,
and it expires in five minutes.

### Profile

Stored as Supabase user metadata and edited in the app: display name, full
name as on ID, phone, address, and Aadhaar verification status with the last
four digits. The display name is what the greeting uses, so it says "namaste
Pranav" rather than "namaste".

---

## 7. The pages

Nine entries in the navigation, fifteen page states in total.

### Trains (home)

Station pickers with a swap control, a date strip, class and passenger
selectors, and a calendar popover showing free and partial counts per day for
the next 61 days. Booking runs **from today**, and today's list excludes
trains that have already left your station.

Below the search sit browsable rails of trains, capped at 12 per rail after an
early version rendered 235 cards across four rails.

### Results

Every train serving the pair, sorted by departure, each showing departure and
arrival, duration, platform numbers, stop count, the four availability counts,
the cheapest price, live running state, and a cancellation banner where it
applies.

### Train

One service in detail with its full stop list, timings, platforms, a favourite
toggle, and a cancellation warning naming the reason.

### Showtimes

Every boarding point for a train, for when you are not sure which station near
you it actually stops at.

### Seats

The coach map. Berth tiles coloured green, dashed amber, grey or blue, with a
legend explaining each. Amber tiles carry the handover station. Blue means
somebody else is at the payment screen right now, arriving over SSE.

Berth numbering follows real layouts, and there is a "towards engine"
orientation marker.

### Confirm

Journey summary, berth list, a fare breakdown with reservation charge,
superfast charge, GST and convenience fee, and the traveller picker.

The traveller picker is a chip row per berth drawn from your saved people
list. A name already used on another berth on this ticket greys out. Adding
someone new is a text field and an Add button.

Pressing "Lock berths and pay" without being signed in opens the auth modal,
and the hold resumes automatically once you are in.

### Ticket

The issued PNR, berths as coach and number, fare paid, and journey detail.

### Seat hop

The feature that falls out of the interval model for free. If no single berth
is free your whole way, khaali chains two partial berths on the **same train**:
ride the green one, move at the change station, ride the amber one to the end.

Both berths lock and pay as **one ticket** through the `segs` contract, where
each berth is pinned to exactly the stretch it was promised. The page shows the
saving against the full fare and names the change station and time.

### Waitlist odds

The odds page bands every serving train:

- **book**: berths are free your whole way, so no waitlist question arises
- **hop**: nothing free, but partial berths exist, so seat hop is the answer
- **odds**: genuinely nothing, so here are the real numbers
- **cx**: cancelled that day

You enter your WL position and quota; it returns the type, the confirmed
percentage, the RAC percentage separately, the queue you would join if you
booked this minute, and the named reasons.

### Fair Tatkal

See section 9.

### Route map

Leaflet with real station coordinates, vendored locally so it works without a
CDN. Trains move along the corridor at their simulated positions.

### Favorites

Trains you starred, kept in `localStorage`.

### Wallet

Balance, transaction log capped at the last 40 entries, a PIN gate for paying
from balance, and a simulated withdraw to bank.

The wallet page also surfaces the three refund situations directly: booked
twice by mistake, train cancelled, and delay over three hours.

### My bookings

Every ticket with its status, plus the refund controls when one applies.

### About

What the prototype is and is not.

---

## 8. Saarthi

The voice and text copilot, backed by Sarvam AI.

**Speech in** goes to `saaras:v3` with `language_code: unknown`, so it detects
the language itself. Chrome records `audio/webm;codecs=opus`, and the server
strips the codec parameter because Sarvam rejects parameterised content types.

**Speech out** is Bulbul, in 11 languages: Bengali, English, Gujarati, Hindi,
Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil, Telugu. The greeting is
generated at boot so the first mic tap answers instantly.

**Script detection** is exact Unicode range matching, not guessing. Saarthi
replies in the same language *and script* you wrote in, and switches happily
if you ask it to speak to a family member in another one.

**Station matching is phonetic across scripts.** Bangalore, Bengaluru, बेंगलुरु
and ಬೆಂಗಳೂರು all resolve to index 5.

**Relative dates** resolve to concrete ISO dates. aaj, ivattu and indru mean
today. kal, nale and nalaikku mean tomorrow. parso, naadiddu and ellundhaikku
mean the day after.

**Times of day resolve to 24 hour times.** "around 7:30 in the evening"
becomes `around: "19:30"`, and shaam, sanje, maalai and raat all imply PM.

Saarthi returns strict JSON with one of four actions:

| Action | Triggered by |
|---|---|
| `search` | trains, seats, prices, availability between two stations |
| `cancellations` | which trains are cancelled, kya cancel hai |
| `odds` | a WL number, waiting confirm hogi kya |
| `mybookings` | my ticket, mera PNR, is my train ok |

It is instructed never to ask for a date before searching, and to inherit
context from history, so "aur parso?" keeps the route and moves the date.

Its spoken text is constrained to plain flowing sentences with no bullets,
dashes, slashes or markdown, because it gets read aloud.

Without a Sarvam key, the endpoint degrades to a friendly notice rather than
breaking.

---

## 9. Fair Tatkal

Tatkal today is a 10:00 stampede. IRCTC's own figures put up to 80% of peak
Tatkal traffic at non-human, and more than 2.5 crore fake accounts have been
blocked. Aadhaar OTP became mandatory in July 2025.

khaali replaces the race with a **window**.

### How a round runs

1. **Open.** A round opens with a seed derived from its ID and tomorrow's
   date, so the whole round is replayable by anyone who knows the seed.
2. **Collect.** Everyone who enters pays the same locked fare of 175 rupees.
   Arrival order is recorded but earns nothing.
3. **Identity filter.** One entry per verified person per round. Not per
   account, per *verified identity*, checked server side against Supabase.
4. **Monthly cap.** Four paid entries per person per month. Crucially, **only
   a win consumes a monthly slot**, so losing costs a human nothing while the
   per-round limit still starves bot farms.
5. **Allot.** All entries go into one pool, shuffled by a seeded PRNG, and the
   first 40 take the berths.
6. **Real berths.** A winner is assigned an actually free berth from live
   inventory, full-way berths first. On a sold-out day the winner gets the
   best partial berth instead, priced for the stretch that is theirs.
7. **Block, don't take.** The fare is never paid to enter. The traveller's
   bank blocks it, the way an IPO application blocks money through a UPI
   mandate or ASBA, and nothing is debited. When the window closes, a
   winner's block is taken and every other block is released. There is no
   refund step because there was no debit. See "Blocked, not taken" below.

### The simulated opposition

Each round seeds three bot farms firing roughly 180, 110 and 60 requests, plus
120 to 150 ordinary travellers. The audit trail states the arithmetic plainly:
hundreds of automated attempts trace back to three verified persons, and the
identity check plus the monthly cap reduce them to **12 standing entries**.

### The glass box

The right side of the screen is the engine while it runs. The audit lines
include the window duration, the request counts, the identity filter result,
the monthly cap arithmetic, the allotment seed, and the split of berths
between bot entries and travellers. Anyone can replay it.

---

## 10. Where the AI sits

This section is split deliberately, because the difference between what runs
today and what the design intends is the thing a judge will probe hardest.

### What runs today

**Sarvam does the language.** Speech in, speech out, script detection, and the
copilot that turns "Bengaluru to Mandya around 7:30 in the evening" into a
structured search. This is real and it is the part a traveller touches most.

**OpenAI writes the prose.** `gpt-4o-mini` narrates finished results: the
Tatkal outcome, and the verdict on trains where the waitlist question is
genuinely interesting. The narration prompt forbids inventing or contradicting
a figure, and forbids the words lottery, luck and draw. Output is cached by
result key, so the same round is never narrated twice.

**The fairness floor is arithmetic.** One entry per verified identity per
round, four per month, and only a win consumes a slot. That is what collapses
hundreds of automated requests into twelve standing entries. It is
deterministic, auditable and replayable, which is exactly why it is not a
model.

**Sentinel does the behavioural filtering.** See section 10a. It is a scored
model, and it sits on top of the arithmetic rather than replacing it.

### 10a. Sentinel

`khaali-live/sentinel.mjs`. What the arithmetic floor cannot see is *how* an
entry arrived. A farm that owns three real verified identities can still buy
in bulk, four entries each, entirely within the rules. Sentinel scores that
behaviour.

**Six signals, all already present in the round:**

| Signal | Feature | What it catches |
|---|---|---|
| `burst` | ms after the window opened | nobody reads a screen and decides in under 3 seconds |
| `rate` | requests fired from this origin, log scaled | one entry is one request |
| `fanout` | distinct accounts behind one origin | six accounts from one origin is the tout business model |
| `payReuse` | one instrument settling several identities | bulk buying with one card |
| `shallow` | things the session did before entering | browsing is human, landing on the endpoint is not |
| `cadence` | coefficient of variation of request gaps | machines keep time |

Each normalises to 0..1 and feeds a logistic with **published weights**:

```
bias -3.2
burst 1.5   rate 1.3   fanout 1.1   payReuse 0.8   shallow 0.7   cadence 1.0
p = 1 / (1 + e^-z)
```

An earlier weight set was strong enough that every farm scored a flat 1.000,
which is not a probability but a saturated sigmoid pretending to be one. These
weights put a clear farm around 0.95 and an ordinary traveller around 0.05,
so the middle of the range means something.

**Deliberately not an LLM.** Every score in the glass box can be recomputed by
hand from the numbers shown next to it. A black box deciding who gets a berth
is the exact failure mode khaali argues against. One of the tests recomputes a
score from the published weights and asserts it matches.

**Bands and what they cost:**

| Band | Threshold | Chits |
|---|---|---|
| clear | below 0.55 | 4 |
| throttle | 0.55 | 2 |
| challenge | 0.85 | 1 |

**A score can never block a person.** The floor is one entry, always. The
worst outcome for a real traveller who trips every signal is being treated as
one person entering once, which is what they are. What Sentinel strips is the
bulk advantage, not the entry, and a test asserts nobody is reduced below one.

**It runs on everyone.** Farms, simulated travellers and real signed-in people
all go through the same function. A scorer that only ever sees the entries you
already suspect is a label, not a model.

**Measured, not asked.** The server keeps a half-hour log per caller of the
requests that mean somebody is looking at trains, plus the rhythm of every
entry attempt. At the moment of entry, `actions`, `gaps` and `accounts` are
read off that log; the browser sends nothing about itself and would be
ignored if it did. `payReuse` cannot be observed while payment is simulated,
so the glass box labels it *not observed* rather than counting it as
innocence. The traveller's own score, band and reasons appear next to the
farms', with five of six signals measured.

**A typical round:** 3 farms firing 447 requests across 111 accounts score
0.946 to 0.957 and are weighted from 12 chits down to 3. All 122 simulated
travellers clear. A real signed-in person scores 0.039 with the reason
"nothing in this entry looks automated". Result: one bot berth instead of
three, and the audit log states each step.

### The rule the code enforces

No LLM touches a number. Not a price, not a probability, not an allotment, and
not a Sentinel score. OpenAI's only job is prose. If its key is missing or its
quota is dead, khaali loses sentences and nothing else. Availability, fares,
odds, locking, scoring and allotment all still work.

---

## 11. Money

### The money tracker

While a Tatkal payment is in flight, four stages show where the money actually
is, each with a timestamp as it completes:

```
your bank  ->  payment gateway  ->  khaali  ->  Indian Railways
```

A line underneath names the current holder in plain words. If the payment
sticks, it says so explicitly: "the payment gateway, not khaali, not the
railway", and marks that no PNR was issued.

### One order, many trains

"Tell khaali what you need, not which train." On any search results page
the traveller can place a journey order instead of picking a train: the two
stations and date from the search, a window of departure times, the classes
they would accept, how many are travelling, and the most they would pay in
total. khaali quotes how many trains that watches and the cheapest fare
among them, then blocks the cap the way a Tatkal entry is blocked.

The order book lives on the server (`khaali-live/orders.mjs` for what an
order is and how it fills; the server for the book, the matcher and the
routes). An order is disbelieved on arrival: stations must be served, the
date within sixty days, the window non-empty, the classes known, the party
at most six, and the cap at least the cheapest fare with fees. Two open
orders per identity.

Matching runs when a block is approved, whenever a hold is released, a
chart is prepared or the store resets, and every twenty seconds. Orders are
served oldest first, so waiting is what earns the place in the queue. A fill
is whole berths only, on the cheapest candidate that has them: before
charting that is an any-berth booking, after it the free berths themselves.
The hold is placed outside the traveller's own hold cap, so a fill never
knocks out a checkout they are in the middle of. The block is captured for
exactly the booking's amount and the rest released; a window closing with
nothing booked releases all of it. Orders and their fills are journaled and
rebuilt at boot, blocks included.

The scanned page plays the bank for an order too: approve the block, then
"berth found, ₹142 debited, ₹38 released" or "order closed, ₹0 debited",
updated live. In the app, the order sheet closes itself when the phone
approves, the bell announces the fill with the train and what was taken, and
My bookings lists every order with its state. A fill made while the device
was away is adopted onto it when the ticket is opened.

Not in an order: seat-hop stitches. A stitched journey is a different
promise, and the traveller did not make it.

### Blocked, not taken

A Tatkal entry is a bet on an allotment, and most entrants lose. Charging
them up front and refunding the losers is the wrong shape: it creates the
"money gone, no ticket" moment and a queue of refunds. khaali's payment
session for a Tatkal entry is therefore a block, not a payment.

The session has four states, in `khaali-live/tatkal.mjs`:

```
pending -> authorised -> captured   allotted: the fare is now taken
                      -> released   not allotted: nothing was ever taken
pending -> cancelled | expired      the bank never approved: nothing blocked
```

Approving the session (`POST /api/pay/:id`) moves it to `authorised` and
enters the traveller in the window. The draw settles every approved block in
the round: `settleRound` captures a winner's and releases the rest. Resetting
a window releases every approved block in it. A block the bank never approved
is never settled, and a settled block cannot be settled again.

Every method uses the same rule and only the word changes: held in the
wallet, authorised on a card, blocked through a UPI mandate, blocked ASBA
style through netbanking. In the wallet this is real: the wallet keeps
`held` separately from `bal`, the header shows available money and the
blocked amount side by side, and the ledger records a release as a zero
rupee line so it is visible that nothing happened.

The scanned page (`khaali-live/public/pay.html`) plays the part of the
traveller's bank for a Tatkal session. It shows the block request with
Approve and Decline, then "blocked, not debited", then, when the draw runs
on the other screen, either "debited, berth S4/12 is yours" or "₹0 debited,
block released". It updates on its own through the same event stream the
booking flow uses. The page says it is a simulated bank.

### Automatic refunds

Money returns to the wallet without anyone claiming it. A Tatkal entry is
the exception on purpose: nothing was taken, so nothing comes back.

| Trigger | Note written to the wallet |
|---|---|
| Not allotted in Tatkal | block released, ₹0 debited |
| Train cancelled | full refund |
| Delay over 3 hours | full refund, with the option to keep the ticket |
| Duplicate booking | khaali spots the pair and asks before refunding |

Duplicate detection compares train, day and journey across your bookings and
raises a banner rather than acting silently.

### Paying

Four methods: UPI, card, netbanking, and khaali wallet. Wallet payment is PIN
gated.

### The second phone

`/pay/{holdId}` is a standalone page. The desktop shows a QR containing the
LAN URL for that hold; scanning it on a phone opens the same payment session,
and paying there confirms the booking on the first screen through SSE.

The QR is rendered as SVG **server side**, so the phone needs no library and
no internet beyond the LAN. A Tatkal entry speaks the same protocol minus the
berths, because the seat does not exist until allotment.

---

## 12. Notifications

A bell in the header collects live cards: cancellations on trains you have
booked, delays past the three hour refund threshold, duplicate bookings, and
Tatkal results. Each card carries its own action, so a cancellation card
refunds and a Tatkal win links to the ticket.

---

## 13. Client storage

Everything client side lives in `localStorage`.

| Key | Holds |
|---|---|
| `khaali-auth` | Supabase session: email, name, token, refresh |
| `khaali-who` | Current signed-in email |
| `khaali-wallet` | Balance and last 40 transactions |
| `khaali-pin` | Wallet PIN, default 123456 |
| `khaali-people` | Saved travellers |
| `khaali-copax` | Which traveller is on which berth |
| `khaali-favs` | Favourite train numbers |
| `khaali-bstat` | Per-booking status overrides |
| `khaali-tklock` | The locked Tatkal fare awaiting settlement |
| `khaali-theme` | Light or dark |

---

## 14. Tests

`npm test` runs 33 tests against the engine, the store and Sentinel. All 33 pass.

They cover 157 served station pairs against their expected train lists and
distances, 25 pairs that genuinely have no service, berth state in both
directions, optimal packing on every train and class, and then the parts that
would actually hurt if they broke:

- two phones cannot hold the same berths
- one bad berth rejects the whole hold
- the same berth can serve two non-overlapping journeys at once
- paying twice does not double book
- a released hold cannot be paid
- 50 phones racing one berth, exactly one wins
- 50 phones each taking a different berth, all succeed
- free + partial + taken + locked always equals the coach count
- a partial berth always costs less than a full one
- partial price tracks distance covered
- expired holds release themselves
- a farm scores high and a person scores low
- a Sentinel score is reproducible by hand from the published weights
- no entrant is ever reduced below one entry
- a slow, browsing, single-request entry cannot be flagged
- people and farms go through the same scoring function

---

## 15. Deployment

Node 20 or newer, no build step, no database.

```
npm start          # node khaali-live/server.mjs
npm test           # 25 tests
```

Railway is the deploy target, configured in `railway.json` with NIXPACKS,
`npm start`, and `/api/health` as the healthcheck. `render.yaml` is kept as a
working alternative.

Environment variables: `SARVAM_API_KEY` for voice, `OPENAI_API_KEY` for
narration, `SUPABASE_URL` and `SUPABASE_ANON_KEY` for identity. Every one of
them is optional, and the feature it powers degrades quietly rather than
taking the app down.

---

## 16. What is real and what is simulated

Being straight about this is worth more than overclaiming.

**Real:**

- The station list, distances and platform numbers
- The six flagship timetables, and 122 more trains from data.gov.in
- The interval model, availability, pricing, and the fare arithmetic
- The locking. Compare and swap, five minute holds, tested under contention
- Supabase authentication and server-side token verification
- The payment session, the QR, the second-phone flow, and PNR issue
- Sarvam speech in and out
- OpenAI narration
- Sentinel: the scorer, its weights, and the weighting it applies
- The waitlist arithmetic, including quota derivation and RAC

**Simulated:**

- Who is already sitting on each berth. Seeded and deterministic, not live
  IRCTC data.
- Train positions on the map, interpolated from timetables.
- Cancellations, at about 8% of services per day.
- The money movement. No real rupees change hands.
- The bot farms in Fair Tatkal.

---

## 17. Known gaps

- **Sentinel is trained on nothing.** The weights are hand-set from reasoning
  about each signal, not fitted to labelled traffic, because no labelled
  traffic exists for this corridor. They are published so they can be argued
  with. Real deployment would refit them against real outcomes.
- **The Saarthi system prompt contradicts itself on booking dates.** One
  clause says booking opens from tomorrow, a later clause says from today.
  The app allows today. The stale clause should go.
- **Bookings survive a restart, not necessarily a redeploy.** The store is
  memory-authoritative and appends a journal (`khaali-live/journal.mjs`) of
  every confirmed booking, Tatkal win and reset; boot replays it. On Railway
  the filesystem is ephemeral, so without a volume the journal survives a
  process restart but not a new container. Mount a volume and set `DATA_DIR`
  to it and it survives everything. Pending five-minute holds are deliberately
  not journaled.
- **The 122 extra trains are searchable but not meaningfully bookable**, since
  only the six core services carry full stop data.
- **The Sarvam and OpenAI keys have passed through chat and the repository is
  public.** Rotate both.
