# khaali — the story, the proof, and what is ours alone

*The pitch document. Every number here has a public source linked at the bottom —
show this page to anyone who asks "is this problem real?"*

---

## The story

**Prakash** books a Sleeper berth on the Kaveri Express from Bangarpet. He is
getting off at Bengaluru, 70 km in. The train runs on to Mysuru — another
138 km — and for that entire stretch, **his berth travels empty**. Paid for,
charted, and carrying nobody.

**Ananya** wants to go from Bengaluru to Mandya that same night. She opens
IRCTC and it says **WAITLISTED 12**. She never boards. The berth that could
have carried her rolled right past her platform — empty — because the system
that sold it thinks of a berth as one indivisible thing, walled into quota
buckets, not as 138 km of space that just became available.

Multiply Ananya by the whole country: **about three crore people a year buy a
ticket and never travel** because their waitlist never clears. Roughly 64
people a minute. Meanwhile Railways' own conductors, walking the coaches with
handheld machines *after the train has left*, find and release about **7,000
empty berths every single day**. The space exists. The demand exists. They
just never meet in time.

That is the whole problem. Not a shortage of berths — a shortage of
*resolution*. The system cannot see halfway.

## What Railways already does (we say this honestly)

Railways is not blind to this. After the chart is prepared — about four hours
before departure — vacant berths at the origin are passed down the line, and
TTEs with handheld terminals allot berths to RAC and waitlisted passengers on
the run: ~5,400 RAC and ~2,700 waitlisted travellers get seats this way daily.
A cottage industry of apps (GapSeat, RailChart, ChartVacancy) helps people
hunt these post-chart vacancies.

But all of it happens **after charting — hours before departure, or on the
moving train**. Nobody plans a family journey around a conductor's handheld.

## What khaali does differently

khaali models every berth as an **interval**, not a unit. Fourteen stations,
thirteen legs, one 13-bit occupancy mask per berth. "Is there space for
Ananya?" becomes one bitwise AND — answered **the moment Prakash books**, not
four hours before departure. Sixty days early, not sixty minutes.

- **Green berths** are free for your whole stretch. Book them.
- **Amber berths** free up en route — you pay only for the kilometres the
  berth is actually yours. Cheaper, honestly priced by distance.
- **Seat hop**: when no single berth covers you, khaali stitches two
  half-empty berths into one guaranteed seat — same train, one berth change,
  one ticket. *Nobody else does this. IRCTC's answer to that situation is
  "waitlisted."*
- **The seat-check page** answers before you pay: book it, hop it, or your
  honest odds — waitlist type derived from where you board (origin = GNWL,
  mid-route = RLWL, Tatkal = TQWL), RAC as its own outcome, and every
  percentage computed from facts we can name out loud: demand, weekday,
  festival windows, cancelled parallel trains. **No AI touches the number.**
- **Saarthi**, a voice copilot built on Sarvam AI, does all of this in
  Indian languages — ask in Marathi at 7:30 in the evening and it answers
  about trains around 7:30 in the evening, in Marathi.
- **A wallet** that refunds cancellations in seconds, shields 3-hour delays,
  and catches accidental double bookings — because for a traveller standing
  on a platform, time matters more than money.

Under it all: a real booking server with berth locking. Two phones cannot
hold the same berth — we wrote the race-condition test to prove it, and 24
more besides.

## The one sentence

> Railways recovers some of this space — but only after the chart, on the
> run, through a conductor's handheld: 7,000 berths a day. It cannot sell
> that space weeks ahead across its quota walls, and it can never stitch two
> half-empty berths into one seat. **khaali does both — 60 days early.**

## The numbers, with receipts

| Claim | Figure | Source |
|---|---|---|
| Waitlisted passengers who never travelled, 2022-23 | 2.70 crore | [India TV / RTI](https://www.indiatvnews.com/news/india/indian-railways-passenger-waiting-list-grows-to-2-70-crore-rti-by-chandra-shekhar-gaur-pnr-status-check-sleeper-class-3ac-ashwini-vaishnaw-irctc-2023-05-08-869472) |
| Same figure, 2023-24 (~64 people/minute) | 2.96 crore | [Business Vibes of India](https://www.businessvibesofindia.com/each-day-nearly-93000-people-in-india-miss-the-train-due-to-non-confirmation-of-tickets/), [Daily Pioneer](https://dailypioneer.com/news/indias-rail-waitlist-crisis-over-3-crore-passengers-missed-train-travel-in-20252026) |
| Vacant berths found and released daily by TTE handhelds, after departure | ~7,000/day | [The Tribune](https://www.tribuneindia.com/news/nation/railways-new-device-checks-real-time-seat-availability-allots-7-000-unconfirmed-passengers-berths-daily-432983) |
| RAC + WL passengers allotted berths on the run, daily | ~5,448 + ~2,759 | [The Tribune](https://www.tribuneindia.com/news/nation/railways-new-device-checks-real-time-seat-availability-allots-7-000-unconfirmed-passengers-berths-daily-432983) |
| Railways' earnings from *cancelled waitlist tickets alone*, 2021–Jan 2024 | ₹1,229 crore | [Business Standard / RTI](https://www.business-standard.com/india-news/indian-railways-earned-rs-1-229-cr-from-cancelled-waiting-list-tickets-124032000421_1.html) |
| Post-chart vacancy transfer to downstream stations (official facility) | — | [The Tribune](https://www.tribuneindia.com/news/archive/business/rlys-announces-facility-to-clear-wait-listed-passengers-302480) |
| The post-chart vacancy-hunting app ecosystem | — | [GapSeat](https://gapseat.in/vacant-seat-in-train), [RailChart](https://railchart.online/), [ChartVacancy](https://chartvacancy.in/), [RailMitra explainer](https://www.railmitra.com/blog/train-chart-vacancy) |

*khaali runs on synthetic data for one real corridor (Bangarpet ⇄ Mysuru, 128
trains from public timetables) and is not affiliated with Indian Railways or
IRCTC. The data is synthetic; the algorithms are real.*
