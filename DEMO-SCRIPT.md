# khaali - 2 minute demo script

Around 345 words of voiceover, which is tight for two minutes. Screen
directions in italics.

## 0:00 - 0:15 - problem, part one

> At ten in the morning, up to eighty percent of the traffic hitting Tatkal is
> not human. That's IRCTC's own figure. They've blocked more than two and a
> half crore fake accounts and it still happens. You were never slow. You were
> queuing behind software.

*The 10:00 stampede, requests flooding in.*

## 0:15 - 0:28 - problem, part two

> On those same trains, berths ride empty. Not unsold ones. A berth booked
> Bengaluru to Mysuru belongs to nobody after Mysuru, and it still isn't for
> sale.

*Cut to a coach with dashed amber berths.*

## 0:28 - 0:40 - Saarthi

> khaali handles both. You can just ask it, in whatever language you actually
> speak, in whatever spelling you actually use.

*Speak to Saarthi in Kannada or Hindi. Show it resolving Bengaluru correctly.*

## 0:40 - 0:58 - the seat map

> 16021 Kaveri Express tonight. Green is free your whole way. Dashed amber is
> free for your stretch only, because someone boards after you get off. This
> train has 215 berths in that second category. That's the inventory nobody
> currently offers you.

*Scroll the coach, hover a dashed berth to show its label.*

## 0:58 - 1:20 - Fair Tatkal

> Tatkal we rebuilt as a window instead of a race. Everyone who enters pays
> the same locked fare. One entry per verified identity, four a month. In this
> run, three bot farms fired thousands of requests and came out of it holding
> twelve entries between them. Then the berths get allotted.

*Split view, the bot traffic collapsing into 12 standing entries.*

## 1:20 - 1:36 - where the AI sits

> Then Sentinel scores every entrant on six signals: when they arrived, how
> hard they hit, how many accounts sit behind one origin, whether one card is
> settling several identities, how much they did in the app, and how regular
> their timing was. The farms come out at nought point nine five. I come out
> at nought point nought four. It weights them down without ever blocking a
> person.
>
> The weights are printed right there. You can redo the arithmetic by hand.

*The Sentinel panel: the three farms flagged, your own row cleared, and the
per-signal contributions under each.*

## 1:30 - 1:42 - the money tracker

> While you're paying, this shows where your money actually is. Your bank,
> then the gateway, then us, then the railway. If it sticks somewhere, it
> names which one is holding it.

*The four stages ticking over, then the stuck state.*

## 1:42 - 1:53 - auto refund

> If you aren't allotted a berth, the money is in your wallet before you've
> closed the screen. Same if the train is cancelled, or runs more than three
> hours late, or if you booked twice by accident.

*Refund lands, wallet balance updates.*

## 1:53 - 2:00 - close

> And then you're back here, with that balance, buying one of the berths that
> was going to travel empty anyway.

*Back to the coach map, tap a dashed berth, ticket issues. End card with the
demo login.*

## Notes before you record

If you run long, shorten the Saarthi beat at 0:28. The voice input is visible
on screen without narration.

Load your actual demo train and date first and swap in the real berth count.
The 215 figure is seeded per train per date.

Record the QR scan in one unbroken take with both phones in frame if you use
it. That's the beat people assume is faked.

## Numbers, and what is behind them

Verified and safe to say on camera:

- Up to 80 percent of peak Tatkal traffic is non-human, per IRCTC's own data.
- More than 2.5 crore fake IRCTC accounts blocked or deactivated. One report
  puts the figure at 30 million suspicious IDs for 2025-26.
- Aadhaar OTP authentication became mandatory for Tatkal in July 2025, and
  agents are barred from the first 30 minutes of the window.

Not verified, do not put a figure on screen:

- There is no citable national statistic for how many reserved berths travel
  empty. Searches for a CAG audit turned up nothing usable. Use khaali's own
  on-screen count instead, which a judge can see behind you.

Safe to claim about the AI, and worth getting the order right:

- Bot filtering is Sentinel, a logistic model over six behavioural signals
  with published weights, in `khaali-live/sentinel.mjs`. It is not an LLM, and
  saying so is the point: every score can be recomputed by hand.
- It sits ON TOP of the arithmetic floor (one entry per verified identity,
  four a month). Say the floor first, then the model. A model with no
  auditable floor underneath is the thing khaali argues against.
- It can weight an entry down. It can never block a person. The worst case for
  a real traveller is being counted as one person entering once.
- OpenAI writes prose only. It never touches a price, a probability, an
  allotment, or a Sentinel score.

Do not claim:

- Sentinel is not trained on real labelled traffic. The weights are hand-set
  from reasoning about each signal and published so they can be argued with.
  If asked, say that plainly.

Sources:

- https://windowsnews.ai/article/irctc-blocks-30-million-suspicious-ids-still-smashes-online-booking-records-in-2025-26.428523
- https://www.metroindia.net/news/articlenews/tatkal-tickets-vanish-in-seconds-33447
- https://www.newsonair.gov.in/railways-announces-new-rules-for-tatkal-tickets-aadhaar-based-otp-authentication-must-from-july-1
