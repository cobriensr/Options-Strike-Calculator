-- Migration 002 — ws_option_trades
--
-- Run once against Neon before deploying the daemon with the
-- option_trades channels enabled:
--
--   psql "$DATABASE_URL" -f uw-stream/sql/002_ws_option_trades.sql
--
-- This DDL is the daemon-side mirror of api/_lib/db-migrations.ts
-- migration #109. We keep the standalone file because the daemon ships
-- ahead of the Vercel deploy and Railway can run psql before the
-- corresponding api/ migration lands. Once Vercel runs migrate-db, the
-- IF NOT EXISTS guards make this file a no-op on subsequent runs.
--
-- Design decisions:
-- - Per-ticker subscription (option_trades:<TICKER>) keeps daily volume
--   to ~1-3M rows/day for the ~50-ticker Lottery Finder universe vs
--   6-10M rows/day for the global option_trades firehose.
-- - ws_trade_id (the UUID UW emits in the WS payload) is the natural
--   dedupe key — NOT NULL UNIQUE so the daemon must reject malformed
--   payloads at the boundary rather than risk a NULL violation later.
-- - raw_payload kept as JSONB for forward-compat — per-trade volume
--   makes JSONB cheaper than wide-row extracted columns (~500 bytes
--   payload vs ~12 typed columns).
-- - A retention cron (TODO, separate spec) will DELETE rows older than
--   7 days to bound table size.

CREATE TABLE IF NOT EXISTS ws_option_trades (
    id BIGSERIAL PRIMARY KEY,

    -- WS-side identity. UW emits a per-trade UUID on the option_trades
    -- channel. NOT NULL so the daemon rejects malformed payloads up
    -- front (mirrors the ws_alert_id pattern in ws_flow_alerts).
    ws_trade_id UUID NOT NULL,

    -- Contract identification.
    ticker TEXT NOT NULL,
    option_chain TEXT NOT NULL,        -- OCC OSI symbol, e.g. "SPY260502C00500000"
    option_type CHAR(1) NOT NULL,      -- 'C' or 'P', parsed from option_chain
    CONSTRAINT ws_option_trades_option_type_chk CHECK (option_type IN ('C', 'P')),
    strike NUMERIC(10, 3) NOT NULL,    -- parsed from option_chain
    expiry DATE NOT NULL,              -- parsed from option_chain

    -- Timing. executed_at is derived from the WS payload's tape time
    -- (ms epoch → UTC TIMESTAMPTZ). received_at is the daemon's local
    -- write time — the gap is the end-to-end latency we instrument.
    executed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Trade fields.
    price NUMERIC(12, 4) NOT NULL,
    size INTEGER NOT NULL,
    underlying_price NUMERIC(12, 4),
    side TEXT NOT NULL,                -- 'ask' | 'bid' | 'mid' | 'no_side'
    CONSTRAINT ws_option_trades_side_chk
        CHECK (side IN ('ask', 'bid', 'mid', 'no_side')),

    -- Greeks at trade time (used by the v4 trigger 5-min rolling means).
    implied_volatility NUMERIC(10, 6),
    delta NUMERIC(10, 6),

    -- Open interest snapshot at trade time. The detector takes
    -- max(open_interest) per chain per day so a single non-null
    -- value per chain is sufficient.
    open_interest INTEGER,

    -- Cancellation flag. UW emits canceled trades; the detector
    -- filters these out (matches the parquet data convention).
    canceled BOOLEAN NOT NULL DEFAULT FALSE,

    -- Optional context retained as JSONB for forward-compat.
    -- Holds anything the daemon doesn't extract into typed columns
    -- (exchange, sip flags, sale_cond_codes, etc.).
    raw_payload JSONB NOT NULL
);

-- Dedupe key.
CREATE UNIQUE INDEX IF NOT EXISTS ws_option_trades_trade_id_uq
    ON ws_option_trades (ws_trade_id);

-- Primary read pattern: detector reads recent trades for one chain
-- (WHERE option_chain = X AND executed_at >= now - 5min).
CREATE INDEX IF NOT EXISTS ws_option_trades_chain_executed_idx
    ON ws_option_trades (option_chain, executed_at DESC);

-- Per-ticker browsing + per-ticker scan for the trigger fan-out.
CREATE INDEX IF NOT EXISTS ws_option_trades_ticker_executed_idx
    ON ws_option_trades (ticker, executed_at DESC);

-- Retention cron + global time-window queries.
CREATE INDEX IF NOT EXISTS ws_option_trades_executed_idx
    ON ws_option_trades (executed_at);
