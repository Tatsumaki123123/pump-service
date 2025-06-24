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
} = require("@solana/spl-token");

const bs58 = require("bs58");
const chalk = require("chalk");

const { PumpFunSDK, GlobalAccount } = require("pumpdotfun-sdk");

const PUMP_FUN_FEE = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
);

const pfSwap = new PumpFunSDK();

class PumpDotFun {
  async getBuyInstructions(params) {
    const {
      tokenMint: tokenMint,
      user: user,
      buyAmount: buyAmount,
      slippage: SLIPPAGE_BASIS_POINTS,
    } = params;

    const instructions = pfSwap.getBuyInstructionsBySolAmount(
      user,
      tokenMint,
      buyAmount,
      slippage
    );

    return instructions;
  }

  async getPoolData(tokenMint) {
    const account = await pfSwap.getBondingCurveAccount(tokenMint);
    console.log(account);
    return account;
  }
}

module.exports = PumpDotFun;
