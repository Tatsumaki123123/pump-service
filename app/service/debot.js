const { Service } = require("egg");
const { chain } = require("lodash");

const BASE_URL = "https://debot.ai/api/";

const cookieStr = "";

class Debot extends Service {
  async getHotToken(groupId, groupSort = {}) {
    const { ctx } = this;
    const appData = await ctx.service.appData.getData();
    let sort_field = "wallet_count";
    let sort_order = "desc";
    if (groupSort) {
      sort_field = groupSort.sort_field;
      sort_order = groupSort.sort_order;
    }
    const uri = `${BASE_URL}wallet/group/hot_token?group_id=${groupId}&page_index=1&page_size=200&sort_field=${sort_field}&sort_order=${sort_order}&duration=24H`;
    const res = await ctx.curl(uri, {
      method: "GET",
      dataType: "json",
      headers: {
        "Content-Type": "application/json",
        cookie: appData.debotCookie,
      },
    });
    if (res.data.code !== 0) {
      throw new Error("Get data from debot error");
    }
    const data = res.data?.data;

    if (data && data.length > 0) {
      const walletCount = groupSort.wallet_count || 1;
      const list = data.filter((item) => {
        const { wallet_count, mkt_cap, percent5m, buy_count, sell_count } =
          item;
        if (
          wallet_count >= walletCount &&
          mkt_cap < 30000 &&
          mkt_cap > 3000
          //   percent5m === 0 &&
          //   buy_count === sell_count &&
          //   buy_count > 1
        ) {
          return true;
        } else {
          return false;
        }
      });
      return list;
    }
  }

  async getTokenInfo(token) {
    const { ctx } = this;
    const uri = `${BASE_URL}market/token/info?token=${token}&chain=solana`;
    const res = await ctx.curl(uri, {
      method: "GET",
      dataType: "json",
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (res.data.code !== 0 && res.data.data) {
      throw new Error("Get data from debot error");
    }
    const data = res.data.data;
    const meta = data.meta;
    return {
      chain: meta.chain,
      token: meta.address,
      dev: meta.creator_address,
      symbol: meta.symbol,
      name: meta.name,
    };
  }
}

module.exports = Debot;
