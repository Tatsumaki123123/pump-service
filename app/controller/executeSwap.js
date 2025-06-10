"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");

/**
 * 1, 生成6个钱包地址，每个转入固定金额sol
 */
class ExecuteSwap extends BaseController {
  async start() {
    const { ctx } = this;
    const res = await ctx.service.executeSwap.start();
    this.success(true);
  }

  async generateWallets() {
    const { ctx } = this;
    const res = await ctx.service.executeSwap.generateWallets();
    this.success(true);
  }

  async end() {
    const { ctx } = this;
    const res = await ctx.service.executeSwap.end();
    this.success(res);
  }

  async buyToken() {
    const { ctx } = this;
    const { token, type } = ctx.request.body;
    if (token && type) {
      const res = await ctx.service.executeSwap.buyToken(token, type);
      this.success(res);
    } else {
      this.fail("params error");
    }
  }

  async sellToken() {
    const { ctx } = this;
    const { token, type } = ctx.request.body;
    if (token && type) {
      const res = await ctx.service.executeSwap.sellToken(token, type);
      this.success(res);
    } else {
      this.fail("params error");
    }
  }
}

module.exports = ExecuteSwap;
