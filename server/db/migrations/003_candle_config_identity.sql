-- Migration 003: Scope normalized candles, natural unique keys, checkpoints, and revisions
-- by feed configuration identity (provider, environment, division, account scope hash, symbol, price basis, policy).
-- Safe for existing pre-003 rows: legacy rows receive config_identity_hash = 'legacy_unscoped'.

ALTER TABLE normalized_candles
  ADD COLUMN IF NOT EXISTS config_identity_hash TEXT NOT NULL DEFAULT 'legacy_unscoped',
  ADD COLUMN IF NOT EXISTS provider_env TEXT NULL,
  ADD COLUMN IF NOT EXISTS account_scope_hash TEXT NULL;

ALTER TABLE normalized_candles
  DROP CONSTRAINT IF EXISTS normalized_candles_natural_key;

ALTER TABLE normalized_candles
  DROP CONSTRAINT IF EXISTS normalized_candles_scoped_natural_key;

ALTER TABLE normalized_candles
  ADD CONSTRAINT normalized_candles_scoped_natural_key UNIQUE (
    config_identity_hash,
    provider,
    provider_symbol,
    price_basis,
    granularity,
    open_time_utc
  );

CREATE INDEX IF NOT EXISTS idx_normalized_candles_config_identity
  ON normalized_candles (
    config_identity_hash,
    provider,
    provider_symbol,
    price_basis,
    granularity,
    open_time_utc DESC
  )
  WHERE complete = TRUE;

ALTER TABLE market_feed_checkpoints
  ADD COLUMN IF NOT EXISTS provider_env TEXT NULL,
  ADD COLUMN IF NOT EXISTS account_scope_hash TEXT NULL;

ALTER TABLE candle_revision_events
  ADD COLUMN IF NOT EXISTS config_identity_hash TEXT NOT NULL DEFAULT 'legacy_unscoped';
