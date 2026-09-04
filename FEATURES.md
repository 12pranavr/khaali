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

### A need proved, not claimed

khaali seats a traveller who needs a lower berth ahead of one who merely
wants it. Until now that need was a chip you ticked, so the rule rested on
everyone being honest: anyone could tick "disabled" and take a lower berth
from a seventy-year-old.

The fix is a consent step on the traveller's own device. Pressing "Check
documents" opens a request; a QR sends it to their phone. That screen lists
what khaali will be told, what it will never be shown, and what the locker
holds, then Allow or Decline. On Allow, exactly two things come back: a date
of birth, and whether a certificate giving lower-berth priority exists. The
Aadhaar number, the PAN, the address and the documents themselves never
leave, and a test asserts that no identifier appears in what is shared.
Nothing is read at all until the holder says yes; a decline or a lapse reads
nothing and keeps nothing.

There is also a locker of its own at `/digilocker`. It signs in with a
one-time code, then shows all six family lockers side by side with the
documents each holds: Aadhaar and PAN, plus driving licences, education
certificates, a pension payment order, an antenatal card. Every card shows,
underneath, the only two answers khaali would ever be given, and a button to
link or unlink that traveller. The code is generated and printed on the page
rather than sent, because a demo that asked for a code from a real phone
would be a phishing page whatever the label said. Five wrong codes lock the
attempt; the code expires in five minutes and works once.

The profile no longer takes an Aadhaar number at all. Where it used to ask
for twelve digits it now points at the locker and says what khaali will be
told.

`khaali-live/digilocker.mjs` holds the demo lockers for the six saved
travellers, the consent state machine (pending, allowed, declined, expired)
and the sign-in codes, all pure and tested. The consent page is
`khaali-live/public/locker.html` at `/locker/<id>`; the locker itself is
`khaali-live/public/digilocker.html` at `/digilocker`.

**It is not DigiLocker.** It is khaali's own consent screen standing in for a
document locker, exactly as `pay.html` stands in for a bank: no emblem, no
borrowed branding, no field that would accept a real Aadhaar number, PAN or
OTP, and it says so on every screen. The records are invented.

### The rule, beside the decision

khaali already follows a stack of real railway rules, and in three places it
does better than they require: no clerkage on a waitlist that never
confirmed, lower berths without the quota's conditions, and a three-hour
delay refunded from the sofa rather than through a form. Without the rule
printed next to the decision, a stranger has to take our word for all three.

A quiet link reading "the rule" sits under four decisions. Tapping it opens
two lines: what the rulebook says, with its source, and what khaali did
instead. Where khaali only matches the rule rather than beating it, the text
says so; overclaiming would invite exactly the checking this feature asks
for. The five rules live in one table (`RULES()` in the client) so a
correction is a single edit, and `ruleBits`/`ruleFlat` render them.

It appears on the travel check when a train is cancelled or over three hours
late, on the ticket's passenger list where a lower berth was given on
priority, on the seat page's waitlist banner, and on the order rows. The
rules quoted are the ones actually in force; the data they are applied to
stays synthetic, as the app says throughout.

### Vikalp, with the citizen holding the rules

The railway's alternate-train scheme moves a waitlisted passenger to another
train, and almost nobody opts in, because it picks for you: it can change
your boarding or destination station, split your party across coaches, and
cannot be undone afterwards. Give up control, and you might still get
nothing.

khaali's waitlist can carry a **fallback**: what to do if it never confirms.
The traveller writes every condition. Three are locked and cannot be turned
off, because they are the three things the real scheme changes: your two
stations stay exactly as they are, your whole party travels on one train,
and only whole berths count. The traveller then chooses the classes khaali
may move them to, an "arrive by" time, and how much more than the fare they
will allow.

The headroom is blocked with the fare, so a move can never cost more than
was set aside; if the waitlist confirms instead, only the fare is taken and
the rest is released.

It runs **once**, at the moment the waitlist has definitively failed: when
that train's chart is prepared, four hours before it leaves. That is late
enough to be certain and early enough that alternates still exist. It is a
filter, not a hunt.

