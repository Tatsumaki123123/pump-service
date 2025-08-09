const { Service } = require("egg");
const { chain } = require("lodash");

const PROXY_KEY =
  "1E97W3TTT5OI4P8LO7NR3HIPG2TAULEIIYKWJVZAIC23RYUDDYD8TVW8Q6ZLFA5LQS4B76940UXI52DB";
const PROXY_URL = `https://app.scrapingbee.com/api/v1/?api_key=${PROXY_KEY}`;

const BASE_URL = "https://debot.ai/api/";

const cookieStr = "";

class Debot extends Service {
  async getList(groupSort) {
    const { category } = groupSort;
    if (category === "fav") {
      return this.getCollectToken(groupSort);
    } else {
      return this.getHotToken(groupSort);
    }
  }
  async getHotToken(groupSort = {}) {
    const { ctx } = this;
    const { groupId } = groupSort;
    const appData = await ctx.service.appData.getData();
    let sort_field = "latest_time";
    let sort_order = "desc";
    if (groupSort) {
      sort_field = groupSort.sort_field;
      sort_order = groupSort.sort_order;
    }
    const uri = `${BASE_URL}wallet/group/hot_token?group_id=${groupId}&page_index=1&page_size=200&sort_field=${sort_field}&sort_order=${sort_order}&duration=24H`;

    // const proxyUri = `${PROXY_URL}&url=${encodeURIComponent(uri)}`;
    const res = await ctx.curl(uri, {
      method: "GET",
      dataType: "json",
      headers: {
        "Content-Type": "application/json",
        cookie: appData.debotCookie,
        "sec-ch-ua-full-version": "138.0.7204.158",
      },
    });
    console.log(res);
    if (res.data.code !== 0) {
      throw new Error("Get data from debot error");
    }
    const data = res.data?.data;

    if (data) {
      const walletCount = groupSort.wallet_count || 1;
      const list = data
        .filter((item) => {
          const { wallet_count, mkt_cap, percent5m, buy_count, sell_count } =
            item;
          if (
            wallet_count >= walletCount
            // mkt_cap > 3000 &&
            // mkt_cap < 150000
            //   percent5m === 0 &&
            //   buy_count === sell_count &&
            //   buy_count > 1
          ) {
            return true;
          } else {
            return false;
          }
        })
        .map((item) => {
          const { tags = [] } = item;
          let amm = "pumpfunamm";
          if (tags && tags.includes("raydium_launchlab")) {
            amm = "raydiumcpmm";
          }
          return {
            ...item,
            amm,
            create_time: item.create_time * 1000,
            latest_time: item.latest_time * 1000,
          };
        });
      return list;
    } else {
      console.log(res);
      throw new Error(res.message);
    }
  }

  async getCollectToken(groupSort) {
    const { ctx } = this;
    const { favId } = groupSort;
    const appData = await ctx.service.appData.getData();

    const uri = `${BASE_URL}self-select/token/group/rank?&group_id=${favId}&chain=solana&duration=1H&sort_field=creation_timestamp&sort_order=asc&filter=%7B%7D`;

    // const proxyUri = `${PROXY_URL}&url=${encodeURIComponent(uri)}`;
    const res = await ctx.curl(uri, {
      method: "GET",
      dataType: "json",
      headers: {
        "Content-Type": "application/json",
        cookie: appData.debotCookie,
        "sec-ch-ua-full-version": "138.0.7204.158",
      },
    });
    if (res.data.code !== 0) {
      throw new Error("Get data from debot error");
    }
    const data = res.data?.data;

    if (data) {
      const list = data.map((item) => {
        const { tags = [], market_info } = item;
        let amm = "pumpfunamm";
        if (tags && tags.includes("raydium_launchlab")) {
          amm = "raydiumcpmm";
        }
        return {
          amm,
          create_time: item.create_time * 1000,
          latest_time: item.latest_time * 1000,
          token: item.address,
          symbol: item.symbol,
          mkt_cap: market_info.mkt_cap,
          create_time: item.creation_timestamp * 1000,
          usdPrice: market_info.price,
          volume_u_5m: market_info.volume,
          volume_u_1h: market_info.volume,
          wallet_count: 0,
          transaction_count: 0,
          buy_count: 0,
          sell_count: 0,
          percent5m: market_info.percent_5m,
          percent1h: market_info.percent_5m,
          latest_time: market_info.last_update_time * 1000,
          holders: market_info.holders,
        };
      });
      return list;
    } else {
      console.log(res);
      throw new Error(res.message);
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
