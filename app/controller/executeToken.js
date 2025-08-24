"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");

class ExecuteToken extends BaseController {
  async tokenList() {
    const { ctx } = this;

    const { line, listType = "default" } = ctx.request.body;
    if (line) {
      let res;
      if (listType !== "default") {
        res = await ctx.model.ReserveToken.find({
          line: line,
          type: listType,
        });
      } else {
        res = await ctx.service.executeToken.getTokenList(line);
      }
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async initTokenList() {
    const { ctx } = this;

    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeToken.initTokenList(line);
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async addToken() {
    const { ctx } = this;

    const { tokenInfo, type = "good" } = ctx.request.body;
    if (tokenInfo) {
      const dbData = await ctx.model.ReserveToken.findOne({
        token: tokenInfo.token,
        line: tokenInfo.line,
      });
      if (!dbData) {
        await ctx.model.ReserveToken.create({ ...tokenInfo, type: type });
      } else {
        await ctx.model.ReserveToken.updateOne(
          {
            token: tokenInfo.token,
            line: tokenInfo.line,
          },
          { type: type }
        );
      }
      this.success(true);
    } else {
      throw new Error("Params error");
    }
  }

  async reserveToken() {
    const { ctx } = this;

    const { line, type } = ctx.request.body;
    if (line) {
      const res = await ctx.model.ReserveToken.find({
        line: line,
        type: type || "good",
      });
      this.success(res);
    } else {
      throw new Error("Params error");
    }
  }

  async deletePoolStore() {
    const { ctx } = this;

    const { token } = ctx.request.body;
    if (token) {
      await ctx.model.PoolStore.deleteOne({
        token: token,
      });
      this.success(true);
    } else {
      throw new Error("Params error");
    }
  }
}

module.exports = ExecuteToken;