If even one rule fails, nobody is moved, the block is released, ₹0 is taken,
and khaali names the rule that stopped it: "3 trains had a whole berth, but
they all arrive later than you asked." `whyNot` finds that by relaxing each
rule in turn and reporting the first one that would have worked.

Arrive-by is counted in minutes from midnight of the travel day, so 360 is
six that morning and 1800 six the next; it never quietly slides a day
forward. `fallbackRules`, `chartedOut` and `whyNot` live in
`khaali-live/orders.mjs` and are covered by seven tests.

### Nobody pays for a ticket they never got

A waitlist on khaali is a journey order pinned to one train. When the seat
page finds no whole berth for the party, it offers "Join the waitlist": the
fare is blocked, not paid, the same way a Tatkal entry or an order is. Your
place in line starts when the bank approves the block; a pending request
holds nothing. The number shown is the number the matcher honours: one more
than the approved, still-open waitlists on that train, date and class whose
journey overlaps yours and which were approved earlier. Flexible orders that
could also take the train are shown as an honest footnote, "N flexible orders
ahead".

A whole berth freeing before the chart fills the oldest overlapping order;
at charting the packer seats the waitlist with everyone else; after the chart,
freed whole berths go the same way. All or nothing per party. The train
leaving without a berth releases the block: ₹0 debited, nothing to claim, no
clerkage. Cancel before that: ₹0. One waitlist per person per train, date and
class; two open orders in all; and when any of a person's orders books a
journey, their other open orders for the same journey and date close and
release ("one journey, one seat").

### The quota counts berths. khaali counts people.

Each traveller carries a date of birth, set once in the profile (or once per
saved co-passenger) and then locked, because a birthday must not move for one
journey. The server works out age on the travel date; sixty and over is a
need. Disability and pregnancy are declared per traveller and, like the
railway's own quota, checked against ID at boarding, which the app says.

Needs are hard rules in the packer (`packInto`): travellers with a need are
seated first and only on lower or side-lower berths; if none is left they
still get a berth and are named as missed. Everyone else follows, and among
them someone who merely prefers a lower berth gets one if it costs no need;
someone with neither leaves lowers alone when an equal berth exists. Before
the chart a whole lower berth cannot be chosen for a fee at all (`lower-
reserved`), so ₹25 never outranks a seventy-year-old; after the chart what is
free is free. The seat page shows lower berths in the class and how many are
already spoken for; the chart publishes needed, given and missed, per
booking and per coach, and the ticket says which it was. Needs are chosen on
the confirm page and pushed to the pending hold, and they travel with orders
and waitlists. The simulated railway bookings carry a realistic share of
needs, so a demo chart visibly moves seniors down.

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

## 11a. SOS - marking the moment

A woman alone at 11pm being stared at does not file a complaint. Filing means
being seen doing it, being asked to explain it, and being disbelieved. What she
wants is for the moment not to disappear.

So khaali holds **the stamp and never the footage**.

`sos.mjs` knows three kinds of moment:

| Kind | What the phone does | What khaali stores |
|---|---|---|
| `mark` | nothing at all | the stamp |
| `photo` | up to six frames on a shutter, kept in IndexedDB | the stamp, plus a note that media exists |
| `video` | `MediaRecorder`, kept in IndexedDB | the stamp, plus a note that media exists |

The stamp is everything she would otherwise have to type while frightened:
train and name, date, class, coach and berth, PNR, the clock, and where the
train was on its run at that minute (`whereIs`, from the timetable). She booked
the journey, so khaali already knew all of it. It also carries `verified` -
whether khaali could match the PNR to a booking of hers, or is only repeating
what the phone claimed. An unverified stamp is still worth having; pretending
it was checked would not be.

`lineOf` renders it as one sentence a person can read out, hand over, or read
back in court:

> 16021 Kaveri Express · Thu, 10 Sept 2026 · S4/31 · 11:14 PM · after Mysuru Jn · PNR 450077

Two consequences follow, and both are the point:

- khaali never holds a picture of anybody's face. There is nothing on the
  server to leak, subpoena, or misuse.
- She can record nothing at all and still mark the moment. `mark` is silent,
  invisible, needs no camera permission, and is what the screen falls back to
  when the camera is refused.

### Filing it with the police

