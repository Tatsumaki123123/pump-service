const { Service } = require("egg");

const API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjQxMjRhMzkwLTdhNmQtNDkzNS05OTYxLWEwZTJlNmJmMWZjZSIsIm9yZ0lkIjoiNDUyMDA4IiwidXNlcklkIjoiNDY1MDc5IiwidHlwZUlkIjoiOGM1YmExYjYtYTdhNy00Y2E3LTg5YTktNjNkOGFhNjYxMmM0IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NDk0NDc2ODAsImV4cCI6NDkwNTIwNzY4MH0.4kv9PS2J1yf8K0-_Tn1TtKlxl2Tn9JFXy31W2vq8cG8";

const BASE_URL = "https://solana-gateway.moralis.io/token/mainnet/";

const headers = {
  accept: "application/json",
  "X-API-Key": API_KEY,
};

class Moralis extends Service {
  async getTokenPairs(token) {
    const { ctx } = this;
    const uri = `${BASE_URL}${token}/pairs`;

    const res = await ctx.curl(uri, {
      method: "GET",
      dataType: "json",
      headers: headers,
    });
    const pairs = res.data.pairs;
    console.log(pairs);
  }

  async getTokenPrice(token) {
    const { ctx } = this;
    const uri = `${BASE_URL}${token}/price`;

    // const res = await ctx.curl(uri, {
    //   method: "GET",
    //   dataType: "json",
    //   headers: headers,
    // });
    // const data = res.data;
    data = {
      tokenAddress: "AhtTjcSc5Y2mK89uAzMDj19oZpmJLWzFqxwknJo6pump",
      pairAddress: "ASFgdYSwUBs5z7LipLarF4A9TBRxQeJd5AFXp1f7wH32",
      exchangeName: "PumpSwap",
      exchangeAddress: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
      nativePrice: {
        value: "56.5274",
        symbol: "WSOL",
        name: "Wrapped Solana",
        decimals: 9,
      },
      usdPrice: 0.00000878,
      usdPrice24h: 0.00000924,
      usdPrice24hrUsdChange: -4.59999999999999e-7,
      usdPrice24hrPercentChange: -4.978354978354967,
      logo: "https://logo.moralis.io/solana-mainnet_AhtTjcSc5Y2mK89uAzMDj19oZpmJLWzFqxwknJo6pump_bf71476a889d3803575247950cf83e47.webp",
      name: "Trumpedo",
      symbol: "TRUMPEDO",
      isVerifiedContract: false,
    };
    return data;
  }
}

module.exports = Moralis;
