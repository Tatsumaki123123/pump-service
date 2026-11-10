"use strict";

/**
 * pumpfundata 数据管理器（进程内单例，挂在 app 上）。
 *
 * 设计要点：
 *  - 官方只给「逐小时 parquet」，没有筛选/排序接口，也没有市值字段，
 *    所以这里把原始事件聚合成 token 级索引（Mongo），筛选在本地做。
 *  - 1 credit = 1 小时文件，因此每个小时文件只下一次（磁盘缓存），
 *    并且用 coverage 表记录已入库的小时，重启后不会重复扣费。
 *  - 只有「已经结束的小时」才永久入库；当前小时按 refreshLatestMinutes
 *    节流刷新，避免反复调用把 credit 烧光。
 *  - 所有可能烧钱的操作都有日预算上限。
 */

const path = require("path");
const { PfdStore } = require("./store");
const { readRows } = require("./parquet");
const { SolPrice } = require("./solPrice");
const { IconResolver } = require("./icon");
const {
  HourAggregator,
  upsertAggregates,
  PUMP_FUN_COLUMNS,
  PUMP_AMM_COLUMNS,
} = require("./indexer");
const { buildTailStats, toAveToken, TAIL_RETENTION_MS } = require("./aveShape");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// 外盘需要在内存里筛，给一个上限避免异常数据把内存打爆
const OUT_CANDIDATE_LIMIT = 5000;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function slotKey(date, hour) {
  return `${date}-${pad2(hour)}`;
}

function slotKeyOf(ms) {
  const slot = slotFromTs(ms);
  return slotKey(slot.date, slot.hour);
}

function pickedDeletedCount(result) {
  if (!result) return 0;
  if (typeof result.deletedCount === "number") return result.deletedCount;
  if (typeof result.n === "number") return result.n;
  return 0;
}

function slotFromTs(ts) {
  const at = Math.floor(ts / HOUR_MS) * HOUR_MS;
  const date = new Date(at);
  return {
    ts: at,
    date: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    hour: date.getUTCHours(),
  };
}

function slotsBetween(fromMs, toMs) {  const slots = [];
  const start = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  for (let ts = start; ts <= toMs; ts += HOUR_MS) {
    slots.push(slotFromTs(ts));
  }
  return slots;
}

function categoryMode(category) {
  const value = String(category || "");
  if (value.startsWith("pump_in") || value === "pump_in_new") {
    return { mode: "in", exchange: "pump_fun" };
  }
  if (value.startsWith("pump_out") || value.startsWith("stonk_out")) {
    return { mode: "out", exchange: "pump_fun" };
  }
  return null;
}

/**
 * 把 AVE 风格的筛选参数翻成 Mongo 查询。
 * 市值是 USD，库里存的是 SOL 市值，所以要用 SOL 价格换算区间。
 * 只返回以 WSOL 计价的 token，其它计价单位（USDC / 各种 SPL 代币）一律排除。
 */
function buildTokenQuery(params, solUsd) {
  const now = Date.now();
  const createFrom = now - params.createDay * DAY_MS;
  const createTo = now - params.createDayEnd * DAY_MS;

  const query = {
    exchange: "pump_fun",
    quoteKind: "sol",
    createAt: { $gte: createFrom, $lte: createTo },
  };
  // 内盘 = 还没毕业；外盘 = 已毕业（bonding_complete）
  if (params.mode === "in") {
    query.graduatedAt = null;
  } else {
    query.graduatedAt = { $ne: null };
  }

  let mcapFilterSkipped = false;
  if (solUsd > 0) {
    query.mcapQuote = {
      $gte: params.mcpMin / solUsd,
      $lte: params.mcpMax / solUsd,
    };
  } else {
    mcapFilterSkipped = true;
  }

  return { query, createFrom, createTo, mcapFilterSkipped };
}

