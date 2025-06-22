const { Service } = require("egg");

const AVE_API_URL = "https://api.avegac.com/";

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
    const sort_field = "created_at";
    const sort_order = "asc";
    const mcp_min = groupSort.mcp_min || 4000;
    const mcp_max = groupSort.mcp_max || 20000;
    const create_min = Math.round(new Date().getTime() / 1000) - 30 * 24 * 3600;
    const holder_min = 50;
    const category = groupSort.category || "pump_out_new";
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
      return data.map((item) => {
        const {
          target_token,
          token0_address,
          token0_symbol,
          token1_address,
          token1_symbol,
        } = item;
        const symbol =
          target_token === token0_address ? token0_symbol : token0_symbol;
        return {
          token: item.target_token,
          symbol: symbol,
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
      });
    }
    return data;
  }
}
module.exports = Ave;
