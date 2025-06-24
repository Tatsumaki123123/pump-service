"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");
const { connection, testWallet } = require("../constants/index");
const {
  wsolToSol,
  wrapSolToWSol,
  closeAllTokenAccounts,
} = require("../utils/solana");

class PumpMonitor extends BaseController {
  async buyToken() {
    const { ctx } = this;

    const { token, poolAddress, quoteAmountIn, baseAmountOut, monitorAddress } =
      ctx.request.body;
    if (token) {
      // await wsolToSol(connection, testWallet);
      await closeAllTokenAccounts(connection, testWallet);
      // const res = await ctx.service.pumpfun.buyToken(token);
      this.success(true);
    } else {
      throw new Error("Params error");
    }
  }
  async sellToken() {
    const { ctx } = this;

    const { token, poolAddress, monitorAddress } = ctx.request.body;
    if (token) {
      const res = await ctx.service.pumpfun.sellToken(token);
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }
}

module.exports = PumpMonitor;
