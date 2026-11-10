"use strict";

/**
 * 把 pumpfundata 的逐笔事件聚合成「每个 token 的当前状态」。
 *
 * 关键点（都已按官方文档 + 博客口径实现）：
 *  - 内盘价格必须用 virtual_token_reserve / virtual_lamports_reserve；
 *    real_lamports_reserve 在内盘开盘时是 0，用它兜底会算出 0 市值。
 *  - 供应量不要硬编码 10 亿，优先取 create 事件的 token_total_supply。
 *  - 不是所有交易都以 SOL 计价，必须先看 lamports_mint。
 *  - 数据里没有市值字段，市值 = 价格 × 总量，USD 还要再乘 SOL 价格。
 */

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const TOKEN_DECIMALS = 6;
const DEFAULT_SUPPLY = 1_000_000_000;

const PUMP_FUN_COLUMNS = [
  "event_type",
  "timestamp",
  "token_mint",
  "token_creator",
  "token_total_supply",
  "name",
  "symbol",
  "uri",
  "action",
  "lamports_amount",
  "lamports_mint",
  "lamports_decimal",
  "real_token_reserve",
  "real_lamports_reserve",
  "virtual_token_reserve",
  "virtual_lamports_reserve",
  "user_wallet",
];

const PUMP_AMM_COLUMNS = PUMP_FUN_COLUMNS.filter(
  (column) =>
    !["token_creator", "token_total_supply", "name", "symbol", "uri"].includes(
      column,
    ),
);

function toNum(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function quoteInfo(quoteMint, quoteDecimal) {
  const mint = quoteMint || WSOL;
  if (mint === WSOL) return { quoteMint: WSOL, quoteKind: "sol", divisor: 1e9 };
  if (mint === USDC || mint === USDT) {
    return { quoteMint: mint, quoteKind: "usd", divisor: 1e6 };
  }
  // 实测有 60+ 种 SPL 代币被当作计价单位。它们不是 SOL，
  // 强行按 SOL 算市值会污染 mcp 筛选，所以单独标记为 other 且市值记 0。
  const decimals = Number.isFinite(quoteDecimal) ? quoteDecimal : 0;
  return { quoteMint: mint, quoteKind: "other", divisor: 10 ** decimals };
}

class HourAggregator {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.map = new Map();
    // 每笔 swap 的回调，用来维护「最近两小时」的逐笔缓冲
    this.onSwap = typeof options.onSwap === "function" ? options.onSwap : null;
  }

  _entry(mint) {
    let item = this.map.get(mint);
    if (!item) {
      item = {
        token: mint,
        symbol: "",
        name: "",
        uri: "",
        creator: "",
        supply: 0,
        createAt: 0,
        graduatedAt: null,
        lastAt: 0,
        priceQuote: 0,
        quoteMint: WSOL,
        quoteKind: "sol",
        trades: 0,
      };
      this.map.set(mint, item);
    }
    return item;
  }

  addRows(rows) {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const mint = row.token_mint;
      if (!mint) continue;
      const eventType = row.event_type;
      const ts = Math.round(toNum(row.timestamp) * 1000);
      const item = this._entry(mint);

      if (eventType === "create") {
        item.createAt = item.createAt || ts;
        item.symbol = item.symbol || row.symbol || "";
        item.name = item.name || row.name || "";
        item.uri = item.uri || row.uri || "";
        item.creator = item.creator || row.token_creator || "";
        const supply = toNum(row.token_total_supply);
        if (supply > 0) {
          item.supply = supply;
        }
        continue;
      }

      if (eventType === "bonding_complete") {
        if (!item.graduatedAt || ts < item.graduatedAt) {
          item.graduatedAt = ts;
        }
        continue;
      }

      if (eventType !== "swap" && eventType !== "liquidity") {
        continue;
      }

      const quote = quoteInfo(row.lamports_mint, toNum(row.lamports_decimal));
      const virtualLamports = toNum(row.virtual_lamports_reserve);
      const virtualTokens = toNum(row.virtual_token_reserve);
      const realLamports = toNum(row.real_lamports_reserve);
      const realTokens = toNum(row.real_token_reserve);

      let quoteReserve = virtualLamports;
      let tokenReserve = virtualTokens;
      if (!(quoteReserve > 0 && tokenReserve > 0)) {
        // 老文件没有 virtual_* 字段；AMM 的 real 储备本身就可以定价。
        quoteReserve = realLamports;
        tokenReserve = realTokens;
      }

      if (quoteReserve > 0 && tokenReserve > 0) {
        const price =
          quoteReserve / quote.divisor / (tokenReserve / 10 ** TOKEN_DECIMALS);
        if (Number.isFinite(price) && price > 0) {
          item.priceQuote = price;
          item.quoteMint = quote.quoteMint;
          item.quoteKind = quote.quoteKind;
        }
      }

      if (eventType === "swap") {
        item.trades += 1;
        if (ts > item.lastAt) item.lastAt = ts;
        if (this.onSwap && item.priceQuote > 0) {
          this.onSwap({
            m: mint,
            t: ts,
            b: row.action === "buy" ? 1 : 0,
            q: toNum(row.lamports_amount) / quote.divisor,
            p: item.priceQuote,
            f: toNum(row.fee_lamports) / quote.divisor,
            w: row.user_wallet || "",
            k: item.quoteKind,
          });
        }
      }
    }
  }

  finalize() {
    const list = [];
    for (const item of this.map.values()) {
      if (!item.lastAt && !item.createAt) continue;
      const supply = item.supply > 0 ? item.supply / 10 ** TOKEN_DECIMALS : DEFAULT_SUPPLY;
      const priceable = item.quoteKind === "sol" || item.quoteKind === "usd";
      const mcapQuote = priceable && item.priceQuote > 0 ? item.priceQuote * supply : 0;
      list.push({
        exchange: this.exchange,
        token: item.token,
        symbol: item.symbol,
        name: item.name,
        uri: item.uri,
        creator: item.creator,
        createAt: item.createAt,
        supply,
        graduatedAt: item.graduatedAt,
        lastAt: item.lastAt || item.createAt,
        priceQuote: item.priceQuote,
        quoteMint: item.quoteMint,
        quoteKind: item.quoteKind,
        mcapQuote,
        trades: item.trades,
      });
    }
    return list;
  }
}

