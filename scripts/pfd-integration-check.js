"use strict";

/**
 * 端到端集成检查：真实 parquet -> 聚合 -> 内存 Mongo -> queryList -> AVE 结构
 *
 * 需要先有一份已缓存的小时文件（跑过 scripts/pfd-live-check.js 或正式采集后自然会有）。
 * 不访问网络、不消耗 credit。
 *
 * 用法：node scripts/pfd-integration-check.js
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { readRows } = require("../app/libs/pfd/parquet");
const {
  HourAggregator,
  PUMP_FUN_COLUMNS,
} = require("../app/libs/pfd/indexer");
const { PfdManager } = require("../app/libs/pfd/manager");

const AVE_KEYS = [
  "token", "symbol", "icon", "token1_address", "token1_symbol", "token1_logo_url",
  "mkt_cap", "create_time", "amm", "usdPrice", "pool", "volume_u_5m", "volume_u_1h",
  "gas_fee_sum", "wallet_count", "transaction_count", "buy_count", "sell_count",
  "percent5m", "percent1h", "latest_time", "holders",
];

function matchDoc(doc, query) {
  for (const [key, expected] of Object.entries(query)) {
    if (key === "$or") {
      if (!expected.some((sub) => matchDoc(doc, sub))) return false;
      continue;
    }
    const value = doc[key];
    if (expected === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof expected === "object" && expected !== null) {
      if ("$ne" in expected && value === expected.$ne) return false;
      if ("$in" in expected && !expected.$in.includes(value)) return false;
      if ("$gte" in expected && !(value >= expected.$gte)) return false;
      if ("$lte" in expected && !(value <= expected.$lte)) return false;
      continue;
    }
    if (value !== expected) return false;
  }
  return true;
}

function makeModel(docs) {
  return {
    find(query = {}) {
      const state = { query, sort: null, skip: 0, limit: Number.MAX_SAFE_INTEGER };
      const api = {
        sort(spec) {
          state.sort = spec;
          return api;
        },
        skip(n) {
          state.skip = n;
          return api;
        },
        limit(n) {
          state.limit = n;
          return api;
        },
        lean() {
          let out = docs.filter((doc) => matchDoc(doc, state.query));
          if (state.sort) {
            const [field, dir] = Object.entries(state.sort)[0];
            out = out.slice().sort((a, b) => ((a[field] || 0) - (b[field] || 0)) * dir);
          }
          return Promise.resolve(out.slice(state.skip, state.skip + state.limit));
        },
      };
      return api;
    },
    countDocuments: async (query = {}) => docs.filter((d) => matchDoc(d, query)).length,
    updateMany: async (query, update) => {
      let n = 0;
      for (const doc of docs) {
        if (!matchDoc(doc, query)) continue;
        Object.assign(doc, (update && update.$set) || {});
        n += 1;
      }
      return { modifiedCount: n };
    },
  };
}

function findCachedHour(cacheDir) {
  const root = path.join(cacheDir, "pump_fun");
  if (!fs.existsSync(root)) return null;
  const dates = fs.readdirSync(root).sort().reverse();
  for (const date of dates) {
    const dir = path.join(root, date);
    if (!fs.statSync(dir).isDirectory()) continue;
    const hours = fs.readdirSync(dir).filter((f) => f.endsWith(".parquet")).sort();
    if (hours.length) {
      return {
        date,
        hour: Number(hours[hours.length - 1].replace(".parquet", "")),
        file: path.join(dir, hours[hours.length - 1]),
      };
    }
  }
  return null;
}

async function main() {
  const cacheDir = path.join(__dirname, "..", "run", "pfd-cache");
  const cached = findCachedHour(cacheDir);
  if (!cached) {
    console.log("没有缓存的小时文件，先运行 scripts/pfd-live-check.js");
    process.exit(0);
  }
  console.log(`使用真实数据：${cached.date} ${cached.hour} 时`);

  const t0 = Date.now();
  const aggregator = new HourAggregator("pump_fun");
  const trades = [];
  aggregator.onSwap = (record) => trades.push(record);
  const result = await readRows(
    fs.readFileSync(cached.file),
    PUMP_FUN_COLUMNS,
    (rows) => aggregator.addRows(rows),
  );
  const aggregated = aggregator.finalize();
  console.log(
    `✓ 解析 ${result.numRows} 行 -> ${aggregated.length} 个 token（${Date.now() - t0}ms）`,
  );

  // 只把带 create 事件（即真正新建的 token）放进索引，模拟落库结果
  const docs = aggregated
    .filter((item) => item.createAt > 0)
    .map((item) => ({
      exchange: item.exchange,
      token: item.token,
      symbol: item.symbol || null,
      name: item.name || null,
      uri: item.uri || null,
      creator: item.creator || null,
      createAt: item.createAt,
      supply: item.supply,
      graduatedAt: item.graduatedAt,
      lastAt: item.lastAt,
      priceQuote: item.priceQuote,
      quoteMint: item.quoteMint,
      quoteKind: item.quoteKind,
      mcapQuote: item.mcapQuote,
      mcapUsd:
        item.quoteKind === "usd"
          ? item.mcapQuote
          : item.quoteKind === "sol"
            ? item.mcapQuote * 200
            : 0,
      icon: null,
    }));
  console.log(`✓ 索引 token 数：${docs.length}（内盘 ${docs.filter((d) => !d.graduatedAt).length}，已毕业 ${docs.filter((d) => d.graduatedAt).length}）`);

  const quoteKinds = {};
  docs.forEach((doc) => {
    quoteKinds[doc.quoteKind] = (quoteKinds[doc.quoteKind] || 0) + 1;
  });
  console.log(`  计价单位分布：${JSON.stringify(quoteKinds)}`);

  const app = {
    baseDir: path.join(__dirname, ".."),
    config: {
      pumpFunData: { apiKey: "local-check", cacheDir },
    },
    logger: { info() {}, warn: console.warn, error: console.error },
    model: {
      PfdToken: makeModel(docs),
      PfdCoverage: { find: () => ({ lean: async () => [] }), updateOne: async () => ({}) },
    },
  };

  const manager = new PfdManager(app);
  manager._initPromise = Promise.resolve();
  manager._tail = trades;
  manager._solUsd = async () => 200;

  const inList = await manager.queryList({
    mode: "in",
    mcpMin: 2000,
    mcpMax: 50000,
    createDay: 5,
    createDayEnd: 0,
    pageNo: 1,
    pageSize: 500,
    sortField: "createAt",
    sortOrder: "asc",
    amm: null,
  });

  assert.deepStrictEqual(Object.keys(inList.list[0] || {}), AVE_KEYS, "返回字段必须与 AVE 一致");
  console.log(`✓ 内盘筛选 $2000~$50000：命中 ${inList.list.length} 个`);

  for (const token of inList.list) {
    if (token.mkt_cap < 2000 || token.mkt_cap > 50000) {
      throw new Error(`市值越界：${token.symbol} ${token.mkt_cap}`);
    }
  }
  console.log("✓ 所有结果市值都在区间内");

  const sample = inList.list[0];
  if (sample) {
    console.log(
      `  样例：${sample.symbol || "(无 symbol)"} mcap=$${sample.mkt_cap.toFixed(0)} ` +
        `price=$${sample.usdPrice.toExponential(3)} vol5m=$${sample.volume_u_5m.toFixed(0)} ` +
        `tx15m=${sample.transaction_count} amm=${sample.amm}`,
    );
  }

  const small = await manager.queryList({
    mode: "in",
    mcpMin: 2000,
    mcpMax: 5000,
    createDay: 5,
    createDayEnd: 0,
    pageNo: 1,
    pageSize: 500,
    sortField: "mcapUsd",
    sortOrder: "desc",
    amm: null,
  });
  console.log(`✓ 收窄到 $2000~$5000：命中 ${small.list.length} 个`);
  for (let i = 1; i < small.list.length; i += 1) {
    assert.ok(small.list[i - 1].mkt_cap >= small.list[i].mkt_cap, "按市值倒序应单调不增");
  }
  console.log(`✓ 按市值倒序排序正确（${small.list.length} 条）`);

  // 外盘分支：本用例没有 pump_amm 数据，应回落到内盘末价且不报错
  const outList = await manager.queryList({
    mode: "out",
    mcpMin: 0,
    mcpMax: 1e9,
    createDay: 5,
    createDayEnd: 0,
    pageNo: 1,
    pageSize: 500,
    sortField: "createAt",
    sortOrder: "asc",
    amm: null,
  });
  assert.ok(outList.list.length > 0, "外盘窗口内应至少有已毕业 token");
  assert.ok(
    outList.list.every((item) => item.amm === "pumpfunamm"),
    "外盘 amm 字段应为 pumpfunamm",
  );
  console.log(`✓ 外盘分支可用：${outList.list.length} 个已毕业 token`);

  console.log("\n集成检查通过 ✅");
}

main().catch((error) => {
  console.error("\n集成检查失败 ❌");
  console.error(error);
  process.exit(1);
});
