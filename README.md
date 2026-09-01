# khaali

**Berths that are already empty.**

A rail booking prototype for the Bangarpet to Mysuru corridor, built for the
Build What Moves India hackathon.

**Live: https://khaali-production.up.railway.app**

Sign in with the demo account below. The scan-to-pay QR works on the deployed
site, so you can open a booking on a laptop and settle it from your phone.

---

## The problem

Indian Railways sells a berth as one indivisible thing for the whole train run.
Somebody books Bangarpet to Bengaluru, 70 km in, and that berth is gone for
everyone. The train runs another 138 km to Mysuru with that berth travelling
empty, paid for and unusable, while somebody at Maddur sees WAITLISTED.

The other half of the problem is Tatkal. IRCTC's own figures put up to 80% of
peak Tatkal traffic at non-human, and more than 2.5 crore fake accounts have
been blocked. You were never slow. You were queuing behind software.

khaali is one app for both.

---

## The idea

Store occupancy per segment instead of per berth. The corridor has 14 stations,
so 13 legs. Every berth carries a 13 bit integer, and bit `i` is set when
somebody is on that berth for leg `i`.

Your journey is a mask too, so availability is one bitwise AND:

```
occupancy & journey == 0          nobody is on it while you travel      free
occupancy & journey == journey    somebody is on it the whole way       taken
anything else                     free for part of your stretch         partial
```

That single operation is the whole product. A partial berth is charged only for
the distance it actually gives you, so it is always cheaper than a full one.

---

## Run it

Node 20 or newer. No build step, no database.

```bash
npm install && npm start
```

Then open the printed `http://192.168.x.x:5173` address. Use the LAN address
rather than `localhost` if you want to test the scan-to-pay flow from a phone.

If you only want to look at it, the deployed site above needs none of this.

Tests:

```bash
npm test
```

55 tests covering routing, interval maths, locking under contention, payment
idempotency, pricing, the caps, the Sentinel scorer and its server-measured
signals, rate limits, and the journal. All pass.

### Demo login

```
khaali@betterthanirctc.com
irctcsucks
```

The sign-in screen has a button that fills these in and shows them on screen
rather than signing you in silently, so you can read them before you commit.

---

## What is in it

**Seat map.** Green berths are free your whole way. Dashed amber berths free up
en route and carry the station where they change hands. Blue means somebody
else is at the payment screen right now, arriving over server-sent events.

**Seat hop.** When no single berth covers you, khaali chains two partial berths
on the same train into one ticket: ride the green one, move at the change
station, ride the amber one to the end. Both berths lock and pay together.

**Waitlist odds.** GNWL, RLWL and TQWL are derived from where you board, never
asked. RAC is a separate number, because "will I get a berth" and "will I board
at all" are different questions. Every percentage is built from nameable facts:
demand, weekday, festivals, cancelled parallel trains, and lead time. No model
touches it.

**Fair Tatkal.** A window instead of a 10:00 race. Everyone pays the same locked
fare, one entry per verified identity, four a month, and only a win consumes a
monthly slot so losing costs a human nothing. The right side of the screen is
the engine while it runs, and the whole round is replayable from its seed.

**Sentinel.** See below.

**Saarthi.** Voice and text copilot on Sarvam AI. Speaks and replies in the same
language and script you used, across 11 languages. Station names match
phonetically, so Bangalore, Bengaluru, बेंगलुरु and ಬೆಂಗಳೂರು are all the same
station. Relative dates and times of day resolve to concrete values, so "around
7:30 in the evening" becomes 19:30.

**Wallet and automatic refunds.** Money comes back without anyone claiming it
when a Tatkal entry is not allotted, a train is cancelled, a train runs more
than three hours late, or you booked the same journey twice.

**Real payment session.** Scanning the QR opens the same bill on a second phone,
and paying there confirms the booking on the first. The QR is rendered as SVG
server side, so the phone needs no library.

---

## Sentinel

The identity check and the four-a-month cap are the fairness floor. They are
arithmetic, anyone can replay them, and they already collapse a few hundred
automated requests into twelve standing entries. What they cannot see is *how*
an entry arrived: a farm holding three real verified identities can still buy in
bulk, four entries each, entirely within the rules.

Sentinel scores that behaviour on six signals the round already records.

| Signal | What it catches |
|---|---|
| burst | nobody reads a screen and decides in under 3 seconds |
| rate | one entry is one request; farms fire hundreds |
| fanout | distinct accounts behind one origin |
| payReuse | one instrument settling several identities |
| shallow | landed on the endpoint without touching the app |
| cadence | machines keep time, people do not |

