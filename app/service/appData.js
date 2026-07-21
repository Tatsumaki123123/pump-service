const { Service } = require("egg");

class AppData extends Service {
  async getData() {
    const appData = await this.ctx.model.AppData.findOne();
    return appData;
  }

  async getXAuth() {
    const appData = await this.getData();
    return appData?.X_AUTH || "";
  }

  async updateXAuth(X_AUTH) {
    const appData = await this.getData();
    if (appData) {
      await this.ctx.model.AppData.updateOne({ _id: appData._id }, { X_AUTH });
    } else {
      await this.ctx.model.AppData.create({ X_AUTH });
    }
    return true;
  }
}

module.exports = AppData;

