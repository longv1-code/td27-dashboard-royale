# Luck, Location, or Leak?

**TAMU Datathon · Dashboard Royale.** An interactive dashboard for The Gilded Ace (a fictional casino with synthetic data) that tests whether the 10 lowest-earning slot machines are truly weak, or just unlucky, badly placed, often broken, or leaking.

**Headline:** don't replace the bottom 10. Three weren't on the floor all period, nine sit in a low-traffic zone, one (M-1158) has a payout fingerprint 124σ off its published paytable, and none of the 7 machines that are truly weak is on the list. Spend $23,700 (inspection, Back Forty signage, one tournament weekend) and keep $76,300.

## Run it

**Windows:** double-click `setup_windows.bat`, then `start_windows.bat`. Full steps: [WINDOWS_SETUP.md](WINDOWS_SETUP.md).

**macOS / Linux:**

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                                   # optional: paste your keys into .env
uvicorn server.app:app --port 8080                     # open http://localhost:8080
```

The processed data (`web/data/data.json`) is included, so the dashboard runs without the challenge dataset. To rebuild it: `python pipeline/build.py --data path/to/dashboard-royale/data`. With no API keys, "Ask the Pit Boss" falls back to keyword search over the evidence table.

## What judges can do (per the guide)

| Judge action | Where |
|---|---|
| Change the analysis period | Date pickers and presets in the sticky bar. Every machine statistic is recomputed in the browser from additive daily sums (ratio of sums, never averaged ratios). |
| Drill into one bank or guest group | Zone and Bank selectors (floor map, tables, downtime). Players tab: tier, region and age chips. |
| Find how the model was validated | **Forecast** tab: train Jan–Apr, frozen, holdout May–Jun, MAE vs constant and weekday baselines. |
| Trace a recommendation to its evidence | **$100k bet** tab: every action has "Trace evidence →" buttons; the **Evidence** tab lists every claim with its source, alternative and limitation, plus a glossary. |

## Repository

```
pipeline/build.py          DuckDB → web/data/data.json (all analysis + model)
web/                       dashboard (index.html, app.js, charts.js; no framework)
server/app.py              FastAPI: static site + /api/ask (Gemini), notes/plans (MongoDB Atlas), /api/hourly (Tiger Data)
integrations/              timescale/ (Tiger Data schema + loader), mongodb/ (Atlas notes)
deploy/                    Dockerfile, Vultr guide
docs/                      WRITEUP.md (≤400 words), CLAIMS_AND_EVIDENCE.md, AI_DISCLOSURE.md, DEV_POST.md, VIDEO_SCRIPT.md, SPONSOR_TRACKS.md
setup_windows.bat          one-time Windows setup (venv, packages, .env)
start_windows.bat          starts the server and opens the browser
.env.example               the keys the server reads (copy to .env; never commit .env)
```

## Methods in brief

- **Luck:** σ(house win) = √(Σbet² × payout-multiplier variance), so z = (win − theo)/σ.
- **Leak:** binomial test of payout-positive spins against the published hit probability. It needs days where hold needs months.
- **Location and exposure:** theo per available hour vs a `zone + game` log-linear fit, with daily ratio-estimator CIs.
- **Downtime:** machine_hour downtime × that machine's own coin-in per available hour at that clock hour.
- **Model:** log-linear weekday + known events + holiday on daily coin-in, frozen 2025-04-30, scored once on May–June.

All casino data is synthetic. Unusual payouts are leads to inspect, not proof of wrongdoing. Player figures cover carded play only.
