const { Service } = require("egg");
const {
  constants: cryptoConstants,
  publicEncrypt,
} = require("node:crypto");

const AVE_API_URL = "https://api.gejbckf.com/";
const AVE_TOKEN_INFO_API_URL = "https://cyjm22.com/";
const AVE_AUTH_BASE_URL =
  process.env.AVE_AUTH_BASE_URL ||
  process.env.AVE_BASE_URL ||
  AVE_TOKEN_INFO_API_URL;
const AVE_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp7rxCs+UF5QjAZWY63Ow1rNY4prtorIRawALlqGcWrDP2TKqC6XLybJCwOZ8HCGYzzHdQJFBLb8wlbaAJxg2/G+glwN/Hp1xNuYw6uJ7LTFMZCFsU5ReLxZ83uVs/uG80vyrpaiN+eU58B9j12+w4VbIv4dd0a5ILAQMLjJQiUgiGfD4JI9ic8qCNwOo2su3wdKthMeg5WYhYXtKJyUBJMn5odKd7XOQO7KmsuHy+dEbutSPuC2kTY+y2bzHUdTYeUp6U/GUZCjHirZCUCQyCBPE8nWoCRjhP9+ewSKSRPaTOG/uicrN1cUZC5Oal9PPigGAJ8gkKTPDgZHFPXTKuQIDAQAB";
const AVE_VISITOR_ID = process.env.AVE_VISITOR_ID || "";
const AVE_TREASURE_API_URL =
  process.env.AVE_TREASURE_API_URL || "https://jyhkdyf.com/";
const AVE_FOLLOW_API_URL =
  process.env.AVE_FOLLOW_API_URL || AVE_TREASURE_API_URL;
const AVE_LOGO_URL = process.env.AVE_LOGO_URL || "https://www.iconaves.com/";

let aveRefreshPromise = null;

function createAuthExpiredError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "AVE_AUTH_EXPIRED";
  return error;
}

function isAuthExpiredError(error) {
  return error?.code === "AVE_AUTH_EXPIRED";
}

function getHttpStatus(response) {
  return Number(
    response?.status || response?.statusCode || response?.res?.statusCode,
  );
}

function isAuthHttpError(error) {
  const status = Number(
    error?.status || error?.statusCode || error?.response?.status,
  );
  return status === 401 || status === 403;
}

function getAveUrl(baseUrl, path) {
  return new URL(path.replace(/^\/+/, ""), baseUrl).toString();
}

function getAveLogoUrl(logoUrl) {
  if (!logoUrl || typeof logoUrl !== "string") {
    return "";
  }
  if (/^https?:\/\//i.test(logoUrl)) {
    return logoUrl;
  }
  return AVE_LOGO_URL + logoUrl.replace(/^\/+/, "");
}

