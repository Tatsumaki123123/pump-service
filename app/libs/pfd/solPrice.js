"use strict";

/**
 * SOL/USD 价格。
 *
 * pumpfundata 只提供以 SOL 计价的储备量，而 AVE 的 mkt_cap 是美元，
 * 前端和筛选参数（mcp_min / mcp_max）都用美元，所以必须换汇。
 *
 * 策略：
 *  1. 多个源并发竞速（Binance / Jupiter / Coinbase / CoinGecko），取最快成功的
 *  2. 成功结果缓存 60s；全部失败也做 60s 负缓存，避免每次请求都等满超时
 *  3. 网络全挂时依次回落到：磁盘上最后一次成功的价格 -> 配置里的静态值
 */

const fsp = require("fs/promises");
const path = require("path");
const axios = require("axios");

const WSOL = "So11111111111111111111111111111111111111112";
const SUCCESS_TTL_MS = 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const DISK_TRUST_MS = 24 * 60 * 60 * 1000;

class SolPrice {
  constructor(options = {}) {
    this.persistPath = options.persistPath;
    this.timeout = Number(options.timeoutMs) || 8000;
    this.fallbackPrice = Number(options.fallbackPrice) || 0;
    this.logger = options.logger || console;
    this._record = null;
    this._failedAt = 0;
    this._inflight = null;
    this._disk = undefined;
  }

  _ensureResolve() {
    if (!this._inflight) {
      this._inflight = this._resolve().finally(() => {
        this._inflight = null;
      });
    }
    return this._inflight;
  }

  async getSolUsd() {
    if (this._record && Date.now() - this._record.at < SUCCESS_TTL_MS) {
      return this._record;
    }
    if (this._failedAt && Date.now() - this._failedAt < FAILURE_TTL_MS) {
      return this._fallback("negative-cache");
    }

    // 有兜底价就先返回兜底价，同时后台去拉实时价；
    // 否则行情源不通时会把接口请求卡满 8 秒超时。
    const pending = this._ensureResolve();
    const quick = await this._fallback("warmup");
    if (quick && quick.value > 0) return quick;
    return pending;
  }

  async _resolve() {
    const attempts = [
      this._binanceSpot(),
      this._jupiter(),
      this._coinbase(),
      this._coingecko(),
    ];
    try {
      const record = await Promise.any(attempts);
      this._record = record;
      this._failedAt = 0;
      await this._persist(record);
      return record;
    } catch (error) {
      this._failedAt = Date.now();
      this.logger.warn("[pfd] 所有 SOL/USD 行情源均不可用，使用兜底价格");
      return this._fallback("all-sources-failed");
    }
  }

  async _fallback(reason) {
    const disk = await this._fromDisk();
    if (disk) {
      const age = Date.now() - disk.at;
      if (age < DISK_TRUST_MS) {
        return { ...disk, source: `${disk.source}+disk-cache` };
      }
    }
    if (this.fallbackPrice > 0) {
      return {
        value: this.fallbackPrice,
        source: "config:static",
        at: Date.now(),
        reason,
      };
    }
    if (disk) {
      return { ...disk, source: `${disk.source}+stale-disk`, reason };
    }
    return { value: 0, source: "none", at: Date.now(), reason };
  }

  _makeHttp() {
    return async (url, parse) => {
      const res = await axios.get(url, {
        timeout: this.timeout,
        validateStatus: () => true,
        proxy: false,
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const value = Number(parse(res.data));
      if (!Number.isFinite(value) || value <= 0) throw new Error("bad price payload");
      return value;
    };
  }

  async _binanceSpot() {
    const get = this._makeHttp();
    const value = await get(
      "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
      (data) => data && data.price,
    );
    return { value, source: "binance:spot", at: Date.now() };
  }

  async _jupiter() {
    const get = this._makeHttp();
    const value = await get(
      `https://lite-api.jup.ag/price/v3?ids=${WSOL}`,
      (data) => data && data[WSOL] && (data[WSOL].usdPrice ?? data[WSOL].price),
    );
    return { value, source: "jupiter", at: Date.now() };
  }

  async _coinbase() {
    const get = this._makeHttp();
    const value = await get(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
      (data) => data && data.data && data.data.amount,
    );
    return { value, source: "coinbase", at: Date.now() };
  }

  async _coingecko() {
    const get = this._makeHttp();
    const value = await get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      (data) => data && data.solana && data.solana.usd,
    );
    return { value, source: "coingecko", at: Date.now() };
  }

  async _persist(record) {
    if (!this.persistPath) return;
    try {
      await fsp.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fsp.writeFile(this.persistPath, JSON.stringify(record));
    } catch (error) {
      // 落盘失败不影响主流程
    }
  }

  async _fromDisk() {
    if (this._disk !== undefined) return this._disk;
    this._disk = null;
    if (!this.persistPath) return null;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.persistPath, "utf8"));
      const value = Number(parsed && parsed.value);
      if (Number.isFinite(value) && value > 0) {
        this._disk = {
          value,
          source: `disk:${parsed.source || "unknown"}`,
          at: Number(parsed.at) || 0,
        };
      }
    } catch (error) {
      // 首次运行没有缓存文件，正常
    }
    return this._disk;
  }

  /** 供 /status 使用 */
  async snapshot() {
    if (this._record) return this._record;
    const disk = await this._fromDisk();
    if (disk) return disk;
    if (this.fallbackPrice > 0) {
      return { value: this.fallbackPrice, source: "config:static", at: 0 };
    }
    return { value: 0, source: "none", at: 0 };
  }
}

module.exports = { SolPrice, WSOL };