/** 用 AMM 的最新状态覆盖内盘记录（AMM 数据更新时才覆盖） */
function pickEffective(row, ammRow) {
  if (!ammRow || (ammRow.lastAt || 0) < (row.lastAt || 0)) return row;
  return {
    ...row,
    priceQuote: ammRow.priceQuote,
    mcapQuote: ammRow.mcapQuote,
    mcapUsd: ammRow.mcapUsd,
    quoteKind: ammRow.quoteKind || row.quoteKind,
    quoteMint: ammRow.quoteMint || row.quoteMint,
    lastAt: ammRow.lastAt,
  };
}

/** 记录里的市值换算成美元；非 SOL/USDC 计价返回 0 */
function toUsdMcap(row, solUsd) {
  if (row.quoteKind === "usd") return Number(row.mcapQuote) || 0;
  if (!row.quoteKind || row.quoteKind === "sol") {
    return (Number(row.mcapQuote) || 0) * (Number(solUsd) || 0);
  }
  return 0;
}

class PfdManager {
  constructor(app) {
    this.app = app;
    const config = (app.config && app.config.pumpFunData) || {};
    this.config = config;
    this.logger = app.logger || console;

    this.cacheDir =
      config.cacheDir || path.join(app.baseDir, "run", "pfd-cache");

    this.store = new PfdStore({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      cacheDir: this.cacheDir,
      minIntervalMs: config.minIntervalMs,
      timeoutMs: config.timeoutMs,
      logger: this.logger,
    });

    this.solPrice = new SolPrice({
      persistPath: path.join(app.baseDir, "run", "pfd-cache", "sol-price.json"),
      logger: this.logger,
      fallbackPrice: Number(config.solUsdFallback) || 0,
    });

    // 图标后台解析：请求 uri 拿 metadata 里的 image，结果写回 Mongo
    this.icons = new IconResolver(app, {
      enabled: config.resolveIcon !== false,
      concurrency: config.iconConcurrency,
      perCall: config.iconPerCall,
    });

    this.maxFilesPerRun = Number(config.maxFilesPerRun) || 48;
    this.refreshLatestMinutes = Number(config.refreshLatestMinutes) || 10;
    this.tailHours = Math.max(2, Number(config.tailHours) || 2);
    // 入库后保留多少小时的 parquet 文件，其余删掉省磁盘（0 = 不清理）
    this.cacheKeepHours = Math.max(0, Number(config.cacheKeepHours ?? 72));
    // 定时任务覆盖最近多少天；每天只补「库里没有的小时」，稳态成本约 24 credit/天
    this.warmDays = Math.max(1, Number(config.warmDays) || 30);
    // 下面两个上限跟着 warmDays 走，避免改了窗口却忘记放大上限、回补被截断
    this.dailyMaxFiles = Math.max(
      1,
      Number(config.dailyMaxFiles) || this.warmDays * 24 + 60,
    );
    this.dailyCreditBudget =
      Number(config.dailyCreditBudget) || this.warmDays * 48 + 200;
    // 是否同时采集 pump_amm（外盘）。关掉可以省一半 credit，但 pump_out_* 会没数据
    this.ingestAmm = config.ingestAmm !== false;
    // 拿不到 SOL/USD 时的行为：empty=返回空列表（安全，默认），skip=不筛市值照常返回
    this.missingSolPrice = config.missingSolPrice === "skip" ? "skip" : "empty";
    this.lastIngest = null;
    this.ingestRunning = false;

    this._coverage = new Map();
    this._tracked = { pump_fun: new Set(), pump_amm: new Set() };
    this._tail = [];
    this._initPromise = null;
    this._currentHourFetchedAt = 0;
    this._creditsUsedToday = { date: "", count: 0 };
    this.lastWarmSummary = null;
  }

  // ---------------------------------------------------------------- 基础状态

  get enabled() {
    return this.store.enabled;
  }

  async ready() {
    if (!this._initPromise) {
      this._initPromise = this._init().catch((error) => {
        this._initPromise = null;
        throw error;
      });
    }
    return this._initPromise;
  }

