"use strict";

/**
 * pumpfundata 数据链路自测（不需要 API key / 不需要 Mongo）。
 *
 * 用法：node scripts/pfd-selftest.js
 *
 * 覆盖：
 *  1. 合成 parquet -> 分块读取 -> 事件聚合
 *  2. 内盘虚拟储备定价、USDC 计价、毕业事件
 *  3. 5m/15m/1h 指标与 AVE 字段结构对齐
 *  4. Mongo 查询条件与市值区间换算
 *  5. 落库写入操作形态（幂等）
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { readRows } = require("../app/libs/pfd/parquet");
const {
  HourAggregator,
  WSOL,
  USDC,
} = require("../app/libs/pfd/indexer");
const { buildTailStats, toAveToken } = require("../app/libs/pfd/aveShape");
const { buildTokenQuery, categoryMode } = require("../app/libs/pfd/manager");

const AVE_KEYS = [
  "token",
  "symbol",
  "icon",
  "token1_address",
  "token1_symbol",
  "token1_logo_url",
  "mkt_cap",
  "create_time",
  "amm",
  "usdPrice",
  "pool",
  "volume_u_5m",
  "volume_u_1h",
  "gas_fee_sum",
  "wallet_count",
  "transaction_count",
  "buy_count",
  "sell_count",
  "percent5m",
  "percent1h",
  "latest_time",
  "holders",
];

const TOKEN_MINT_A = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_MINT_B = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_MINT_C = "MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const CREATOR = "CreatorWa11et111111111111111111111111111111";

const now = Date.now();
// 放在 4 分钟前，保证落在 5m/15m 指标窗口内
const baseTs = Math.floor((now - 4 * 60 * 1000) / 1000);

const rows = [];
function addRow(overrides) {
  rows.push({
    event_type: "swap",
    timestamp: baseTs,
    token_mint: TOKEN_MINT_A,
    token_creator: "",
    token_total_supply: 0,
    name: "",
    symbol: "",
    uri: "",
    action: "buy",
    user_wallet: "",
    token_amount: 0,
    lamports_amount: 0,
    lamports_mint: WSOL,
    fee_lamports: 0,
    real_token_reserve: 0,
    real_lamports_reserve: 0,
    virtual_token_reserve: 0,
    virtual_lamports_reserve: 0,
    ...overrides,
  });
}

// A：标准内盘，两笔买单把市值推到约 47.37 SOL
addRow({
  event_type: "create",
  timestamp: baseTs,
  token_mint: TOKEN_MINT_A,
  token_creator: CREATOR,
  token_total_supply: 1_000_000_000 * 1e6,
  name: "Alpha",
  symbol: "ALPHA",
  uri: "https://example.com/a.json",
  action: "",
});
addRow({
  timestamp: baseTs + 60,
  token_mint: TOKEN_MINT_A,
  user_wallet: "Wallet111",
  lamports_amount: 10 * 1e9,
  fee_lamports: 0.01 * 1e9,
  virtual_lamports_reserve: 40 * 1e9,
  virtual_token_reserve: 980_000_000 * 1e6,
});
addRow({
  timestamp: baseTs + 120,
  token_mint: TOKEN_MINT_A,
  user_wallet: "Wallet222",
  lamports_amount: 5 * 1e9,
  fee_lamports: 0.005 * 1e9,
  virtual_lamports_reserve: 45 * 1e9,
  virtual_token_reserve: 950_000_000 * 1e6,
});

// B：以 USDC 计价，价格 1.0001e-5 USD/枚 -> 市值约 10001 USD
addRow({
  event_type: "create",
  timestamp: baseTs + 10,
  token_mint: TOKEN_MINT_B,
  token_creator: CREATOR,
  token_total_supply: 1_000_000_000 * 1e6,
  name: "Beta",
  symbol: "BETA",
  action: "",
});
addRow({
  timestamp: baseTs + 200,
  token_mint: TOKEN_MINT_B,
  user_wallet: "Wallet333",
  action: "sell",
  lamports_mint: USDC,
  lamports_decimal: 6,
  lamports_amount: 100 * 1e6,
  fee_lamports: 0.1 * 1e6,
  virtual_lamports_reserve: 10_000 * 1e6,
  virtual_token_reserve: 999_900_000 * 1e6,
});

// C：毕业币
addRow({
  event_type: "create",
  timestamp: baseTs + 20,
  token_mint: TOKEN_MINT_C,
  token_creator: CREATOR,
  token_total_supply: 1_000_000_000 * 1e6,
  symbol: "GAMMA",
  action: "",
});
addRow({
  timestamp: baseTs + 300,
  token_mint: TOKEN_MINT_C,
  virtual_lamports_reserve: 85 * 1e9,
  virtual_token_reserve: 500_000_000 * 1e6,
});
addRow({
  event_type: "bonding_complete",
  timestamp: baseTs + 400,
  token_mint: TOKEN_MINT_C,
  action: "",
});

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfd-selftest-"));
  const file = path.join(tmpDir, "sample.parquet");

  const { parquetWriteBuffer } = await import("hyparquet-writer");
  const INT64_COLUMNS = new Set([
    "token_total_supply",
    "token_amount",
    "lamports_amount",
    "fee_lamports",
    "real_token_reserve",
    "real_lamports_reserve",
    "virtual_token_reserve",
    "virtual_lamports_reserve",
  ]);
  const DOUBLE_COLUMNS = new Set(["timestamp"]);
  const columnData = Object.keys(rows[0]).map((name) => {
    if (INT64_COLUMNS.has(name)) {
      return {
        name,
        type: "INT64",
        data: rows.map((row) => BigInt(Math.round(row[name] || 0))),
      };
    }
    if (DOUBLE_COLUMNS.has(name)) {
      return { name, type: "DOUBLE", data: rows.map((row) => Number(row[name])) };
    }
    return { name, type: "STRING", data: rows.map((row) => String(row[name] ?? "")) };
  });
  const buffer = Buffer.from(parquetWriteBuffer({ columnData }));
  fs.writeFileSync(file, buffer);
  console.log(`✓ 生成测试 parquet：${file} (${buffer.length} bytes, ${rows.length} 行)`);

  // ---- 1. 分块读取 + 聚合
  const trades = [];
  const aggregator = new HourAggregator("pump_fun", {
    onSwap: (record) => trades.push(record),
  });
  const result = await readRows(
    fs.readFileSync(file),
    Object.keys(rows[0]),
    (chunk) => aggregator.addRows(chunk),
    { chunkSize: 3 },
  );
  assert.strictEqual(result.numRows, rows.length, "行数应与写入一致");
  console.log(`✓ 分块读取 ${result.numRows} 行，触发 ${trades.length} 笔 swap 回调`);

  const aggList = aggregator.finalize();
  const byMint = new Map(aggList.map((item) => [item.token, item]));

  const a = byMint.get(TOKEN_MINT_A);
  const b = byMint.get(TOKEN_MINT_B);
  const c = byMint.get(TOKEN_MINT_C);

  assert.ok(a && b && c, "三个 token 都应聚合出来");

  // ---- 2. 定价与市值
  const expectedPriceA = 45 / 950_000_000;
  assert.ok(
    Math.abs(a.priceQuote - expectedPriceA) / expectedPriceA < 1e-6,
    `A 价格应约 ${expectedPriceA}，实际 ${a.priceQuote}`,
  );
  assert.ok(
    Math.abs(a.mcapQuote - expectedPriceA * 1e9) / (expectedPriceA * 1e9) < 1e-6,
    `A 市值应约 ${expectedPriceA * 1e9} SOL，实际 ${a.mcapQuote}`,
  );
  assert.strictEqual(a.symbol, "ALPHA");
  assert.strictEqual(a.creator, CREATOR);
  assert.strictEqual(a.graduatedAt, null);
  console.log(`✓ 内盘定价：price=${a.priceQuote.toExponential(4)} SOL, mcap=${a.mcapQuote.toFixed(4)} SOL`);

  const expectedPriceB = 10_000 / 999_900_000;
  assert.ok(
    Math.abs(b.priceQuote - expectedPriceB) / expectedPriceB < 1e-6,
    `B 价格应约 ${expectedPriceB}，实际 ${b.priceQuote}`,
  );
  assert.strictEqual(b.quoteKind, "usd");
  assert.strictEqual(b.quoteMint, USDC);
  console.log(`✓ USDC 计价：price=${b.priceQuote.toExponential(4)} USD, mcap=${b.mcapQuote.toFixed(2)} USD`);

  assert.ok(c.graduatedAt > 0, "C 应记录毕业时间");
  console.log(`✓ 毕业事件：token 仍被保留，graduatedAt=${c.graduatedAt}`);

  // ---- 3. 尾窗指标 + AVE 结构
  const solUsd = 200;
  const statsMap = buildTailStats(trades, Date.now(), new Set([TOKEN_MINT_A]));
  const statsA = statsMap.get(TOKEN_MINT_A);
  assert.ok(statsA, "A 应有尾窗统计");
  assert.strictEqual(statsA.tx15m, 2, "A 的 15m 成交数");
  assert.strictEqual(statsA.buy15m, 2);
  assert.strictEqual(statsA.vol15m > 0, true);

  const aveToken = toAveToken(a, { solUsd, stats: statsA, amm: "pump" });
  assert.deepStrictEqual(Object.keys(aveToken), AVE_KEYS, "字段必须与 aveTokenToDB 完全一致");
  assert.ok(
    Math.abs(aveToken.mkt_cap - a.mcapQuote * solUsd) < 1e-3,
    "USD 市值 = SOL 市值 × SOL 价格",
  );
  assert.strictEqual(aveToken.amm, "pump");
  assert.strictEqual(aveToken.token1_address, WSOL);
  assert.strictEqual(aveToken.wallet_count, 2, "15m 内两个不同钱包");
  assert.strictEqual(aveToken.holders, 0, "数据源没有 holders");
  console.log(
    `✓ AVE 结构对齐：${Object.keys(aveToken).length} 个字段，mkt_cap=$${aveToken.mkt_cap.toFixed(2)}`,
  );

  // ---- 4. 查询条件
  const inQuery = buildTokenQuery(
    { mode: "in", mcpMin: 2000, mcpMax: 50000, createDay: 5, createDayEnd: 1 },
    200,
  );
  assert.strictEqual(inQuery.query.graduatedAt, null, "内盘必须过滤掉已毕业");
  assert.strictEqual(inQuery.query.quoteKind, "sol", "只返回 SOL 计价的 token");
  assert.strictEqual(inQuery.query.$or, undefined, "非 SOL 计价已排除，不需要 $or");
  assert.strictEqual(
    inQuery.query.createAt.$gte < inQuery.query.createAt.$lte,
    true,
  );
  assert.ok(
    Math.abs(inQuery.query.mcapQuote.$gte - 10) < 1e-9,
    "2000 USD / 200 = 10 SOL",
  );
  assert.ok(
    Math.abs(inQuery.query.mcapQuote.$lte - 250) < 1e-9,
    "50000 USD / 200 = 250 SOL",
  );

  const outQuery = buildTokenQuery(
    { mode: "out", mcpMin: 2000, mcpMax: 50000, createDay: 5, createDayEnd: 1 },
    200,
  );
  assert.deepStrictEqual(outQuery.query.graduatedAt, { $ne: null });

  const noPrice = buildTokenQuery(
    { mode: "in", mcpMin: 1, mcpMax: 2, createDay: 1, createDayEnd: 0 },
    0,
  );
  assert.strictEqual(noPrice.mcapFilterSkipped, true, "无 SOL 价格时必须标记跳过筛选");
  console.log("✓ 查询条件：内盘/外盘、美元→SOL 市值区间换算正确");

  // ---- 5. category 映射
  assert.deepStrictEqual(categoryMode("pump_in_new"), { mode: "in", exchange: "pump_fun" });
  assert.deepStrictEqual(categoryMode("pump_out_hot"), { mode: "out", exchange: "pump_fun" });
  assert.strictEqual(categoryMode("user"), null);
  console.log("✓ category 映射：pump_in_* -> 内盘，pump_out_* -> 外盘");

  // ---- 6. 落库写入形态
  const captured = [];
  const fakeApp = {
    model: {
      PfdToken: {
        bulkWrite: async (ops) => {
          captured.push(...ops);
          return { ok: 1 };
        },
      },
    },
  };
  const { upsertAggregates } = require("../app/libs/pfd/indexer");
  await upsertAggregates(fakeApp, "pump_fun", aggList, null);
  assert.strictEqual(captured.length, 3);
  const opA = captured.find((op) => op.updateOne.filter.token === TOKEN_MINT_A);
  assert.strictEqual(opA.updateOne.upsert, true);
  assert.ok(opA.updateOne.update.$max.lastAt > 0, "lastAt 必须用 $max 防止回退");
  assert.ok(opA.updateOne.update.$set.graduatedAt === undefined, "内盘 token 不应写 graduatedAt");
  const opC = captured.find((op) => op.updateOne.filter.token === TOKEN_MINT_C);
  assert.ok(opC.updateOne.update.$set.graduatedAt > 0, "毕业 token 应写入 graduatedAt");
  console.log("✓ 落库：$set 幂等 + $max 防回退，graduatedAt 只写一次");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n全部自测通过 ✅");
}

main().catch((error) => {
  console.error("\n自测失败 ❌");
  console.error(error);
  process.exit(1);
});