Each normalises to 0..1 and feeds a logistic with published weights. A clear
farm lands around 0.95 and an ordinary traveller around 0.05.

Three things about it are deliberate:

**It is not an LLM.** Every score in the glass box can be recomputed by hand
from the weights printed beside it, and one of the tests does exactly that. A
black box deciding who gets a berth is the failure mode khaali argues against.

**It can never block a person.** The floor is one entry, always. The worst
outcome for a real traveller who trips every signal is being counted as one
person entering once, which is what they are. What gets stripped is the bulk
advantage, not the entry.

**It runs on everyone.** Farms, simulated travellers and real signed-in people
go through the same function, and your own score sits in the glass box next to
the farms'. A scorer that only sees the entries you already suspect is a label,
not a model.

In a typical round the three farms drop from 12 chits to 3, all 122 travellers
clear, and one bot berth is taken instead of three.

The weights are hand-set from reasoning about each signal, not fitted to
labelled traffic, because no labelled traffic exists for this corridor. They are
published so they can be argued with.

---

## Where the AI sits

Sarvam does the language: speech in, speech out, and the copilot that turns a
spoken sentence into a structured search.

Sentinel does the behavioural scoring, and it is a logistic model with published
weights rather than a language model.

OpenAI writes prose only. It narrates finished results, and its prompt forbids
inventing or contradicting a figure.

**No LLM touches a number.** Not a price, not a probability, not an allotment,
not a Sentinel score. If the OpenAI key is missing or its quota is dead, khaali
loses sentences and nothing else.

---

## Layout

```
Rail Booking Flow.dc.html   the app, served at /
khaali-live/
  server.mjs                HTTP API, Saarthi, Fair Tatkal, narration
  engine.mjs                masks, berth state, pricing, odds, live positions
  store.mjs                 shared berth state, holds, compare-and-swap
  sentinel.mjs              the behavioural scorer
  data.mjs                  stations, classes, core timetables
  extra-trains.mjs          122 more trains from data.gov.in
  journal.mjs               append-only journal, replayed at boot
  activity.mjs              what each caller did, for Sentinel
  limits.mjs                per-caller limits on the paid routes
  test.mjs                  55 tests
  public/pay.html           the second-phone payment page
```

Memory decides and a journal remembers. The store keeps deciding in memory,
which is what makes the locking a real compare-and-swap, and appends one
line per confirmed booking, Tatkal win and reset to
`khaali-live/data/khaali-journal.jsonl` (or `DATA_DIR`). Boot replays it, so a
restart keeps every booking. On Railway, mount a volume and set `DATA_DIR` to
it so a redeploy keeps them too.

### Locking

Each berth carries a `booked` mask and a `held` mask. `store.hold()` does its
check and its set inside one synchronous function with no `await` between them.
Node runs one turn of the event loop at a time, so two phones racing for the
same berth cannot both win. That is a real compare and swap, not an
approximation, and the tests fire 50 simultaneous requests at one berth to prove
exactly one winner.

Holds are all or nothing, last 5 minutes, and release themselves.

A hold locks only the legs a berth can actually give you, so one physical berth
can serve two different people on two non-overlapping stretches at once.

---

## Deploy

Railway, configured in `railway.json`. `render.yaml` is kept as a working
alternative.

| Variable | Powers |
|---|---|
| `SARVAM_API_KEY` | voice in and out, Saarthi |
| `OPENAI_API_KEY` | narration |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | sign-in and profiles |

Every one is optional. The feature it powers degrades quietly rather than taking
the app down.

Sign-in goes from the browser straight to Supabase, so khaali never sees a
password. The server verifies the returned token against Supabase before
allowing a hold, and uses the email Supabase returns rather than one the request
claims.

---

## Real, and simulated

Being straight about this is worth more than overclaiming.

Real: the station list and distances, the timetables, the interval model,
pricing, the locking, Supabase authentication and server-side token
verification, the payment session and PNR issue, Sarvam speech, OpenAI
narration, the waitlist arithmetic, and Sentinel.

Simulated: who is already sitting on each berth, train positions on the map,
cancellations at about 8% of services a day, the money movement, and the bot
farms in Fair Tatkal.

This is a prototype. It is not IRCTC, and it books nothing real.

---

## More

- [FEATURES.md](FEATURES.md) is the full end-to-end reference, every feature and
  every endpoint.
- [THE-STORY.md](THE-STORY.md) is the pitch, with a public source for every
  number in it.
- [DEMO-SCRIPT.md](DEMO-SCRIPT.md) is the two-minute video script.
- [khaali-live/README.md](khaali-live/README.md) covers the server on its own.

Built by Pranav.
