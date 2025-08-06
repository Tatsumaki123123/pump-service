const {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} = require("@solana/spl-token");
const { AnchorProvider, Wallet } = require("@coral-xyz/anchor");

const { PumpFunSDK } = require("pumpdotfun-repumped-sdk/dist/cjs");

const { connection, PUMP_AMM_PROGRAM_ID } = require("../constants");

const {
  getPoolsWithPrices,
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getBuyTokenAmountBuyPoolDetail,
} = require("./pool");
const wallet = Keypair.generate();
const provider = new AnchorProvider(connection, new Wallet(wallet), {
  commitment: "confirmed",
});
const sdk = new PumpFunSDK(provider);

class PumpSwapSDK {
  constructor() {}

  async createBuyInstruction(params) {
    const { tokenMint, user, buyAmount, slippage = 0.1, poolDetail } = params;
    const slippageBasisPoints = BigInt(slippage * 10000);

    const buyAmountSol = BigInt(buyAmount * LAMPORTS_PER_SOL);

    const bondingAccount = await sdk.token.getBondingCurveAccount(
      tokenMint,
      "confirmed"
    );
    if (!bondingAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }

    const amount = bondingAccount.getBuyPrice(buyAmountSol);
    const buyAmountWithSlippage = calculateWithSlippageBuy(
      buyAmountSol,
      slippageBasisPoints
    );
    console.log(amount, buyAmountWithSlippage);
    const transaction = new Transaction();

    await sdk.trade.buildBuyIx(
      user,
      tokenMint,
      amount,
      buyAmountWithSlippage,
      transaction,
      "confirmed",
      false
    );
    return transaction.instructions;
  }

  async createSellInstruction(params) {
    const { tokenMint, user, tokenAmount, sellNewAccount, poolDetail } = params;
  }
}

module.exports = PumpSwapSDK;
