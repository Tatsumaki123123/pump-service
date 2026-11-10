"use strict";

/**
 * pumpfundata 连通性检查（只读，正常情况下不消耗 credit）。
 *
 * 用法：
 *   node scripts/pfd-live-check.js
 *   PFD_API_KEY=xxx node scripts/pfd-live-check.js
 *
 * 会依次验证：
 *   1. /range 是否可用、数据覆盖到哪一天
 *   2. 下载是否还有余额（402 表示需要充值）
 *   3. SOL/USD 价格源是否可用
 */

const path = require("path");
const { PfdStore } = require("../app/libs/pfd/store");
const { SolPrice } = require("../app/libs/pfd/solPrice");

const config = require("../config/config.default")({ name: "pump-service", baseDir: path.join(__dirname, "..") });

async function main() {
  const apiKey = process.env.PFD_API_KEY || config.pumpFunData.apiKey;
  if (!apiKey) {
    console.error("缺少 PFD_API_KEY");
    process.exit(1);
  }

  const store = new PfdStore({
    apiKey,
    cacheDir: path.join(__dirname, "..", "run", "pfd-cache"),
  });

  console.log(`api key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);

  for (const exchange of ["pump_fun", "pump_amm"]) {
    try {
      const range = await store.getRange(exchange, { force: true });
      const days = Math.round(
        (Date.parse(range.end) - Date.parse(range.start)) / 86400000,
      );
      console.log(
        `✓ ${exchange}: ${range.start} ~ ${range.end}（${range.files} 个文件，约 ${days} 天）`,
      );
    } catch (error) {
      console.log(`✗ ${exchange}: [${error.code || error.name}] ${error.message}`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  try {
    const buf = await store.getHour("pump_fun", yesterday, 12);
    console.log(`✓ 下载成功：${yesterday} 12 时 ${buf.length} bytes（可用余额）`);
  } catch (error) {
    console.log(
      `! 下载测试：${today} -> [${error.code || error.name}] ${error.message}`,
    );
    if (error.code === "PFD_NO_CREDITS") {
      console.log("  => 需要到 https://pumpfundata.com/account 充值后才能采集历史数据");
    }
  }

  const sol = new SolPrice({
    fallbackPrice: config.pumpFunData.solUsdFallback,
  });
  const record = await sol.getSolUsd();
  console.log(
    record && record.value
      ? `✓ SOL/USD = ${record.value}（来源 ${record.source}）`
      : "✗ SOL/USD 价格获取失败（行情源不可用且未配置兜底价）",
  );
  if (record && record.source === "config:static") {
    console.log(
      `  注：实时行情源全部不可达，当前用的是配置兜底价 ${config.pumpFunData.solUsdFallback}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