function aveTokenToDB(item) {
  const {
    target_token,
    token0_address,
    token0_logo_url,
    token0_symbol,
    token1_address,
    token1_logo_url,
    token1_symbol,
  } = item;
  const isToken0 = target_token === token0_address;
  const symbol = isToken0 ? token0_symbol : token1_symbol;
  const logoUrl = isToken0 ? token0_logo_url : token1_logo_url;
  return {
    token: item.target_token,
    symbol: symbol,
    icon: getAveLogoUrl(logoUrl || item.logo_url),
    mkt_cap: item.market_cap,
    create_time: item.created_at,
    amm: item.amm,
    // dev:devData,
    usdPrice: item.current_price_usd,
    pool: item.pair,
    volume_u_5m: item.volume_u_15m,
    volume_u_1h: item.volume_u_1h,
    gas_fee_sum: item.gas_fee_sum,
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
    gas_fee_sum: item.gas_fee_sum,
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
    const storedAuth = await this.ctx.service.appData.getXAuth();
    return String(storedAuth || process.env.AVE_X_AUTH || "").trim();
  }

  async requestRaw(uri, options = {}) {
    const { ctx } = this;
    let response;
    try {
      response = await ctx.curl(uri, {
        dataType: "json",
        ...options,
      });
    } catch (error) {
      if (isAuthHttpError(error)) {
        throw createAuthExpiredError("AVE x-auth expired or rejected", error);
      }
      throw error;
    }

    const httpStatus = getHttpStatus(response);
    if (httpStatus === 401 || httpStatus === 403) {
      throw createAuthExpiredError(`AVE x-auth rejected (HTTP ${httpStatus})`);
    }

    const status = String(response?.data?.status ?? "");
    if (status === "10000" || status === "10001") {
      throw createAuthExpiredError("AVE x-auth expired or rejected");
    }
    return response;
  }

  async requestAve(uri, options = {}) {
    let xAuth = await this.getXAuth();
    if (!xAuth) {
      xAuth = await this.refreshXAuth("");
      return this.requestRaw(uri, {
        ...options,
        headers: { ...(options.headers || {}), "x-auth": xAuth },
      });
    }

    try {
      return await this.requestRaw(uri, {
        ...options,
        headers: { ...(options.headers || {}), "x-auth": xAuth },
      });
    } catch (error) {
      if (!isAuthExpiredError(error)) {
        throw error;
      }
      xAuth = await this.refreshXAuth(xAuth);
      return this.requestRaw(uri, {
        ...options,
        headers: { ...(options.headers || {}), "x-auth": xAuth },
      });
    }
  }

  async refreshXAuth(rejectedToken) {
    if (aveRefreshPromise) {
      return aveRefreshPromise;
    }

    aveRefreshPromise = (async () => {
      const currentToken = await this.getXAuth();
      if (currentToken && currentToken !== rejectedToken) {
        return currentToken;
      }

      const visitorId = String(
        process.env.AVE_VISITOR_ID || AVE_VISITOR_ID,
      ).trim();
      if (!/^[0-9a-f]{32}$/i.test(visitorId)) {
        throw new Error(
          "AVE_VISITOR_ID must be the 32-character hexadecimal browser visitorId",
        );
      }

      const serverTimeUri = getAveUrl(
        AVE_AUTH_BASE_URL,
        "/v1api/v2/settings/serverTime",
      );
      const serverTimeResponse = await this.requestRaw(serverTimeUri, {
        method: "GET",
      });
      const serverTime = Number(serverTimeResponse.data?.data?.server_time);
      if (
        String(serverTimeResponse.data?.status) !== "1" ||
        !Number.isSafeInteger(Math.trunc(serverTime)) ||
        serverTime <= 0
      ) {
        throw new Error("AVE returned an invalid server_time");
      }

      const timestamp = Math.trunc(serverTime) * 1000 + (Date.now() % 1000);
      const plaintext = `${visitorId}$web$1.0.0$r1r$${timestamp}`;
      const requestId = publicEncrypt(
        {
          key: Buffer.from(AVE_PUBLIC_KEY, "base64"),
          format: "der",
          type: "spki",
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(plaintext),
      ).toString("base64");

      const tokenUri = getAveUrl(
        AVE_AUTH_BASE_URL,
        "/v1api/v1/captcha/requestToken",
      );
      const tokenResponse = await this.requestRaw(tokenUri, {
        method: "POST",
        contentType: "json",
        headers: { "Content-Type": "application/json" },
        data: { request_id: requestId },
      });
      const tokenData = tokenResponse.data?.data || {};
      if (tokenData.image || tokenData.image_base64) {
        throw new Error(
          "AVE requires captcha verification before x-auth can be updated",
        );
      }
      const nextToken = String(tokenData.id || "").trim();
      if (String(tokenResponse.data?.status) !== "1" || !nextToken) {
        throw new Error("AVE requestToken returned no valid token");
      }

      await this.ctx.service.appData.updateXAuth(nextToken);
      return nextToken;
    })();

    try {
      return await aveRefreshPromise;
    } finally {
      aveRefreshPromise = null;
    }
  }

  async getTokenInfo(tokenAddress) {
    const tokenId = `${tokenAddress}-solana`;
    const uri = `${AVE_TOKEN_INFO_API_URL}v2api/token_info/v1/token/detail?token_id=${tokenId}&cache_use=false`;

    const res = await this.requestAve(uri);
    const data = res.data?.data;

    // const devData = await this.getTokenDev(tokenAddress);
    if (res.data?.status === 1 && data?.token) {
      const result = {};
      const { pairs = [], token } = data;
      const pair =
        pairs.find((item) => item.pair === token.main_pair) || pairs[0] || {};
      const usdPrice = Number(token.current_price_usd || 0);
      const totalSupply = Number(token.total || 0);
      let appendix = {};
      try {
        appendix = token.appendix ? JSON.parse(token.appendix) : {};
      } catch (error) {}

      result.token = token.token;
      result.symbol = token.symbol;
      result.name = token.name;
      result.logo_url = token.logo_url;
      // result.dev = devData;
      result.usdPrice = token.current_price_usd;
      result.solPrice = token.current_price_eth;
      result.mkt_cap = usdPrice && totalSupply ? usdPrice * totalSupply : 0;
      result.pool = pair.pair || token.main_pair || "";
      result.amm = pair.amm || token.launchpad || "";
      result.volume_u_5m = pair.volume_u_5m || 0;
      result.volume_u_1h = pair.volume_u_1h || 0;
      result.volume_u_24h = pair.volume_u_24h || 0;
      result.wallet_count = pair.makers_5m || 0;
      result.transaction_count = pair.tx_5m_count || 0;
      result.buy_count = pair.buys_tx_5m_count || 0;
      result.sell_count = pair.sells_tx_5m_count || 0;
      result.percent5m = pair.price_change_5m ?? token.price_change ?? 0;
      result.percent1h = pair.price_change_1h ?? token.price_change ?? 0;
      result.holders = token.holders || 0;
      result.create_time =
        (token.opening_at || token.publish_at || pair.created_at || 0) * 1000;
      result.latest_time = (pair.updated_at || pair.first_trade_at || 0) * 1000;
      result.twitter = appendix.twitter || "";
      result.website = appendix.website || "";

      return result;
    } else {
      throw new Error("Cannot get token info by AVE");
    }
  }

  async getTokenDev(tokenAddress) {
    const uri = `${AVE_API_URL}v1api/v3/stats/rugpullrate?token_id=${tokenAddress}-solana`;
    const res = await this.requestAve(uri);
    const data = res.data?.data;
    if (data) {
      return data.dev;
    } else {
      throw new Error("Cannot get token dev by AVE");
    }
  }

  async getFollowAggregateStates(tokenAddress) {
    const tokenId = `${tokenAddress}-solana`;
    const uri = `${AVE_FOLLOW_API_URL}v1api/v3/stats/follows/aggregatestates?token_id=${encodeURIComponent(tokenId)}&self_address=0xa65ad9201b6d48519822a3a1972ee68ec0437e1b`;

    const res = await this.requestAve(uri);
    const data = res.data?.data;
    if (String(res.data?.status) === "1" && data) {
      return data;
    }
    throw new Error(
      `Cannot get token follow states by AVE: status=${res.data?.status ?? "unknown"} msg=${res.data?.msg || "unknown"}`,
    );
  }

  async getList(groupSort = {}) {
    const category = groupSort.category || "pump_out_new";

    if (category === "user") {
      const list = await this.getUserList(groupSort);
      return list;
    }

    const sortField = groupSort.sort_field || "created_at";
    const sortOrder = groupSort.sort_order || "asc";
    const marketCapMin = groupSort.mcp_min ?? 4000;
    const marketCapMax = groupSort.mcp_max ?? 20000;
    const holderMin = groupSort.holder_min ?? 30;
    const createDay = Number(groupSort.create_day ?? 10);
    const createDayEnd = Number(groupSort.create_day_end ?? 0);
    const pageNo = Number(groupSort.page_no ?? 1);
    const pageSize = Number(groupSort.page_size ?? 500);

    if (
      !Number.isFinite(createDay) ||
      !Number.isFinite(createDayEnd) ||
      createDay < 0 ||
      createDayEnd < 0 ||
      createDay < createDayEnd
    ) {
      throw new Error(
        "create_day and create_day_end must be non-negative, and create_day must be greater than or equal to create_day_end",
      );
    }
    if (
      !Number.isInteger(pageNo) ||
      !Number.isInteger(pageSize) ||
      pageNo < 1 ||
      pageSize < 1
    ) {
      throw new Error("page_no and page_size must be positive integers");
    }

    const now = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      chain: "solana",
      sort: sortField,
      sort_dir: sortOrder,
      created_at_min: String(Math.floor(now - createDay * 24 * 3600)),
      created_at_max: String(Math.floor(now - createDayEnd * 24 * 3600)),
      marketcap_min: String(marketCapMin),
      marketcap_max: String(marketCapMax),
      holder_min: String(holderMin),
      pageNO: String(pageNo),
      pageSize: String(pageSize),
      category,
    });
    if (groupSort.amm) {
      params.set("amm", groupSort.amm);
    }
    if (groupSort.self_address) {
      params.set("self_address", groupSort.self_address);
    }

    const uri = new URL(
      "v1api/v4/tokens/treasure/list",
      AVE_TREASURE_API_URL,
    );
    uri.search = params.toString();

    const res = await this.requestAve(uri.toString());
    const data = res.data?.data?.data;
    if (data) {
      return data.map((item) => aveTokenToDB(item));
    }
    return data;
  }

  async getMonitorPumpList() {
    const sort_field = "created_at";
    const sort_order = "asc";
    const mcp_min = 500000;
    const mcp_max = 10000000;
    const create_day = 30;
    const create_min =
      Math.round(new Date().getTime() / 1000) - create_day * 24 * 3600;
    const holder_min = 50;
    const category = "pump_out_hot";
    const uri = `${AVE_TREASURE_API_URL}v1api/v4/tokens/treasure/list?chain=solana&sort=${sort_field}&sort_dir=${sort_order}&created_at_min=${create_min}&marketcap_min=${mcp_min}&marketcap_max=${mcp_max}&holder_min=${holder_min}&pageNO=1&pageSize=500&category=${category}`;

    const res = await this.requestAve(uri);
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
    const list = [];
    for (const addr of address) {
      const uri = `${AVE_API_URL}/v2api/walletinfo/v1/tokens?user_address=${addr}&chain=solana&pageNO=1&pageSize=500&sort_dir=desc&sort=last_txn_time&is_self=0e`;

      const res = await this.requestAve(uri);
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
