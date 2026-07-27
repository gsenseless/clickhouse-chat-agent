-- 3. Trades (subset — April 2026 only), partitioned by month so future months can be added cleanly
CREATE TABLE polymarket.trades
(
    timestamp        UInt64,
    trade_time       DateTime MATERIALIZED toDateTime(timestamp),
    block_number     UInt64,
    transaction_hash String,
    log_index        UInt32,
    contract         String,
    market_id        String,
    condition_id     String,
    event_id         String,
    maker            String,
    taker            String,
    price            Float64,
    usd_amount       Float64,
    token_amount     Float64,
    maker_direction  String,
    taker_direction  String,
    nonusdc_side     String,
    asset_id         String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(trade_time)
ORDER BY (market_id, timestamp);

INSERT INTO polymarket.trades
(timestamp, block_number, transaction_hash, log_index, contract, market_id, condition_id,
 event_id, maker, taker, price, usd_amount, token_amount, maker_direction, taker_direction,
 nonusdc_side, asset_id)
SELECT timestamp, block_number, transaction_hash, log_index, contract, market_id, condition_id,
       event_id, maker, taker, price, usd_amount, token_amount, maker_direction, taker_direction,
       nonusdc_side, asset_id
FROM url(
  'https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data/resolve/refs%2Fconvert%2Fparquet/default/train/0004.parquet',
  'Parquet'
)
WHERE timestamp >= 1775001600 AND timestamp < 1777593600  -- 2026-04-01 00:00:00 to 2026-05-01 00:00:00 UTC
SETTINGS max_http_get_redirects = 1, enable_url_encoding = 0,
         max_execution_time = 1800, timeout_before_checking_execution_speed = 0;