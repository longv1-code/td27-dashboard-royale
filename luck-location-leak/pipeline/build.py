"""
Luck, Location, or Leak? -- reproducible data pipeline for The Gilded Ace dashboard.

Reads the Dashboard Royale release (parquet) with DuckDB and writes ONE file,
web/data/data.json, that the static dashboard loads. Every number on the
dashboard is either in that file or computed in the browser from additive
sums in it (so the analysis period can be changed without breaking the math).

Usage:
    python pipeline/build.py --data path/to/dashboard-royale/data

Money rules followed (GUIDE section 5):
  * ratio of sums, never mean of daily ratios
  * off-floor rows (active = false) excluded
  * scheduled_seconds from calendar_day (DST day = 23 h)
  * comp cost counted once (it is already inside POS cogs)
  * guest tables aggregated before joining
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

TRAIN_END = "2025-04-30"  # forecast frozen at end of gaming day 2025-04-30
TEST_START = "2025-05-01"
FORECAST_FREEZE = pd.Timestamp("2025-04-30")


def r(x, nd=2):
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return None
    return round(float(x), nd)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="path to the release's data/ folder")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "web" / "data" / "data.json"))
    args = ap.parse_args()
    D = Path(args.data).resolve()

    c = duckdb.connect()
    views = {
        "d": "1_prepared_views/prepared_daily_view",
        "pday": "1_prepared_views/property_day",
        "pp": "1_prepared_views/player_period",
        "md": "2_machine_decision/machine_day",
        "gm": "2_machine_decision/game_math",
        "mach": "2_machine_decision/machines",
        "cal": "2_machine_decision/calendar_day",
        "loc": "2_machine_decision/floor_locations",
        "walk": "2_machine_decision/floor_walkways",
        "ops": "2_machine_decision/operations",
        "act": "2_machine_decision/action_catalog",
        "ev": "4_context/events",
        "zt": "4_context/zone_traffic_hourly",
        "wx": "4_context/real_sources/weather_daily",
        "cv": "4_context/real_sources/city_visitation_monthly",
        "bs": "4_context/real_sources/benchmark_state_monthly",
        "mh": "5_optional/machine_hour",
        "ros": "5_optional/shift_roster",
        "vpm": "5_optional/visitor_profile_monthly",
        "led": "3_guests/loyalty_ledger",
    }
    for v, p in views.items():
        c.sql(f"CREATE VIEW {v} AS SELECT * FROM '{(D / (p + '.parquet')).as_posix()}'")
    q = lambda s: c.sql(s).df()  # noqa: E731

    out: dict = {"meta": {
        "title": "Luck, Location, or Leak?",
        "property": "The Gilded Ace (fictional; synthetic data)",
        "window": "Gaming dates 2025-01-01 to 2025-06-30",
        "release": json.loads((D / "manifest.json").read_text())["version"],
        "train_end": TRAIN_END,
    }}

    # ------------------------------------------------------------------ calendar
    cal = q("SELECT gaming_date, local_weekday, is_weekend, federal_holiday, scheduled_seconds, month FROM cal ORDER BY 1")
    dates = [d.strftime("%Y-%m-%d") for d in pd.to_datetime(cal.gaming_date)]
    di = {d: i for i, d in enumerate(dates)}
    out["dates"] = dates
    out["sched_h"] = [r(s / 3600, 3) for s in cal.scheduled_seconds]
    out["weekday"] = list(cal.local_weekday)
    out["holiday"] = [h if isinstance(h, str) else None for h in cal.federal_holiday]

    # ------------------------------------------------------------------ floor + machines
    locs = q("SELECT location_id, node_type, zone_id, bank_id, name, x_m, y_m FROM loc")
    out["floor"] = {
        "zones": q("SELECT location_id id, name, x_m x, y_m y FROM loc WHERE node_type='zone' ORDER BY 1").to_dict("records"),
        "slots": [{"id": a.location_id, "bank": a.bank_id, "zone": a.zone_id, "x": a.x_m, "y": a.y_m}
                  for a in locs[locs.node_type == "slot"].itertuples()],
        "entrances": q("SELECT location_id id, name, x_m x, y_m y, zone_id zone FROM loc WHERE node_type='entrance'").to_dict("records"),
        "outlets": q("SELECT location_id id, name, x_m x, y_m y, zone_id zone FROM loc WHERE node_type='outlet'").to_dict("records"),
        "walkways": [
            {**w, "closed_from": (str(w["closed_from_utc"])[:10] if pd.notna(w["closed_from_utc"]) else None),
             "closed_to": (str(w["closed_to_utc"])[:10] if pd.notna(w["closed_to_utc"]) else None)}
            for w in q("SELECT walkway_id id, zone_a a, zone_b b, length_m len, closed_from_utc, closed_to_utc, closure_reason reason FROM walk").to_dict("records")
        ],
    }
    for w in out["floor"]["walkways"]:
        w.pop("closed_from_utc", None); w.pop("closed_to_utc", None)
        if w["reason"] is None or (isinstance(w["reason"], float) and math.isnan(w["reason"])):
            w["reason"] = None
    zone_name = dict(q("SELECT location_id, name FROM loc WHERE node_type='zone'").values)
    out["zone_names"] = zone_name

    gm = q("SELECT * FROM gm ORDER BY config_id")
    out["configs"] = {g.config_id: {"theme": g.theme, "rtp": float(g.configured_rtp), "var": float(g.payout_multiplier_variance),
                                     "hit_p": float(g.hit_probability), "vol": g.volatility_class,
                                     "max_mult": float(g.max_multiplier), "bets": g.bet_options_cents}
                      for g in gm.itertuples()}

    mach = q("""SELECT m.machine_id, m.manufacturer, m.theme, m.install_date, m.retire_date, m.lease_class,
                       (SELECT any_value(config_id) FROM md WHERE md.machine_id=m.machine_id AND md.config_id IS NOT NULL) config_id
                FROM mach m ORDER BY m.machine_id""")
    mids = list(mach.machine_id)
    mi = {m: i for i, m in enumerate(mids)}
    out["machines"] = [{
        "id": m.machine_id, "mfr": m.manufacturer, "theme": m.theme, "cfg": m.config_id, "lease": m.lease_class,
        "install": str(m.install_date)[:10], "retire": (str(m.retire_date)[:10] if pd.notna(m.retire_date) else None),
    } for m in mach.itertuples()]

    # ------------------------------------------------------------------ machine x day (columnar)
    md = q("""
        SELECT md.machine_id, md.gaming_date, md.active, md.location_id,
               d.bank_id, d.zone_id,
               md.coin_in_cents/100.0 ci, md.house_win_cents/100.0 hw, md.theo_cents/100.0 theo,
               md.available_seconds/3600.0 avh, md.occupied_seconds/3600.0 occh, md.scheduled_seconds/3600.0 schh,
               md.paid_spins spins, md.payout_positive_spins hits,
               md.sum_bet_squared * g.payout_multiplier_variance / 10000.0 var_usd2,
               md.carded_coin_in_cents/100.0 cci,
               d.faults_opened faults, d.contribution_after_supplied_costs_usd contrib,
               d.lease_cost_usd + d.service_cost_usd + d.power_cost_usd + d.repair_cost_usd costs
        FROM md
        JOIN d USING (machine_id, gaming_date)
        LEFT JOIN gm g ON g.config_id = md.config_id
        ORDER BY 1, 2
    """)
    md["di"] = [di[x.strftime("%Y-%m-%d")] for x in pd.to_datetime(md.gaming_date)]
    md["mi"] = md.machine_id.map(mi)
    N, T = len(mids), len(dates)

    def grid(col, nd=2, fill=0.0):
        a = np.full((N, T), fill, dtype=float)
        sub = md[md.active]
        a[sub.mi.values, sub["di"].values] = sub[col].astype(float).fillna(fill).values
        return [[r(v, nd) if nd else int(round(v)) for v in row] for row in a]

    bank_list = sorted(locs[locs.node_type == "bank"].bank_id.dropna().unique().tolist())
    bank_idx = {b: i for i, b in enumerate(bank_list)}
    loc_list = sorted(locs[locs.node_type == "slot"].location_id.tolist())
    loc_idx = {l: i for i, l in enumerate(loc_list)}
    bank_zone = dict(locs[locs.node_type == "bank"][["bank_id", "zone_id"]].values)
    out["banks"] = [{"id": b, "zone": bank_zone.get(b)} for b in bank_list]
    out["locs"] = loc_list

    locg = np.full((N, T), -1, dtype=int)
    sub = md[md.active]
    locg[sub.mi.values, sub["di"].values] = [loc_idx[x] for x in sub.location_id]
    out["md"] = {
        "loc": locg.tolist(),               # -1 = not on floor that day
        "ci": grid("ci", 0), "hw": grid("hw", 0), "theo": grid("theo", 1),
        "avh": grid("avh", 2), "occh": grid("occh", 2), "schh": grid("schh", 2),
        "spins": grid("spins", 0), "hits": grid("hits", 0),
        "var": grid("var_usd2", 0),         # Var(house win) in $^2 = sum(bet^2) * payout-multiplier variance
        "cci": grid("cci", 0), "faults": grid("faults", 0), "contrib": grid("contrib", 0), "costs": grid("costs", 1),
    }
    # bank index derived from location
    slot_bank = dict(locs[locs.node_type == "slot"][["location_id", "bank_id"]].values)
    out["loc_bank"] = [bank_idx[slot_bank[l]] for l in loc_list]

    # ------------------------------------------------------------------ manager's list (as given)
    mgr = q("""SELECT machine_id, sum(house_win_usd) hw FROM d WHERE active GROUP BY 1 ORDER BY hw LIMIT 10""")
    out["manager_bottom10"] = list(mgr.machine_id)

    # ------------------------------------------------------------------ downtime & lost play (machine_hour)
    c.sql("""CREATE TABLE mhx AS SELECT machine_id, hour_start_utc, hour_start_local, local_hour, gaming_date, active,
                 available_seconds, coin_in_cents, location_id,
                 CASE WHEN active THEN greatest(0, 3600 - available_seconds) ELSE 0 END down_s
             FROM mh""")
    # expected coin-in per AVAILABLE hour for that machine at that local hour, computed on the full window
    c.sql("""CREATE TABLE rate AS SELECT machine_id, local_hour,
                 sum(coin_in_cents)/100.0 / nullif(sum(available_seconds)/3600.0, 0) ci_per_h
             FROM mhx WHERE active GROUP BY ALL""")
    c.sql("""CREATE TABLE lost AS SELECT x.machine_id, x.gaming_date, x.local_hour, dayofweek(x.hour_start_local) dow,
                 x.down_s/3600.0 down_h, x.down_s/3600.0 * coalesce(r.ci_per_h, 0) lost_ci,
                 x.down_s/3600.0 * coalesce(r.ci_per_h, 0) * (1 - g.configured_rtp) lost_theo
             FROM mhx x LEFT JOIN rate r USING (machine_id, local_hour)
             JOIN md USING (machine_id, gaming_date) JOIN gm g ON g.config_id = md.config_id
             WHERE x.down_s > 0""")
    lost_md = q("SELECT machine_id, gaming_date, sum(lost_ci) lci, sum(lost_theo) lth FROM lost GROUP BY ALL")
    lci = np.zeros((N, T)); lth = np.zeros((N, T))
    for row in lost_md.itertuples():
        i, t = mi[row.machine_id], di[row.gaming_date.strftime("%Y-%m-%d")]
        lci[i, t] = row.lci; lth[i, t] = row.lth
    out["md"]["lost_ci"] = [[int(round(v)) for v in row] for row in lci]
    out["md"]["lost_theo"] = [[r(v, 1) for v in row] for row in lth]
    heat = q("SELECT dow, local_hour, sum(down_h) h, sum(lost_theo) th FROM lost GROUP BY ALL ORDER BY 1,2")
    out["downtime_heat"] = [{"dow": int(a.dow), "hour": int(a.local_hour), "h": r(a.h, 1), "theo": r(a.th, 0)} for a in heat.itertuples()]

    # repair response vs staffing (shift = local clock: day 05-13, swing 13-21, grave 21-05)
    tk = q("""
        WITH t AS (
          SELECT o.*, CASE WHEN hour(opened_at_local) >= 5 AND hour(opened_at_local) < 13 THEN 'day'
                           WHEN hour(opened_at_local) >= 13 AND hour(opened_at_local) < 21 THEN 'swing' ELSE 'grave' END shift,
                 CAST(opened_at_local - INTERVAL 5 HOUR AS DATE) shift_date
          FROM ops o WHERE event_type = 'fault_repair')
        SELECT t.shift, r.planned_headcount planned, r.actual_headcount actual, count(*) n,
               avg(epoch(work_started_at_utc - opened_at_utc))/3600 wait_h,
               avg(epoch(available_at_utc - work_started_at_utc))/3600 fix_h,
               avg(epoch(available_at_utc - opened_at_utc))/3600 down_h
        FROM t LEFT JOIN ros r ON r.role = 'slot_tech' AND r.shift = t.shift AND r.gaming_date = t.shift_date
        GROUP BY ALL ORDER BY 1, 2, 3""")
    out["repair_staffing"] = [{"shift": a.shift, "planned": int(a.planned) if pd.notna(a.planned) else None,
                               "actual": int(a.actual) if pd.notna(a.actual) else None, "n": int(a.n),
                               "wait_h": r(a.wait_h), "fix_h": r(a.fix_h), "down_h": r(a.down_h)} for a in tk.itertuples()]
    tickets = q("""SELECT machine_id, CAST(opened_at_local - INTERVAL 6 HOUR AS DATE) gd, hour(opened_at_local) hr,
                          round(epoch(work_started_at_utc - opened_at_utc)/3600, 2) wait_h,
                          round(epoch(available_at_utc - opened_at_utc)/3600, 2) down_h, direct_cost_cents/100 cost
                   FROM ops WHERE event_type='fault_repair' ORDER BY opened_at_utc""")
    out["tickets"] = [[mi[a.machine_id], di.get(a.gd.strftime("%Y-%m-%d"), -1), int(a.hr), float(a.wait_h), float(a.down_h), float(a.cost)]
                      for a in tickets.itertuples()]
    out["ops_other"] = q("""SELECT machine_id, event_type, CAST(opened_at_local AS VARCHAR) at_local, location_id, direct_cost_cents/100 cost
                            FROM ops WHERE event_type <> 'fault_repair' ORDER BY opened_at_utc""").to_dict("records")
    roster = q("""SELECT gaming_date, shift, planned_headcount p, actual_headcount a FROM ros WHERE role='slot_tech' ORDER BY 1,2""")
    out["tech_roster"] = [[di[a.gaming_date.strftime("%Y-%m-%d")], a.shift, int(a.p), int(a.a)] for a in roster.itertuples()]

    # ------------------------------------------------------------------ property day + context
    pday = q("""SELECT p.*, w.tmax_c, w.prcp_mm FROM pday p LEFT JOIN wx w ON w.source_date = p.gaming_date ORDER BY gaming_date""")
    keep = ["coin_in_usd", "house_win_usd", "theo_usd", "available_machine_hours", "occupied_machine_hours", "carded_coin_in_share",
            "pos_cash_usd", "pos_cogs_usd", "comp_face_value_usd", "comp_cost_usd", "faults_opened", "incidents_reported",
            "total_zone_entries_observed", "counter_coverage_share", "machine_supplied_costs_usd", "tech_labor_cost_usd",
            "contribution_after_supplied_costs_usd", "active_machines", "tmax_c", "prcp_mm"]
    out["pday"] = {k: [r(v, 3) for v in pday[k].astype(float)] for k in keep}
    out["pday"]["events"] = [e if isinstance(e, str) else None for e in pday.events_active]

    ev = q("SELECT * FROM ev ORDER BY start_date")
    out["events"] = [{"id": e.event_id, "name": e.name, "type": e.event_type, "start": str(e.start_date)[:10], "end": str(e.end_date)[:10],
                      "announced": str(e.announced_date)[:10], "scope": e.local_scope,
                      "url": e.source_url if isinstance(e.source_url, str) else None} for e in ev.itertuples()]

    # zone traffic per gaming day (observed entries + coverage, never treating missing as zero)
    zt = q("""SELECT zone_id, CAST(hour_start_local - INTERVAL 6 HOUR AS DATE) gd,
                     sum(entries_count) e, sum(coverage_minutes)/60.0 cov_h
              FROM zt GROUP BY ALL""")
    zones = sorted(zone_name.keys())
    out["zones"] = zones
    ztr = {z: [None] * T for z in zones}; zcov = {z: [None] * T for z in zones}
    for a in zt.itertuples():
        k = a.gd.strftime("%Y-%m-%d")
        if k in di:
            ztr[a.zone_id][di[k]] = int(a.e) if pd.notna(a.e) else None
            zcov[a.zone_id][di[k]] = r(a.cov_h, 1)
    out["zone_traffic"] = ztr; out["zone_cov_h"] = zcov

    out["real"] = {
        "lvcva": q("SELECT month, visitor_volume, hotel_occupancy_ratio, convention_attendance, airport_en_deplaned_passengers, as_of_limitation FROM cv ORDER BY 1").to_dict("records"),
        "missouri": q("SELECT month, slot_units, handle_usd, agr_usd, agr_usd/handle_usd hold FROM bs ORDER BY 1").to_dict("records"),
        "survey": q("SELECT month, survey_metric, estimate, standard_error se, sample_size n, unit FROM vpm ORDER BY 2,1").to_dict("records"),
    }
    for k in out["real"]:
        for rec in out["real"][k]:
            for kk, vv in list(rec.items()):
                if isinstance(vv, (float, np.floating)):
                    rec[kk] = r(vv, 4)
                elif hasattr(vv, "item"):
                    rec[kk] = vv.item()

    # ------------------------------------------------------------------ Back Forty closure: difference-in-differences
    did = q("""SELECT CASE WHEN gaming_date < '2025-03-03' THEN 'before' WHEN gaming_date < '2025-04-07' THEN 'closed' ELSE 'after' END per,
                      zone_id = 'Z-B40' b40, sum(coin_in_usd)/sum(available_hours) ci_avh, sum(occupied_hours)/sum(available_hours) occ
               FROM d WHERE active GROUP BY ALL""")
    g = {(a.per, bool(a.b40)): a for a in did.itertuples()}
    rel = {p: g[(p, True)].ci_avh / g[(p, False)].ci_avh for p in ["before", "closed", "after"]}
    out["closure_did"] = {
        "walkway": "W-ENT-B40 (Main Entrance <-> Back Forty), renovation, 2025-03-03 to 2025-04-06",
        "rows": [{"period": p, "b40_ci_avh": r(g[(p, True)].ci_avh), "rest_ci_avh": r(g[(p, False)].ci_avh),
                  "b40_occ": r(g[(p, True)].occ, 4), "rest_occ": r(g[(p, False)].occ, 4), "ratio": r(rel[p], 4)} for p in ["before", "closed", "after"]],
        "did_effect": r(rel["closed"] / rel["before"] - 1, 4),
        "recovery": r(rel["after"] / rel["before"] - 1, 4),
    }

    # ------------------------------------------------------------------ model: daily floor coin-in forecast, time-based holdout
    pdf = pday[["gaming_date", "local_weekday", "coin_in_usd"]].copy()
    pdf["gaming_date"] = pd.to_datetime(pdf.gaming_date)
    pdf["y"] = pdf.coin_in_usd.astype(float)
    pdf["holiday"] = [isinstance(h, str) for h in cal.federal_holiday]

    # event flags known at the freeze date only (announced_date <= freeze). A promo announced later is invisible to the model.
    def flag(row, kind, known_only=True):
        for e in out["events"]:
            if e["start"] <= row.strftime("%Y-%m-%d") <= e["end"]:
                is_city = e["scope"] == "citywide"
                if (kind == "city" and is_city) or (kind == "promo" and not is_city):
                    if not known_only or pd.Timestamp(e["announced"]) <= FORECAST_FREEZE:
                        return 1.0
        return 0.0
    pdf["city"] = [flag(t, "city") for t in pdf.gaming_date]
    pdf["promo"] = [flag(t, "promo") for t in pdf.gaming_date]
    pdf["train"] = pdf.gaming_date <= pd.Timestamp(TRAIN_END)
    tr, te = pdf[pdf.train], pdf[~pdf.train]

    wd_order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    def design(df):
        X = [np.ones(len(df))]
        for w in wd_order[1:]:
            X.append((df.local_weekday == w).astype(float).values)
        X += [df.city.values, df.promo.values, df.holiday.astype(float).values]
        return np.column_stack(X)
    beta, *_ = np.linalg.lstsq(design(tr), np.log(tr.y.values), rcond=None)
    resid_tr = np.log(tr.y.values) - design(tr) @ beta
    smear = float(np.mean(np.exp(resid_tr)))  # Duan smearing for log back-transform
    pdf["f_model"] = np.exp(design(pdf) @ beta) * smear
    pdf["f_const"] = tr.y.mean()
    wd_mean = tr.groupby("local_weekday").y.mean()
    pdf["f_weekday"] = pdf.local_weekday.map(wd_mean)
    sd_log = float(np.std(resid_tr, ddof=design(tr).shape[1]))
    pdf["lo"] = pdf.f_model * math.exp(-1.96 * sd_log)
    pdf["hi"] = pdf.f_model * math.exp(1.96 * sd_log)

    def mae(a, b): return float(np.mean(np.abs(a - b)))
    def mape(a, b): return float(np.mean(np.abs(a - b) / a))
    te = pdf[~pdf.train]
    # exclude the post-freeze-announced promo week from a second MAE so the reader sees both
    te_np = te[[flag(t, "promo", known_only=False) == 0 for t in te.gaming_date]]
    scores = []
    for name, col in [("Constant training mean (baseline)", "f_const"), ("Weekday mean", "f_weekday"), ("Log-linear: weekday + known events + holiday", "f_model")]:
        scores.append({"name": name, "col": col,
                       "mae": r(mae(te.y, te[col]), 0), "mape": r(mape(te.y, te[col]), 4),
                       "mae_excl_promo": r(mae(te_np.y, te_np[col]), 0),
                       "bias": r(float(np.mean(te[col] - te.y)), 0),
                       "train_mae": r(mae(tr.y, pdf[pdf.train][col]), 0)})
    # lift attribution with the frozen model (out-of-sample) and for in-sample events (refit excluding the event)
    def lift_out_of_sample(start, end):
        m = (pdf.gaming_date >= start) & (pdf.gaming_date <= end)
        a, f = pdf[m].y.sum(), pdf[m].f_model.sum()
        # day-level uncertainty from training residual SD (log scale), independent days
        se = math.sqrt(float(np.sum((pdf[m].f_model * sd_log) ** 2)))
        return {"actual": r(a, 0), "forecast": r(f, 0), "lift": r(a - f, 0), "lift_pct": r(a / f - 1, 4), "se": r(se, 0), "days": int(m.sum())}
    def lift_refit(start, end):
        m = (pdf.gaming_date >= start) & (pdf.gaming_date <= end)
        trn = pdf[pdf.train & ~m].copy(); trn["promo"] = 0.0
        X = design(trn)
        b, *_ = np.linalg.lstsq(X, np.log(trn.y.values), rcond=None)
        rs = np.log(trn.y.values) - X @ b
        sm = float(np.mean(np.exp(rs))); sd = float(np.std(rs, ddof=X.shape[1]))
        ev_df = pdf[m].copy(); ev_df["promo"] = 0.0
        f = np.exp(design(ev_df) @ b) * sm
        a = ev_df.y.values
        return {"actual": r(a.sum(), 0), "forecast": r(f.sum(), 0), "lift": r(a.sum() - f.sum(), 0), "lift_pct": r(a.sum() / f.sum() - 1, 4),
                "se": r(math.sqrt(float(np.sum((f * sd) ** 2))), 0), "days": int(m.sum())}
    floor_hold = float(pday.theo_usd.sum() / pday.coin_in_usd.sum())
    lifts = {
        "Gilded Ace Winter Slot Tournament (Feb 21-23, in training: refit without it)": lift_refit("2025-02-21", "2025-02-23"),
        "Gilded Ace Locals Appreciation Week (Jun 9-15, announced after freeze: true holdout)": lift_out_of_sample("2025-06-09", "2025-06-15"),
        "EDC Las Vegas festival weekend (May 16-18, holdout)": lift_out_of_sample("2025-05-16", "2025-05-18"),
    }
    for v in lifts.values():
        v["theo_lift"] = r(v["lift"] * floor_hold, 0); v["theo_se"] = r(v["se"] * floor_hold, 0)
    out["model"] = {
        "target": "Daily floor coin-in (all play, USD)",
        "train": f"{dates[0]} to {TRAIN_END} ({int(pdf.train.sum())} days)",
        "test": f"{TEST_START} to {dates[-1]} ({int((~pdf.train).sum())} days)",
        "frozen": "Coefficients, weekday means and the constant were fit on training days only and frozen before scoring the holdout. Event flags use only events whose announced_date <= 2025-04-30; LVCVA/survey data (published after 2025) are not inputs.",
        "features": ["weekday (6 dummies)", "citywide event active (announced before freeze)", "property promotion active (announced before freeze)", "US federal holiday"],
        "coef": {n: r(b, 4) for n, b in zip(["intercept"] + [f"wd_{w}" for w in wd_order[1:]] + ["citywide_event", "property_promo", "holiday"], beta)},
        "sd_log": r(sd_log, 4),
        "scores": scores,
        "series": {"y": [r(v, 0) for v in pdf.y], "const": [r(v, 0) for v in pdf.f_const], "weekday": [r(v, 0) for v in pdf.f_weekday],
                    "model": [r(v, 0) for v in pdf.f_model], "lo": [r(v, 0) for v in pdf.lo], "hi": [r(v, 0) for v in pdf.hi]},
        "lifts": lifts,
        "floor_theo_hold": r(floor_hold, 5),
        "weekday_mean_train": {w: r(wd_mean.get(w), 0) for w in wd_order},
    }

    # ------------------------------------------------------------------ guests (carded only)
    c.sql("""CREATE TABLE pt AS SELECT player_id, any_value(opening_tier) tier, any_value(home_region) region,
                    coalesce(any_value(age_band), 'Unknown') age,
                    sum(tracked_coin_in_usd) ci, sum(tracked_payout_usd) po, sum(tracked_net_usd) net, sum(theo_usd) theo,
                    sum(comp_cost_usd) comp, sum(comp_face_value_usd) comp_face, sum(tracked_contribution_usd) contrib,
                    sum(observed_visits) visits, sum(carded_play_hours) play_hours, sum(linked_pos_cash_usd) pos_cash, sum(linked_pos_cogs_usd) pos_cogs
             FROM pp GROUP BY 1""")
    cube = q("""SELECT period_month m, opening_tier tier, home_region region, coalesce(age_band,'Unknown') age,
                       count(*) players, sum(observed_visits) visits, sum(tracked_coin_in_usd) ci, sum(tracked_payout_usd) po,
                       sum(tracked_net_usd) net, sum(theo_usd) theo, sum(comp_cost_usd) comp, sum(comp_face_value_usd) comp_face,
                       sum(comps_redeemed) comps, sum(tracked_contribution_usd) contrib, sum(linked_pos_cash_usd) pos_cash,
                       sum(linked_pos_cogs_usd) pos_cogs, sum(points_earned) pe, sum(points_redeemed) pr,
                       count(*) FILTER (WHERE tracked_net_usd > 0) ahead, count(*) FILTER (WHERE tracked_coin_in_usd > 0) gamers
                FROM pp GROUP BY ALL ORDER BY 1,2,3,4""")
    out["guest_cube_cols"] = list(cube.columns)
    out["guest_cube"] = [[(r(v, 2) if isinstance(v, (float, np.floating)) else (int(v) if isinstance(v, (int, np.integer)) else v)) for v in row] for row in cube.itertuples(index=False)]

    # whole-period concentration per group (players summed over months first)
    def conc(where: str, label: str):
        s = q(f"SELECT theo, net, ci FROM pt WHERE ci > 0 {('AND ' + where) if where else ''} ORDER BY theo DESC")
        if len(s) == 0:
            return None
        th = s.theo.values.astype(float); tot = th.sum(); n = len(th)
        cum = np.cumsum(th) / tot
        share = lambda p: float(cum[max(0, int(math.ceil(n * p)) - 1)])  # noqa: E731
        lorenz = [[r(p, 3), r(float(cum[max(0, int(math.ceil(n * p)) - 1)]), 4)] for p in np.linspace(0.01, 1, 40)]
        net = s.net.values.astype(float)
        bins = [-1e9, -5000, -1000, -500, -100, -25, 0, 25, 100, 500, 1e9]
        labels = ["< -$5k", "-$5k..-1k", "-$1k..-500", "-$500..-100", "-$100..-25", "-$25..0", "0..$25", "$25..100", "$100..500", "> $500"]
        hist = np.histogram(net, bins=bins)[0].tolist()
        gini = 1 - 2 * float(np.trapezoid(np.concatenate([[0], np.sort(th).cumsum() / tot]), dx=1 / n)) if hasattr(np, "trapezoid") else None
        return {"label": label, "players": n, "top1": r(share(0.01), 4), "top5": r(share(0.05), 4), "top10": r(share(0.10), 4), "top20": r(share(0.20), 4),
                "gini": r(gini, 4), "lorenz": lorenz, "net_hist": hist, "net_bins": labels, "ahead_share": r(float((net > 0).mean()), 4),
                "median_net": r(float(np.median(net)), 2), "theo": r(tot, 0), "net_total": r(float(net.sum()), 0)}
    groups = {"All tracked players": ""}
    for col in ["tier", "region", "age"]:
        for v in q(f"SELECT DISTINCT {col} FROM pt ORDER BY 1")[col]:
            groups[f"{col}:{v}"] = f"{col} = '{v}'"
    out["guest_conc"] = {k: conc(w, k) for k, w in groups.items()}

    # ------------------------------------------------------------------ comps / loyalty
    comp_w = q("""SELECT CAST(date_trunc('week', event_at_utc - INTERVAL 14 HOUR) AS DATE) wk, tier_before tier,
                         count(*) n, -sum(points_delta) pts, sum(face_value_cents)/100.0 face, sum(economic_cost_cents)/100.0 cost
                  FROM led WHERE event_type='redeem' GROUP BY ALL ORDER BY 1, 2""")
    out["comp_weekly"] = [{"wk": a.wk.strftime("%Y-%m-%d"), "tier": a.tier, "n": int(a.n), "pts": int(a.pts), "face": r(a.face), "cost": r(a.cost)} for a in comp_w.itertuples()]
    comp_d = q("""SELECT CAST(event_at_utc - INTERVAL 14 HOUR AS DATE) d, -sum(points_delta)/(sum(face_value_cents)/100.0) ppd, count(*) n
                  FROM led WHERE event_type='redeem' GROUP BY 1 ORDER BY 1""")
    out["comp_daily_ppd"] = {a.d.strftime("%Y-%m-%d"): [r(a.ppd, 3), int(a.n)] for a in comp_d.itertuples()}
    bt = q("""SELECT tier_before tier, event_at_utc >= TIMESTAMP '2025-05-01 13:00:00' after_change,
                     -sum(points_delta)/(sum(face_value_cents)/100.0) pts_per_face_usd, sum(economic_cost_cents)/(-sum(points_delta))/100.0 cost_per_pt,
                     count(*) n, sum(economic_cost_cents)/100.0 cost
              FROM led WHERE event_type='redeem' GROUP BY ALL ORDER BY 1, 2""")
    out["comp_change"] = [{"tier": a.tier, "after": bool(a.after_change), "pts_per_face_usd": r(a.pts_per_face_usd, 2),
                           "cost_per_1000pts": r(a.cost_per_pt * 1000, 2), "n": int(a.n), "cost": r(a.cost, 0)} for a in bt.itertuples()]
    items = q("""SELECT benefit_id, avg(face_value_cents)/100.0 face, avg(economic_cost_cents)/100.0 cost, count(*) n
                 FROM led WHERE event_type='redeem' GROUP BY 1 ORDER BY n DESC""")
    out["comp_items"] = [{"id": a.benefit_id, "face": r(a.face, 2), "cost": r(a.cost, 2), "n": int(a.n)} for a in items.itertuples()]
    bal = q("""SELECT sum(points_delta) FILTER (WHERE event_type='award') awarded, -sum(points_delta) FILTER (WHERE event_type='redeem') redeemed,
                      sum(economic_cost_cents) FILTER (WHERE event_type='redeem' AND event_at_utc <  TIMESTAMP '2025-05-01 13:00:00')/100.0
                        / (-sum(points_delta) FILTER (WHERE event_type='redeem' AND event_at_utc <  TIMESTAMP '2025-05-01 13:00:00')) c_pre,
                      sum(economic_cost_cents) FILTER (WHERE event_type='redeem' AND event_at_utc >= TIMESTAMP '2025-05-01 13:00:00')/100.0
                        / (-sum(points_delta) FILTER (WHERE event_type='redeem' AND event_at_utc >= TIMESTAMP '2025-05-01 13:00:00')) c_post
               FROM led""").iloc[0]
    # per-day redemption activity around the change to test "did behaviour respond?"
    pre = q("""SELECT count(*)/count(DISTINCT CAST(event_at_utc - INTERVAL 14 HOUR AS DATE)) per_day FROM led
               WHERE event_type='redeem' AND event_at_utc >= TIMESTAMP '2025-03-01 13:00:00' AND event_at_utc < TIMESTAMP '2025-05-01 13:00:00'""").iloc[0, 0]
    post = q("""SELECT count(*)/count(DISTINCT CAST(event_at_utc - INTERVAL 14 HOUR AS DATE)) per_day FROM led
                WHERE event_type='redeem' AND event_at_utc >= TIMESTAMP '2025-05-01 13:00:00' AND event_at_utc < TIMESTAMP '2025-07-01 13:00:00'""").iloc[0, 0]
    out["points_liability"] = {
        "awarded": int(bal.awarded), "redeemed": int(bal.redeemed), "outstanding": int(bal.awarded - bal.redeemed),
        "cost_per_1000_pre": r(bal.c_pre * 1000, 3), "cost_per_1000_post": r(bal.c_post * 1000, 3),
        "liability_pre_rate": r((bal.awarded - bal.redeemed) * bal.c_pre, 0), "liability_post_rate": r((bal.awarded - bal.redeemed) * bal.c_post, 0),
        "redemptions_per_day_mar_apr": r(pre, 1), "redemptions_per_day_may_jun": r(post, 1),
        "redeem_rate_of_awarded": r(bal.redeemed / bal.awarded, 4),
    }

    # ------------------------------------------------------------------ action catalog
    act = q("SELECT * FROM act ORDER BY action_type_id")
    out["actions"] = [{k: (None if (isinstance(v, float) and math.isnan(v)) else (v.item() if hasattr(v, "item") else v)) for k, v in rec.items()}
                      for rec in act.to_dict("records")]

    # ------------------------------------------------------------------ provenance
    out["meta"]["data_sha256"] = {p: next((f["sha256"] for f in json.loads((D / "manifest.json").read_text())["files"] if f["path"] == p + ".parquet"), None)
                                  for p in views.values()}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(out, separators=(",", ":"), default=str)
    Path(args.out).write_text(txt)
    print(f"wrote {args.out} ({len(txt)/1e6:.2f} MB), sha256={hashlib.sha256(txt.encode()).hexdigest()[:16]}")
    print(json.dumps({"scores": out["model"]["scores"], "lifts": lifts, "did": out["closure_did"], "liab": out["points_liability"],
                      "conc": {k: (v["top1"], v["top5"], v["top20"], v["ahead_share"]) for k, v in out["guest_conc"].items() if v}}, indent=1, default=str))


if __name__ == "__main__":
    main()
