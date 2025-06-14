const { Service } = require("egg");

const BASE_URL = "https://debot.ai/api/";

const cookieStr = "";

class Debot extends Service {
  async getHotToken(groupId) {
    const { ctx } = this;
    const appData = await ctx.service.appData.getData();
    const uri = `${BASE_URL}wallet/group/hot_token?group_id=${groupId}&page_index=1&page_size=200&sort_field=wallet_count&sort_order=desc&duration=24H`;
    const res = await ctx.curl(uri, {
      method: "GET",
      dataType: "json",
      headers: {
        "Content-Type": "application/json",
        cookie: appData.debotCookie,
      },
    });
    const data = res.data?.data;

    if (data && data.length > 0) {
      const list = data.filter((item) => {
        const { wallet_count, mkt_cap, percent5m, buy_count, sell_count } =
          item;
        if (
          wallet_count > 1 &&
          mkt_cap < 30000
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
}

module.exports = Debot;