khaali is handed the recording on exactly one path: she chooses **Send to the
RPF**. Then the photograph or the video is uploaded alongside the stamp, and the
officer can watch what happened rather than reading a line saying a video exists
on somebody else's phone. That difference is the difference between evidence and
a note.

Everything else is unchanged. Keeping it sends khaali nothing. Sending it to a
friend sends khaali nothing - that goes phone to phone through the share sheet.
And deleting the report unlinks the filed copy from disk as well, so *deleted
means deleted* still holds end to end.

The button says so before she taps it, not after.

If the recording does not go with the report - no signal on the train, a
reload between recording and sending, a browser that never ran the upload -
the app says so rather than reporting success, and offers **Send the recording
to the RPF** on the result screen and against the report in *Earlier*. It pulls
the recording back out of the phone's own storage and files it, without making
her record anything again. The officer's page updates on its next poll.

Uploads are capped at 40 MB and must be an image or a video by content type;
anything else is refused. Over the cap the request is drained and answered
`413` rather than having its socket destroyed, because a phone left waiting on
a reply that never comes is the worst outcome on this screen.

*(Worth noting as a real-world design question rather than a settled one:
evidence filed with a police force cannot normally be withdrawn by the person
who filed it. This prototype lets her delete it, because "deleted means deleted"
is the promise the rest of the feature makes. A real deployment would have to
choose.)*

**Capturing is not reporting.** An alert is `held` until she says otherwise.
When she is safe she gets four choices: delete it, keep it and tell nobody,
send it to the RPF, or send it to someone she trusts. `handOver` marks it
`sent`, records the channel and returns a reference `KH-<train>-<6 digits>`.

The two channels are not the same kind of thing, and the screen says which is
which:

- **The RPF** is the simulated one. khaali prepares the report and hands it
  over. The recording stays on the phone. khaali does not send anybody to her
  coach and never says it has.
- **Someone I trust** is real, and it is not khaali forwarding anything. The
  page hands the message - and where the browser allows it, the recording
  itself as a `File` - to `navigator.share`, so WhatsApp, Signal, Messages and
  the rest appear on her own share sheet. It goes phone to phone. It does not
  pass through khaali, which is exactly the point: khaali cannot leak what it
  never had. Where there is no share sheet the page falls back to a `wa.me`
  link and puts the line on the clipboard; if the popup is blocked an **Open
  WhatsApp** button appears instead.

  The blob is kept in hand from the moment of capture, because iOS will not
  open a share sheet after an `await`. If she backs out of the sheet, the alert
  stays `held` and nothing is recorded as sent.

`remove` deletes the stamp as well as the media reference, and `publicOf`
returns nothing but the id and the status afterwards. Deleted means deleted.

### For a woman who never booked through khaali

The stamp does not actually need the booking. It needs four facts - which
train, where on the line, which berth, and when - and a khaali booking is only
one way to get them. So live location carries the feature for everybody else.

`placeOf(lat, lng)` projects the phone onto the corridor from `geo.mjs` and
answers in the language of a railway: *between Ramanagara and Channapatna*, *at
Mandya*, or *10 km off the line, nearest Whitefield* when she is plainly not on
a train. No ticket, no PNR, nothing typed.

Each new fix is appended to a capped trail. `headingOf` reads the direction out
of it - and refuses to guess from a phone that is standing still - which gives
`nextStopOf` **the next station she will reach and when the train is due**.
That is the whole reason live location is worth anything to the RPF: not a dot
on a map, but somewhere to be standing before the train arrives.

When the ticket and the phone disagree - she is somewhere her ticketed train
does not go - khaali says so and falls back to the line itself, so the RPF
still gets a platform. Both facts can be true at once; she may have moved.

### Who the RPF is handed

`Send to the RPF` attaches a name and a number, and says where they came from:

- `source: 'booking'` - khaali sold the ticket and checked the name.
- `source: 'phone'` - the app offered it. Passed on, labelled, never dressed up
  as verified.
- `source: 'none'` - khaali does not know her. The RPF is told exactly that
  rather than handed a guess.

`Send to someone I trust` attaches none of it. A friend on WhatsApp already
knows who is messaging them.

`/rpf/<ref>` is a stand-in for the console they would use. It leads with how
old the position is - green *Live*, amber *Last seen*, red when cold - because
a stale position presented as current is what puts an officer on the wrong
platform.

