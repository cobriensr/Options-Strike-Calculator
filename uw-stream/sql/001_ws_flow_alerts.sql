-- Migration 001 — ws_flow_alerts + ws_flow_alerts_enriched
--
-- Run once against Neon before deploying the daemon for the first time:
--   psql "$DATABASE_URL" -f uw-stream/sql/001_ws_flow_alerts.sql
--
-- This DDL is also intended to be ported into api/_lib/db-migrations.ts
-- as a numbered migration so api/journal/init.ts re-creates it on a
-- fresh DB. We keep the standalone file because the daemon ships
-- ahead of any api/ change and Railway can run psql before the
-- corresponding migration lands.
--
-- Design decisions:
-- - Raw payload fields only in the table. Derived signals (dte_at_alert,
--   moneyness, etc.) live in the ws_flow_alerts_enriched view so the math
--   stays centralised and re-runnable.
-- - The full OCC option_chain symbol is preserved alongside parsed
--   strike/expiry/option_type so /option-contract/{symbol}/* REST lookups
--   still work without re-stringification.
-- - issue_type is populated by the daemon from a hardcoded ticker → type
--   lookup (Index for SPX/SPXW/NDX/RUT, ETF for SPY/QQQ/IWM/DIA, etc.).
-- - This table is independent of the cron-fed flow_alerts table. The two
--   coexist during the soak window described in
--   docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md.

CREATE TABLE IF NOT EXISTS ws_flow_alerts (
    id BIGSERIAL PRIMARY KEY,

    -- WS-side identity. UW emits a per-alert UUID (`id` in the WS
    -- payload) which is the natural dedupe key. We make it NOT NULL so
    -- the daemon's _transform must reject any payload missing it
    -- rather than silently inserting a NULL alert id. The unique
    -- index below enforces it.
    ws_alert_id UUID NOT NULL,
    rule_id UUID,
    rule_name TEXT,

    -- Contract identification.
    ticker TEXT NOT NULL,
    option_chain TEXT NOT NULL,
    issue_type TEXT,                  -- daemon lookup; never null in practice
    expiry DATE NOT NULL,             -- parsed from option_chain
    strike NUMERIC(10, 3) NOT NULL,   -- parsed from option_chain
    option_type CHAR(1) NOT NULL,     -- 'C' or 'P', parsed from option_chain
    CONSTRAINT ws_flow_alerts_option_type_chk CHECK (option_type IN ('C', 'P')),

    -- Timing. created_at is derived from WS executed_at (ms epoch → UTC TIMESTAMPTZ).
    created_at TIMESTAMPTZ NOT NULL,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Pricing.
    price NUMERIC(12, 4),
    underlying_price NUMERIC(12, 4),
    bid NUMERIC(12, 4),
    ask NUMERIC(12, 4),

    -- Flow stats.
    volume INTEGER,
    total_size INTEGER,
    total_premium NUMERIC(18, 2),
    total_ask_side_prem NUMERIC(18, 2),
    total_bid_side_prem NUMERIC(18, 2),
    open_interest INTEGER,
    volume_oi_ratio NUMERIC(10, 4),
    trade_count INTEGER,
    expiry_count INTEGER,

    -- Side breakdown.
    ask_vol INTEGER,
    bid_vol INTEGER,
    no_side_vol INTEGER,
    mid_vol INTEGER,
    multi_vol INTEGER,
    stock_multi_vol INTEGER,

    -- Boolean flags.
    has_multileg BOOLEAN,
    has_sweep BOOLEAN,
    has_floor BOOLEAN,
    has_singleleg BOOLEAN,
    all_opening_trades BOOLEAN,

    -- Array fields kept as JSONB for flexibility.
    upstream_condition_details JSONB,
    exchanges JSONB,
    trade_ids JSONB,

    -- Misc.
    url TEXT,
    raw_payload JSONB NOT NULL
);

-- Dedupe key: the per-alert UUID UW emits in the WS payload's `id`
-- field. Two distinct UW rules firing on the same contract within the
-- same millisecond emit different UUIDs, so this is the only key that
-- preserves them as separate rows.
CREATE UNIQUE INDEX IF NOT EXISTS ws_flow_alerts_alert_id_uq
    ON ws_flow_alerts (ws_alert_id);

-- Common access patterns.
CREATE INDEX IF NOT EXISTS ws_flow_alerts_chain_created_idx
    ON ws_flow_alerts (option_chain, created_at);
CREATE INDEX IF NOT EXISTS ws_flow_alerts_created_at_idx
    ON ws_flow_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS ws_flow_alerts_ticker_created_idx
    ON ws_flow_alerts (ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS ws_flow_alerts_rule_name_idx
    ON ws_flow_alerts (rule_name);
CREATE INDEX IF NOT EXISTS ws_flow_alerts_expiry_strike_idx
    ON ws_flow_alerts (expiry, strike);

-- Enriched view: read-time derived fields. All math here is deterministic
-- from columns in the underlying row, so the view can be materialised
-- later if read latency ever becomes an issue.
CREATE OR REPLACE VIEW ws_flow_alerts_enriched AS
SELECT
    a.*,

    -- Days to expiry at alert time. Cast both sides to date in US/Central
    -- so an after-3pm-UTC alert on a same-day expiry still computes 0 DTE.
    (a.expiry - (a.created_at AT TIME ZONE 'America/Chicago')::date) AS dte_at_alert,

    -- Strike vs spot.
    (a.strike - a.underlying_price) AS distance_from_spot,
    CASE
        WHEN a.underlying_price IS NULL OR a.underlying_price = 0 THEN NULL
        ELSE (a.strike - a.underlying_price) / a.underlying_price
    END AS distance_pct,

    -- Moneyness (binary ITM flag + textual classification).
    CASE
        WHEN a.option_type = 'C' AND a.strike < a.underlying_price THEN TRUE
        WHEN a.option_type = 'P' AND a.strike > a.underlying_price THEN TRUE
        ELSE FALSE
    END AS is_itm,
    CASE
        WHEN a.underlying_price IS NULL THEN 'unknown'
        WHEN a.option_type = 'C' AND a.strike < a.underlying_price THEN 'itm'
        WHEN a.option_type = 'C' AND a.strike > a.underlying_price THEN 'otm'
        WHEN a.option_type = 'P' AND a.strike > a.underlying_price THEN 'itm'
        WHEN a.option_type = 'P' AND a.strike < a.underlying_price THEN 'otm'
        ELSE 'atm'
    END AS moneyness,

    -- Session-relative time. minute_of_day is wall-clock minutes in
    -- US/Central (regular session = 510..899 inclusive).
    (
        EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/Chicago') * 60
        + EXTRACT(MINUTE FROM a.created_at AT TIME ZONE 'America/Chicago')
    )::INTEGER AS minute_of_day,
    (
        EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/Chicago') * 60
        + EXTRACT(MINUTE FROM a.created_at AT TIME ZONE 'America/Chicago')
        - 510
    )::INTEGER AS session_elapsed_min,
    EXTRACT(DOW FROM a.created_at AT TIME ZONE 'America/Chicago')::INTEGER AS day_of_week,

    -- Premium-side ratios. Guarded against zero denominator.
    CASE
        WHEN a.total_premium IS NULL OR a.total_premium = 0 THEN NULL
        ELSE a.total_ask_side_prem / a.total_premium
    END AS ask_side_ratio,
    CASE
        WHEN a.total_premium IS NULL OR a.total_premium = 0 THEN NULL
        ELSE a.total_bid_side_prem / a.total_premium
    END AS bid_side_ratio,
    (COALESCE(a.total_ask_side_prem, 0) - COALESCE(a.total_bid_side_prem, 0)) AS net_premium

FROM ws_flow_alerts a;
