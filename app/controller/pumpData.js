"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");

class PumpData extends BaseController {
  async status() {
    const { ctx } = this;
    const res = await ctx.service.pumpData.status();
    this.success(res);
  }

  async warm() {
    const { ctx } = this;
    const {
      createDay,
      createDayEnd,
      exchange,
      maxFiles,
      dryRun,
    } = ctx.request.body || {};
    const res = await ctx.service.pumpData.warm({
      createDay,
      createDayEnd,
      exchange,
      maxFiles,
      dryRun,
    });
    this.success(res);
  }

  /**
   * 调试用：不依赖线路配置，直接用 groupSort 走一遍 pumpfundata 筛选，
   * 返回结构与 /v1/executetoken/tokenList 一致。
   */
  async tokenList() {
    const { ctx } = this;
    const { groupSort } = ctx.request.body || {};
    const res = await ctx.service.pumpData.getList(groupSort || {});
    this.success(res);
  }
}

module.exports = PumpData;
