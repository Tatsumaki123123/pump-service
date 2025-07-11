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
const { AnchorProvider, Wallet } = require("@coral-xyz/anchor");
const chalk = require("chalk");
const { connection } = require("../constants/");
const { getSwapInstructions } = require("../utils/raydium");

const SLIPPAGE_BASIS_POINTS = 0.2;
class RaydiumCpmm extends Service {
  async batchBuyToken(token, wallets) {
    const { ctx } = this;
    console.log(chalk.green("\nRaydiumCpmm batchBuyToken----", wallets.length));
    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const { blockhash } = await connection.getLatestBlockhash();
      const buyTxns = [];
      let existJitoIx = false;
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const { buyAmount, limit, price, fee } = wallet;
        let volumeIxs = [];
        console.log(`${user.toBase58()} buy ${buyAmount} ${token}`);

        const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: limit,
        });

        const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: price,
        });

        const buyIxs = await getSwapInstructions({
          tokenMint,
          type: "buy",
          buyAmount,
          slippage: SLIPPAGE_BASIS_POINTS,
        });
        volumeIxs = [setComputeUnitLimitIx, setComputeUnitPriceIx, ...buyIxs];

        const jipAcc = ctx.service.jito.getTipAcc();
        if (wallet.isGmgn) {
          const gmgnTipTx = SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: GMGN_FEES_VAULT,
            lamports: GMGN_FEE * LAMPORTS_PER_SOL,
          });
          volumeIxs.push(gmgnTipTx);
        }
        if (wallet.isTrogan) {
          const troganTipIx = createTroProxyInstruction(user, jipAcc);

          volumeIxs.push(troganTipIx);
        } else {
          const jitoTipIx = SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: jipAcc,
            lamports: fee * LAMPORTS_PER_SOL,
          });
          volumeIxs.push(jitoTipIx);
          existJitoIx = true;
        }

        if (existJitoIx === false && i !== 0 && i === wallets.length - 1) {
          const jitoTipIx = SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: jipAcc,
            lamports: fee * LAMPORTS_PER_SOL,
          });
          volumeIxs.push(jitoTipIx);
        }

        try {
          const messageV0 = new TransactionMessage({
            payerKey: user,
            recentBlockhash: blockhash,
            instructions: volumeIxs,
          }).compileToV0Message();

          const tx = new VersionedTransaction(messageV0);
          tx.sign([keypair]);

          // 模拟交易
          // const simulationResult = await connection.simulateTransaction(tx, {
          //   commitment: "confirmed",
          // });
          // if (simulationResult.value.err) {
          //   console.error("simulation", simulationResult.value);
          //   throw new Error(simulationResult.value);
          // }

          // console.log(
          //   chalk.green("simulation success", keypair.publicKey.toString())
          // );
          buyTxns.push(tx);
        } catch (error) {
          console.error(error.message);
          break;
        }
      }
      console.log("buyTxns", buyTxns.length);
      if (buyTxns.length > 0) {
        if (buyTxns.length === 1) {
          const transferTx = buyTxns[0];
          const signature = await connection.sendTransaction(transferTx, {
            skipPreflight: false,
          });
          await connection.confirmTransaction(signature, "processed");
          return true;
        }
        const bundleResult = await ctx.service.jito.sendBundle(buyTxns);
        console.log(bundleResult);
        console.log(chalk.green("Buy transactions completed."));
        return true;
      }
    } else {
      throw new Error("batchBuyToken: param error");
    }
  }

  async batchSellToken(token, wallets) {
    const { ctx } = this;
    console.log(chalk.green("\n Pump fun batch sell Token----"));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const { blockhash } = await connection.getLatestBlockhash();
      const jipAcc = ctx.service.jito.getTipAcc();
      const sellTxns = [];
      const newWallets = [];
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const tokenAmount = await getSPLBalance(
          connection,
          tokenMint,
          keypair.publicKey
        );

        console.log(`${user.toBase58()} sell ${tokenAmount} ${token}`);
        if (tokenAmount >= 100) {
          newWallets.push({ ...wallet, tokenAmount });
        }
      }

      const len = newWallets.length > 5 ? 5 : newWallets.length;
      for (let i = 0; i < len; i++) {
        const wallet = newWallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const tokenAmount = wallet.tokenAmount;

        const { limit, price, fee } = wallet;

        let volumeIxs = [];
        let sellTx = await pfSwap.sell(
          user,
          tokenMint,
          BigInt(Math.trunc(tokenAmount * Math.pow(10, 6))),
          SLIPPAGE_BASIS_POINTS,
          {
            unitLimit: limit,
            unitPrice: price,
          },
          "processed"
        );
        const jitoTipIx = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: jipAcc,
          lamports: fee * LAMPORTS_PER_SOL,
        });
        volumeIxs = [...sellTx.instructions, jitoTipIx];

        try {
          const messageV0 = new TransactionMessage({
            payerKey: keypair.publicKey,
            recentBlockhash: blockhash,
            instructions: volumeIxs,
          }).compileToV0Message();

          const tx = new VersionedTransaction(messageV0);
          tx.sign([keypair]);

          // 模拟交易
          // const simulationResult = await connection.simulateTransaction(tx, {
          //   commitment: "confirmed",
          // });
          // if (simulationResult.value.err) {
          //   console.log("simulation", simulationResult.value);
          //   throw new Error(simulationResult.value);
          // }

          // console.log(
          //   chalk.green("simulation success", keypair.publicKey.toString())
          // );
          sellTxns.push(tx);
        } catch (error) {
          console.error(
            chalk.red(
              `Error compiling transaction for ${user.toBase58()}:`,
              error.message
            )
          );
          continue;
        }
      }

      console.log("sellTxns", sellTxns.length);
      if (sellTxns.length > 0) {
        if (sellTxns.length === 1) {
          const transferTx = sellTxns[0];
          const signature = await connection.sendTransaction(transferTx, {
            skipPreflight: false,
          });
          await connection.confirmTransaction(signature, "processed");
          return true;
        }
        const bundleResult = await ctx.service.jito.sendBundle(sellTxns);
        console.log(bundleResult);

        console.log(chalk.green("Sell transactions completed."));
      }
      return true;
    } else {
      throw new Error("batch sell Token: param error");
    }
  }
}
module.exports = RaydiumCpmm;
