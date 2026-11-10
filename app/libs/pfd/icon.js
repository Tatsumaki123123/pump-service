"use strict";

/**
 * token 图标解析。
 *
 * pumpfundata 只给 metadata 的 `uri`（通常是 ipfs 上的 JSON），图标在那份 JSON 的
 * `image` 字段里，所以必须请求一次 uri 才能拿到。为了不给接口加延迟：
 *  - 只在「本次返回的列表」里挑没图标的 token，丢进后台队列异步解析
 *  - 解析结果写回 MongoDB（PfdToken.icon），下次请求直接带出来
 *  - 失败也记 iconCheckedAt，N 天内不再重试
 *
 * 另有 iconaves 的 CDN 看似能拼地址，但实测只对 AVE 已收录的 token 返回 200，
 * 新盘一律 403，不能当通用方案。
 */

const axios = require("axios");

const DEFAULT_TIMEOUT = 3000;
const MAX_QUEUE = 200;
const RETRY_DAYS = 7;
// 网络/HTTP 失败只等 1 小时就重试（ipfs 网关经常抽风）
const RETRY_ERROR_MS = 60 * 60 * 1000;

async function fetchIconFromUri(uri, timeout = DEFAULT_TIMEOUT) {
  if (typeof uri !== "string" || !/^https?:\/\//i.test(uri)) return "";
  const res = await axios.get(uri, {
    timeout,
    maxContentLength: 256 * 1024,
    maxBodyLength: 256 * 1024,
    validateStatus: () => true,
    proxy: false,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const data = res.data;
  if (!data || typeof data !== "object") return "";
  const image = data.image || data.image_url || data.icon || "";
  if (typeof image !== "string" || !/^https?:\/\//i.test(image)) return "";
  return image;
}

class IconResolver {
  constructor(app, options = {}) {
    this.app = app;
    this.logger = app.logger || console;
    this.enabled = options.enabled !== false;
    this.concurrency = Math.max(1, Number(options.concurrency) || 4);
    this.perCall = Math.max(0, Number(options.perCall) || 40);
    this.timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
    this.retryMs = (Number(options.retryDays) || RETRY_DAYS) * 24 * 3600 * 1000;
    this.maxQueue = Number(options.maxQueue) || MAX_QUEUE;

    this.queue = [];
    this.inQueue = new Set();
    this.active = 0;
    this.stats = { resolved: 0, failed: 0, skipped: 0 };
  }

  /**
   * @param {object[]} rows PfdToken 记录（需要 token / uri / icon / iconCheckedAt）
   */
  enqueue(rows) {
    if (!this.enabled || !rows || !rows.length) return 0;
    if (this.queue.length >= this.maxQueue) return 0;

    const now = Date.now();
    let added = 0;
    for (const row of rows) {
      if (added >= this.perCall) break;
      if (this.queue.length >= this.maxQueue) break;
      if (!row || !row.uri || row.icon) continue;
      if (row.iconCheckedAt) {
        const age = now - new Date(row.iconCheckedAt).getTime();
        const limit = row.iconError ? RETRY_ERROR_MS : this.retryMs;
        if (age < limit) continue;
      }
      if (this.inQueue.has(row.token)) continue;

      this.inQueue.add(row.token);
      this.queue.push({ token: row.token, uri: row.uri });
      added += 1;
    }
    if (added) this._drain();
    return added;
  }

  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active += 1;
      this._run(job).finally(() => {
        this.active -= 1;
        this.inQueue.delete(job.token);
        this._drain();
      });
    }
  }

  async _run(job) {
    let icon = "";
    let failed = false;
    try {
      icon = await fetchIconFromUri(job.uri, this.timeout);
    } catch (error) {
      icon = "";
      failed = true;
    }

    try {
      await this.app.model.PfdToken.updateMany(
        { token: job.token },
        {
          $set: {
            icon,
            iconCheckedAt: new Date(),
            iconError: failed,
          },
        },
      );
      if (icon) this.stats.resolved += 1;
      else this.stats.failed += 1;
    } catch (error) {
      this.logger.warn(`[pfd] 写入 icon 失败 ${job.token}: ${error.message}`);
    }
  }
}

module.exports = { IconResolver, fetchIconFromUri };
