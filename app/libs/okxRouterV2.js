const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} = require("@solana/web3.js");

const crypto = require("crypto");

/**
 * okxRouter
 * okxRouter.1234
 */
const SOLANA_CHAIN_ID = "501";
const CLIENT_CONFIG = {
  apiKey: "cf60893d-2b6d-4f4e-97f9-b6f18c887b42",
  secretKey: "BEB7804D176CE9630A14821C7E1833D9",
  apiPassphrase: "Youarebeautiful.1234",
  projectId: "8b31b7f024e326c88c39a2ca3ceda15e",
};

const OKX_BASE_URL = "https://web3.okx.com";

async function createTransaction(instructionsData) {
  const transactions = [];

  for (const instr of instructionsData) {
    const dataBuffer = Buffer.from(instr.data, "base64");

    const keys = instr.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    }));

    const instruction = new TransactionInstruction({
      keys,
      programId: new PublicKey(instr.programId),
      data: dataBuffer,
    });

    transactions.push(instruction);
  }

  return transactions;
}

class OKXRouterSDK {
  async getBuyInstructions(ctx, params) {
    const { user, tokenMint, buyAmount, slippage = 0.1 } = params;

    try {
      const fromTokenAddress = "11111111111111111111111111111111";

      const res = await this.getRouterInstruction(ctx, {
        fromTokenAddress: fromTokenAddress,
        toTokenAddress: tokenMint.toBase58(),
        amount: buyAmount * LAMPORTS_PER_SOL,
        slippage,
        userWalletAddress: user.toBase58(),
      });

      console.log(res);
      const data = res?.data?.data;
      if (data && data.instructionLists) {
        const instructions = data.instructionLists;
        return createTransaction(instructions);
      } else {
        throw new Error("Can not get OKX instruction");
      }
      return;
    } catch (error) {
      console.error(error);
    }
  }

  async getSellInstructions(ctx, params) {
    const { user, tokenMint, tokenAmount, slippage = 0.1 } = params;

    try {
      const fromTokenAddress = "11111111111111111111111111111111";

      const res = await this.getRouterInstruction(ctx, {
        fromTokenAddress: tokenMint.toBase58(),
        toTokenAddress: fromTokenAddress,
        amount: tokenAmount,
        slippage,
        userWalletAddress: user.toBase58(),
      });

      const data = res?.data?.data;
      if (data && data.instructionLists) {
        const instructions = data.instructionLists;
        return createTransaction(instructions);
      } else {
        throw new Error("Can not get OKX instruction");
      }
      return;
    } catch (error) {
      console.error(error);
    }
  }

  async getRouterInstruction(ctx, params) {
    const {
      amount,
      fromTokenAddress,
      toTokenAddress,
      slippage,
      userWalletAddress,
    } = params;
    const method = "GET";
    const requestPath = "/api/v5/dex/aggregator/swap-instruction";
    const queryString = `?chainIndex=${SOLANA_CHAIN_ID}&amount=${amount}&fromTokenAddress=${fromTokenAddress}&toTokenAddress=${toTokenAddress}&slippage=${slippage}&userWalletAddress=${userWalletAddress}`;

    const headers = this.getHeaders(method, requestPath, queryString);

    const uri = `${OKX_BASE_URL}${requestPath}${queryString}`;

    const res = await ctx.curl(uri, {
      method: "GET",
      dataType: "json",
      headers: headers,
    });
    return res;
  }

  getHeaders(method, requestPath, queryString = "", body = "") {
    const timestamp = new Date().toISOString();

    // 构造预哈希字符串
    const prehashString =
      timestamp + method.toUpperCase() + requestPath + (queryString || body);

    // 使用 HMAC SHA256 生成签名
    const signature = crypto
      .createHmac("sha256", CLIENT_CONFIG.secretKey)
      .update(prehashString)
      .digest("base64");

    return {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": CLIENT_CONFIG.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": CLIENT_CONFIG.apiPassphrase,
      "OK-ACCESS-PROJECT": CLIENT_CONFIG.projectId,
    };
  }

  async getBuyTokenAmount(ctx, params) {
    const { amount, fromTokenAddress, toTokenAddress } = params;
    const method = "GET";
    const requestPath = "/api/v5/dex/aggregator/quote";
    const queryString = `?chainIndex=${SOLANA_CHAIN_ID}&amount=${amount}&fromTokenAddress=${fromTokenAddress}&toTokenAddress=${toTokenAddress}`;

    const headers = this.getHeaders(method, requestPath, queryString);
    const uri = `${OKX_BASE_URL}${requestPath}${queryString}`;
    const res = await ctx.curl(uri, {
      method: "GET",
      dataType: "json",
      headers: headers,
    });
    const data = res.data?.data;
    if (data && data[0]) {
      const tokenAmount = data[0].toTokenAmount;
      return tokenAmount;
    } else {
      throw new Error("Can not get price from OKX dex");
    }
  }

  async buy(ctx, params) {}
}

module.exports = OKXRouterSDK;
