const { Service } = require("egg");

class AppData extends Service {
  async getData() {
    const appData = await this.ctx.model.AppData.findOne();
    return appData;
  }
}

module.exports = AppData;
