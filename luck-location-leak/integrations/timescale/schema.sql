-- Best Use of Tiger Data: the 1.3M-row machine_hour table as a TimescaleDB hypertable,
-- with a continuous aggregate that powers /api/hourly (daily coin-in, downtime, hit rate per machine)
-- and a "payout fingerprint" alert query that catches M-1158 on its first day of data.
-- Run with: python integrations/timescale/load.py --schema-only   (or psql "$TIMESCALE_URL" -f schema.sql)

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS machine_hour (
  machine_id            text        NOT NULL,
  hour_start_utc        timestamptz NOT NULL,
  local_hour            int,
  gaming_date           date,
  location_id           text,
  active                boolean,
  available_seconds     int,
  occupied_seconds      int,
  paid_spins            bigint,
  payout_positive_spins bigint,
  coin_in_cents         bigint,
  payout_cents          bigint,
  PRIMARY KEY (machine_id, hour_start_utc)
);
SELECT create_hypertable('machine_hour', by_range('hour_start_utc', INTERVAL '7 days'), if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS game_config (machine_id text PRIMARY KEY, config_id text, hit_probability double precision, configured_rtp double precision);

-- daily rollup per machine (UTC-day buckets; the dashboard itself uses 06:00 gaming days)
CREATE MATERIALIZED VIEW IF NOT EXISTS machine_daily_cagg
WITH (timescaledb.continuous) AS
SELECT machine_id,
       time_bucket(INTERVAL '1 day', hour_start_utc)                       AS bucket,
       sum(coin_in_cents) / 100.0                                          AS coin_in_usd,
       sum(CASE WHEN active THEN 3600 - available_seconds ELSE 0 END) / 3600.0 AS down_hours,
       sum(payout_positive_spins)::float / NULLIF(sum(paid_spins), 0)      AS hit_rate,
       sum(paid_spins)                                                     AS spins
FROM machine_hour
GROUP BY machine_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('machine_daily_cagg', start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE);

ALTER TABLE machine_hour SET (timescaledb.compress, timescaledb.compress_segmentby = 'machine_id');
SELECT add_compression_policy('machine_hour', INTERVAL '30 days', if_not_exists => TRUE);

-- Payout fingerprint alert: machines whose hit rate in [t0, t1) deviates > 5 sigma from the published paytable.
-- SELECT * FROM payout_fingerprint('2025-01-01 14:00+00', '2025-01-02 14:00+00');   -- M-1158 is already flagged
CREATE OR REPLACE FUNCTION payout_fingerprint(t0 timestamptz, t1 timestamptz)
RETURNS TABLE (machine_id text, spins bigint, hit_rate double precision, published double precision, z double precision) AS $$
  SELECT h.machine_id, sum(h.paid_spins)::bigint, sum(h.payout_positive_spins)::float / sum(h.paid_spins), g.hit_probability,
         (sum(h.payout_positive_spins) - sum(h.paid_spins) * g.hit_probability)
           / sqrt(sum(h.paid_spins) * g.hit_probability * (1 - g.hit_probability))
  FROM machine_hour h JOIN game_config g USING (machine_id)
  WHERE h.hour_start_utc >= t0 AND h.hour_start_utc < t1 AND h.paid_spins > 0
  GROUP BY h.machine_id, g.hit_probability
  HAVING abs((sum(h.payout_positive_spins) - sum(h.paid_spins) * g.hit_probability)
           / sqrt(sum(h.paid_spins) * g.hit_probability * (1 - g.hit_probability))) > 5
$$ LANGUAGE sql STABLE;
