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
    this.success(res);
  }

  async end() {
    const { ctx } = this;
    const res = await ctx.service.executeSwap.end();
    this.success(res);
  }

  async buyToken() {
    const { ctx } = this;
    const { token, twice } = ctx.request.body;
    if (token) {
      const res = await ctx.service.executeSwap.buyToken(token, twice);
      this.success(res);
    } else {
      this.fail("params error");
    }
  }

  async sellToken() {
    const { ctx } = this;
    const { address } = ctx.request.body;
    if (address) {
      const res = await ctx.service.executeSwap.sellTokenToken(address);
      this.success(res);
    } else {
      this.fail("params error");
    }
  }

  async generateWallets() {}
}

module.exports = ExecuteSwap;
