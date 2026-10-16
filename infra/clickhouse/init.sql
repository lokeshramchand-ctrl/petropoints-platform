-- Analytics warehouse (ClickHouse). Apply with: clickhouse-client --multiquery < init.sql
-- Layers: bronze = raw events in S3/MinIO (Parquet/JSONL, not here) -> silver = typed + deduped -> gold = serving aggregates.

CREATE DATABASE IF NOT EXISTS analytics;

-- SILVER: one row per business event. ReplacingMergeTree keyed on event_id absorbs the at-least-once
-- duplicates the bus can deliver; queries use FINAL (or argMax) when exact counts matter.
CREATE TABLE IF NOT EXISTS analytics.points_events
(
    event_id        UUID,
    event_type      LowCardinality(String),
    occurred_at     DateTime64(3, 'UTC'),
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),
    transaction_id  UUID,
    customer_id     UUID,
    merchant_id     Nullable(UUID),
    outlet_id       Nullable(UUID),
    points          Int64,                 -- signed effect on the customer's wallet
    amount_paise    Nullable(Int64),
    fuel_type       LowCardinality(Nullable(String)),
    original_type   LowCardinality(Nullable(String))   -- set on reversals: EARN | REDEEM
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (merchant_id, toDate(occurred_at), event_id)
TTL toDateTime(occurred_at) + INTERVAL 5 YEAR;

-- GOLD: daily merchant/outlet rollups maintained incrementally by a materialized view.
CREATE TABLE IF NOT EXISTS analytics.daily_outlet_stats
(
    day             Date,
    merchant_id     Nullable(UUID),
    outlet_id       Nullable(UUID),
    earned          SimpleAggregateFunction(sum, Int64),
    redeemed        SimpleAggregateFunction(sum, Int64),
    sales_paise     SimpleAggregateFunction(sum, Int64),
    txns            SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (day, merchant_id, outlet_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_outlet_stats_mv
TO analytics.daily_outlet_stats AS
SELECT
    toDate(occurred_at, 'Asia/Kolkata')                   AS day,  -- business day in IST, not UTC
    merchant_id,
    outlet_id,
    -- reversals net out the original: reversing an EARN has negative points, reversing a REDEEM positive
    sumIf(points, event_type = 'points.earned.v1')
      + sumIf(points, event_type = 'points.reversed.v1' AND original_type = 'EARN')      AS earned,
    sumIf(-points, event_type = 'points.redeemed.v1')
      - sumIf(points, event_type = 'points.reversed.v1' AND original_type = 'REDEEM')    AS redeemed,
    sumIf(ifNull(amount_paise, 0), event_type = 'points.earned.v1')
      - sumIf(ifNull(amount_paise, 0), event_type = 'points.reversed.v1' AND original_type = 'EARN') AS sales_paise,
    count()                                               AS txns
FROM analytics.points_events
GROUP BY day, merchant_id, outlet_id;

-- GOLD: customer activity for cohort / churn analysis.
CREATE TABLE IF NOT EXISTS analytics.customer_activity
(
    customer_id  UUID,
    first_seen   SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    last_seen    SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    lifetime_points_earned SimpleAggregateFunction(sum, Int64),
    lifetime_points_redeemed SimpleAggregateFunction(sum, Int64)
)
ENGINE = AggregatingMergeTree
ORDER BY customer_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.customer_activity_mv
TO analytics.customer_activity AS
SELECT
    customer_id,
    min(occurred_at) AS first_seen,
    max(occurred_at) AS last_seen,
    sumIf(points, event_type = 'points.earned.v1')    AS lifetime_points_earned,
    sumIf(-points, event_type = 'points.redeemed.v1') AS lifetime_points_redeemed
FROM analytics.points_events
GROUP BY customer_id;
