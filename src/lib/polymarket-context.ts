export function polymarketDataContext(): string {
  return `# Polymarket data reference (visual_db)

Scope of loaded data:
- polymarket.markets: full snapshot (all loaded rows, no time filter)
- polymarket.trades: April 2026 only 
- Missing by design: raw on-chain fee fields, users rollups, quant-style pre-normalized YES view, and full multi-month trade history

If a user asks for out-of-scope data, state that explicitly.

Join and grain:
- markets grain: one row per market; primary key is markets.id
- trades grain: one row per matched trade (maker/taker match)
- join key: trades.market_id = markets.id

Gotchas:
1. trades.price is not normalized to YES perspective when nonusdc_side='token2'.
   Use yes-normalized price when comparing prices across outcomes:
   multiIf(nonusdc_side = 'token1', price, 1 - price) AS yes_price
2. markets.volume is lifetime market volume, not April-only subset volume.
   For April analytics use sum(trades.usd_amount) in the selected time window.
3. trades only contains April 2026. Queries for other months can return zero rows without errors.
4. No raw fee columns (maker_fee, protocol_fee, raw wei amounts) are loaded.
5. No per-user rollup table is loaded. Approximate from maker/taker + maker_direction/taker_direction.

Text search (polymarket.markets):
- Text indexes exist on lower(question) and lower(event_title).
- For keyword search in ClickHouse on these columns, use hasToken / hasAnyTokens / hasAllTokens.
- Do not use match()/regexp for keyword search, and prefer token search over LIKE.
- Always wrap indexed columns in lower(...) so the text index can be used.

Query patterns:
- April volume by market:
  SELECT market_id, sum(usd_amount) AS april_volume_usd FROM polymarket.trades GROUP BY market_id ORDER BY april_volume_usd DESC
- Daily normalized YES trend for one market:
  SELECT toDate(trade_time) AS day, avg(multiIf(nonusdc_side = 'token1', price, 1 - price)) AS avg_yes_price
  FROM polymarket.trades
  WHERE market_id = '{market_id}'
  GROUP BY day
  ORDER BY day
- Single keyword in question:
  SELECT id, question FROM polymarket.markets
  WHERE hasToken(lower(question), 'bitcoin')
  SETTINGS max_execution_time = 30, timeout_before_checking_execution_speed = 0
- Any of several keywords in event_title (OR):
  SELECT id, event_title FROM polymarket.markets
  WHERE hasAnyTokens(lower(event_title), 'bitcoin ethereum solana')
  SETTINGS max_execution_time = 30, timeout_before_checking_execution_speed = 0
- All keywords required in question (AND):
  SELECT id, question FROM polymarket.markets
  WHERE hasAllTokens(lower(question), ['election', '2028'])
  SETTINGS max_execution_time = 30, timeout_before_checking_execution_speed = 0`;
}