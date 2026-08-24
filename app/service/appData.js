const { Service } = require("egg");

class AppData extends Service {
  static DEFAULT_WALLET_KEY = "basketball";

  async getData() {
    const appData = await this.ctx.model.AppData.findOne();
    return appData;
  }

  async getWalletKey() {
    const appData = await this.getData();
    if (!appData) {
      await this.ctx.model.AppData.create({
        key: AppData.DEFAULT_WALLET_KEY,
      });
      return AppData.DEFAULT_WALLET_KEY;
    }

    if (!appData.key) {
      await this.ctx.model.AppData.updateOne(
        { _id: appData._id },
        { key: AppData.DEFAULT_WALLET_KEY },
      );
      return AppData.DEFAULT_WALLET_KEY;
    }

    return appData.key;
  }

  async getReceiveAddress() {
    const appData = await this.getData();
    if (!appData?.receiveAddress) {
      throw new Error("AppData.receiveAddress is not configured");
    }
    return appData.receiveAddress;
  }

  async getReceiveWallet() {
    const appData = await this.ctx.model.AppData.findOne()
      .select("+receivePrivateKey")
      .lean();
    if (!appData?.receiveAddress) {
      throw new Error("AppData.receiveAddress is not configured");
    }
    if (!appData.receivePrivateKey) {
      throw new Error("AppData.receivePrivateKey is not configured");
    }
    return {
      address: appData.receiveAddress,
      privateKey: appData.receivePrivateKey,
    };
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