`/rpf` is the list: every report anyone has sent to the RPF, newest first, each
showing who, where, and the next station. It is open - no key, no sign-in - the
way the real thing would be to an officer on duty.

What is *not* on it matters as much as what is. A moment she kept to herself,
or sent only to someone she trusts, never reaches this page; nor does one she
deleted. Only what she handed to the RPF herself.

The console is given her position in stations - *between Ramanagara and
Channapatna* - and never her coordinates. That is all it needs to put someone
on a platform, and it means an open page cannot be used to plot anybody on a
map.

Reports are journalled in full - the alert on creation, each fix, the handover
with its contact, and the deletion - and replayed into memory at boot. Before
this they lived only in a `Map`, so every restart silently destroyed every
report; an officer opening a reference an hour later found nothing. A report
that does not outlive the process is not a report.

### Routes

| Route | Does |
|---|---|
| `POST /api/sos` | make the stamp. Carries no media, and never will |
| `GET /api/sos` | her moments, and only hers |
| `POST /api/sos/:id/where` | a new fix from her phone |
| `POST /api/sos/:id/send` | hand it to `rpf` or `trusted` |
| `DELETE /api/sos/:id` | destroy the stamp, the trail and the note of the media |
| `GET /api/rpf/:ref` | the report as the RPF would see it |

### What live location cannot do

A browser permission cannot be made mandatory. If she refuses, there is no
location, and the screen says plainly that the RPF will not see where she is -
it never blocks the SOS over it. Location is asked for the moment the screen
opens rather than mid-recording, because two permission prompts at once is how
you get neither.

Mobile browsers stop reporting position when the screen locks or she switches
apps. A wake lock is taken where supported, and when updates stop the RPF page
says *last seen* instead of showing a position that is no longer true.

A PNR belonging to someone else is refused. A PNR this server never issued is
stamped as unverified rather than refused, because the demo bookings are local.

### What the screen does

One press on **SOS** in the header opens a dark page with the page behind it
pinned, so nothing slides under her thumb. No shutter sound, no flash, no
confirm dialog. Closing mid-recording stops and keeps nothing.

The screen is never blank while the camera is open, because a still dark
rectangle reads as broken at the exact moment she cannot afford to wonder:

- **The live picture**, sharp, filling the frame. A `<video>` the framework
  never touches, parked over a slot in the layout and repositioned on every
  tick, so re-rendering four times a second cannot blink it out.
- **A sound meter** that answers to the room - the half of the recording she
  cannot see.
- **A running clock**, and a note saying nothing has been sent yet.
- If frames stop arriving for 3.5 seconds it says so, rather than sitting there
  looking dead. If a photo comes back a few pixels wide it is refused outright,
  because "saved on your phone" over a blank frame would be khaali lying about
  evidence.

Afterwards she can **watch the clip back or look at the photos** right on the
result screen, before deciding anything.

### Photographs: a shutter, not a snapshot

Evidence is rarely one frame. She wants the man's face *and* the coach number
*and* the berth. So *Take photos* opens the camera and leaves it open: a
shutter button, one tap per frame, a strip of what she has so far, and a count
- *3 of 6*. *Done* keeps them; *Back* with nothing taken stamps nothing.

They are one report, not six. They share the stamp, they go to WhatsApp as one
share with every file attached, and when she files it with the RPF each is
uploaded with its place in the set (`x-khaali-shot: n`), so a retry replaces
its own slot rather than doubling up. The server caps a report at six and
serves the nth at `/api/rpf/<ref>/media/<n>`; the officer's page shows all of
them, each opening full size. Deleting the report unlinks every one.

### Formats

`video/mp4` is chosen first and deliberately: a `.webm` is refused by WhatsApp
and by most phone galleries, so a recording in webm is a recording she cannot
send, which is the same as no recording at all. Every candidate names its audio
codec. The file is named from the type the recorder actually produced, never a
hardcoded extension - naming an mp4 `.webm` was enough on its own to make every
video share silently fail while photos worked.

If the share sheet still refuses the file, the page says so plainly and offers
**Save the recording to this phone** so she can attach it herself.

### Keeping the sound

