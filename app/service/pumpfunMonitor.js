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

const bs58 = require("bs58");
const borsh = require("@coral-xyz/borsh");
const chalk = require("chalk");

const { connection, WSOL_TOKEN_ACCOUNT } = require("../constants/index");

const PUMP_FUN_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

class TokenEvent {
  constructor(fields) {
    this.name = fields.name;
    this.symbol = fields.symbol;
    this.uri = fields.uri;
    this.mint = fields.mint;
    this.bondingCurve = fields.bondingCurve;
    this.user = fields.user;
    this.creator = fields.creator;
    this.timestamp = fields.timestamp;
    this.virtualTokenReserves = fields.virtualTokenReserves;
    this.virtualSolReserves = fields.virtualSolReserves;
    this.realTokenReserves = fields.realTokenReserves;
    this.tokenTotalSupply = fields.tokenTotalSupply;
  }
}

class PumpFunMonitor extends Service {
  async startNewMonitor() {
    // await this.wrapSolToWSol(2);
    // await this.wsolToSol();
    const { ctx } = this;
    try {
      const parseData = async (base64Data, signature) => {
        const buffer = Buffer.from(base64Data, "base64");
        const discriminator = buffer.slice(0, 8);
        const createDiscriminator = Buffer.from([
          27, 114, 169, 77, 222, 235, 99, 118,
        ]);
        if (discriminator.equals(createDiscriminator)) {
          console.log("create");
          const tokenEventSchema = borsh.struct([
            borsh.str("name"), // 变长字符串
            borsh.str("symbol"),
            borsh.str("uri"),
            borsh.publicKey("mint"), // 32 字节公钥
            borsh.publicKey("bondingCurve"),
            borsh.publicKey("user"),
            borsh.publicKey("creator"),
            borsh.u64("timestamp"), // 64 位无符号整数
            borsh.u64("virtualTokenReserves"),
            borsh.u64("virtualSolReserves"),
            borsh.u64("realTokenReserves"),
            borsh.u64("tokenTotalSupply"),
          ]);

          const event = tokenEventSchema.decode(buffer.slice(8));

          console.log(event.symbol, new Date(event.timestamp));
        }

        return;
      };
      parseData(
        "G3KpTd7rY3YdAAAATWFrZSBJc3JhaGVsbCBQYWxlc3RpbmUgQWdhaW4EAAAATUlQQWIAAABodHRwczovL3Vwd2FyZC1zcG9ydC1oZWFkZWQucXVpY2tub2RlLWlwZnMuY29tL2lwZnMvUW1WVDhiN0VkTktkWW9TOFIzUTVvN3lXeENVREJFc3Z1eWhKV0VXS1g3Sk1iVDsSWfuy6D0vmc107wrVa62iw0EYUD3f2HdwK5djhrWFtxG+c0PvMbENL79QVLOCFOxi58rZSsFLo6R3mDe39wvnMgqRlXlq36cbIVY/pESBX45XEkTxxLpbIXxMRVTeOucyCpGVeWrfpxshVj+kRIFfjlcSRPHEulshfExFVN46gwhZaAAAAAAAENhH488DAACsI/wGAAAAAHjF+1HRAgAAgMakfo0DAA=="
      );

      console.log(chalk.green("Pump amm monitor start------"));
      return;
      this.subscriptionId = connection.onLogs(
        PUMP_FUN_ID,
        async (log) => {
          try {
            const { logs } = log;
            const buyLog = logs.find(
              (item) => item === "Program log: Instruction: Create"
            );
            if (buyLog) {
              const logPrefix = "Program data: ";
              const dataLog = logs.find((item) => item.indexOf(logPrefix) > -1);
              if (dataLog) {
                const base64Data = dataLog.slice(logPrefix.length).trim();
                this.parseData(base64Data, log.signature);
              }
            }
          } catch (error) {
            console.error("error", error);
          }
        },
        "processed"
      );

      console.log("pump monitor started");
    } catch (error) {}
  }

  async stopMonitorAMM() {
    if (this.subscriptionId !== null) {
      await connection.removeProgramAccountChangeListener(this.subscriptionId);
      this.subscriptionId = null;
      console.log("Believe monitor stopped");
    }
  }
}

module.exports = PumpFunMonitor;
