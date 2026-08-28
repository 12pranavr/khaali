# khaali - 2 minute demo script

Presenter-led. Around 320 words of speech, which fits two minutes at a normal
pace. Screen directions in italics.

## 0:00 - 0:24 - on camera

> Every day, people open IRCTC with the same hope. I just need one ticket.
>
> But at ten in the morning, Tatkal is a race against bots. By IRCTC's own
> figures, up to eighty percent of that traffic is not human. Money gets
> deducted and you are left unsure whether you have a ticket or a refund
> coming. And a berth that empties halfway down the route still isn't for sale
> to the next person who needs it.
>
> Hi, I'm Pranav, and I'm building khaali for that.
>
> Three things: make the race fair, make the money clear, and sell the space
> that is already empty.
>
> Let me show you.

## 0:24 - 0:32 - homepage

> A traveller starts by choosing the exact stretch they need. Not the train's
> final destination. Their stretch.

*Pick the two stations and search.*

## 0:32 - 0:58 - berth selection

> khaali checks availability station by station. If somebody gets off earlier,
> that berth becomes available to the next traveller.
>
> Green is free your whole way. Amber opens up partway, and it's priced only
> for the part you actually use. When nothing covers you end to end, khaali
> stitches two half-empty berths into one ticket and tells you exactly where
> you change.
>
> On this train tonight, that's 215 berths nobody is currently allowed to sell
> you.

*Scroll the coach. Hover an amber berth so its handover station shows. If you
have time, open Seat hop for one beat.*

## 0:58 - 1:24 - Fair Tatkal

> Now Tatkal. Today it is a speed race. khaali makes it a verified window
> instead, so nobody wins by clicking first.
>
> Then we score how each entry arrived. Impossible booking speed, repeated
> request patterns, bulk account activity. These three farms come out at nought
> point nine five. I come out at nought point nought four.
>
> The weights are printed right there, so you can check the arithmetic
> yourself. And it never blocks a genuine traveller. The worst it does is count
> you as one person, entering once. What it removes is the bulk advantage.

*Open the window, close it, and let the Sentinel panel land. Your own row sits
above the three farms.*

## 1:24 - 1:42 - Saarthi

> This is Saarthi, our multilingual assistant. A traveller just says it: I need
> to go from Bengaluru to Mysuru tomorrow evening. It searches, explains the
> waitlist, and answers in the same language they asked in.

*Speak to it. Kannada or Hindi lands better than English here.*

## 1:42 - 1:56 - money

> And after you pay, khaali says plainly where your money is. Your bank, the
> gateway, us, or the railway. If it sticks, it names who is holding it. If no
> berth comes, the refund is back in your wallet before you have closed the
> screen.

*The four-stage tracker, then the refund landing in the wallet.*

## 1:56 - 2:00 - close

> khaali does not create more trains. It makes the journey fairer for the
> people already trying to travel.

*End card with the demo login.*

## Before you record

Load your actual demo train and date first. The 215 figure is seeded per train
per date, and the three farm scores shift slightly each round, so read the real
numbers off the screen.

Run one Tatkal round and reset it before you roll, so the window opens clean
rather than showing a finished result.

The deployed site sleeps when idle. Open it once so the instance is warm.

If you use the scan-to-pay QR, record it in one unbroken take with both phones
in frame. That is the beat people assume is faked.

If you run long, the Saarthi beat at 1:24 is the one to shorten. The voice
input is visible on screen without narration.

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