The sound meter runs off a **clone** of the microphone track, never the track
being recorded. Routing the recorder's own audio into a Web Audio graph is
enough to make some phones write a silent file while the meter carries on
bouncing - the worst kind of failure, because it looks like it is working.

The recorder is handed a stream built from exactly the video track and the
audio track, so there is no question about what is being written. The
microphone is asked for three ways in turn - precise constraints, then plain
`audio: true`, then plain everything - because an over-specified constraint set
is a classic way to be handed nothing at all on an older phone.

Afterwards the finished file is checked for an audio track (`mp4a`, `OpusHead`,
`A_VORBIS` in the header). If the sound did not make it, the screen says so
rather than letting her find out days later when she plays it back.

### What is honest about it

The handover is simulated and the page says so. Browsers cannot record
invisibly - the permission prompt, the tab indicator and the phone's own
recording dot are not ours to hide - and the screen says that too, then offers
`mark` for exactly that case.

---

## 11b. After the train - the metro, and a pass for the city

A ticket to Whitefield leaves a person on a platform 1.7 km from the metro
station that shares its name - and 150 m from a different one, Kadugodi Tree
Park, that does not. Nobody tells them. This is the telling.

### The data, all of it real and labelled

| What | Source | Status |
|---|---|---|
| 23 stations Whitefield (Kadugodi) -> Majestic, order, run times, entrances, lifts, fares | BMRCL timetable as GTFS, via Vonter/bmrcl-gtfs (ODbL) | real, stop times good to a minute or two |
| headways by time of day, first and last train | the same feed's weekday schedule bands | real |
| crowding per station per hour | BMRCL entries under RTI, Aug-Sep 2025, weekdays averaged, via Vonter/bmrcl-ridership-hourly (ODbL) | real |
| Kannada station names | BMRCL's own translations | real |
| the walk from the railway to the metro | measured between the two sets of coordinates | measured |
| a metro train's position right now | nobody publishes one | not pretended |

`metro.mjs` holds it; the header says where every field came from.

### The engine - `journey.mjs`

`boardStop()` sends the train passenger to the *nearest* metro, not the
namesake, and records how far the namesake really is. `headwayAt` follows
BMRCL's bands and goes dark after the last train. `nextMetro` answers with the
headway - "every 8 minutes" - and the wait it implies, never a false 09:07,
because frequency service has no timetable to promise. `crowdAt` scores a
station against its own busiest hour. `entranceFor` picks a lift when the need
says so. `plan({arriveAt, needs})` puts it together and `explain` reads it in
one breath:

> Off the train, Entrance A of Kadugodi Tree Park is 150 m - about 3 min on
> foot, with a lift . Purple Line every 10 min . 20 stops to Majestic, about
> 44 min . there by 09:39 AM . Majestic will be at its busiest.

A late train arrives late: the plan starts from when it actually stops.

### The pass - a right to ride, not a seat

A city bus is not something you book; it is something you have the right to
board, and the next one comes. So the city part of the journey is a **day
pass**: issued once for the travel date in the traveller's name, covering the
metro and any BMTC bus, costing the metro fare. `scan()` is the gate's or the
conductor's tap - it records a ride, refuses the wrong day, a cancelled pass,
or a mode it never covered, and treats the same door twice in a minute as one
tap. A pass is never used up; that is the difference between a pass and a
ticket. Missing a bus is not an event, it is a longer wait.

`/scan/<id>` is the conductor's page: one big word - *Good today*, *Not
today*, *No* - the holder, the date, and two buttons. Nothing to install.

### On the ticket

Any ticket that ends at Whitefield carries an **After the train** card:
walk, metro, arrival, fares by QR and smart card, and one tap for the pass,
which then becomes the card with its QR. Each leg carries its source badge -
*measured*, *timetable*. After the last train the card says so and names the
first and last.

### On the map

The Purple Line is drawn from BMRCL's own shape, stations tinted by how busy
they are at the hour the map is showing, the 150 m walk from the railway drawn
as a dotted line, and one label that matters: *Kadugodi Tree Park . 150 m from
the railway*.

### Routes

