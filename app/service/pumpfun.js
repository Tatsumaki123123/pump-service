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

const TIP_ACCOUNT = new PublicKey(
  "6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK"
);
const SLIPPAGE_BASIS_POINTS = 5000n;

class PumpFun extends Service {
  constructor(ctx) {
    super(ctx);
    this.buyTimer = null;
    this.canBuy = true;
  }
  async buyToken(token, amount = 0.01) {
    try {
      if (!this.canBuy) return false;
      this.canBuy = false;
      console.log(chalk.green("Buy token", token));
      const buyTx = await pfSwap.buy(
        testWallet.publicKey,
        new PublicKey(token),
        BigInt(amount * LAMPORTS_PER_SOL),
        SLIPPAGE_BASIS_POINTS,
        {
          unitLimit: 250000,
          unitPrice: 250000,
        },
        "processed"
      );
      // const tipIx = SystemProgram.transfer({
      //   fromPubkey: testWallet.publicKey,
      //   toPubkey: TIP_ACCOUNT,
      //   lamports: 0.0001 * LAMPORTS_PER_SOL,
      // });
      // const volumeIxs = [tipIx, ...buyTx.instructions];
      const volumeIxs = [...buyTx.instructions];
      const res = await sendV0Transaction(connection, testWallet, volumeIxs);
      setTimeout(() => {
        this.canBuy = true;
      }, 10 * 1000);
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
          BigInt(Math.trunc(currentSPLBalance * Math.pow(10, 6))),
          SLIPPAGE_BASIS_POINTS,
          {
            unitLimit: 250000,
            unitPrice: 250000,
          },
          "processed"
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
