# Appendix A — Claims & Evidence

Full window: gaming dates 2025-01-01 to 2025-06-30. Every figure is reproduced by `pipeline/build.py` (DuckDB over the release parquet files) and by the dashboard's in-browser recomputation from additive daily sums. The dashboard's **Evidence** tab shows this table live, with a "Show" button that jumps to the chart behind each claim.

| # | Claim | Table / query | Result | Alternative explanation tested | Limitation |
|---|---|---|---|---|---|
| C1 | 3 of the manager's bottom 10 were not on the floor all window | `machines.install_date/retire_date`, `machine_day.active` | M-5076 49 days (installed May 13), M-1118 55 days (retired Feb 25), M-1120 132 days (retired May 13) | They might also be weak per hour → checked with the peer index, none is | Per-hour index for these rests on fewer days |
| C2 | 9 of the bottom 10 are in Back Forty, which earns 67% of floor theo per available hour for the same game mix | `prepared_daily_view`; weighted fit `log(theo/available_h) = zone + game` | Zone factors: Back Forty 0.67, Main Entrance and Center Pit highest | Back Forty may just hold weaker games → the model separates zone and game effects | Zone and game partly confounded (Royal Draw 95% RTP concentrated there) |
| C3 | M-1158's payout differs from its published paytable | `machine_day.payout_positive_spins / paid_spins` vs `game_math.hit_probability` (binomial z) | 38.6% vs 31.5%, z = +124 (z = 8.6 after day 1); hold 3.0% vs 10.0% configured; luck z = −4.57 | Bad luck → rejected: hit rate stable every week; no other machine exceeds \|z\| = 3 | A lead to inspect, not proof of fault or tampering |
| C4 | Low earnings are mostly luck | `Var(win) = Σbet² × payout_multiplier_variance` from `machine_day.sum_bet_squared` × `game_math` | SD of z across 310 machines = 1.09; 20 beyond ±2σ vs 14 expected | Variance formula may understate jackpot risk | Assumes independent spins |
| C5 | Only 7 machines are truly weak; none is on the manager's list | Peer index = theo per available hour ÷ zone+game expectation; daily ratio-estimator 95% CI | Lowest: M-1184 82% (CI 76–88%), M-1008 87%, M-1145 88% … | Bank-level effects within a zone | Daily SE ignores autocorrelation; CIs may be slightly narrow |
| C6 | Closing walkway W-ENT-B40 cut Back Forty play 31% relative to the floor | `floor_walkways` closure dates; `prepared_daily_view`; `zone_traffic_hourly` | Ratio B40/rest: 0.660 before → 0.457 closed → 0.635 after; S-B40 entries 25 → 18/h | Seasonal mix shift → rejected: other zones rose in March | One event, no randomisation |
| C7 | Downtime cost ≈ $99k theo (0.42%), 55% Ridgeline | `machine_hour.available_seconds` × machine's own coin-in per available hour at that local hour × (1 − RTP) | 5,021 machine-hours, $1.06M coin-in; Ridgeline 40.4 faults / 1,000 machine-days vs 16.7 / 11.1 | Players may switch to a neighbour (true loss smaller) | Upper bound: assumes no substitution |
| C8 | Repair wait depends on technicians actually on shift | `operations` ⨝ `shift_roster` (slot_tech, shift, gaming date) | Day 2/2 techs: 0.12 h; day 1/0: 4.71 h; grave 1/1: 1.76 h; swing 2/2: 0.68 h | Fault mix differs by shift | Only 20 tickets on no-show days |
| C9 | Tracked theo is concentrated; most players lose about theo | `player_period` summed per player | Wagered $163.8M, paid $148.2M, net −$15.59M vs theo $15.49M; top 1% = 20%, top 5% = 52% of theo; 16.1% finished ahead; Locals = 7% of cards, 58% of theo | Uncarded play may be less concentrated | Carded play only (~66% of coin-in) |
| C10 | On 2025-05-01 points per comp dollar roughly halved in every tier | `loyalty_ledger` (redeem): −Σpoints ÷ Σface value, split by `tier_before` | Base 15.0→7.0, Gold 12.0→5.65, Platinum 9.0→4.24; cost per 1,000 pts $21.3→$48.4; redemptions/day 330→335; point balance value $3.34M→$7.57M | Tier-mix shift → rejected: step occurs within each tier on the same day | Two months of post-change data |
| C11 | Frozen forecast beats the baseline on a time holdout | `property_day`, `calendar_day`, `events` (announced ≤ 2025-04-30) | Holdout MAE: model $49.3k, weekday mean $68.7k, constant $218.3k | Weekday mean does most of the work | Two-month holdout, summer unseen |
| C12 | Tournament weekends pay for themselves | Model residuals during events | Feb tournament +15.8% coin-in, $72k ± $12k theo (refit without it); Locals Week +3.0%, $27k ± $16k (true holdout); EDC +4.8% | Weekend coincided with other demand | Tournament estimate is in-sample |

## Recommendation trace

| Action | Cost (guide formula) | Expected theo (30-day) | Evidence | Measurement |
|---|---:|---:|---|---|
| Inspect M-1158 (A-INSPECT ×1) | $1,200 | $4.9k (range $2.8k–$8.3k; assumes 85% chance a fault is confirmed) | C3 | Hit rate back within ±3σ of 31.5% within one day; weekly luck funnel |
| Wayfinding, Back Forty (A-WAYFINDING ×1) | $7,500 | $13k at a 5% lift (range $0–$26k); break-even lift 2.9% | C2, C6 | Diff-in-diff Back Forty ÷ rest, 20 days after vs 28 before; S-B40 counter |
| Tournament weekend (A-PROMO ×1) | $15,000 | $43k at 60% of Feb lift (range $12k–$72k) | C11, C12 | Actual vs the frozen forecast; lift ± SE |
| Keep | $76,300 | — | C7, C8 (tech and PM fail break-even) | — |

Sensitivity: every assumption is a slider on the dashboard's **$100k bet** tab. Even with zero lift from signage, the plan covers its $23,700 cost if the tournament repeats at least 26% of February's lift (4.9k + 0.26 × 72k ≈ 23.7k).
