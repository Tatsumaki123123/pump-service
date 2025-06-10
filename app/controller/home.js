const { Controller } = require("egg");

class HomeController extends Controller {
  async index() {
    const { ctx } = this;
    ctx.body = "hi, egg  pump service";
  }
}

module.exports = HomeController;
