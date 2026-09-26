"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const { connection } = require("../constants");
const { closeAllTokenAccounts } = require("../utils/solana");

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
    const { line, force = false } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.end(line, force);
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async buyToken() {
    const { ctx } = this;
    const { tid, type, walletAddress } = ctx.request.body;
    if (tid && type) {
      let res;
      if (walletAddress) {
        res = await ctx.service.executeSwap.buyTokenByWallet(
          tid,
          walletAddress,
        );
      } else if (Array.isArray(type)) {
        res = await ctx.service.executeSwap.buyTokenArr(tid, type);
      } else {
        res = await ctx.service.executeSwap.buyToken(tid, type);
      }
      this.success(res);
    } else {
      this.fail("params error");
    }
  }

  async sellToken() {
    const { ctx } = this;
    const { tid, type, walletAddress, percent } = ctx.request.body;
    if (tid && type) {
      let res;
      if (walletAddress) {
        res = await ctx.service.executeSwap.sellTokenByWallet(
          tid,
          walletAddress,
          percent,
        );
      } else if (Array.isArray(type)) {
        res = await ctx.service.executeSwap.sellTokenArr(tid, type, percent);
      } else {
        res = await ctx.service.executeSwap.sellToken(tid, type, percent);
      }
      this.success(res);
    } else {
      this.fail("params error");
    }
  }
  async getWallets() {
    const { ctx } = this;
    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.getWalletsWithBalance(line);
      this.success(res);
    } else {
      this.fail("params error");
    }
  }

  async getWalletBalances() {
    const { ctx } = this;
    const { wallets } = ctx.request.body;
    const res = await ctx.service.walletAdmin.getWalletBalances(wallets);
    this.success(res);
  }

  async getAxiomWallets() {
    const { ctx } = this;
    const { startTime, endTime, eid } = ctx.request.body;
    const res = await ctx.service.axiomWallet.getAxiomWallets({
      startTime,
      endTime,
      eid,
    });
    ctx.logger.info(`[Axiom] response preparing: total=${res.total}`);
    this.success(res);
    ctx.logger.info(`[Axiom] response written: total=${res.total}`);
  }

  async getPumpWallets() {
    const { ctx } = this;
    const { startTime, endTime, eid } = ctx.request.body;
    const res = await ctx.service.axiomWallet.getPumpWallets({
      startTime,
      endTime,
      eid,
    });
    ctx.logger.info(`[Pump] response preparing: total=${res.total}`);
    this.success(res);
    ctx.logger.info(`[Pump] response written: total=${res.total}`);
  }

  async getWalletPrivateKey() {
    const { ctx } = this;
    const { address, key } = ctx.request.body;
    const res = await ctx.service.walletAdmin.getWalletPrivateKey(address, key);
    this.success(res);
  }

  async transferWalletBalance() {
    const { ctx } = this;
    const { wallets } = ctx.request.body;
    const res = await ctx.service.walletAdmin.transferWalletBalance(wallets);
    this.success(res);
  }

  async transferFromReceiveAddress() {
    const { ctx } = this;
    const { address, targetAddress, amount = 0.01 } = ctx.request.body;
    const res = await ctx.service.walletAdmin.transferFromReceiveAddress(
      targetAddress || address,
      amount,
    );
    this.success(res);
  }

  async claimCashback() {
    const { ctx } = this;
    const { wallets } = ctx.request.body;
    const res = await ctx.service.walletAdmin.claimCashback(wallets);
    this.success(res);
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
    const res = await ctx.model.ExecuteLine.find().sort({ lineId: "asc" });
    this.success(res);
  }

  async checkToken() {
    const { ctx } = this;

    const { tokenData, eid, forceCheck = false } = ctx.request.body;
    if (tokenData && eid) {
      const res = await ctx.service.executeSwap.checkToken(
        tokenData,
        eid,
        forceCheck,
      );
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async closeAllAccounts() {
    const { ctx } = this;

    const { line, isFirst = false, force = false } = ctx.request.body;
    if (line) {
      let res;
      if (isFirst) {
        const lineData = await ctx.model.ExecuteLine.findOne({
          lineId: line,
        }).lean();
        const { firstWallet } = lineData;
        const secretKey = bs58.decode(firstWallet.privateKey);
        const keypair = Keypair.fromSecretKey(secretKey);
        res = await closeAllTokenAccounts(connection, keypair, force);
      } else {
        res = await ctx.service.executeSwap.closeAllAccounts(line, force);
      }
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async withdraw() {
    const { ctx } = this;

    const { line, amount } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.withdraw(line, amount);
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async getBuyTokes() {
    const { ctx } = this;

    const { eid, tid } = ctx.request.body;
    if (eid || tid) {
      if (tid) {
        const res = await ctx.model.ExecuteToken.findOne({
          tid,
        }).lean();
        const reserveData = await ctx.model.ReserveToken.findOne({
          token: res.token,
          line: res.line,
        }).lean();
        this.success({ ...res, reserveType: reserveData?.type || "" });
      } else {
        const count = await ctx.model.ExecuteToken.count({ eid: eid });
        const res = await ctx.model.ExecuteToken.find({
          eid,
          status: { $in: ["pending", "buy"] },
        }).sort({
          createTime: -1,
        });
        this.success({ list: res, total: count });
      }
    } else {
      throw new Error("Params error");
    }
  }

  async getTokenAccounts() {
    const { ctx } = this;
    const { token, tokenEid, botLine } = ctx.request.body;
    if (token) {
      const data = { tokenAccounts: [], lineBotsAccounts: [] };
      if (tokenEid) {
        data.tokenAccounts =
          await ctx.service.executeSwap.getWalletTokenBalance(tokenEid, token);
      }
      if (botLine) {
        const res = await ctx.service.executeSwap.getLineBotTokenBalance(
          botLine,
          token,
        );
        data.lineBotsAccounts = res.list;
      }
      this.success(data);
    } else {
      throw new Error("params error");
    }
  }

  async deleteToken() {
    const { ctx } = this;
    const { tid } = ctx.request.body;
    if (tid) {
      const dbData = await ctx.model.ExecuteToken.findOne({
        tid: tid,
        status: "pending",
      });
      if (dbData) {
        await ctx.model.ExecuteToken.deleteOne({ tid: tid });
        this.success(true);
      } else {
        throw new Error("Your can only delete Pending token");
      }
    } else {
      throw new Error("params error");
    }
  }

  async autoSwap() {
    const { ctx } = this;
    const { status, line } = ctx.request.body;
    if (line) {
      if (typeof status === "undefined") {
        const data = await ctx.model.ExecuteLine.findOne({ lineId: line });
        this.success(data.autoSwap);
      } else {
        await ctx.model.ExecuteLine.updateOne(
          { lineId: line },
          { autoSwap: status },
        );
        if (status) {
          // ctx.service.autoSwap.start(line);
        }
        this.success(status);
      }
    } else {
      throw new Error("Params error");
    }
  }

  async nextWallet() {
    const { ctx } = this;
    const { line } = ctx.request.body;

    if (line) {
      const res = await ctx.service.executeSwap.nextWallet(line);
      this.success(res);
    } else {
      throw new Error("params");
    }
  }

  async updateLineData() {
    const { ctx } = this;
    const { data, line } = ctx.request.body;
    if (!line) {
      throw new Error("Params error");
    }
    if (data) {
      try {
        const parseData = JSON.parse(data);
        const res = await ctx.model.ExecuteLine.findOne({
          lineId: line,
        }).lean();
        const hasFirstWallet = Object.prototype.hasOwnProperty.call(
          parseData,
          "firstWallet",
        );
        const newData = {
          ...res,
          ...parseData,
        };
        if (hasFirstWallet) {
          const nextFirstWallet = { ...(parseData.firstWallet || {}) };
          if (res.firstWallet?.privateKey && !nextFirstWallet.privateKey) {
            nextFirstWallet.privateKey = res.firstWallet.privateKey;
          }
          newData.firstWallet = nextFirstWallet;
        }
        const { _id, __v, ...updateData } = newData;
        await ctx.model.ExecuteLine.updateOne({ lineId: line }, updateData);
        this.success(true);
      } catch (error) {
        throw new Error("Date format error");
      }
    } else {
      const res = await ctx.model.ExecuteLine.findOne({ lineId: line }).lean();
      const { privateKey, ...firstWallet } = res.firstWallet;
      const data = {
        lineName: res.lineName,
        walletConfig: res.walletConfig,
        firstWallet: firstWallet,
        needFirstWallet: res.needFirstWallet,
        minFollowStates: Number(res.minFollowStates || 0),
        maxBuyTax: res.maxBuyTax,
        sourceWeb: res.sourceWeb,
        groupSort: res.groupSort,
        autoStep: res.autoStep,
        lineBots: res.lineBots,
      };
      this.success(JSON.stringify(data));
    }
  }
}

module.exports = ExecuteSwap;
