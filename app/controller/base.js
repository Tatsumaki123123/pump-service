"use strict";

const { Controller } = require("egg");
class BaseController extends Controller {
  success(data) {
    this.ctx.body = {
      code: 0,
      data,
    };
    this.ctx.status = 200;
  }

  fail(message, code = 1) {
    this.ctx.body = {
      code,
      message,
    };
    this.ctx.status = 200;
  }

  notFound(message = "not found") {
    this.ctx.throw(404, message);
  }
}

module.exports = BaseController;
