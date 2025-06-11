"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");

/**
 * 1, 生成6个钱包地址，每个转入固定金额sol
 */
class ExecuteSwap extends BaseController {
  async start() {
    const { ctx } = this;
    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.start(line);
      this.success(true);
    } else {
      throw new Error("Params error");
    }
  }

  async generateWallets() {
    const { ctx } = this;
    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.generateWallets(line);
      this.success(true);
    } else {
      throw new Error("Params error");
    }
  }

  async end() {
    const { ctx } = this;
    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.end(line);
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async buyToken() {
    const { ctx } = this;
    const { token, type, line } = ctx.request.body;
    if (token && type && line) {
      const res = await ctx.service.executeSwap.buyToken(token, line, type);
      this.success(res);
    } else {
      this.fail("params error");
    }
  }

  async sellToken() {
    const { ctx } = this;
    const { token, type, line } = ctx.request.body;
    if (token && type && line) {
      const res = await ctx.service.executeSwap.sellToken(token, line, type);
      this.success(res);
    } else {
      this.fail("params error");
    }
  }
  async getWallets() {
    const { ctx } = this;
    const { line, token } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.getWalletsWithBalance(
        line,
        token
      );
      this.success(res);
    } else {
      this.fail("params error");
    }
  }

  async getBoss() {
    const { ctx } = this;
    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.getBossWithBalance(line);
      this.success(res);
    } else {
      this.fail("params error");
    }
  }

  async getLines() {
    const { ctx } = this;
    const res = await ctx.model.ExecuteLine.find();
    this.success(res);
  }

  async checkToken() {
    const { ctx } = this;

    const { token, eid } = ctx.request.body;
    if (token && eid) {
      const res = await ctx.service.executeSwap.checkToken(token, eid);
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }
}

module.exports = ExecuteSwap;
