"""Create the Tiger Data schema and load machine_hour (1.3M rows) with COPY. No psql needed.

    pip install -r requirements.txt            (includes psycopg and duckdb)
    put TIMESCALE_URL=postgres://tsdbadmin:...@....tsdb.cloud.timescale.com:5432/tsdb?sslmode=require in .env
    python integrations/timescale/load.py --data path/to/dashboard-royale/data
    python integrations/timescale/load.py --schema-only        (just create tables/views)
"""
import argparse
import os
import re
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.strip().strip('"').strip("'")
                if v:
                    os.environ.setdefault(k.strip(), v)


def statements(sql: str):
    """Split schema.sql into statements; $$-quoted function bodies are kept whole."""
    sql = re.sub(r"--[^\n]*", "", sql)
    out, buf, in_dollar = [], [], False
    for part in re.split(r"(\$\$|;)", sql):
        if part == "$$":
            in_dollar = not in_dollar
            buf.append(part)
        elif part == ";" and not in_dollar:
            s = "".join(buf).strip()
            if s:
                out.append(s)
            buf = []
        else:
            buf.append(part)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="release data/ folder (needed unless --schema-only)")
    ap.add_argument("--schema-only", action="store_true")
    a = ap.parse_args()
    load_env()
    url = os.environ.get("TIMESCALE_URL")
    if not url:
        raise SystemExit("TIMESCALE_URL is not set (add it to .env)")

    with psycopg.connect(url, autocommit=True) as con:  # caggs cannot be created inside a transaction
        for st in statements((HERE / "schema.sql").read_text(encoding="utf-8")):
            con.execute(st)
        print("schema ready")
        if a.schema_only:
            return
        if not a.data:
            raise SystemExit("--data is required to load rows")
        import duckdb
        D = Path(a.data)
        rows = duckdb.sql(f"""
            SELECT machine_id, hour_start_utc, local_hour, gaming_date, location_id, active, available_seconds, occupied_seconds,
                   paid_spins, payout_positive_spins, coin_in_cents, payout_cents
            FROM '{(D / "5_optional/machine_hour.parquet").as_posix()}'""").fetchall()
        cfg = duckdb.sql(f"""
            SELECT m.machine_id, any_value(m.config_id), any_value(g.hit_probability)::double, any_value(g.configured_rtp)::double
            FROM '{(D / "2_machine_decision/machine_day.parquet").as_posix()}' m
            JOIN '{(D / "2_machine_decision/game_math.parquet").as_posix()}' g USING (config_id) GROUP BY 1""").fetchall()
        with con.transaction():
            with con.cursor() as cur:
                cur.execute("TRUNCATE machine_hour; TRUNCATE game_config;")
                with cur.copy("COPY machine_hour FROM STDIN") as cp:
                    for r in rows:
                        cp.write_row(r)
                cur.executemany("INSERT INTO game_config VALUES (%s,%s,%s,%s)", cfg)
        con.execute("CALL refresh_continuous_aggregate('machine_daily_cagg', NULL, NULL)")
        print(f"loaded {len(rows):,} machine-hours")
        print("first-day payout fingerprint alerts:",
              con.execute("SELECT * FROM payout_fingerprint('2025-01-01 14:00+00', '2025-01-02 14:00+00')").fetchall())


if __name__ == "__main__":
    main()
