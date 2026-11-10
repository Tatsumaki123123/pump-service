"use strict";

/**
 * pumpfundata.com 数据下载层。
 *
 * 官方限制（见 https://pumpfundata.com/docs）：
 *  - 只有 /range 与 /download 两个接口，均需 X-API-Key
 *  - 1 credit = 1 个「小时」文件，重复下载会重复扣费
 *  - 30 请求 / 分钟
 *
 * 因此这里做了三件事：本地磁盘缓存（同一小时只下一次）、串行限速、
 * 以及把 401/402 翻译成可识别的错误码，避免把余额问题当成网络错误重试。
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const axios = require("axios");

const PARQUET_MAGIC = "PAR1";

class PfdError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PfdError";
    this.code = code;
  }
}

class RateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.tail = Promise.resolve();
    this.nextAt = 0;
  }

  run(task) {
    const exec = this.tail.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.nextAt = Date.now() + this.minIntervalMs;
      return task();
    });
    this.tail = exec.then(
      () => undefined,
      () => undefined,
    );
    return exec;
  }
}

function isParquet(buf) {
  if (!buf || buf.length < 12) return false;
  return (
    buf.toString("latin1", 0, 4) === PARQUET_MAGIC &&
    buf.toString("latin1", buf.length - 4, buf.length) === PARQUET_MAGIC
  );
}

class PfdStore {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || "").trim();
    this.baseUrl = String(options.baseUrl || "https://api.pumpfundata.com").replace(
      /\/+$/,
      "",
    );
    this.cacheDir = options.cacheDir;
    this.timeout = Number(options.timeoutMs) || 60000;
    this.logger = options.logger || console;
    this.limiter = new RateLimiter(options.minIntervalMs ?? 2100);
    this.rangeTtlMs = Number(options.rangeTtlMs) || 10 * 60 * 1000;

    this._rangeCache = new Map();
    this._inflight = new Map();
    this._noCreditsAt = 0;
    this.stats = { downloads: 0, cacheHits: 0, bytes: 0, requests: 0 };
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async request(pathname, params = {}, options = {}) {
    if (!this.apiKey) {
      throw new PfdError(
        "PFD_NO_API_KEY",
        "pumpfundata api key is not configured (set PFD_API_KEY or config.pumpFunData.apiKey)",
      );
    }

    const url = new URL(this.baseUrl + pathname);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    const raw = Boolean(options.raw);
    const res = await this.limiter.run(() => {
      this.stats.requests += 1;
      return axios.get(url.toString(), {
        headers: { "X-API-Key": this.apiKey },
        responseType: raw ? "arraybuffer" : "json",
        timeout: this.timeout,
        validateStatus: () => true,
        proxy: false,
      });
    });

    if (res.status === 200) {
      return res.data;
    }

    const detail = this._errorDetail(res.data);
    if (res.status === 401 || res.status === 403) {
      throw new PfdError(
        "PFD_UNAUTHORIZED",
        `pumpfundata rejected the api key (HTTP ${res.status}${detail})`,
      );
    }
    if (res.status === 402) {
      throw new PfdError(
        "PFD_NO_CREDITS",
        `pumpfundata credits exhausted (HTTP 402${detail}); top up at https://pumpfundata.com/account`,
      );
    }
    if (res.status === 429) {
      throw new PfdError("PFD_RATE_LIMITED", "pumpfundata rate limit hit (HTTP 429)");
    }
    throw new PfdError(
      "PFD_HTTP_" + res.status,
      `pumpfundata request failed (HTTP ${res.status}${detail})`,
    );
  }

  _errorDetail(body) {
    try {
      let text = body;
      if (Buffer.isBuffer(body)) text = body.toString("utf8");
      if (typeof text === "string") text = JSON.parse(text);
      if (text && typeof text === "object" && text.error) {
        return `: ${text.error}`;
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  async getRange(exchange, options = {}) {
    const cached = this._rangeCache.get(exchange);
    if (!options.force && cached && Date.now() - cached.at < this.rangeTtlMs) {
      return cached.data;
    }
    const data = await this.request("/range", { exchange });
    if (!data || !data.start || !data.end) {
      throw new PfdError("PFD_BAD_RANGE", "pumpfundata returned an unexpected /range payload");
    }
    const normalized = {
      exchange: data.exchange || exchange,
      start: data.start,
      end: data.end,
      files: Number(data.files) || 0,
    };
    this._rangeCache.set(exchange, { at: Date.now(), data: normalized });
    return normalized;
  }

  hourKey(exchange, date, hour) {
    return `${date}-${String(hour).padStart(2, "0")}`;
  }

  hourPath(exchange, date, hour) {
    return path.join(
      this.cacheDir,
      exchange,
      date,
      `${String(hour).padStart(2, "0")}.parquet`,
    );
  }

  hasHour(exchange, date, hour) {
    try {
      const file = this.hourPath(exchange, date, hour);
      return fs.statSync(file).size > 0;
    } catch (error) {
      return false;
    }
  }

  async readHour(exchange, date, hour) {
    const buf = await fsp.readFile(this.hourPath(exchange, date, hour));
    if (!isParquet(buf)) {
      throw new PfdError(
        "PFD_BAD_CACHE",
        `cached file is not parquet: ${this.hourPath(exchange, date, hour)}`,
      );
    }
    return buf;
  }

  /**
   * 取某个小时的文件内容，优先命中磁盘缓存。
   * @param {boolean} options.force 强制重新下载（会再扣 1 credit）
   */
  async getHour(exchange, date, hour, options = {}) {
    const file = this.hourPath(exchange, date, hour);

    if (!options.force && this.hasHour(exchange, date, hour)) {
      try {
        const buf = await this.readHour(exchange, date, hour);
        this.stats.cacheHits += 1;
        return buf;
      } catch (error) {
        if (error && error.code === "PFD_BAD_CACHE") {
          // 缓存文件损坏（例如上次写入中断），删掉后重新下载
          await fsp.unlink(file).catch(() => undefined);
        } else {
          throw error;
        }
      }
    }

    const inflight = this._inflight.get(file);
    if (inflight) {
      return inflight;
    }

    const task = (async () => {
      if (!options.force && Date.now() - this._noCreditsAt < 5 * 60 * 1000) {
        throw new PfdError(
          "PFD_NO_CREDITS",
          "pumpfundata credits exhausted recently; skipping download for 5 minutes",
        );
      }

      let buf;
      try {
        buf = await this.request(
          "/download",
          { exchange, date, hour: String(hour) },
          { raw: true },
        );
      } catch (error) {
        if (error && error.code === "PFD_NO_CREDITS") {
          this._noCreditsAt = Date.now();
        }
        throw error;
      }

      if (!isParquet(buf)) {
        throw new PfdError(
          "PFD_BAD_FILE",
          `pumpfundata returned a non-parquet payload for ${exchange} ${date} ${hour}`,
        );
      }

      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.part`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);

      this.stats.downloads += 1;
      this.stats.bytes += buf.length;
      return buf;
    })();

    this._inflight.set(file, task);
    try {
      return await task;
    } finally {
      this._inflight.delete(file);
    }
  }
}

module.exports = { PfdStore, PfdError, RateLimiter, isParquet };
