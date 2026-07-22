export function polymarketDataContext(): string {
  return `# Polymarket data reference (visual_db)

Scope of loaded data:
- polymarket.markets: full snapshot (all loaded rows, no time filter)
- polymarket.trades: April 2026 only (2026-04-01 00:00:00 UTC to 2026-05-01 00:00:00 UTC)
- Missing by design: raw on-chain fee fields, users rollups, quant-style pre-normalized YES view, and full multi-month trade history

If a user asks for out-of-scope data, state that explicitly and offer to load additional data instead of inferring from missing data.

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

Query patterns:
- Coverage sanity check:
  SELECT min(trade_time) AS earliest, max(trade_time) AS latest, count() AS n_rows FROM polymarket.trades
- April volume by market:
  SELECT market_id, sum(usd_amount) AS april_volume_usd FROM polymarket.trades GROUP BY market_id ORDER BY april_volume_usd DESC LIMIT 20
- Daily normalized YES trend for one market:
  SELECT toDate(trade_time) AS day, avg(multiIf(nonusdc_side = 'token1', price, 1 - price)) AS avg_yes_price
  FROM polymarket.trades
  WHERE market_id = '{market_id}'
  GROUP BY day
  ORDER BY day`;
}