"use strict";

/**
 * 把内部索引记录映射成 AVE `tokens/treasure/list` 的字段结构。
 * 字段集合必须与 app/service/ave.js 里的 aveTokenToDB 完全一致，
 * 否则前端要改。
 */

const { WSOL } = require("./indexer");

const TAIL_RETENTION_MS = 2 * 60 * 60 * 1000;

/**
 * 从最近两小时的逐笔缓冲里算 5m/15m/1h 指标。
 * @param {Array} trades 形如 { m, t, b, q, p, f, w, k }
 * @param {number} nowMs
 * @param {Set<string>} [mintFilter] 只算这些 token，省一次遍历
 */
function buildTailStats(trades, nowMs, mintFilter) {
  const out = new Map();
  const from = nowMs - TAIL_RETENTION_MS;
  const t5 = nowMs - 5 * 60 * 1000;
  const t15 = nowMs - 15 * 60 * 1000;
  const t1h = nowMs - 60 * 60 * 1000;

  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    if (trade.t < from) continue;
    if (mintFilter && !mintFilter.has(trade.m)) continue;

    let item = out.get(trade.m);
    if (!item) {
      item = {
        vol5m: 0,
        vol15m: 0,
        vol1h: 0,
        buy15m: 0,
        sell15m: 0,
        tx15m: 0,
        fee15m: 0,
        wallets: new Set(),
        basePrice5m: 0,
        basePrice1h: 0,
        lastPrice: 0,
        lastAt: 0,
        quoteKind: trade.k || "sol",
      };
      out.set(trade.m, item);
    }

    const is5m = trade.t >= t5;
    const is15m = trade.t >= t15;
    const is1h = trade.t >= t1h;

    if (!is1h && trade.p > 0) item.basePrice1h = trade.p;
    if (!is5m && trade.p > 0) item.basePrice5m = trade.p;

    if (is1h) item.vol1h += trade.q;
    if (is15m) {
      item.vol15m += trade.q;
      item.fee15m += trade.f || 0;
      item.tx15m += 1;
      if (trade.b) item.buy15m += 1;
      else item.sell15m += 1;
      if (trade.w) item.wallets.add(trade.w);
    }
    if (is5m) item.vol5m += trade.q;

    if (trade.p > 0 && trade.t >= item.lastAt) {
      item.lastPrice = trade.p;
      item.lastAt = trade.t;
    }
    if (!item.basePrice5m && trade.p > 0 && is5m) item.basePrice5m = trade.p;
  }

  return out;
}

function percentChange(current, base) {
  if (!base || !current) return 0;
  return ((current - base) / base) * 100;
}

/**
 * @param {object} row PfdToken 记录
 * @param {object} context { solUsd, stats, amm }
 */
function toAveToken(row, context = {}) {
  const solUsd = Number(context.solUsd) || 0;
  const stats = context.stats;
  const isUsdQuote = row.quoteKind === "usd";
  const isSolQuote = !row.quoteKind || row.quoteKind === "sol";
  const priceable = isUsdQuote || isSolQuote;
  const priceUsd = !priceable
    ? 0
    : isUsdQuote
      ? row.priceQuote
      : row.priceQuote * solUsd;
  const supply = row.supply > 0 ? row.supply : 1_000_000_000;

  const base = {
    token: row.token,
    symbol: row.symbol || "",
    icon: row.icon || "",
    token1_address: row.quoteMint || WSOL,
    token1_symbol: isUsdQuote ? "USDC" : isSolQuote ? "SOL" : "",
    token1_logo_url: "",
    mkt_cap: priceUsd * supply,
    create_time: row.createAt || 0,
    amm: context.amm || "pump",
    usdPrice: priceUsd,
    pool: "",
    volume_u_5m: 0,
    volume_u_1h: 0,
    gas_fee_sum: 0,
    wallet_count: 0,
    transaction_count: 0,
    buy_count: 0,
    sell_count: 0,
    percent5m: 0,
    percent1h: 0,
    latest_time: row.lastAt || 0,
    holders: 0,
  };

  if (!stats) {
    return base;
  }

  const lastPrice = stats.lastPrice || row.priceQuote;
  const quoteKind = stats.quoteKind || row.quoteKind;
  const convert =
    quoteKind === "usd"
      ? (value) => value
      : quoteKind && quoteKind !== "sol"
        ? () => 0
        : (value) => value * solUsd;

  base.volume_u_5m = convert(stats.vol15m);
  base.volume_u_1h = convert(stats.vol1h);
  base.gas_fee_sum = convert(stats.fee15m);
  base.wallet_count = stats.wallets.size;
  base.transaction_count = stats.tx15m;
  base.buy_count = stats.buy15m;
  base.sell_count = stats.sell15m;
  base.percent5m = percentChange(lastPrice, stats.basePrice5m);
  base.percent1h = percentChange(lastPrice, stats.basePrice1h);
  base.latest_time = stats.lastAt || base.latest_time;

  return base;
}

module.exports = { buildTailStats, toAveToken, percentChange, TAIL_RETENTION_MS };
