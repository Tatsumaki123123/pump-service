"use strict";

/**
 * pumpfundata 定时采集。
 *
 * - 应用启动后立刻跑一次（immediate）
 * - 之后按 ingestCron 每天跑一次（默认 03:10）
 * - 只补「Mongo 里还没有的小时」，所以稳态成本约 24 credit/天/交易所，
 *   首次回补是 warmDays × 24 × 交易所数
 *
 * 开关与时间都在 config.pumpFunData 里，也可以用环境变量覆盖：
 *   PFD_AUTO_INGEST=false     关掉定时采集
 *   PFD_INGEST_CRON="0 5 * * * *"   改成每小时（成本不变，但市值只旧 1 小时）
 */

const { getManager } = require("../libs/pfd/manager");

module.exports = (app) => {
  const config = app.config.pumpFunData || {};
  const disabled =
    config.autoIngest === false || app.config.env === "unittest";

  return {
    schedule: {
      // worker 类型保证多进程下只有一个进程执行，不会重复下载
      type: "worker",
      cron: config.ingestCron || "0 10 3 * * *",
      immediate: !disabled,
      disable: disabled,
    },

    async task() {
      const manager = getManager(app);
      try {
        await manager.dailyIngest();
      } catch (error) {
        // dailyIngest 内部已经兜住错误并写入 lastIngest，这里只防漏
        app.logger.error(`[pfd] 定时采集异常: ${error.message}`);
      }
    },
  };
};
