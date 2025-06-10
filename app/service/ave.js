const { Service } = require("egg");

const AVE_API_URL = "https://api.eskegs.com/";

class Ave extends Service {
  async getXAuth() {
    const appData = await this.ctx.model.AppData.findOne();
    return appData.X_AUTH;
  }

  async getTokenInfo(tokenAddress) {
    console.log("get token info");
    const { ctx } = this;
    const X_AUTH = await this.getXAuth();
    const uri = `${AVE_API_URL}v1api/v3/tokens/${tokenAddress}-solana`;

    const res = await ctx.curl(uri, {
      dataType: "json",
      headers: {
        "x-auth": X_AUTH,
      },
    });
    const data = res.data?.data;
    const devData = await this.getTokenDev(tokenAddress);
    console.log(data, devData);
    if (data && devData) {
      const result = {};
      const { pairs, token } = data;
      const pair = pairs.find((item) => item.amm === "pumpfunamm");

      result.token = token.token;
      result.symbol = token.symbol;
      result.dev = devData;
      result.usePrice = token.current_price_usd;
      result.solPrice = token.current_price_eth;
      result.pool = pair.pair;
      result.volume_u_5m = pair.volume_u_5m;
      result.volume_u_1h = pair.volume_u_1h;

      return result;
    } else {
      throw new Error("Cannot get token info by AVE");
    }
  }

  async getTokenDev(tokenAddress) {
    const X_AUTH = await this.getXAuth();
    const { ctx } = this;

    const uri = `${AVE_API_URL}v1api/v3/stats/rugpullrate?token_id=${tokenAddress}-solana`;
    const res = await this.ctx.curl(uri, {
      dataType: "json",
      headers: {
        "x-auth": X_AUTH,
      },
    });
    const data = res.data?.data;
    if (data) {
      return data.dev;
    } else {
      throw new Error("Cannot get token dev by AVE");
    }
  }
}
module.exports = Ave;
