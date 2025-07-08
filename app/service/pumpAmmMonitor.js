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
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  createInitializeAccountInstruction,
  createCloseAccountInstruction,
} = require("@solana/spl-token");

const {
  default: Client,
  CommitmentLevel,
} = require("@triton-one/yellowstone-grpc");

const bs58 = require("bs58");
const borsh = require("@coral-xyz/borsh");
const chalk = require("chalk");
const { BN } = require("@coral-xyz/anchor");

const { PumpAmmSdk } = require("../libs/pumpfun/sdk/pumpAmm");

const {
  connection,
  PUMP_AMM_PROGRAM_ID,
  WSOL_TOKEN_ACCOUNT,
  testWallet,
} = require("../constants/index");
const { GRPC_ENDPOINT, GRPC_TOKEN } = require("../constants");

const { sendV0Transaction, getSPLBalance } = require("../utils/solana");

const {
  getPoolsWithQuoteMint,
  getPoolsWithPrices,
  getPriceAndLiquidity,
  getPoolsWithBaseMint,
} = require("../libs/pool");
const PumpSwapSDK = require("../libs/pumpSwap");

const pSwap = new PumpSwapSDK();
const pumpAmmSdk = new PumpAmmSdk(connection);

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
    this.poolAddresses = [];
    this.getPoolsTimer = null;
  }

  async buyToken({ poolAddress, solAmount, tokenAmount }) {
    const { ctx } = this;
    console.log(chalk.green("Buy, ", poolAddress, solAmount));
    try {
      const wallet = testWallet;
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
      const buyAmount = 0.01;
      const slippage = 0.2;

      console.log(chalk.green("Buy", buyAmount, tokenMint.toBase58()));

      const { blockhash } = await connection.getLatestBlockhash("processed");

      //  1: limit
      const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 250000,
      });

      //  2: price
      const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 16000,
      });

      // 3 swap
      const swapIx = await ctx.service.pumpAMM.getBuyAmmIxs(
        tokenMint,
        wallet.publicKey,
        buyAmount,
        poolDetail,
        slippage
      );
      const volumeIxs = [
        setComputeUnitLimitIx,
        setComputeUnitPriceIx,
        ...swapIx,
      ];

      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: volumeIxs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign([wallet]);

      const signature = await connection.sendTransaction(tx);
      await connection.confirmTransaction(signature, "processed");
      console.log(chalk.green(`Success: Buy ${poolAddress} ${buyAmount}sol`));
    } catch (error) {
      console.error(error);
    }
  }
  async sellToken({ poolAddress, monitorAddress }) {
    const { ctx } = this;
    const wallet = testWallet;
    try {
      const user = wallet.publicKey;
      const poolMint = new PublicKey(poolAddress);
      const poolData = await pumpAmmSdk.fetchPool(poolMint);
      const pool_detail = {
        address: new PublicKey(poolAddress),
        is_native_base: false,
        poolData: poolData,
      };
      const poolDetail = await getPriceAndLiquidity(pool_detail);

      const tokenMint = poolData.baseMint;
      console.log(chalk.yellow("Sell", tokenMint.toBase58()));

      const tokenAmount = await getSPLBalance(connection, tokenMint, user);
      if (tokenAmount === 0) {
        throw new Error("No amount");
      }

      const { blockhash } = await connection.getLatestBlockhash();

      let volumeIxs = [];
      //  1: limit
      const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 150000,
      });

      //  2: price
      const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 970148,
      });

      // 3, createAccountWithSeed
      const seed = new Date().getTime().toString();

      const newAccount = await PublicKey.createWithSeed(
        user,
        seed,
        TOKEN_PROGRAM_ID
      );
      const createAccountWithSeedIx = SystemProgram.createAccountWithSeed({
        fromPubkey: user,
        newAccountPubkey: newAccount,
        basePubkey: user,
        seed: seed,
        lamports: 2039280,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
      });

      // 4, initializeAccount
      const initializeAccountIx = createInitializeAccountInstruction(
        newAccount,
        WSOL_TOKEN_ACCOUNT,
        user,
        TOKEN_PROGRAM_ID
      );

      const swapTx = await pSwap.createSellInstruction({
        tokenMint,
        user: wallet.publicKey,
        tokenAmount,
        sellNewAccount: newAccount,
        poolDetail,
      });

      const closeAccountIx = createCloseAccountInstruction(
        newAccount,
        user,
        user
      );
      volumeIxs = [
        setComputeUnitLimitIx,
        setComputeUnitPriceIx,
        createAccountWithSeedIx,
        initializeAccountIx,
        swapTx,
        closeAccountIx,
      ];
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

  async handleTransaction(data) {
    const { ctx } = this;
    const {
      type,
      poolAddress,
      tokenAmount,
      solAmount,
      diffTime,
      monitorAddress: userAddress,
    } = data;
    const findPool = this.poolAddresses.find(
      (address) => address.toLowerCase() === poolAddress.toLowerCase()
    );
    if (!findPool) return;
    if (type === "sell") {
      if (solAmount >= 5) {
        await this.buyToken(data);
      }
    }
    if (type === "buy") {
      if (solAmount >= 3) {
        await this.sellToken(data);
      }
    }
  }

  async startMonitor() {
    this.startGrpcMonitor();

    this.getPoolsTimer && clearInterval(this.getPoolsTimer);
    await this.getPoolAddresses();
    setInterval(async () => {
      await this.getPoolAddresses();
    }, 60 * 60 * 1000);
  }

  async startGrpcMonitor() {
    const { ctx } = this;
    console.log(chalk.green("\n Pump AMM startGrpcMonitor"));
    const yellowClient = new Client(GRPC_ENDPOINT, GRPC_TOKEN);
    const stream = await yellowClient.subscribe();

    const request = createSubscribeRequest();
    const handleStreamEvents = (stream) => {
      return new Promise((resolve, reject) => {
        stream.on("data", (data) => this.handleMonitorData(data));
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

  async handleMonitorData(data) {
    const tx = data.transaction?.transaction;
    const message = tx?.transaction?.message;
    const logs = tx?.meta?.logMessages;

    if (!tx || !message || !logs) {
      return;
    }
    this.parseLogMessage(logs);
  }

  async parseLogMessage(logs, transaction) {
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
      } else {
        return;
      }
      // console.log(chalk.yellowBright("----handleMonitorData-----"));
      const u64Schema = borsh.u64();
      const timestamp = u64Schema.decode(buffer.slice(8, 8 + 8));
      const baseAmount = u64Schema.decode(buffer.slice(16, 16 + 8)).toNumber();
      const quoteAmount = u64Schema.decode(buffer.slice(64, 64 + 8)).toNumber();
      const offset1 = 120;
      const poolAddress = bs58.encode(buffer.slice(offset1, offset1 + 32));
      const offset2 = 152;
      const userAddress = bs58.encode(buffer.slice(offset2, offset2 + 32));
      // const offset3 = 184;
      // const userBaseTokenAccount = bs58.encode(
      //   buffer.slice(offset3, offset3 + 32)
      // );
      const offset4 = 312;
      const coinCreator = bs58.encode(buffer.slice(offset4, offset4 + 32));

      const createdTime = new Date(parseInt(timestamp) * 1000);
      const updateTime = new Date();
      const diffTime = updateTime.getTime() - createdTime.getTime();

      let baseMint = "";
      // try {
      //   const tokenAccount = await getAccount(
      //     connection,
      //     new PublicKey(userBaseTokenAccount)
      //   );
      //   baseMint = tokenAccount.mint.toBase58();
      // } catch (error) {}

      let solAmount = quoteAmount;
      let tokenAmount = baseAmount;
      if (
        coinCreator === "11111111111111111111111111111111" ||
        solAmount > tokenAmount
      ) {
        return;
      }
      this.handleTransaction({
        type,
        poolAddress,
        solAmount: solAmount / LAMPORTS_PER_SOL,
        tokenAmount,
        createdTime,
        diffTime,
        coinCreator,
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

  async getPoolAddresses(isFetch = true) {
    const { ctx } = this;
    if (isFetch) {
      const list = await ctx.service.ave.getMonitorPumpList();
      for (const item of list) {
        const dbData = await ctx.model.MonitorPumpToken.findOne({
          pool: item.pool,
        });
        if (!dbData) {
          await ctx.model.MonitorPumpToken.create({
            amm: item.amm,
            token: item.token,
            symbol: item.symbol,
            dev: item.dev,
            pool: item.pool,
            createTime: item.createTime,
          });
        }
      }
    }

    const dbList = await ctx.model.MonitorPumpToken.find({
      amm: "pumpfunamm",
    }).lean();
    if (dbList && dbList.length > 0) {
      this.poolAddresses = dbList.map((item) => item.pool);
      console.log(this.poolAddresses);
    }
    return this.poolAddresses;
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
