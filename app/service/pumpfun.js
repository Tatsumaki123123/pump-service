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

const { testWallet } = require("../constants");

const { PumpFunSDK, GlobalAccount } = require("pumpdotfun-sdk");

const pfSwap = new PumpFunSDK();

class PumpFun extends Service {
  buyToken(token, amount) {}
  sellToken(token, amount) {}
}
module.exports = PumpFun;
