---
title: "Hold tells you in six months. Hit rate tells you on day one."
published: false
tags: datascience, hackathon, analytics, python
---

*For the DEV writing challenge at TAMU Datathon. The casino is fictional and the data synthetic (Dashboard Royale).*

The general manager of The Gilded Ace, a made-up 300-machine Las Vegas casino, had a simple plan: replace the 10 slot machines that earned the least between January and June. Our job was to say whether that plan was right.

It wasn't, and the reasons make a nice lesson in measuring noisy things.

## 1. Ranking by money ranks by luck

Slot results are wildly noisy. A machine's house win is its **theo** (bets × (1 − RTP)) plus luck. We could measure the luck exactly. Each machine-day records Σbet², and each game publishes the variance of its payout multiplier, so

```
σ(house win) = sqrt( Σbet² × payout_variance )
luck z       = (house win − theo) / σ
```

Across 310 machines the z-scores have a standard deviation of 1.09, which is about what pure chance gives. Twenty machines sit beyond ±2σ; chance predicts fourteen. Most "underperformers" were simply on the wrong side of the dice.

## 2. Where a machine sits matters more than what it is

Nine of the bottom ten sit in one zone, the Back Forty. We fit a tiny model, `log(theo per available hour) = zone + game`, and the Back Forty came out at 67% of the floor average for the same games.

We also got a natural experiment. A renovation closed the walkway from the main entrance to the Back Forty for five weeks. Relative to the rest of the floor, Back Forty play dropped 31%, then recovered when the walkway reopened. That tells you access drives this zone, which signage can fix and a new cabinet cannot.

Once you control for zone and game, machines are remarkably alike: most sit within ±10% of their peers. Only 7 are truly weak, and **none of them was on the manager's list.**

## 3. The trick: test the noisy thing's quiet cousin

One machine, M-1158, had a luck z of −4.6. That's suspicious but not conclusive, because jackpot games produce big swings.

Hold (win ÷ wagers) is noisy because payout *sizes* vary enormously. Whether a spin pays *anything* is a plain coin flip with a published probability, and coin flips are quiet. So we ran a binomial test of each machine's hit rate against its game's published hit probability:

```
z = (hits − spins × p) / sqrt(spins × p × (1 − p))
```

M-1158 hits on 38.6% of spins. Its paytable says 31.5%. Over 674k spins that's **z = 124**. After its first day alone it was already **8.6σ** out. Every other machine on the floor was within ±3σ.

The hold-based signal needed six months to reach −4.6σ. The hit-rate signal was unmistakable within 24 hours. That's the difference between a quarterly review and a same-day inspection ticket. (It's also only a lead: a misconfigured paytable, not anyone's wrongdoing, is the likeliest story.)

## 4. What we'd spend

With a $100,000 July budget we funded three things, each answering one diagnosis:

- **Leak:** inspect M-1158, $1,200.
- **Location:** signage for the Back Forty, $7,500. It breaks even at a 2.9% lift.
- **Demand:** one tournament weekend, $15,000. A frozen weekday + event forecast (MAE $49k vs $218k for a constant baseline on a May–June holdout) says February's tournament added ~$72k of theo.

We kept $76,300. Extra technicians and preventive maintenance were real improvements that still couldn't pay back within 30 days, and replacing the bottom ten would have bought new cabinets for a location problem.

## Stack

DuckDB over Parquet for the pipeline; a dependency-free SVG dashboard that recomputes every statistic in the browser from additive daily sums, so changing the date range never averages ratios; FastAPI on Vultr; Gemini for a "Pit Boss" that answers only from a cited evidence table; MongoDB Atlas for the decision log; Tiger Data (TimescaleDB) for the 1.3M-row hourly meters, where the hit-rate alert is a single SQL function.

**The lesson for any noisy metric: before you rank by the outcome, find a component of it that has less noise.**
