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
const { AnchorProvider, Wallet } = require("@coral-xyz/anchor");

const { testWallet, connection } = require("../constants");

const { PumpFunSDK, GlobalAccount } = require("../libs/pumpfun");

const { sendV0Transaction, getSPLBalance } = require("../utils/solana");
const chalk = require("chalk");

const provider_wallet = new Wallet(new Keypair());
const provider = new AnchorProvider(connection, provider_wallet, {
  commitment: "finalized",
});

const pfSwap = new PumpFunSDK(provider);

const SLIPPAGE_BASIS_POINTS = 500n;

class PumpFun extends Service {
  async buyToken(token, amount = 0.01) {
    try {
      console.log(chalk.green("Buy token", token));
      const buyTx = await pfSwap.buy(
        testWallet.publicKey,
        new PublicKey(token),
        BigInt(amount * LAMPORTS_PER_SOL),
        SLIPPAGE_BASIS_POINTS,
        {
          unitLimit: 250000,
          unitPrice: 250000,
        }
      );

      const res = await sendV0Transaction(
        connection,
        testWallet,
        buyTx.instructions
      );

      return true;
    } catch (error) {
      console.error(error);
    }
  }
  async sellToken(token, amount) {
    try {
      const { ctx } = this;
      console.log(chalk.green("Sell token", token));
      const tokenMint = new PublicKey(token);
      const currentSPLBalance = await getSPLBalance(
        connection,
        tokenMint,
        testWallet.publicKey
      );
      if (currentSPLBalance) {
        let sellTx = await pfSwap.sell(
          testWallet.publicKey,
          tokenMint,
          BigInt(currentSPLBalance * Math.pow(10, 6)),
          SLIPPAGE_BASIS_POINTS,
          {
            unitLimit: 250000,
            unitPrice: 250000,
          }
        );
        const res = await sendV0Transaction(
          connection,
          testWallet,
          sellTx.instructions
        );
        return true;
      } else {
        console.error("No token amount");
      }
    } catch (error) {
      console.error(error);
    }
  }
}
module.exports = PumpFun;