  async _init() {
    const Coverage = this.app.model.PfdCoverage;
    const Token = this.app.model.PfdToken;

    const coverages = await Coverage.find({}).lean();
    for (const doc of coverages) {
      this._coverage.set(doc.exchange, new Set(doc.hours || []));
      if (doc.stats && doc.stats.creditDate && doc.stats.creditDate === this._today()) {
        this._creditsUsedToday = {
          date: doc.stats.creditDate,
          count: Number(doc.stats.creditCount) || 0,
        };
      }
    }
    if (!this._coverage.has("pump_fun")) this._coverage.set("pump_fun", new Set());
    if (!this._coverage.has("pump_amm")) this._coverage.set("pump_amm", new Set());

    // 已入库的 token 集合：决定后续小时里「没有 create 事件的旧 token」还要不要更新
    // 30 天窗口大约 80 万个 token，这里只取两个字段并排除 _id，避免启动时内存占用过高
    const since = Date.now() - (this.warmDays + 2) * DAY_MS;
    const tokens = await Token.find(
      { exchange: "pump_fun", createAt: { $gte: since } },
      { _id: 0, token: 1, graduatedAt: 1 },
    ).lean();
    for (const row of tokens) {
      this._tracked.pump_fun.add(row.token);
      if (row.graduatedAt) this._tracked.pump_amm.add(row.token);
    }

    this.logger.info(
      `[pfd] ready: pump_fun tracked=${this._tracked.pump_fun.size} hours=${this._coverage.get("pump_fun").size}`,
    );

    // 用已缓存的文件重建「最近两小时」逐笔缓冲，不下载、不写库
    await this._rebuildTail().catch((error) => {
      this.logger.warn(`[pfd] rebuild tail failed: ${error.message}`);
    });
  }

  _today() {
    return new Date().toISOString().slice(0, 10);
  }

  _spendCredit(count = 1) {
    const today = this._today();
    if (this._creditsUsedToday.date !== today) {
      this._creditsUsedToday = { date: today, count: 0 };
    }
    this._creditsUsedToday.count += count;
  }

  _budgetLeft() {
    const today = this._today();
    if (this._creditsUsedToday.date !== today) return this.dailyCreditBudget;
    return Math.max(0, this.dailyCreditBudget - this._creditsUsedToday.count);
  }

  _isIngested(exchange, key) {
    const set = this._coverage.get(exchange);
    return Boolean(set && set.has(key));
  }

  async _markIngested(exchange, keys) {
    if (!keys.length) return;
    let set = this._coverage.get(exchange);
    if (!set) {
      set = new Set();
      this._coverage.set(exchange, set);
    }
    const fresh = keys.filter((key) => !set.has(key));
    fresh.forEach((key) => set.add(key));
    if (!fresh.length) return;

    await this.app.model.PfdCoverage.updateOne(
      { exchange },
      {
        $addToSet: { hours: { $each: fresh } },
        $set: {
          lastRunAt: new Date(),
          "stats.creditDate": this._today(),
          "stats.creditCount": this._creditsUsedToday.count,
        },
      },
      { upsert: true },
    );
  }

