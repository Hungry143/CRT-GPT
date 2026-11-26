-- Migration 001: Stage 2A persistent market-data schema
-- Strictly read/write market-data telemetry only; zero broker order/trade/position tables.

CREATE TABLE IF NOT EXISTS normalized_candles (
  source_candle_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  granularity TEXT NOT NULL,
  price_basis TEXT NOT NULL,
  open_time_utc TIMESTAMPTZ NOT NULL,
  close_time_utc TIMESTAMPTZ NOT NULL,
  open_price NUMERIC NOT NULL,
  high_price NUMERIC NOT NULL,
  low_price NUMERIC NOT NULL,
  close_price NUMERIC NOT NULL,
  volume INTEGER NULL,
  complete BOOLEAN NOT NULL,
  source_retrieved_at_utc TIMESTAMPTZ NOT NULL,
  CONSTRAINT normalized_candles_natural_key UNIQUE (
    provider,
    provider_symbol,
    price_basis,
    granularity,
    open_time_utc
  ),
  CONSTRAINT normalized_candles_ohlc_positive CHECK (
    open_price > 0 AND high_price > 0 AND low_price > 0 AND close_price > 0
  ),
  CONSTRAINT normalized_candles_ohlc_bounds CHECK (
    high_price >= open_price
    AND high_price >= close_price
    AND high_price >= low_price
    AND low_price <= open_price
    AND low_price <= close_price
  ),
  CONSTRAINT normalized_candles_time_order CHECK (
    close_time_utc > open_time_utc
  )
);

CREATE INDEX IF NOT EXISTS idx_normalized_candles_lookup
  ON normalized_candles (granularity, provider_symbol, open_time_utc DESC)
  WHERE complete = TRUE;

CREATE TABLE IF NOT EXISTS candle_revision_events (
  id BIGSERIAL PRIMARY KEY,
  source_candle_id TEXT NOT NULL,
  detected_at_utc TIMESTAMPTZ NOT NULL,
  changed_fields TEXT[] NOT NULL,
  previous_close NUMERIC NOT NULL,
  revised_close NUMERIC NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candle_revision_events_candle
  ON candle_revision_events (source_candle_id, detected_at_utc DESC);

CREATE TABLE IF NOT EXISTS market_feed_checkpoints (
  checkpoint_key TEXT PRIMARY KEY,
  adapter_name TEXT NOT NULL,
  provider_symbol TEXT NULL,
  state TEXT NOT NULL,
  provider_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_successful_request_utc TIMESTAMPTZ NULL,
  last_provider_candle_open_utc TIMESTAMPTZ NULL,
  last_complete_candle_close_utc TIMESTAMPTZ NULL,
  missing_bar_count INTEGER NULL,
  duplicate_bar_count INTEGER NULL,
  reason_code TEXT NULL,
  warnings TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