| Route | Does |
|---|---|
| `GET /api/metro` | the line, for the map and the ticket |
| `GET /api/journey?arrive=<minute>&needs=` | the plan from a train arrival |
| `POST /api/pass` | issue a day pass (signed in) |
| `GET /api/pass/:id`, `DELETE` | her pass; cancel it |
| `GET/POST /api/scan/:id` | the door - open on purpose; a pass tells a stranger only whether it is good today |

Passes and rides are journalled and replayed at boot.

### Where you plan the whole journey

**Plan a journey** at `/plan` is its own page. Three features, three screens:
**Trains** books a train, **Plan a journey** moves a person, **the live map**
watches trains.

Nobody wants "a train". They want to be at Majestic by nine, sitting down if
possible. So the page offers **several ways**, and the fastest is not always the
one a person picks:

| Leave | Arrive | Time | Cost | Way | Seat |
|---|---|---|---|---|---|
| 08:00 | 09:45 | 105m | 165 | train + metro | standing |
| 08:00 | 10:22 | 142m | 110 | train + bus | **you sit** |
| 08:15 | 11:19 | 184m | 80 | bus + bus | **you sit** |

Faster, cheaper, or seated. That is the choice, and nothing new was added to
the network to create it - it is the same trains, buses and metro that run
today, combined the way somebody who knew the city would combine them.

### Will you get a seat

This is the idea the rest hangs off. A bus boarded at stop 3 of 37 has empty
seats; the same bus at stop 30 has none, and nobody tells you which one you are
getting on. It is in the timetable already and has never been read out.

- **Bus** - how far into the route you board. Within the first tenth is "you
  board where the bus starts, so the seats are still empty".
- **Train** - the berth count for your stretch, from the same inventory the
  booking page sells from.
- **Metro** - that station's own busiest hour, from the RTI ridership data.

A journey carries the **worst** seat on it, never the best: a seat you lose
halfway is not a seat.

### Buses

`buses.mjs`. Three BMTC routes between Whitefield and Majestic are real, pulled
from BMTC's published GTFS: KBS-1K, KBS-1I and V-335E, with their stops, run
times, median gaps and boarding positions. All three board at Hope Farm, stop 3
of their route - which is why you sit.

Bangarpet to Bengaluru is a real service with **no published timetable
anywhere**; Karnataka has never opened KSRTC's data. That leg is modelled,
marked `simulated`, and every screen that shows it says so. Inventing the
numbers quietly would be dishonest; leaving out the leg that makes the whole
journey work would be worse.

### Which way, and why - the allocator

Routing says what she can physically do. `allocate.mjs` says which of those
to put first, and it answers for two people at once: the passenger and the
network. Every way gets a passenger cost (time from when she is ready to when
she arrives, fare, changes, walking, standing) and a network cost (how full
each leg already is, squared, so a 90% train weighs far more than two 45%
buses), both in minutes, and the smallest total is **Recommended for you**.

There is always a line the network may not cross on her behalf: never more
than a set number of minutes slower than the fastest way, never an extra
change beyond one, never a long walk. **Rank by** moves the line - Comfortable
will trade forty-five minutes for a seat, Fastest will trade ten - but there
is always a line. Hard constraints (reach by nine, at most one change, a
lift) are never traded at all.

"Leave after eight" means the clock starts at eight, not when the train does.
A 10:30 departure that runs 95 minutes has cost her the whole morning.

The reason is a set of codes and verified numbers - `LOWER_CROWDING`,
`BETTER_SEAT`, `ONLY_MINUTES_SLOWER`, the exact minute and rupee differences,
a confidence word - and the sentence on the card is made from those and
nothing else. `/api/plan?trace=1` shows every score.

### How full, and how well we know it - capacity

`capacity.mjs`. Every leg carries a snapshot: how full, how many it takes,
where the number came from, and its quality. **Counted** is a train's berths
for this stretch, from the same inventory the booking page sells. **Estimated**
is a bus's boarding position: stop 3 of 43 is arithmetic on the timetable.
**Predicted** is a metro station's own weekday hour, from BMRCL under RTI.
**Unknown** is unknown - carried as null, scored as half full, and the
confidence says LOW. It is never zero and never "probably 40%".

The allocator is tested on a network that does not exist (A-B-C-D, made-up
capacities) before it is trusted on Bengaluru.