  async _markError(exchange, error) {
    try {
      await this.app.model.PfdCoverage.updateOne(
        { exchange },
        {
          $set: {
            lastError: `${error.code || error.name}: ${error.message}`.slice(0, 500),
            lastErrorAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (inner) {
      // 记录错误失败不影响主流程
    }
  }

  // ---------------------------------------------------------------- 逐笔缓冲

  _pushTail(record) {
    // 回补历史小时时会产生大量「早就过期」的成交，直接丢弃，
    // 否则缓冲会从几十万条涨到上千万条并且顺序被破坏
    if (record.t < Date.now() - TAIL_RETENTION_MS) return;
    this._tail.push(record);
    const cutoff = Date.now() - TAIL_RETENTION_MS - 5 * 60 * 1000;
    if (this._tail.length > 0 && this._tail[0].t < cutoff) {
      let drop = 0;
      while (drop < this._tail.length && this._tail[drop].t < cutoff) drop += 1;
      this._tail.splice(0, drop);
    }
  }

  async _rebuildTail() {
    if (!this.enabled) return;
    const now = Date.now();
    const slots = slotsBetween(now - this.tailHours * HOUR_MS, now - HOUR_MS);
    let loaded = 0;
    for (const slot of slots) {
      try {
        // 命中磁盘缓存则免费；新机器上会补下 1~2 个小时文件，保证重启后
        // 5m/15m/1h 指标不为空
        await this._ingestSlot("pump_fun", slot, { persistIndex: false });
        loaded += 1;
      } catch (error) {
        this.logger.warn(
          `[pfd] 重建尾窗 ${slotKey(slot.date, slot.hour)} 失败: ${error.message}`,
        );
      }
    }
    if (loaded) {
      this.logger.info(
        `[pfd] tail rebuilt from ${loaded} hour file(s), ${this._tail.length} trades`,
      );
    }
  }

  // ---------------------------------------------------------------- 采集

  async _ingestSlot(exchange, slot, options = {}) {
    const columns =
      exchange === "pump_amm" ? PUMP_AMM_COLUMNS : PUMP_FUN_COLUMNS;

    const buffer = await this.store.getHour(exchange, slot.date, slot.hour, {
      force: Boolean(options.force),
    });
    const aggregator = new HourAggregator(exchange, {
      onSwap: (record) => this._pushTail(record),
    });
    const result = await readRows(buffer, columns, (rows) =>
      aggregator.addRows(rows),
    );
    const list = aggregator.finalize();

    if (options.persistIndex !== false) {
      const tracked = this._tracked.pump_fun;
      let keep;
      if (exchange === "pump_fun") {
        // create 事件是「新 token」的唯一可靠来源；其余只在已跟踪时才更新
        keep = list.filter((item) => item.createAt > 0 || tracked.has(item.token));
      } else {
        keep = list.filter((item) => tracked.has(item.token));
      }
      await upsertAggregates(this.app, exchange, keep, null, {
        solUsd: options.solUsd || 0,
      });
      if (exchange === "pump_fun") {
        for (const item of keep) {
          if (item.createAt > 0) {
            tracked.add(item.token);
            if (item.graduatedAt) this._tracked.pump_amm.add(item.token);
          }
          if (item.graduatedAt) this._tracked.pump_amm.add(item.token);
        }
      }
    }

    return { ...result, tokens: list.length };
  }

  /**
   * 补齐 [fromMs, toMs] 内缺失的小时。
   * @param {object} options
   * @param {number} [options.maxFiles] 本次最多下多少个文件
   * @param {"asc"|"desc"} [options.order] 默认升序（先补老的，create 事件必须先入库）
   * @param {boolean} [options.persistIndex]
   * @param {boolean} [options.dryRun] 只算计划，不下载
   */
  async ensureRange(exchange, fromMs, toMs, options = {}) {
    await this.ready();

    const order = options.order === "desc" ? "desc" : "asc";
    const persistIndex = options.persistIndex !== false;
    const maxFiles = Math.max(0, Number(options.maxFiles) || this.maxFilesPerRun);

    let range;
    try {
      range = await this.store.getRange(exchange);
    } catch (error) {
      this.logger.warn(`[pfd] range unavailable: ${error.message}`);
      return { downloaded: 0, missing: 0, error: error.message, keys: [] };
    }

    const rangeStart = Date.parse(`${range.start}T00:00:00Z`);
    const rangeEnd = Date.parse(`${range.end}T23:59:59Z`);
    const now = Date.now();
    const latestComplete = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;

    const clampedFrom = Math.max(fromMs, rangeStart);
    const clampedTo = Math.min(toMs, latestComplete, rangeEnd);
    if (!(clampedTo >= clampedFrom)) {
      return { downloaded: 0, missing: 0, keys: [], skipped: "out-of-range" };
    }

    let slots = slotsBetween(clampedFrom, clampedTo);
    let missing = slots.filter(
      (slot) => !this._isIngested(exchange, slotKey(slot.date, slot.hour)),
    );

    const needCurrentHour =
      toMs >= Math.floor(now / HOUR_MS) * HOUR_MS &&
      Date.now() - this._currentHourFetchedAt > this.refreshLatestMinutes * 60 * 1000;

    if (order === "desc") missing = missing.reverse();

    const plan = { missing: missing.length, downloaded: 0, keys: [], errors: [] };
    if (options.dryRun) {
      plan.planned = missing.slice(0, maxFiles).map((s) => slotKey(s.date, s.hour));
      return plan;
    }

    const budget = this._budgetLeft();
    const allow = Math.min(maxFiles, budget);
    if (missing.length > allow) {
      this.logger.warn(
        `[pfd] ${exchange} 缺 ${missing.length} 个小时，本次只补 ${allow} 个（预算/单次上限），剩余下次继续`,
      );
    }

    const done = [];
    let pending = [];
    const solUsd = persistIndex ? await this._solUsd() : 0;
    for (const slot of missing.slice(0, allow)) {
      try {
        await this._ingestSlot(exchange, slot, { persistIndex, solUsd });
        const key = slotKey(slot.date, slot.hour);
        done.push(key);
        pending.push(key);
        plan.downloaded += 1;
        this._spendCredit(1);

        // 每 20 个小时落一次水位：30 天回补要跑几十分钟，
        // 中途崩溃可以从断点继续，不用把已下载的几百个文件重下一遍
        if (persistIndex && pending.length >= 20) {
          await this._markIngested(exchange, pending);
          pending = [];
        }

        // 入库完就把 parquet 文件删掉（数据已经在 Mongo）
        if (
          this.cacheKeepHours > 0 &&
          Date.now() - slot.ts > this.cacheKeepHours * HOUR_MS
        ) {
          await this.store.dropHour(exchange, slot.date, slot.hour);
        }
      } catch (error) {
        plan.errors.push({ key: slotKey(slot.date, slot.hour), code: error.code, message: error.message });
        await this._markError(exchange, error);
        if (error.code === "PFD_NO_CREDITS" || error.code === "PFD_UNAUTHORIZED") {
          this.logger.error(`[pfd] 停止采集: ${error.message}`);
          break;
        }
      }
    }

    if (persistIndex && pending.length) {
      await this._markIngested(exchange, pending);
    }
    plan.keys = done;

    // 当前小时（未结束）单独节流刷新，用于让市值尽量新
    if (needCurrentHour && persistIndex && this._budgetLeft() > 0) {
      const currentSlot = slotFromTs(Math.floor(now / HOUR_MS) * HOUR_MS);
      try {
        await this._ingestSlot(exchange, currentSlot, {
          persistIndex: true,
          solUsd,
          force: true,
        });
        this._currentHourFetchedAt = Date.now();
        this._spendCredit(1);
        plan.currentHour = slotKey(currentSlot.date, currentSlot.hour);
      } catch (error) {
        plan.errors.push({ key: "current", code: error.code, message: error.message });
        this._currentHourFetchedAt = Date.now();
      }
    }

    this.lastWarmSummary = { exchange, at: new Date().toISOString(), ...plan };
    return plan;
  }

  // ---------------------------------------------------------------- 定时采集

  /**
   * 采集入口：启动后跑一次 + 每天定时跑一次。
   * 只补「库里没有的小时」，所以稳态成本 ≈ 24 credit/天/交易所。
   */
  async dailyIngest() {
    if (this.ingestRunning) {
      this.logger.warn("[pfd] 上一次采集还没结束，跳过本次");
      return this.lastIngest;
    }
    if (!this.enabled) {
      this.logger.warn("[pfd] 未配置 pumpfundata api key，跳过采集");
      return null;
    }

    this.ingestRunning = true;
    const startedAt = Date.now();
    try {
      await this.ready();
      const from = startedAt - this.warmDays * DAY_MS;
      const targets = this.ingestAmm ? ["pump_fun", "pump_amm"] : ["pump_fun"];
      const summary = {};

      for (const exchange of targets) {
        summary[exchange] = await this.ensureRange(exchange, from, startedAt, {
          order: "asc",
          maxFiles: this.dailyMaxFiles,
        });
      }

      const pruned = await this.prune();
      this.lastIngest = {
        at: new Date(startedAt).toISOString(),
        ms: Date.now() - startedAt,
        summary,
        pruned,
      };
      this.logger.info(
        `[pfd] 采集完成，用时 ${this.lastIngest.ms}ms，` +
          `pump_fun 新增 ${summary.pump_fun?.downloaded || 0} 个文件` +
          (summary.pump_amm ? `，pump_amm 新增 ${summary.pump_amm.downloaded || 0} 个` : "") +
          `，清理 token ${pruned.pumpFun} + ${pruned.pumpAmm}`,
      );
      return this.lastIngest;
    } catch (error) {
      this.lastIngest = {
        at: new Date(startedAt).toISOString(),
        ms: Date.now() - startedAt,
        error: error.message,
        code: error.code,
      };
      this.logger.error(`[pfd] 采集失败: ${error.message}`);
      return this.lastIngest;
    } finally {
      this.ingestRunning = false;
    }
  }

  /** 清理超出窗口的旧数据，避免 Mongo 无限增长 */
  async prune() {
    const Token = this.app.model.PfdToken;
    const cutoff = Date.now() - (this.warmDays + 2) * DAY_MS;

    const [pumpFun, pumpAmm] = await Promise.all([
      Token.deleteMany({ exchange: "pump_fun", createAt: { $lt: cutoff } }),
      Token.deleteMany({ exchange: "pump_amm", lastAt: { $lt: cutoff } }),
    ]);

    // coverage 里的小时水位同样只需要保留窗口内
    try {
      await this.app.model.PfdCoverage.updateMany(
        {},
        { $pull: { hours: { $lt: slotKeyOf(cutoff) } } },
      );
    } catch (error) {
      this.logger.warn(`[pfd] 清理 coverage 失败: ${error.message}`);
    }

    return {
      pumpFun: pickedDeletedCount(pumpFun),
      pumpAmm: pickedDeletedCount(pumpAmm),
    };
  }

  // ---------------------------------------------------------------- 查询

  async _solUsd() {
    const record = await this.solPrice.getSolUsd();
    return Number(record && record.value) || 0;
  }

  async queryList(params) {
    await this.ready();
    const Token = this.app.model.PfdToken;

    const now = Date.now();
    const createFrom = now - params.createDay * DAY_MS;
    const createTo = now - params.createDayEnd * DAY_MS;

    // 数据只由定时任务采集，请求路径不再触发任何下载（不烧 credit、不阻塞请求）
    if (params.createDay > this.warmDays) {
      this.logger.warn(
        `[pfd] create_day=${params.createDay} 超过采集窗口 warmDays=${this.warmDays}，` +
          "更早的 token 库里没有数据，需要调大 warmDays",
      );
    }
    const solUsd = await this._solUsd();

    const { query, mcapFilterSkipped } = buildTokenQuery(params, solUsd);
    if (mcapFilterSkipped) {
      this.logger.warn("[pfd] SOL/USD 价格不可用，无法按美元市值筛选");
      if (this.missingSolPrice === "empty") {
        // 宁可不出单，也不要买进市值区间外的币
        this.logger.error(
          "[pfd] missingSolPrice=empty，本次返回空列表；请配置 PFD_SOL_USD 或放通行情源",
        );
        return { list: [], solUsd, scanned: 0, mcapFilterSkipped };
      }
    }

    const sortDir = params.sortOrder === "desc" ? -1 : 1;
    let rows;

    if (params.mode === "in") {
      const sort = {};
      sort[params.sortField] = sortDir;
      rows = await Token.find(query)
        .sort(sort)
        .skip((params.pageNo - 1) * params.pageSize)
        .limit(params.pageSize)
        .lean();
    } else {
      // 外盘的市值来自 AMM，内盘最后成交价（≈毕业线）不能拿来筛选，
      // 否则 50 万~1000 万这种区间会全部筛空。
      // 毕业 token 数量有限，直接取窗口内全量，叠 AMM 状态后在内存里筛/排/分页。
      const candidates = await Token.find({
        exchange: "pump_fun",
        createAt: { $gte: createFrom, $lte: createTo },
        graduatedAt: { $ne: null },
      })
        .sort({ createAt: 1 })
        .limit(OUT_CANDIDATE_LIMIT)
        .lean();

      const ammMap = new Map();
      if (candidates.length) {
        const ammRows = await Token.find(
          {
            exchange: "pump_amm",
            token: { $in: candidates.map((row) => row.token) },
          },
          {
            token: 1,
            priceQuote: 1,
            mcapQuote: 1,
            mcapUsd: 1,
            lastAt: 1,
            quoteKind: 1,
            quoteMint: 1,
          },
        ).lean();
        ammRows.forEach((row) => ammMap.set(row.token, row));
      }

      const kept = [];
      for (const row of candidates) {
        const effective = pickEffective(row, ammMap.get(row.token));
        // 只保留 SOL 计价的，其它计价单位一律不返回
        if (effective.quoteKind !== "sol") continue;
        const usdMcap = toUsdMcap(effective, solUsd);
        if (!(usdMcap > 0)) continue;
        if (usdMcap < params.mcpMin || usdMcap > params.mcpMax) continue;
        kept.push({ row: effective, usdMcap });
      }

      const sortKey = (item) => {
        if (params.sortField === "mcapUsd") return item.usdMcap;
        if (params.sortField === "lastAt") return item.row.lastAt || 0;
        return item.row.createAt || 0;
      };
      kept.sort((a, b) => (sortKey(a) - sortKey(b)) * sortDir);

      rows = kept
        .slice(
          (params.pageNo - 1) * params.pageSize,
          params.pageNo * params.pageSize,
        )
        .map((item) => item.row);

      this.logger.info(
        `[pfd] 外盘候选 ${candidates.length} 个，市值区间内 ${kept.length} 个`,
      );
    }

    if (!rows.length) {
      // 空结果时补一条诊断，直接从日志区分「库里没数据」还是「被市值区间筛掉」
      const explain = await this._explainEmpty(params, { solUsd });
      this.logger.info(
        `[pfd] 空结果诊断 category=${params.mode} ` +
          `窗口内=${explain.totalInWindow} 其中市值区间内=${explain.withBand} ` +
          `缺小时=${explain.missingHours} solUsd=${solUsd} 库里最老=${explain.dbFrom || "空库"}`,
      );
      return { list: [], solUsd, scanned: 0, mcapFilterSkipped, explain };
    }

    const mintFilter = new Set(rows.map((row) => row.token));
    const statsMap = buildTailStats(this._tail, Date.now(), mintFilter);

    // 把本次返回里还没有图标的 token 丢到后台异步解析，下轮请求就能带上
    this.icons.enqueue(rows);

    const ammName = params.amm || (params.mode === "in" ? "pump" : "pumpfunamm");

    const list = rows.map((row) =>
      toAveToken(row, {
        solUsd,
        stats: statsMap.get(row.token),
        amm: ammName,
      }),
    );

    return { list, solUsd, scanned: rows.length, mcapFilterSkipped };
  }

  /**
   * 空结果诊断：窗口内有多少 token、其中落在市值区间内多少、还缺多少小时没入库。
   * 只在结果为空时执行，常态请求不会多一次 count。
   */
  async _explainEmpty(params, context) {
    const Token = this.app.model.PfdToken;
    const createFrom = Date.now() - params.createDay * DAY_MS;
    const createTo = Date.now() - params.createDayEnd * DAY_MS;

    const base = {
      exchange: "pump_fun",
      quoteKind: "sol",
      createAt: { $gte: createFrom, $lte: createTo },
    };
    if (params.mode === "in") base.graduatedAt = null;
    else base.graduatedAt = { $ne: null };

    const [totalInWindow, withBand, oldest] = await Promise.all([
      Token.countDocuments(base).catch(() => -1),
      context.solUsd > 0
        ? Token.countDocuments({
            ...base,
            mcapQuote: {
              $gte: params.mcpMin / context.solUsd,
              $lte: params.mcpMax / context.solUsd,
            },
          }).catch(() => -1)
        : Promise.resolve(-1),
      Token.findOne({ exchange: "pump_fun" }, { createAt: 1 })
        .sort({ createAt: 1 })
        .lean()
        .catch(() => null),
    ]);

    const slots = slotsBetween(createFrom, createTo);
    const missingHours = slots.filter(
      (slot) => !this._isIngested("pump_fun", slotKey(slot.date, slot.hour)),
    ).length;

    return {
      totalInWindow,
      withBand,
      missingHours,
      windowHours: slots.length,
      // 库里最老的 token 时间，直接回答「为什么更早的没有」
      dbFrom: oldest && oldest.createAt ? new Date(oldest.createAt).toISOString() : null,
    };
  }

  async status() {
    await this.ready();
    const Token = this.app.model.PfdToken;
    const [
      pumpFunCount,
      pumpAmmCount,
      graduatedCount,
      solRecord,
      oldestToken,
      newestToken,
    ] = await Promise.all([
      Token.countDocuments({ exchange: "pump_fun" }),
      Token.countDocuments({ exchange: "pump_amm" }),
      Token.countDocuments({ exchange: "pump_fun", graduatedAt: { $ne: null } }),
      this.solPrice.snapshot(),
      Token.findOne({ exchange: "pump_fun" }, { createAt: 1 })
        .sort({ createAt: 1 })
        .lean(),
      Token.findOne({ exchange: "pump_fun" }, { createAt: 1 })
        .sort({ createAt: -1 })
        .lean(),
    ]);

    // 库里实际能查到的时间范围：排查「为什么更早的币没有」时直接看这个
    const dataRange =
      oldestToken && newestToken && newestToken.createAt
        ? {
            from: new Date(oldestToken.createAt || 0).toISOString(),
            to: new Date(newestToken.createAt).toISOString(),
            days: Math.round(
              (newestToken.createAt - (oldestToken.createAt || 0)) / DAY_MS,
            ),
          }
        : null;

    let range = null;
    if (this.enabled) {
      range = await this.store.getRange("pump_fun").catch((error) => ({
        error: error.message,
      }));
    }

    // 当前采集窗口里还差哪些小时没入库
    const needSlots = slotsBetween(
      Date.now() - this.warmDays * DAY_MS,
      Date.now() - HOUR_MS,
    );
    const countMissing = (exchange) =>
      needSlots.filter(
        (slot) => !this._isIngested(exchange, slotKey(slot.date, slot.hour)),
      ).length;

    return {
      enabled: this.enabled,
      cacheDir: this.cacheDir,
      range,
      solUsd: solRecord,
      solPriceMissing: !(solRecord && solRecord.value > 0),
      tokens: {
        pump_fun: pumpFunCount,
        pump_amm: pumpAmmCount,
        graduated: graduatedCount,
      },
      coverage: {
        pump_fun: this._coverage.get("pump_fun")?.size || 0,
        pump_amm: this._coverage.get("pump_amm")?.size || 0,
        missingHours: {
          pump_fun: countMissing("pump_fun"),
          pump_amm: countMissing("pump_amm"),
        },
      },
      dataRange,
      config: {
        warmDays: this.warmDays,
        ingestAmm: this.ingestAmm,
        missingSolPrice: this.missingSolPrice,
        dailyCreditBudget: this.dailyCreditBudget,
      },
      credits: {
        date: this._creditsUsedToday.date,
        usedToday: this._creditsUsedToday.count,
        dailyBudget: this.dailyCreditBudget,
      },
      tailTrades: this._tail.length,
      icons: { ...this.icons.stats, queued: this.icons.queue.length },
      downloadStats: this.store.stats,
      lastIngest: this.lastIngest,
      lastWarm: this.lastWarmSummary,
    };
  }
}

const registry = new WeakMap();

function getManager(app) {
  let manager = registry.get(app);
  if (!manager) {
    manager = new PfdManager(app);
    registry.set(app, manager);
  }
  return manager;
}

module.exports = {
  PfdManager,
  getManager,
  categoryMode,
  buildTokenQuery,
  slotsBetween,
  slotKey,
};
