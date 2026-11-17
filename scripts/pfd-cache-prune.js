"use strict";

/**
 * pumpfundata 本地 parquet 缓存清理 / 体检。
 *
 * 背景：run/pfd-cache 只是「省 credit」的缓存，数据入库后都在 MongoDB 里。
 * 删掉最坏情况是下次补同一小时再扣 1 credit，不会丢业务数据。
 *
 * 采集流程里有两条清理路径：
 *   - ensureRange：每下完一个小时文件，若超出 cacheKeepHours 立即 dropHour
 *   - dailyIngest：采集结束再全量扫一遍，兜住历史残留和 .part 半成品
 * 本脚本用于手工体检/立即释放空间，不依赖 egg，可以直接跑。
 *
 * 用法：
 *   node scripts/pfd-cache-prune.js                       # 只报告（默认保留 72 小时）
 *   node scripts/pfd-cache-prune.js --apply               # 按报告结果真删
 *   node scripts/pfd-cache-prune.js --keep-hours 24       # 换保留窗口再报告
 *   node scripts/pfd-cache-prune.js --keep-hours 24 --apply
 *   node scripts/pfd-cache-prune.js --all --apply         # 全清（下次启动会补最近 2 小时）
 */

const path = require("path");
const { PfdStore } = require("../app/libs/pfd/store");

const args = process.argv.slice(2);

function hasFlag(name) {
  return args.includes(name);
}

function readOption(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

(async () => {
  const cacheDir =
    process.env.PFD_CACHE_DIR || path.join(__dirname, "..", "run", "pfd-cache");
  const apply = hasFlag("--apply");
  const all = hasFlag("--all");
  const keepHours = readOption(
    "--keep-hours",
    Number(process.env.PFD_CACHE_KEEP_HOURS ?? 72),
  );

  console.log(`缓存目录: ${cacheDir}`);
  console.log(
    all
      ? "保留策略: 全清（--all）"
      : `保留策略: 最近 ${keepHours} 小时（可用 --keep-hours 覆盖）`,
  );
  console.log(`模式: ${apply ? "实际删除" : "只统计（加 --apply 才会删）"}\n`);

  const store = new PfdStore({ cacheDir });
  const result = await store.pruneCache({
    keepHours,
    all,
    dryRun: !apply,
  });

  console.log(`扫描文件: ${result.scanned} 个`);
  console.log(`命中清理: ${result.removed} 个（${formatBytes(result.bytes)}）`);
  if (result.parts) console.log(`  其中 .part 半成品: ${result.parts} 个`);
  if (apply) {
    console.log(`删除空目录: ${result.dirs} 个`);
    console.log("\n完成。Mongo 里的 token 索引不受影响。");
  } else if (result.removed > 0) {
    const rerun = ["node scripts/pfd-cache-prune.js", ...args, "--apply"].join(" ");
    console.log(`\n这是一次演练。确认后执行：${rerun}`);
  } else {
    console.log("\n没有需要清理的文件。若目录仍然很大，检查 PFD_CACHE_KEEP_HOURS 是否被设成了 0（0 = 不自动清理）。");
  }
})().catch((error) => {
  console.error(`清理失败: ${error.message}`);
  process.exit(1);
});
