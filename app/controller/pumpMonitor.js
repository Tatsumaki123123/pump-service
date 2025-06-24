"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");

class PumpMonitor extends BaseController {
  async buyToken() {
    const { ctx } = this;

    const { poolAddress, quoteAmountIn, baseAmountOut, monitorAddress } =
      ctx.request.body;
    if (line) {
      const res = await ctx.service.pumpAmmMonitor.buyToken({
        poolAddress,
        baseAmountOut,
        quoteAmountIn,
        monitorAddress,
      });
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }
  async sellToken() {
    const { ctx } = this;

    const { poolAddress, monitorAddress } = ctx.request.body;
    if (poolAddress) {
      const res = await ctx.service.pumpAmmMonitor.sellToken({
        poolAddress,
        monitorAddress,
      });
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }
}

module.exports = PumpMonitor;
