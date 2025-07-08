"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");
const { connection, testWallet } = require("../constants/index");
const {
  wsolToSol,
  wrapSolToWSol,
  closeAllTokenAccounts,
} = require("../utils/solana");
const { PublicKey } = require("@solana/web3.js");

class PumpMonitor extends BaseController {
  async buyToken() {
    const { ctx } = this;

    const { token, poolAddress, quoteAmountIn, baseAmountOut, monitorAddress } =
      ctx.request.body;
    if (token) {
      // await wsolToSol(connection, testWallet);
      // await closeAllTokenAccounts(connection, testWallet);
      // const res = await ctx.service.pumpfun.buyToken(token);

      // const tokenData = {
      //   mint: new PublicKey("5YEooHantgYDeQ1FTJ59q5aVSrpXYCR5fs7UQoyKpump"),
      //   bondingCurve: new PublicKey(
      //     "75cZxpqQ7PmQxhHkYebtcWbsnCqnmFfdSsvNMXuXg7G"
      //   ),
      //   creator: new PublicKey("qtMHp2K9eFYP8FwKqfBAujagtTUzLNjeajtjTuuSrVQ"),
      // };
      // const res = await ctx.service.pumpfun.quickBuyToken(tokenData);
      const res = await ctx.service.pumpAmmMonitor.buyToken({
        token,
        poolAddress,
      });
      this.success(true);
    } else {
      throw new Error("Params error");
    }
  }
  async sellToken() {
    const { ctx } = this;

    const { token, poolAddress, monitorAddress } = ctx.request.body;
    if (token) {
      // const res = await ctx.service.pumpfun.sellToken(token);
      const res = await ctx.service.pumpAmmMonitor.sellToken({ poolAddress });
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async webhook() {
    const { ctx } = this;

    const { data } = ctx.request.body;
    console.log(ctx.request.body);
    this.success(JSON.stringify(data));
  }
}

module.exports = PumpMonitor;
