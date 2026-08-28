# khaali - 2 minute demo script

Presenter-led. Around 305 words, which fits two minutes at a normal pace.
Screen directions in italics.

## What leads, and what follows

The order is deliberate. A judge watching fifty videos decides what this is in
the first ten seconds, so the thing nobody else can say goes first.

**Tier 1, the thing khaali owns.** Interval berths and seat hop. It is the
name, it is the architecture, and it is the only part a competitor cannot ship
next week by adding a feature. 44 seconds.

**Tier 2, the thing that proves the engineering.** Fair Tatkal and Sentinel.
42 seconds.

**Tier 3, normal.** Saarthi and the money tracker. Both good, neither
category-defining. Keep them short and do not argue for them. 26 seconds.

**Not in the video at all.** Waitlist odds, the wallet, favourites, the live
map. Good work, wrong format. They need more than ten seconds to land.

The problem is split rather than stacked: the empty berth at the top, the
Tatkal race at 0:44. Three problems in a row before anything is shown is where
attention goes.

## 0:00 - 0:14 - on camera

> A berth empties at Bengaluru and rides another hundred and thirty-eight
> kilometres to Mysuru with nobody in it. Somebody at Maddur is on the waitlist
> for that same train.
>
> I'm Pranav. Khaali is the word for empty. That's the whole product.

## 0:14 - 0:44 - the seat map (tier 1)

> You start by picking the stretch you're actually travelling. Not where the
> train ends. Where you get off.
>
> khaali checks every berth station by station. Green is yours the whole way.
> Amber empties partway, and you pay only for the part you ride. When nothing
> covers you end to end, it stitches two half-empty berths into one ticket and
> tells you which station to move at.
>
> On this train tonight, 215 berths cover part of your trip. Nobody is allowed
> to sell you one.

*Pick the stations, search, scroll the coach, hover an amber berth so its
handover station shows.*

## 0:44 - 1:00 - the second problem

> The other half. Ten in the morning. App open, details saved, thumb over the
> button. You lose anyway.
>
> Eighty percent of the traffic you're racing isn't human. That's IRCTC's own
> number.

## 1:00 - 1:26 - Fair Tatkal (tier 2)

> khaali makes it a window, so clicking first buys you nothing. Then we score
> how each entry arrived.
>
> These three bot farms: nought point nine five. Me: nought point nought four.
>
> The weights are printed right there, so you can redo the arithmetic yourself.
> It never blocks a person. The worst it does is count you as one person
> entering once. What it takes away is buying in bulk.

*Open the window, close it, let the Sentinel panel land. Your own row sits above
the three farms.*

## 1:26 - 1:38 - Saarthi (tier 3)

> Saarthi. I asked that in Kannada. It answered in Kannada and found the train.

*Say it on camera first, then let the answer play.*

## 1:38 - 1:52 - money (tier 3)

> And your money is never nowhere. Bank, gateway, us, railway. It names who is
> holding it right now. No berth, no argument: the refund is in your wallet
> before you close the tab.

*The four-stage tracker, then the refund landing in the wallet.*

## 1:52 - 2:00 - close

> khaali doesn't add one train, one coach, or one berth. It just sells the ones
> already going empty.

*End card with the demo login.*

The open and the close are one loop: empty berth at the top, "sells the ones
already going empty" at the bottom. Land it and stop. No thank-you after it.

## Spare line

Cut for time, kept because it is strong. Trade it for the Saarthi beat if you
would rather lead harder on the money problem:

> Or the money leaves your account, no ticket appears, and now you own a
> screenshot and a customer care number.

## Before you record

Load your actual demo train and date first. The 215 figure is seeded per train
per date, and the three farm scores shift slightly each round, so read the real
numbers off the screen.

Run one Tatkal round and reset it before you roll, so the window opens clean
rather than showing a finished result.

The deployed site sleeps when idle. Open it once so the instance is warm.

If you use the scan-to-pay QR, record it in one unbroken take with both phones
in frame. That is the beat people assume is faked.

If you run long, cut from the top of tier 3 down. Saarthi at 1:26 is twelve
seconds and the voice is audible without narration, so it survives on screen
with no script at all.

## Numbers, and what is behind them

Verified and safe to say on camera:

- Up to 80 percent of peak Tatkal traffic is non-human, per IRCTC's own data.
- More than 2.5 crore fake IRCTC accounts blocked or deactivated. One report
  puts it at 30 million suspicious IDs for 2025-26.
- Aadhaar OTP authentication became mandatory for Tatkal in July 2025, and
  agents are barred from the first 30 minutes of the window.

Not verified, do not put a figure on screen:

- There is no citable national statistic for how many reserved berths travel
  empty. Use khaali's own on-screen count instead, which a judge can see behind
  you.

Safe to claim about the AI, and worth getting the order right:

- Bot filtering is Sentinel, a logistic model over six behavioural signals with
  published weights, in `khaali-live/sentinel.mjs`. It is not an LLM, and saying
  so is the point: every score can be recomputed by hand.
- It sits on top of the arithmetic floor: one entry per verified identity, four
  a month. Say the floor first, then the model. A model with no auditable floor
  underneath is the thing khaali argues against.
- It can weight an entry down. It can never block a person.
- Sarvam powers Saarthi's speech. OpenAI writes prose only, and never touches a
  price, a probability, an allotment, or a Sentinel score.

Do not claim:

- Sentinel is not trained on real labelled traffic. The weights are hand-set
  from reasoning about each signal and published so they can be argued with. If
  asked, say that plainly.

Sources:

- https://windowsnews.ai/article/irctc-blocks-30-million-suspicious-ids-still-smashes-online-booking-records-in-2025-26.428523
- https://www.metroindia.net/news/articlenews/tatkal-tickets-vanish-in-seconds-33447
- https://www.newsonair.gov.in/railways-announces-new-rules-for-tatkal-tickets-aadhaar-based-otp-authentication-must-from-july-1

## The three-rule audit

Harry Dry's test on every claim: can I visualise it, can I falsify it, can
nobody else say it. Three noes means it is filler. Three yeses means it is
yours.

Lines that earn their place:

| Line | Visualise | Falsify | Nobody else |
|---|---|---|---|
| a screenshot and a customer care number | yes | yes | shared problem, so no |
| 138 kilometres to Mysuru with nobody in it | yes | yes | yes |
| 215 berths cover part of your trip | yes | yes | yes |
| these farms nought point nine five, me nought point nought four | yes | yes | yes |
| it names who is holding it, right now | yes | yes | yes |
| doesn't add one train, one coach, or one berth | yes | yes | yes |

What was cut, and why:

- **"Three commitments: fairer booking, clearer payments, better use of
  capacity."** Three noes. You cannot picture "fairer booking", you cannot
  prove it, and any booking startup could sign it. Zoomed in until each one hit
  a concrete object: who is holding your money, clicking first buys you
  nothing, the berth going empty.
- **"Payments can be deducted while passengers are left unsure about the ticket
  or refund."** Abstract. What do you actually hold in that moment? A
  screenshot and a customer care number.
- **"It makes the journey fairer for the people already trying to travel."**
  The first half of that closer was doing real work by saying what khaali is
  not. The second half was an adjective. Replaced with what it does instead.
- **"Answers in the same language they asked in."** That is talking. "I asked
  that in Kannada, it answered in Kannada" is pointing at something the viewer
  just watched.

