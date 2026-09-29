const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} = require("@solana/web3.js");

const crypto = require("crypto");
const {
  createLocalOkxBuyInstructions,
} = require("./okxLocalRouter");

/**
 * okxRouter
 * okxRouter.1234
 */
const SOLANA_CHAIN_ID = "501";
const CLIENT_CONFIG = {
  apiKey: process.env.OKX_API_KEY || "",
  secretKey: process.env.OKX_API_SECRET_KEY || process.env.OKX_SECRET_KEY || "",
  apiPassphrase:
    process.env.OKX_API_PASSPHRASE || process.env.OKX_PASSPHRASE || "",
  projectId: process.env.OKX_PROJECT_ID || process.env.OKX_PROJECT || "",
};

const OKX_BASE_URL = (process.env.OKX_BASE_URL || "https://web3.okx.com").replace(
  /\/$/,
  "",
);

async function createTransaction(instructionsData) {
  if (!Array.isArray(instructionsData)) {
    throw new Error("OKX returned invalid instructionLists");
  }

  const transactions = [];

  for (const instr of instructionsData) {
    if (
      !instr ||
      !instr.programId ||
      !Array.isArray(instr.accounts) ||
      typeof instr.data !== "string"
    ) {
      throw new Error("OKX returned an invalid instruction");
    }

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
  async getLocalBuyInstructions(ctx, params) {
    return createLocalOkxBuyInstructions(params);
  }

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

      const responseData = res?.data;
      const payload = Array.isArray(responseData?.data)
        ? responseData.data[0]
        : responseData?.data || responseData;
      const instructions = payload?.instructionLists;
      if (!Array.isArray(instructions) || instructions.length === 0) {
        throw new Error(
          `Can not get OKX instruction: ${responseData?.msg || responseData?.code || "instructionLists is empty"}`,
        );
      }
      return await createTransaction(instructions);
    } catch (error) {
      throw new Error(`OKX buy instructions failed: ${error.message}`, {
        cause: error,
      });
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

      const responseData = res?.data;
      const payload = Array.isArray(responseData?.data)
        ? responseData.data[0]
        : responseData?.data || responseData;
      const instructions = payload?.instructionLists;
      if (!Array.isArray(instructions) || instructions.length === 0) {
        throw new Error(
          `Can not get OKX instruction: ${responseData?.msg || responseData?.code || "instructionLists is empty"}`,
        );
      }
      return await createTransaction(instructions);
    } catch (error) {
      throw new Error(`OKX sell instructions failed: ${error.message}`, {
        cause: error,
      });
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
    const missingConfig = [
      ["OKX_API_KEY", CLIENT_CONFIG.apiKey],
      ["OKX_API_SECRET_KEY", CLIENT_CONFIG.secretKey],
      ["OKX_API_PASSPHRASE", CLIENT_CONFIG.apiPassphrase],
      ["OKX_PROJECT_ID", CLIENT_CONFIG.projectId],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingConfig.length > 0) {
      throw new Error(
        `OKX credentials are not configured: ${missingConfig.join(", ")}`,
      );
    }

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