/**
 * 落库。全部用 $set，天然幂等，重放同一小时不会把计数翻倍。
 * @param {object} app egg app
 * @param {string} exchange
 * @param {object[]} aggregates
 * @param {Set<string>|null} trackedSet 仅处理集合内的 token（null 表示不过滤）
 */
async function upsertAggregates(app, exchange, aggregates, trackedSet, options = {}) {
  const Model = app.model.PfdToken;
  const now = new Date();
  const solUsd = Number(options.solUsd) || 0;
  let written = 0;

  const filtered = trackedSet
    ? aggregates.filter((item) => trackedSet.has(item.token))
    : aggregates;

  const BATCH = 2000;
  for (let start = 0; start < filtered.length; start += BATCH) {
    const slice = filtered.slice(start, start + BATCH);
    const ops = [];

    for (const item of slice) {
      const set = {
        supply: item.supply,
        priceQuote: item.priceQuote,
        quoteMint: item.quoteMint,
        quoteKind: item.quoteKind,
        mcapQuote: item.mcapQuote,
        updatedAt: now,
      };
      // 归一化的美元市值，只用于跨计价单位排序；拿不到 SOL 价格时保留旧值
      if (item.mcapQuote > 0) {
        if (item.quoteKind === "usd") {
          set.mcapUsd = item.mcapQuote;
        } else if (item.quoteKind === "sol" && solUsd > 0) {
          set.mcapUsd = item.mcapQuote * solUsd;
        }
      }
      if (item.symbol) set.symbol = item.symbol;
      if (item.name) set.name = item.name;
      if (item.uri) set.uri = item.uri;
      if (item.creator) set.creator = item.creator;
      if (item.createAt) set.createAt = item.createAt;
      // graduatedAt 只在「首次确认毕业」时写一次，绝不用 null 覆盖已有值。
      if (item.graduatedAt) set.graduatedAt = item.graduatedAt;

      ops.push({
        updateOne: {
          filter: { exchange, token: item.token },
          update: { $set: set, $max: { lastAt: item.lastAt || 0 } },
          upsert: true,
        },
      });
    }

    if (!ops.length) continue;
    await Model.bulkWrite(ops, { ordered: false });
    written += ops.length;
  }

  return written;
}

module.exports = {
  WSOL,
  USDC,
  USDT,
  TOKEN_DECIMALS,
  DEFAULT_SUPPLY,
  PUMP_FUN_COLUMNS,
  PUMP_AMM_COLUMNS,
  HourAggregator,
  upsertAggregates,
  quoteInfo,
  toNum,
};