### The part that understands sentences - and may not invent

`intel.mjs`. A language model does three jobs and no others. It turns "I
need to reach Majestic by nine, not much walking" into a structured request;
it turns the allocator's codes into one plain sentence; and it answers "why
through Whitefield?" from the journey facts it is handed. It never decides a
route, a fare, a probability or how full a train is.

Every job has a deterministic fallback, so the product works with no key at
all. The sentence is first read by khaali's own grammar (places, "by nine",
"only trains", "no bus", "one change", "grandmother"); a model may fill what
that left empty but may not override a time or a mode the grammar found, and
everything it returns is squeezed through a schema - a rocket is not a mode,
nine changes is not a constraint. The page shows **Understood: ...** before it
acts, and says what it could not place rather than guessing.

An explanation the model phrases is checked for numbers: a figure that is in
none of the facts means the sentence is thrown away and the template is used.
The same check guards answers. OpenAI reads and phrases; Sarvam talks; either
stands in for the other; the arithmetic never waits for either.

### Ten thousand people, twice - the simulation

`sim.mjs`. One recommendation is a courtesy; ten thousand of the same one is
a crowd, and a planner that sends everyone the obvious way has only moved the
crush from one platform to another. So the Plan page can run the morning
twice: **today**, where everyone takes the way that gets them there soonest,
and **allocated**, where each person gets the best way given everyone who was
allocated before them - so the loads the allocator sees are the loads the
earlier passengers made.

A vehicle that cannot take the next ten people is not a choice; once a
vehicle is past its seats, the seat is gone; when there is simply not enough
room the number goes past 100 and says so. It is deterministic. Pick 300,
2,000 or 10,000 people and read the finding: how the most crowded vehicle,
the vehicles past 90%, the share standing, the bus utilisation and the
average minutes moved, and what it cost.

On Bangarpet the gains are modest, because the network out of Bangarpet is
thin - three trains and a bus every half hour - and the tool shows exactly
that. The same engine runs on a network that does not exist in the tests,
where a busy train beside an empty bus gives the result you would expect.

### Anywhere

A journey may start or end anywhere on the map, not only at a station khaali
knows. Type "Hebbal" - or say "I need to go from Bangarpet to Hebbal" - and
the place is found on OpenStreetMap (keyless, via Photon), joined to the
nearest station or stop within 15 km, and the last mile becomes its own leg:
a walk under 1.2 km, otherwise an auto or local bus with an estimated fare,
in the time, in the price, and drawn on the map in its own colour. The card
says which station it goes through and how far. A place farther than any
station khaali knows is refused with the distance, not guessed.

**Leave after** and **Reach by** are two separate things, and both count:
the clock starts at one, the search is cut off at the other, and each has
its chips and a custom time. The sentence reads both ("after 8 by 10").

### The controls

Mode chips - **All / Train / Metro / Bus** - decide what may be used, and the
answers change with them. **Leave after** and **Reach by** are chips, not a
native time picker, because a phone's time picker is a three-column slot
machine and nobody wants one to say "after nine".

### One journey on the map

Click a journey and it is drawn alone: train in red, bus dashed blue, metro in
the line's own purple, walks dotted grey, and one numbered pin per place in the
order you pass it. Every other train, route and line is left off - the question
on that screen is how *she* gets there, and a map answering twelve other
questions at the same time answers none of them. Choosing a different journey
replaces the route; it never adds to it.

The base is Esri's Light Gray Canvas, keyless, chosen because it is quiet.
Leaflet is loaded only when a journey is actually drawn.

### The map

`/live-map` is a map: the corridor, live train positions, the Purple Line
tinted by how busy each station is at that hour, and a place search that finds
a station, a metro stop, or anywhere in Karnataka. Map / Satellite is a pill
top-left.

Tiles are **keyless**: OpenStreetMap's own for streets (Kannada labels come
free with them), Esri for satellite and for dark. CARTO's basemaps now require
an API key and stamp *API KEY REQUIRED* across the map without one, which is
exactly what they did on production until this was fixed.

### Scope, on purpose

One corridor, one metro line, two stations, one pass. KSRTC intercity buses
have no open data and are not shown; other metro lines and the full BMTC
network are the same code with more data. Depth first.

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
