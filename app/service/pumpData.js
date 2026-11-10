"use strict";

const { Service } = require("egg");
const { getManager, categoryMode } = require("../libs/pfd/manager");

/**
 * sourceWeb = "data" 时的代币来源：pumpfundata.com 的原始链上事件。
 *
 * 对外契约与 service/ave.js 的 getList 完全一致：
 * 入参 groupSort 支持 mcp_min / mcp_max / create_day / create_day_end / category，
 * 出参是 aveTokenToDB 同构的数组，前端无需改动。
 */

const SORT_FIELDS = {
  created_at: "createAt",
  create_time: "createAt",
  createAt: "createAt",
  // 市值排序用归一化到美元的字段，避免 SOL/USDC 计价单位混在一起排错
  market_cap: "mcapUsd",
  mkt_cap: "mcapUsd",
  marketcap: "mcapUsd",
  last_trade_at: "lastAt",
  latest_time: "lastAt",
  updated_at: "lastAt",
};

const AMM_IN = "pump";
const AMM_OUT = "pumpfunamm";

class PumpData extends Service {
  get manager() {
    return getManager(this.app);
  }

  async getList(groupSort = {}) {
    const { ctx } = this;
    const manager = this.manager;

    if (!manager.enabled) {
      throw new Error(
        "sourceWeb=data 未配置 pumpfundata API key（环境变量 PFD_API_KEY 或 config.pumpFunData.apiKey）",
      );
    }

    const category = groupSort.category || "pump_out_new";
    if (category === "user") {
      throw new Error("sourceWeb=data 不支持 category=user");
    }

    const categoryInfo = categoryMode(category);
    if (!categoryInfo) {
      throw new Error(`sourceWeb=data 暂不支持 category=${category}`);
    }
    const exchange = categoryInfo.exchange;

    const marketCapMin = groupSort.mcp_min ?? 4000;
    const marketCapMax = groupSort.mcp_max ?? 20000;
    const createDay = Number(groupSort.create_day ?? 10);
    const createDayEnd = Number(groupSort.create_day_end ?? 0);
    const pageNo = Number(groupSort.page_no ?? 1);
    const pageSize = Number(groupSort.page_size ?? 500);

    // 与 ave.getList 保持完全一致的校验和报错文案
    if (
      !Number.isFinite(createDay) ||
      !Number.isFinite(createDayEnd) ||
      createDay < 0 ||
      createDayEnd < 0 ||
      createDay < createDayEnd
    ) {
      throw new Error(
        "create_day and create_day_end must be non-negative, and create_day must be greater than or equal to create_day_end",
      );
    }
    if (
      !Number.isInteger(pageNo) ||
      !Number.isInteger(pageSize) ||
      pageNo < 1 ||
      pageSize < 1
    ) {
      throw new Error("page_no and page_size must be positive integers");
    }
    if (
      !Number.isFinite(marketCapMin) ||
      !Number.isFinite(marketCapMax) ||
      marketCapMin < 0 ||
      marketCapMax < marketCapMin
    ) {
      throw new Error(
        "mcp_min and mcp_max must be non-negative, and mcp_max must be greater than or equal to mcp_min",
      );
    }

    let amm = null;
    let mode = categoryInfo.mode;
    if (groupSort.amm) {
      if (groupSort.amm === AMM_IN) amm = AMM_IN;
      else if (groupSort.amm === AMM_OUT || groupSort.amm === "pumpswap") {
        amm = AMM_OUT;
      }
      // amm 显式指定时以它为准，和 AVE 把 amm 当查询条件的行为一致
      if (amm === AMM_IN) mode = "in";
      if (amm === AMM_OUT) mode = "out";
    }

    const sortField = SORT_FIELDS[groupSort.sort_field] || "createAt";
    const sortOrder = groupSort.sort_order === "desc" ? "desc" : "asc";

    const result = await manager.queryList({
      mode,
      exchange,
      mcpMin: marketCapMin,
      mcpMax: marketCapMax,
      createDay,
      createDayEnd,
      pageNo,
      pageSize,
      sortField,
      sortOrder,
      amm,
    });

    if (result.mcapFilterSkipped) {
      ctx.logger.warn("[pfd] 市值筛选被跳过：SOL/USD 价格不可用");
    }
    ctx.logger.info(
      `[pfd] list category=${category} mcp=${marketCapMin}-${marketCapMax} day=${createDay}~${createDayEnd} -> ${result.list.length}`,
    );
    return result.list;
  }

  /**
   * 显式补数据。返回本次计划/结果，便于运维确认到底花了多少 credit。
   * @param {object} options
   * @param {number} [options.createDay] 补最近 N 天（默认 2）
   * @param {number} [options.createDayEnd]
   * @param {string} [options.exchange] pump_fun | pump_amm | both
   * @param {number} [options.maxFiles]
   * @param {boolean} [options.dryRun]
   */
  async warm(options = {}) {
    const manager = this.manager;
    if (!manager.enabled) {
      throw new Error("pumpfundata API key 未配置");
    }
    await manager.ready();

    const now = Date.now();
    const createDay = Number(options.createDay ?? 2);
    const createDayEnd = Number(options.createDayEnd ?? 0);
    const fromMs = now - createDay * 24 * 3600 * 1000;
    const toMs = now - createDayEnd * 24 * 3600 * 1000;

    const targets =
      options.exchange === "pump_fun" || options.exchange === "pump_amm"
        ? [options.exchange]
        : ["pump_fun", "pump_amm"];

    const results = {};
    for (const exchange of targets) {
      results[exchange] = await manager.ensureRange(exchange, fromMs, toMs, {
        maxFiles: options.maxFiles,
        dryRun: options.dryRun,
        order: "asc",
      });
    }

    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), results };
  }

  async status() {
    return this.manager.status();
  }
}

module.exports = PumpData;
