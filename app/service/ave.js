const { Service } = require("egg");

const AVE_API_URL = "https://api.gejbckf.com/";

function aveTokenToDB(item) {
  const {
    target_token,
    token0_address,
    token0_symbol,
    token1_address,
    token1_symbol,
  } = item;
  const symbol =
    target_token === token0_address ? token0_symbol : token1_symbol;
  return {
    token: item.target_token,
    symbol: symbol,
    logo_url: item.logo_url,
    mkt_cap: item.market_cap,
    create_time: item.created_at,
    amm: item.amm,
    // dev:devData,
    usdPrice: item.current_price_usd,
    pool: item.pair,
    volume_u_5m: item.volume_u_15m,
    volume_u_1h: item.volume_u_1h,
    wallet_count: item.makers_15m,
    transaction_count: item.tx_15m_count,
    buy_count: item.buys_tx_15m_count,
    sell_count: item.sells_tx_15m_count,
    percent5m: item.price_change_15m,
    percent1h: item.price_change_1h,
    latest_time: item.last_trade_at,
    holders: item.holders,
  };
}

function aveTokenInfoToList(item) {
  let amm = "";
  if (item.issue_platform === "letsbonk.fun") {
    amm = "raydiumcpmm";
  } else if (item.issue_platform === "pump.fun") {
    amm = "pumpfunamm";
  }
  return {
    token: item.token,
    symbol: item.symbol,
    logo_url: item.logo_url,
    mkt_cap: parseFloat(item.current_price_usd) * 10 ** 9,
    create_time: parseInt(item.last_txn_time) * 1000,
    amm: amm,
    usdPrice: item.current_price_usd,
    pool: "",
    volume_u_5m: 0,
    volume_u_1h: 0,
    wallet_count: 0,
    transaction_count: 0,
    buy_count: item.total_purchase,
    sell_count: item.total_sold,
    percent5m: 0,
    percent1h: 0,
    latest_time: parseInt(item.last_txn_time) * 1000,
    holders: 0,
  };
}

class Ave extends Service {
  async getXAuth() {
    const appData = await this.ctx.model.AppData.findOne();
    return appData.X_AUTH;
  }

  async getTokenInfo(tokenAddress) {
    const { ctx } = this;
    const X_AUTH = await this.getXAuth();
    const uri = `${AVE_API_URL}v1api/v3/tokens/${tokenAddress}-solana`;

    const res = await ctx.curl(uri, {
      dataType: "json",
      headers: {
        "x-auth": X_AUTH,
      },
    });
    console.log(res);
    const data = res.data?.data;

    // const devData = await this.getTokenDev(tokenAddress);
    if (data) {
      const result = {};
      const { pairs, token } = data;
      // const pair = pairs.find((item) => item.amm === "pumpfunamm");
      const pair = pairs[0] || {};

      result.token = token.token;
      result.symbol = token.symbol;
      // result.dev = devData;
      result.usdPrice = token.current_price_usd;
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

  async getList(groupSort) {
    const { ctx } = this;

    const category = groupSort.category || "pump_out_new";

    if (category === "user") {
      const list = await this.getUserList(groupSort);
      return list;
    }

    const sort_field = groupSort.sort_field || "created_at";
    const sort_order = groupSort.sort_order || "asc";
    const mcp_min = groupSort.mcp_min || 4000;
    const mcp_max = groupSort.mcp_max || 20000;
    const create_day = groupSort.create_day || 10;
    const create_min =
      Math.round(new Date().getTime() / 1000) - create_day * 24 * 3600;
    const holder_min = 10;
    const uri = `${AVE_API_URL}v1api/v4/tokens/treasure/list?chain=solana&sort=${sort_field}&sort_dir=${sort_order}&created_at_min=${create_min}&marketcap_min=${mcp_min}&marketcap_max=${mcp_max}&holder_min=${holder_min}&pageNO=1&pageSize=500&category=${category}`;

    const X_AUTH = await this.getXAuth();

    const res = await ctx.curl(uri, {
      dataType: "json",
      headers: {
        "x-auth": X_AUTH,
      },
    });
    const data = res.data?.data?.data;
    if (data) {
      return data.map((item) => aveTokenToDB(item));
    }
    return data;
  }

  async getMonitorPumpList() {
    const { ctx } = this;
    const sort_field = "created_at";
    const sort_order = "asc";
    const mcp_min = 500000;
    const mcp_max = 10000000;
    const create_day = 30;
    const create_min =
      Math.round(new Date().getTime() / 1000) - create_day * 24 * 3600;
    const holder_min = 50;
    const category = "pump_out_hot";
    const uri = `${AVE_API_URL}v1api/v4/tokens/treasure/list?chain=solana&sort=${sort_field}&sort_dir=${sort_order}&created_at_min=${create_min}&marketcap_min=${mcp_min}&marketcap_max=${mcp_max}&holder_min=${holder_min}&pageNO=1&pageSize=500&category=${category}`;

    const X_AUTH = await this.getXAuth();

    const res = await ctx.curl(uri, {
      dataType: "json",
      headers: {
        "x-auth": X_AUTH,
      },
    });
    const data = res.data?.data?.data;
    if (data) {
      console.log(data.length);
      return data.map((item) => aveTokenToDB(item));
    }
    return [];
  }

  async getUserList(groupSort) {
    const { address } = groupSort;
    if (!address || address.length === 0) {
      throw new Error("address is required");
    }
    const X_AUTH = await this.getXAuth();
    const { ctx } = this;

    const list = [];
    for (const addr of address) {
      const uri = `${AVE_API_URL}/v2api/walletinfo/v1/tokens?user_address=${addr}&chain=solana&pageNO=1&pageSize=500&sort_dir=desc&sort=last_txn_time&is_self=0e`;

      const res = await ctx.curl(uri, {
        dataType: "json",
        headers: {
          "x-auth": X_AUTH,
        },
      });
      const data = res.data?.data;
      if (data) {
        const tokens = data.filter(
          (item) =>
            parseInt(item.total_profit) !== 0 &&
            item.token !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        );
        tokens.forEach((tItem) => {
          if (!list.find((item) => item.token === tItem.token)) {
            list.push(tItem);
          }
        });
      }
    }

    return list
      .map((item) => aveTokenInfoToList(item))
      .filter((item) => item.amm);
  }

  async getFavList(groupSort) {}
}
module.exports = Ave;
