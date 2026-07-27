-- 2. Markets (reference table, full load — ~1M rows, small)
CREATE TABLE polymarket.markets
(
    id             String,
    question       String,
    slug           String,
    condition_id   String,
    token1         String,
    token2         String,
    answer1        String,
    answer2        String,
    closed         UInt8,
    active         UInt8,
    archived       UInt8,
    outcome_prices String,
    volume         Float64,
    event_id       String,
    event_slug     String,
    event_title    String,
    created_at     DateTime64(3, 'UTC'),
    end_date       DateTime64(3, 'UTC'),
    updated_at     DateTime64(3, 'UTC'),
    neg_risk       UInt8
)
ENGINE = MergeTree
ORDER BY id;

INSERT INTO polymarket.markets
SELECT *
FROM url(
  'https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet',
  'Parquet'
)
SETTINGS max_http_get_redirects = 1, enable_url_encoding = 0,
         max_execution_time = 300, timeout_before_checking_execution_speed = 0;
