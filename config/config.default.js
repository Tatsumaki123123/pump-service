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
    // 采集最近多少天。create_day 最大 10 的话这里设 11
    warmDays: Number(process.env.PFD_WARM_DAYS) || 6,
    // 单次采集最多下载多少个小时文件（首次回补用）
    dailyMaxFiles: Number(process.env.PFD_DAILY_MAX_FILES) || 320,
    // 是否同时采集 pump_amm（外盘）。关掉省一半 credit，但 pump_out_* 会没数据
    ingestAmm: process.env.PFD_INGEST_AMM !== "false",
    // 手动补数据接口 /v1/pumpdata/warm 的单次上限
    maxFilesPerRun: Number(process.env.PFD_MAX_FILES) || 48,
    // 当前小时（未结束）的刷新间隔
    refreshLatestMinutes: Number(process.env.PFD_REFRESH_MINUTES) || 10,
    // 每天最多消耗多少 credit，防止失控
    dailyCreditBudget: Number(process.env.PFD_DAILY_BUDGET) || 600,
    // 逐笔缓冲保留多少小时（用于 5m/15m/1h 指标）
    tailHours: 2,

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
