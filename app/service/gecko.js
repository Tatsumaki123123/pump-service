const { Service } = require("egg");

const API_URL = "https://app.geckoterminal.com/api/p1/";

class Gecko extends Service {
  async getList(groupSort) {
    const { ctx } = this;

    const sort_field = "created_at";
    const sort_order = "asc";
    const mcp_min = groupSort.mcp_min || 4000;
    const mcp_max = groupSort.mcp_max || 20000;
    const createHour = 20 * 24;
    const holder_min = 50;

    const page = 1;

    const uri = `${AVE_API_URL}solana/pools?page=${page}&fdv_in_usd%5Bgte%5D=${mcp_min}&fdv_in_usd%5Blte%5D=${mcp_max}&networks=solana&dexes=pumpswap&sort=pool_creation_date&pool_creation_hours_ago[lte]=${createHour}`;

    const res = await ctx.curl(uri, {
      dataType: "json",
    });
    const data = res.data;
    if (data) {
      const list = [];
      data.forEach((item) => {
        const { attributes } = item;
        const tokenData = {
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
    } else {
      throw new Error("Gecko get list error");
    }
  }
}
module.exports = Gecko;
