"use strict";

const BaseController = require("./base");

class Fomo extends BaseController {
  async importWallet() {
    const { lineId, privateKey, key } = this.ctx.request.body;
    this.success(
      await this.ctx.service.fomo.importWallet(lineId, privateKey, key),
    );
  }

  async getWallets() {
    const { lineId, address } = this.ctx.request.body;
    this.success(await this.ctx.service.fomo.getWallets(lineId, address));
  }

  async getTokenBalance() {
    const { address, token } = this.ctx.request.body;
    this.success(await this.ctx.service.fomo.getTokenBalance(address, token));
  }

  async updateWallet() {
    const { lineId, address, newPrivateKey, key } = this.ctx.request.body;
    this.success(
      await this.ctx.service.fomo.updateWallet(
        lineId,
        address,
        newPrivateKey,
        key,
      ),
    );
  }

  async deleteWallet() {
    const { lineId, address, key } = this.ctx.request.body;
    this.success(await this.ctx.service.fomo.deleteWallet(lineId, address, key));
  }

  async sellToken() {
    const { lineId, address, token, sellRatio = 1 } = this.ctx.request.body;
    this.success(
      await this.ctx.service.fomo.sellToken({
        lineId,
        address,
        token,
        sellRatio,
      }),
    );
  }

  async swapUsdcToSol() {
    const { lineId, address, sellRatio = 1 } = this.ctx.request.body;
    this.success(
      await this.ctx.service.fomo.swapUsdcToSol({ lineId, address, sellRatio }),
    );
  }
}

module.exports = Fomo;
