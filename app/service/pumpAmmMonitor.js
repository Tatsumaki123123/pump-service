const { Service } = require("egg");
const {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  TransactionInstruction,
  Transaction,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");

const bs58 = require("bs58");
const borsh = require("@coral-xyz/borsh");
const chalk = require("chalk");

const { PumpAmmSdk } = require("../libs/pumpfun");

const {
  connection,
  PUMP_AMM_PROGRAM_ID,
  WSOL_TOKEN_ACCOUNT,
  testWallet,
} = require("../constants/index");

const { getSPLBalance } = require("../utils/solana");

const {
  getPoolsWithQuoteMint,
  getPoolsWithPrices,
  getPriceAndLiquidity,
  getPoolsWithBaseMint,
} = require("../libs/pool");
const PumpSwapSDK = require("../libs/pumpSwap");

const pSwap = new PumpSwapSDK();
const pumpAmmSdk = new PumpAmmSdk(connection);

const addresses = ["8J5GUAf7hr3LTPHJSkwrKFDNJPtAXtLHhnNHq6XxTLrW"];

const BUY_IX_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_IX_DISCRIMINATOR = Buffer.from([
  51, 230, 133, 164, 1, 127, 131, 173,
]);

const PUMP_AMM_EVENT_AUTHORITY = new PublicKey(
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR"
);

const COMMITMENT = CommitmentLevel.PROCESSED;
const FILTER_CONFIG = {
  programIds: [PUMP_AMM_PROGRAM_ID.toBase58()],
  requiredAccounts: [
    PUMP_AMM_PROGRAM_ID.toBase58(),
    PUMP_AMM_EVENT_AUTHORITY.toBase58(),
  ],
  instructionDiscriminators: [BUY_IX_DISCRIMINATOR, SELL_IX_DISCRIMINATOR],
};

class PumpAmmMonitor extends Service {
  constructor(ctx) {
    super(ctx);
    this.subscriptionId = null;
    // this.user = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    this.user = null;
  }

  async buyToken({
    poolAddress,
    quoteAmountIn,
    baseAmountOut,
    monitorAddress,
  }) {
    const { ctx } = this;
    const wallet = this.user;
    try {
      const poolMint = new PublicKey(poolAddress);
      const poolData = await pumpAmmSdk.fetchPool(poolMint);
      const pool_detail = {
        address: new PublicKey(poolAddress),
        is_native_base: false,
        poolData: poolData,
      };
      const poolDetail = await getPriceAndLiquidity(pool_detail);

      const tokenMint = poolData.baseMint;
      // const buyAmount = Math.floor(quoteAmountIn / 10) / LAMPORTS_PER_SOL;
      const buyAmount = 0.1;
      const slippage = 0.2;

      console.log(chalk.green("Buy", buyAmount, tokenMint.toBase58()));
      const dbData = await ctx.model.MonitorToken.findOne({
        token: tokenMint.toBase58(),
        monitorAddress: monitorAddress,
      });
      if (!dbData) {
        await ctx.model.MonitorToken.create({
          token: tokenMint.toBase58(),
          monitorAddress: monitorAddress,
          buyAmount: buyAmount,
          createTime: new Date(),
        });
      }

      const { blockhash } = await connection.getLatestBlockhash();
      const volumeIxs = [];
      //  1: limit
      const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 150000,
      });
      volumeIxs.push(setComputeUnitLimitIx);

      //  2: price
      const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 970148,
      });
      volumeIxs.push(setComputeUnitPriceIx);

      const userBaseTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        wallet.publicKey
      );
      const accountInfo = await connection.getAccountInfo(userBaseTokenAccount);
      if (!accountInfo) {
        const createTokenAccountTx = createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          userBaseTokenAccount,
          wallet.publicKey,
          tokenMint
        );
        volumeIxs.push(createTokenAccountTx);
      }

      // 3 swap
      const swapIx = await pSwap.createBuyInstruction({
        tokenMint,
        user: wallet.publicKey,
        buyAmount,
        slippage,
        poolDetail,
      });
      volumeIxs.push(swapIx);
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: volumeIxs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign([wallet]);

      const signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(signature, "processed");
      console.log(
        chalk.green(`Success: Buy ${tokenMint.toBase58()} ${buyAmount}sol`)
      );
    } catch (error) {
      console.error(error);
    }
  }
  async sellToken({ poolAddress, monitorAddress }) {
    const { ctx } = this;
    const wallet = this.user;
    try {
      const poolMint = new PublicKey(poolAddress);
      const poolData = await pumpAmmSdk.fetchPool(poolMint);
      const pool_detail = {
        address: new PublicKey(poolAddress),
        is_native_base: false,
        poolData: poolData,
      };
      const poolDetail = await getPriceAndLiquidity(pool_detail);

      const tokenMint = poolData.baseMint;
      const dbData = await ctx.model.MonitorToken.findOne({
        token: tokenMint.toBase58(),
        monitorAddress: monitorAddress,
      });
      if (!dbData) {
        throw new Error("Your do not buy this token:", tokenMint.toBase58());
      }
      console.log(chalk.yellow("Sell", tokenMint.toBase58()));

      const { blockhash } = await connection.getLatestBlockhash();

      const volumeIxs = [];
      //  1: limit
      const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 150000,
      });
      volumeIxs.push(setComputeUnitLimitIx);

      //  2: price
      const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 970148,
      });
      volumeIxs.push(setComputeUnitPriceIx);

      const tokenAmount = await getSPLBalance(
        connection,
        tokenMint,
        wallet.publicKey
      );
      if (tokenAmount === 0) {
        throw new Error("No amount");
      }

      const sellNewAccount = await getAssociatedTokenAddress(
        WSOL_TOKEN_ACCOUNT,
        wallet.publicKey
      );
      const swapTx = await pSwap.createSellInstruction({
        tokenMint,
        user: wallet.publicKey,
        tokenAmount,
        sellNewAccount,
        poolDetail,
      });

      volumeIxs.push(swapTx);

      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: volumeIxs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign([wallet]);

      const signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(signature, "processed");
      console.log(chalk.green(`Sell:  ${tokenMint.toBase58()}`));
    } catch (error) {
      console.error(error);
    }
  }

  async start() {
    await this.startGrpcMonitor();
  }

  async startGrpcMonitor() {
    const { ctx } = this;
    console.log(chalk.green("\n startGrpcMonitor"));
    const yellowClient = new Client(GRPC_ENDPOINT, GRPC_TOKEN);
    const stream = await yellowClient.subscribe();

    const request = createSubscribeRequest();
    const handleStreamEvents = (stream) => {
      return new Promise((resolve, reject) => {
        stream.on("data", (data) => this.handleData(data));
        stream.on("error", (error) => {
          console.error("Stream error:", error);
          reject(error);
          stream.end();
        });
        stream.on("end", () => {
          console.log("Stream ended");
          resolve();
        });
        stream.on("close", () => {
          console.log("Stream closed");
          resolve();
        });
      });
    };
    try {
      await sendSubscribeRequest(stream, request);
      console.log(
        "Geyser connection established - watching new Pump.fun mints. \n"
      );
      await handleStreamEvents(stream);
    } catch (error) {
      console.error("Error in subscription process:", error);
      stream.end();
    }
  }

  async handleData(data) {
    const transaction = data.transaction?.transaction;
    const message = transaction?.transaction?.message;
    const logs = transaction?.meta?.logMessages;

    if (!transaction || !message || !logs) {
      return;
    }

    this.parseLogMessage(logs);
  }

  async parseLogMessage(logs) {
    const parseData = async (base64Data) => {
      const buffer = Buffer.from(base64Data, "base64");
      const discriminator = buffer.slice(0, 8);

      const buyDiscriminator = Buffer.from([
        103, 244, 82, 31, 44, 245, 119, 119,
      ]);
      const sellDiscriminator = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
      let type = "";
      if (discriminator.equals(buyDiscriminator)) {
        type = "buy";
      } else if (discriminator.equals(sellDiscriminator)) {
        type = "sell";
      }
      const u64Schema = borsh.u64();
      const timestamp = u64Schema.decode(buffer.slice(8, 8 + 8)).toString();
      const baseAmountOut = u64Schema
        .decode(buffer.slice(16, 16 + 8))
        .toString();
      const quoteAmountIn = u64Schema
        .decode(buffer.slice(64, 64 + 8))
        .toString();
      const offset1 = 120;
      const pool = buffer.slice(offset1, offset1 + 32);
      const offset2 = 152;
      const user = buffer.slice(offset2, offset2 + 32);
      const createdTime = parseInt(timestamp) * 1000;
      const userAddress = bs58.encode(user);
      const poolAddress = bs58.encode(pool);

      console.log({
        poolAddress,
        quoteAmountIn,
        baseAmountOut,
        monitorAddress: userAddress,
      });
      return;
    };
    // parseData(
    //   "G3KpTd7rY3YdAAAATWFrZSBJc3JhaGVsbCBQYWxlc3RpbmUgQWdhaW4EAAAATUlQQWIAAABodHRwczovL3Vwd2FyZC1zcG9ydC1oZWFkZWQucXVpY2tub2RlLWlwZnMuY29tL2lwZnMvUW1WVDhiN0VkTktkWW9TOFIzUTVvN3lXeENVREJFc3Z1eWhKV0VXS1g3Sk1iVDsSWfuy6D0vmc107wrVa62iw0EYUD3f2HdwK5djhrWFtxG+c0PvMbENL79QVLOCFOxi58rZSsFLo6R3mDe39wvnMgqRlXlq36cbIVY/pESBX45XEkTxxLpbIXxMRVTeOucyCpGVeWrfpxshVj+kRIFfjlcSRPHEulshfExFVN46gwhZaAAAAAAAENhH488DAACsI/wGAAAAAHjF+1HRAgAAgMakfo0DAA=="
    // );
    const buyLog = logs.find(
      (item) =>
        item === "Program log: Instruction: Buy" ||
        item === "Program log: Instruction: Sell"
    );
    if (buyLog) {
      const logPrefix = "Program data: ";
      const dataLog = logs.find((item) => item.indexOf(logPrefix) > -1);
      if (dataLog) {
        const base64Data = dataLog.slice(logPrefix.length).trim();
        parseData(base64Data);
      }
    }
  }
}

function createSubscribeRequest() {
  return {
    accounts: {},
    slots: {},
    transactions: {
      pumpFun: {
        accountInclude: [],
        accountExclude: [],
        accountRequired: FILTER_CONFIG.requiredAccounts,
        instructionDiscriminators: FILTER_CONFIG.instructionDiscriminators,
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    commitment: COMMITMENT,
    accountsDataSlice: [],
    ping: undefined,
  };
}

function sendSubscribeRequest(stream, request) {
  return new Promise((resolve, reject) => {
    stream.write(request, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

module.exports = PumpAmmMonitor;
