# khaali live

Server-authoritative berth booking with real locking, a simulated payment
gateway and a 5-minute hold window. Built for testing from several phones at
once on the same wifi.

## Run

```
npm install
node server.mjs
```

The console prints a `http://192.168.x.x:5173` address. Open that on every
phone. `localhost` works on this machine only.

## Why a server

The design prototype (`../Rail Booking Flow.dc.html`) keeps all berth state in
the browser. Two phones running it are two independent copies, so a lock on one
is invisible to the other. Locking across devices is only possible with shared
state, which is what this server is.

## Locking

Each berth carries two 13-bit masks: `booked` and `held`. A berth is available
for a journey only if both are clear on every leg of it.

`store.hold()` does check-then-set inside one synchronous function. Node runs a
single turn of the event loop at a time, so nothing can interleave between the
check and the set — two phones racing for the same berth cannot both win. The
test suite fires 50 simultaneous requests at one berth and asserts exactly one
winner.

Holds are all-or-nothing: if any berth in the request is unavailable, none are
locked.

## Payment

`POST /api/hold` locks the berths for 5 minutes and returns a hold id.
`/pay/<holdId>` shows the countdown and a QR code. The QR encodes a plain
`http://<lan-ip>:5173/pay/<holdId>` URL so scanning it opens the same payment on
another phone.

**The QR is not a UPI code and moves no real money.** Anyone who opens the page
and presses pay marks the booking as paid. That is deliberate — a QR that
actually charged a card has no place in a prototype.

On expiry the hold is released automatically and the berths return to everyone.

## Endpoints

| | |
|---|---|
| `GET /api/meta` | stations, classes, trains, `lanBase` |
| `GET /api/search?from&to&cls&date` | trains for a journey, with live position |
| `GET /api/availability?train&cls&from&to&date` | per-berth state + packing summary |
| `GET /api/live` | simulated position of every train |
| `POST /api/hold` | lock berths, returns hold + `expiresAt` |
| `DELETE /api/hold/:id` | release early |
| `POST /api/pay/:id` | confirm payment, returns PNR |
| `GET /api/qr?d=<url>` | QR as SVG |
| `GET /api/events` | SSE stream: `held`, `released`, `booked` |
| `POST /api/reset` | wipe back to seeded state |

## Tests

```
node test.mjs
```

33 tests: routing against `corridor_all_pairs.xlsx` (157 served pairs and 25
no-service pairs), interval maths, packing optimality, locking, payment
idempotency, a 50-phone race, expiry, and the Sentinel scorer.

## Data

Timetable and berth seeding come from the design prototype so both tell the same
story. Routing is validated against `corridor_all_pairs.xlsx`: all 157 served
pairs match on train list and distance, and all 25 no-service pairs produce no
train.
