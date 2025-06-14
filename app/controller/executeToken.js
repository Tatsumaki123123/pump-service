"use strict";

const { Controller } = require("egg");
const BaseController = require("./base");

class ExecuteToken extends BaseController {
  async tokenList() {
    const { ctx } = this;

    const { line } = ctx.request.body;
    if (line) {
      const res = await ctx.service.executeToken.getTokenList(line);
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
}

module.exports = ExecuteToken;
