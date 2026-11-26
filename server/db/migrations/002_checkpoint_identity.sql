-- Migration 002: Checkpoint configuration identity & scoped candle index
-- Prevents stale durable checkpoints from a different provider, account, symbol, or price basis
-- from being treated as current across process boundaries.

ALTER TABLE market_feed_checkpoints
  ADD COLUMN IF NOT EXISTS config_identity_hash TEXT NULL,
  ADD COLUMN IF NOT EXISTS provider TEXT NULL,
  ADD COLUMN IF NOT EXISTS price_basis TEXT NULL,
  ADD COLUMN IF NOT EXISTS policy_version TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_normalized_candles_scoped
  ON normalized_candles (provider, provider_symbol, price_basis, granularity, open_time_utc DESC)
  WHERE complete = TRUE;
