"use strict";

const BaseController = require("./base");

class AppData extends BaseController {
  async getXAuth() {
    const { ctx } = this;
    const X_AUTH = await ctx.service.appData.getXAuth();
    this.success({ X_AUTH });
  }

  async checkVisitPass() {
    const { ctx } = this;
    const { pass } = ctx.request.body;
    const valid = await ctx.service.appData.checkVisitPass(pass);
    this.success(valid);
  }

  async updateXAuth() {
    const { ctx } = this;
    const { X_AUTH, xAuth } = ctx.request.body;
    const nextXAuth = typeof X_AUTH !== "undefined" ? X_AUTH : xAuth;

    if (typeof nextXAuth === "string") {
      await ctx.service.appData.updateXAuth(nextXAuth);
      this.success(true);
    } else {
      throw new Error("Params error");
    }
  }
}

module.exports = AppData;

