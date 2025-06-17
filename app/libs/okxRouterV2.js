const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} = require("@solana/web3.js");

const crypto = require("crypto");

const {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} = require("@solana/spl-token");

const { OKXDexClient } = require("@okx-dex/okx-dex-sdk");
const { SolanaAgentKit, KeypairWallet } = require("solana-agent-kit");

const borsh = require("@coral-xyz/borsh");

const {
  Program,
  AnchorProvider,
  Idl,
  BN,
  BorshInstructionCoder,
} = require("@coral-xyz/anchor");
const {
  getPoolsWithPrices,
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getBuyTokenAmountBuyPoolDetail,
} = require("./pool");

const {
  connection,
  RPC_URL,
  WSOL_TOKEN_ACCOUNT,
  PUMP_AMM_PROGRAM_ID,
} = require("../constants");
const {
  RENT_SYSVAR,
  GLOBAL_CONFIG,
  PUMP_AMM_FEE,
  PUMP_AMM_FEE_TOKEN_ACCOUNT,
  EVENT_AUTHORITY,
} = require("./constants");
const chalk = require("chalk");

const OKX_PROGRAM_ID = new PublicKey(
  "6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma"
);

/**
 * okxRouter
 * okxRouter.1234
 */
const SOLANA_CHAIN_ID = "501";
const CLIENT_CONFIG = {
  apiKey: "e84bcde0-0522-45a6-8c6c-081181e14f42",
  secretKey: "CF299A4E3849179B27F8FBB97F30318F",
  apiPassphrase: "okxRouter.1234",
  projectId: "d3158151954a9493528106856d205a7f",
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
}

module.exports = OKXRouterSDK;
