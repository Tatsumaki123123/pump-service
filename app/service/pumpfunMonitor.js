"use strict";
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
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createInitializeAccountInstruction,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} = require("@solana/spl-token");
const {
  createSolanaRpcSubscriptions,
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
  address,
  Address,
} = require("@solana/kit");

const bs58 = require("bs58");
const borsh = require("@coral-xyz/borsh");
const chalk = require("chalk");

const {
  default: Client,
  CommitmentLevel,
} = require("@triton-one/yellowstone-grpc");

const GRPC_ENDPOINT = "https://solana-yellowstone-grpc.publicnode.com:443";

const {
  connection,
  testWallet,
  WSOL_TOKEN_ACCOUNT,
} = require("../constants/index");

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_FUN_MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";
const CREATE_EVENT_IX_DISCRIMINATOR = Buffer.from([
  27, 114, 169, 77, 222, 235, 99, 118,
]);
const CREATE_IX_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

const COMMITMENT = CommitmentLevel.PROCESSED;

const FILTER_CONFIG = {
  programIds: [PUMP_FUN_PROGRAM_ID],
  requiredAccounts: [PUMP_FUN_PROGRAM_ID, PUMP_FUN_MINT_AUTHORITY],
  instructionDiscriminators: [CREATE_IX_DISCRIMINATOR],
};

class PumpFunMonitor extends Service {
  async handleParseCreate(buffer) {
    const { ctx } = this;
    const tokenEventSchema = borsh.struct([
      borsh.str("name"),
      borsh.str("symbol"),
      borsh.str("uri"),
      borsh.publicKey("mint"),
      borsh.publicKey("bondingCurve"),
      borsh.publicKey("user"),
      borsh.publicKey("creator"),
      borsh.u64("timestamp"),
      borsh.u64("virtualTokenReserves"),
      borsh.u64("virtualSolReserves"),
      borsh.u64("realTokenReserves"),
      borsh.u64("tokenTotalSupply"),
    ]);

    const event = tokenEventSchema.decode(buffer.slice(8));
    await this.handleCreateEvent(event);
  }

  async handleCreateEvent(event) {
    console.log(chalk.green("handleCreateEvent"));
    const { ctx } = this;
    // const metadataRes = await ctx.curl(event.uri, { dataType: "json" });
    // const metadata = metadataRes.data;
    const metadata = {};
    const dbData = {
      token: event.mint.toBase58(),
      dev: "",
      pool: event.bondingCurve.toBase58(),
      name: event.name,
      symbol: event.symbol,
      uri: event.uri,
      createTime: new Date(event.timestamp * 1000),
      updateTime: new Date(),
      metadata: metadata,
    };
    console.log(dbData);
    console.log(dbData.createTime);
    console.log(dbData.updateTime);
    console.log(dbData.updateTime.getTime() - dbData.createTime.getTime());
    return;
    if (
      metadata &&
      metadata.twitter &&
      metadata.twitter.indexOf("communities") > -1
    ) {
      const res = await ctx.service.pumpfun.buyToken(dbData.token);
      if (res) {
        setTimeout(async () => {
          await ctx.service.pumpfun.sellToken(dbData.token);
        }, 1000);
      }
      await ctx.model.PumpToken.create(dbData);
    }
  }

  async handleBuyEvent(buffer) {}

  async handleSellEvent(buffer) {}

  async startMonitor() {
    await this.startGrpcMonitor();
  }

  async startLogMonitor() {
    const { ctx } = this;
    try {
      console.log(chalk.green("Pump fun monitor start------"));
      this.subscriptionId = connection.onLogs(
        new PublicKey(PUMP_FUN_PROGRAM_ID),
        async (log) => {
          try {
            const { logs } = log;
          } catch (error) {
            console.error("error", error);
          }
        },
        "processed"
      );

      console.log("pump fun monitor started");
    } catch (error) {}
  }

  async startGrpcMonitor() {
    console.log(chalk.green("\n startGrpcMonitor"));
    const yellowClient = new Client(GRPC_ENDPOINT);
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

  async parseLogMessage(logs) {
    const parseData = async (base64Data) => {
      const buffer = Buffer.from(base64Data, "base64");
      const discriminator = buffer.slice(0, 8);
      if (discriminator.equals(CREATE_EVENT_IX_DISCRIMINATOR)) {
        await this.handleParseCreate(buffer);
      }

      return;
    };
    // parseData(
    //   "G3KpTd7rY3YdAAAATWFrZSBJc3JhaGVsbCBQYWxlc3RpbmUgQWdhaW4EAAAATUlQQWIAAABodHRwczovL3Vwd2FyZC1zcG9ydC1oZWFkZWQucXVpY2tub2RlLWlwZnMuY29tL2lwZnMvUW1WVDhiN0VkTktkWW9TOFIzUTVvN3lXeENVREJFc3Z1eWhKV0VXS1g3Sk1iVDsSWfuy6D0vmc107wrVa62iw0EYUD3f2HdwK5djhrWFtxG+c0PvMbENL79QVLOCFOxi58rZSsFLo6R3mDe39wvnMgqRlXlq36cbIVY/pESBX45XEkTxxLpbIXxMRVTeOucyCpGVeWrfpxshVj+kRIFfjlcSRPHEulshfExFVN46gwhZaAAAAAAAENhH488DAACsI/wGAAAAAHjF+1HRAgAAgMakfo0DAA=="
    // );
    const buyLog = logs.find(
      (item) => item === "Program log: Instruction: Create"
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

  async handleData(data) {
    const transaction = data.transaction?.transaction;
    const message = transaction?.transaction?.message;
    const logs = transaction?.meta?.logMessages;

    if (!transaction || !message || !logs) {
      return;
    }

    this.parseLogMessage(logs);

    // const createInstruction = message.instructions.find(
    //   (ix) => ix?.data && CREATE_IX_DISCRIMINATOR.equals(ix.data.slice(0, 8))
    // );
    // if (!createInstruction) {
    //   return;
    // }
    // const accountKeys = message.accountKeys;
    // console.log(createInstruction);

    // await this.handleParseCreate(createInstruction.data);
  }

  async stopMonitor() {
    if (this.subscriptionId !== null) {
      await connection.removeProgramAccountChangeListener(this.subscriptionId);
      this.subscriptionId = null;
      console.log("pump fun monitor stopped");
    }
  }
}
// Helper functions
function createSubscribeRequest() {
  return {
    accounts: {},
    slots: {},
    transactions: {
      pumpFun: {
        accountInclude: [],
        accountExclude: [],
        accountRequired: FILTER_CONFIG.requiredAccounts,
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

module.exports = PumpFunMonitor;
