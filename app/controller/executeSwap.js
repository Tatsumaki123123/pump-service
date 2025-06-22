"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");

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
    const { tid, type } = ctx.request.body;
    if (tid && type) {
      let res;
      if (Array.isArray(type)) {
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
    const { tid, type, walletAddress } = ctx.request.body;
    if (tid && type) {
      let res;
      if (walletAddress) {
        res = await ctx.service.executeSwap.sellTokenByWallet(
          tid,
          walletAddress
        );
      } else if (Array.isArray(type)) {
        res = await ctx.service.executeSwap.sellTokenArr(tid, type);
      } else {
        res = await ctx.service.executeSwap.sellToken(tid, type);
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

    const { tokenData, eid } = ctx.request.body;
    if (tokenData && eid) {
      const res = await ctx.service.executeSwap.checkToken(tokenData, eid);
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async closeAllAccounts() {
    const { ctx } = this;

    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.closeAllAccounts(line);
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async withdraw() {
    const { ctx } = this;

    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeSwap.withdraw(line);
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
          token
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
          { autoSwap: status }
        );
        if (status) {
          ctx.service.autoSwap.start(line);
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
}

module.exports = ExecuteSwap;
