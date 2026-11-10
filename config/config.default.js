/* eslint valid-jsdoc: "off" */

/**
 * @param {Egg.EggAppInfo} appInfo app info
 */
module.exports = (appInfo) => {
  /**
   * built-in config
   * @type {Egg.EggAppConfig}
   **/
  const config = (exports = {});

  // use for cookie sign key, should change to your own and keep security
  config.keys = appInfo.name + "_1749457041635_4105";

  // add your middleware config here
  config.middleware = ["errorHandler"];

  config.errorHandler = {
    match: "/v1",
  };

  config.security = {
    csrf: {
      enable: false,
      ignore: (ctx) => {
        if (ctx.request.method === "OPTIONS") return true;
        return false;
      },
    },
  };
  config.cors = {
    origin: "*",
    allowMethods: "GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS",
  };

  config.httpclient = {
    request: { timeout: 1000 * 600 },
  };

  // add your user config here
  const userConfig = {
    // myAppName: 'egg',
  };

  // pumpfundata.com 数据源（sourceWeb = "data"）
  // 官方只提供逐小时 parquet，1 credit / 小时文件，30 req/min。
  //
  // warmDays 是唯一需要调的旋钮：它同时决定「往库里采多久」「库保留多久」
  // （清理按 warmDays+2 天），下面两个上限按它自动推导，不用单独配。
  const warmDays = Number(process.env.PFD_WARM_DAYS) || 10;

  config.pumpFunData = {
    apiKey: process.env.PFD_API_KEY || "pfd_aabbc0fc2ddc43f1a0a495a1f5cbd8c6",
    baseUrl: process.env.PFD_BASE_URL || "https://api.pumpfundata.com",
    // 小时文件的本地缓存目录，默认 run/pfd-cache（run/ 已在 .gitignore 里）
    // 注意：这里只是省 credit 的缓存，token 索引与采集水位都存在 MongoDB
    cacheDir: process.env.PFD_CACHE_DIR || "",
    // 官方限速 30 次/分钟，留出余量
    minIntervalMs: 2100,
    timeoutMs: 60000,

    // ---- 定时采集 ----
    // 启动后自动跑一次，之后按 ingestCron 每天一次
    autoIngest: process.env.PFD_AUTO_INGEST !== "false",
    // 六段式 cron：秒 分 时 日 月 周。改成 "0 5 * * * *" 即每小时一次（成本不变）
    ingestCron: process.env.PFD_INGEST_CRON || "0 10 3 * * *",
    warmDays,
    // 单次采集最多下载多少个小时文件：留出一天余量，保证一次能把窗口补齐
    dailyMaxFiles:
      Number(process.env.PFD_DAILY_MAX_FILES) || warmDays * 24 + 60,
    // 每天最多消耗多少 credit：覆盖一次全量回补（按 2 个交易所算）+ 余量
    dailyCreditBudget:
      Number(process.env.PFD_DAILY_BUDGET) || warmDays * 48 + 200,
    // 是否同时采集 pump_amm（外盘）。关掉省一半 credit，但 pump_out_* 会没数据
    ingestAmm: process.env.PFD_INGEST_AMM !== "false",
    // 手动补数据接口 /v1/pumpdata/warm 的单次上限
    maxFilesPerRun: Number(process.env.PFD_MAX_FILES) || 48,
    // 当前小时（未结束）的刷新间隔
    refreshLatestMinutes: Number(process.env.PFD_REFRESH_MINUTES) || 10,
    // 逐笔缓冲保留多少小时（用于 5m/15m/1h 指标）
    tailHours: 2,
    // 本地 parquet 缓存保留多少小时。数据入库后即可删，只有回补尾窗要用最近几个小时。
    // 30 天窗口全部保留会占 20GB+，所以默认只留 72 小时；设 0 表示不自动清理
    cacheKeepHours: Number(process.env.PFD_CACHE_KEEP_HOURS ?? 72),

    // ---- 图标 ----
    // 后台请求 metadata uri 解析 icon 并写回 Mongo。关掉则 icon 恒为空
    resolveIcon: process.env.PFD_RESOLVE_ICON !== "false",
    iconConcurrency: Number(process.env.PFD_ICON_CONCURRENCY) || 4,
    // 每次 tokenList 最多新排多少个图标任务（防止高频轮询把队列撑爆）
    iconPerCall: Number(process.env.PFD_ICON_PER_CALL) || 40,

    // ---- 市值换算 ----
    // SOL/USD 兜底价：实时行情源全部不可用时用这个价格换算市值，默认 100。
    // 设为 0 表示不做静态兜底（此时拿不到实时价就不出数据）。
    solUsdFallback: Number(process.env.PFD_SOL_USD ?? 100) || 0,
    // 完全拿不到 SOL 价格时的行为：
    //   empty = 返回空列表（默认，安全，避免买到市值区间外的币）
    //   skip  = 不筛市值照常返回
    missingSolPrice: process.env.PFD_MISSING_SOL_PRICE || "empty",
  };

  return {
    ...config,
    ...userConfig,
  };
};
