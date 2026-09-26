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
const BN = require("bn.js");
const chalk = require("chalk");
const { connection, BLOCK_RAZOR_1 } = require("../constants");
const { getRaydiumLaunchSwapInstructions } = require("../utils/raydium");
const { getSPLBalanceAmount, sendV0Transaction } = require("../utils/solana");
const { createTroProxyInstruction } = require("../libs/trogan");
const OKXSwapSDK = require("../libs/okxRouterV2");
const JupSDK = require("../libs/jup");
const DFlowSDK = require("../libs/dflow");
const { sendAstralaneTransaction } = require("../utils/astralane");
const { splitIntoBundles } = require("../utils/utils");

const okxSwap = new OKXSwapSDK();
const jupSwap = new JupSDK();
const dflowSwap = new DFlowSDK();

const GMGN_FEES_VAULT = new PublicKey(
  "BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT"
);
const GMGN_FEE = 0.0004;

// DFlow/Jupiter slippage is passed as a fraction: 0.05 = 5%.
const SLIPPAGE_BASIS_POINTS = Number(
  process.env.DFLOW_BATCH_SLIPPAGE || 0.05,
);
class RaydiumLaunch extends Service {
  async batchBuyToken(token, wallets) {
    const { ctx } = this;
    console.log(
      chalk.green("\nRaydiumLaunch batchBuyToken----", wallets.length)
    );
    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const { blockhash } = await connection.getLatestBlockhash();
      const buyTxns = [];
      let existJitoIx = false;
      const jipAcc = ctx.service.jito.getTipAcc();
      const dflowBuyData = await Promise.all(
        wallets.map((wallet, i) => {
          if (!wallet.isDflow) {
            return null;
          }
          const slippage = wallet.slippage ?? SLIPPAGE_BASIS_POINTS;
          const { buyAmount, price } = wallet;
          return dflowSwap.getBuyInstructions(ctx, {
            user: wallet.keypair.publicKey,
            tokenMint,
            buyAmount,
            slippage,
            connection,
            price,
          });
        }),
      );
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const slippage = wallet.slippage ?? SLIPPAGE_BASIS_POINTS;
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const { buyAmount, limit, price, fee } = wallet;

        let volumeIxs = [];
        let lookupTableAccounts;
        console.log(`${user.toBase58()} buy ${buyAmount} ${token}`);

        if (wallet.isOkx) {
          const okxIxs = await okxSwap.getBuyInstructions(ctx, {
            user,
            tokenMint,
            buyAmount: buyAmount,
            slippage: slippage,
          });
          volumeIxs = [...okxIxs];
        } else if (wallet.isDflow) {
          const dflowSwapData = dflowBuyData[i];
          volumeIxs = [...dflowSwapData.instructions];
          lookupTableAccounts = dflowSwapData.lookupTableAccounts;
        } else if (wallet.isJup) {
          const jupSwapData = await jupSwap.getBuyInstructions(ctx, {
            user,
            tokenMint,
            buyAmount,
            slippage,
            connection,
            useSharedAccounts: true,
          });
          volumeIxs = [...jupSwapData.instructions];
          lookupTableAccounts = jupSwapData.lookupTableAccounts;
        } else {
          const computeBudgetConfig = {
            units: limit,
            microLamports: price,
          };
          const buyIxs = await getRaydiumLaunchSwapInstructions({
            tokenMint,
            type: "buy",
            amount: buyAmount * LAMPORTS_PER_SOL,
            slippage: slippage,
            computeBudgetConfig,
            user: user,
          });
          // transaction.add(...buyIxs);
          volumeIxs = [...buyIxs];

          if (wallet.isGmgn) {
            const gmgnTipTx = SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: GMGN_FEES_VAULT,
              lamports: GMGN_FEE * LAMPORTS_PER_SOL,
            });
            volumeIxs.push(gmgnTipTx);
          }
        }
        if (wallet.isTrogan || wallet.isTragon) {
          const troganTipIx = createTroProxyInstruction(
            user,
            jipAcc,
            undefined,
            { includeJitoDontFront: i === 0 },
          );
          if (troganTipIx) {
            volumeIxs.push(troganTipIx);
          }
        }
        if (wallets.length === 1) {
          await sendV0Transaction(keypair, volumeIxs, lookupTableAccounts);
          // await sendAstralaneTransaction(keypair, volumeIxs, blockhash);
          return;
        } else {
          if (existJitoIx === false && i === wallets.length - 1) {
            const jitoTipIx = SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: jipAcc,
              lamports: fee * LAMPORTS_PER_SOL,
            });
            volumeIxs.push(jitoTipIx);
          }
        }

        try {
          const messageV0 = new TransactionMessage({
            payerKey: user,
            recentBlockhash: blockhash,
            instructions: volumeIxs,
          }).compileToV0Message(lookupTableAccounts);

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
          console.error("messageV0", error.message);
          break;
        }
      }
      console.log("buyTxns", buyTxns.length);
      if (buyTxns.length > 1) {
        const bundleResult = await ctx.service.jito.sendBundle(buyTxns);
        console.log(bundleResult);
        console.log(chalk.green("Buy transactions completed."));
        return true;
      }
    } else {
      throw new Error("batchBuyToken: param error");
    }
  }

  async batchSellToken(token, wallets, type = "", percent = 100) {
    const { ctx } = this;
    console.log(chalk.green("\n Raydium cpmm batch sell Token----"));

    if (token && wallets) {
      const bundles = splitIntoBundles(wallets);
      if (bundles.length > 1) {
        for (const bundleWallets of bundles) {
          await this.batchSellToken(token, bundleWallets, type, percent);
        }
        return true;
      }

      const sellAll = String(type).toLowerCase() === "all";
      const getWalletSellPercent = (wallet) => {
        const walletPercent =
          sellAll
            ? 100
            : typeof wallet.sellRatio === "number"
            ? wallet.sellRatio * 100
            : percent;
        const normalizedPercent = Number(walletPercent);
        if (
          !Number.isFinite(normalizedPercent) ||
          normalizedPercent <= 0 ||
          normalizedPercent > 100
        ) {
          throw new Error(
            "sell percent must be greater than 0 and less than or equal to 100"
          );
        }
        return normalizedPercent;
      };

      const tokenMint = new PublicKey(token);
      const { blockhash } = await connection.getLatestBlockhash();
      const sellTxns = [];
      const newWallets = [];
      const defaultSlippage = wallets.length === 1 ? 0.01 : SLIPPAGE_BASIS_POINTS;
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const balanceRaw = BigInt(
          await getSPLBalanceAmount(connection, tokenMint, keypair.publicKey)
        );
        const sellPercent = getWalletSellPercent(wallet);
        const percentBasisPoints = BigInt(Math.round(sellPercent * 100));
        const tokenAmountRaw = (balanceRaw * percentBasisPoints) / 10000n;
        const tokenAmount = tokenAmountRaw.toString();

        console.log(
          `${user.toBase58()} sell ${tokenAmount} (${sellPercent}%) ${token}`
        );
        if ((sellAll ? balanceRaw > 0n : balanceRaw >= 100n) && tokenAmountRaw > 0n) {
          newWallets.push({ ...wallet, tokenAmount });
        }
      }
      newWallets.reverse();
      const len = newWallets.length > 5 ? 5 : newWallets.length;
      for (let i = 0; i < len; i++) {
        const wallet = newWallets[i];
        const slippage = wallet.slippage ?? defaultSlippage;
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const tokenAmount = wallet.tokenAmount;

        const { limit, price, fee } = wallet;

        let volumeIxs = [];
        let sellIxs;
        const computeBudgetConfig = {
          units: limit,
          microLamports: price,
        };
        sellIxs = await getRaydiumLaunchSwapInstructions({
          tokenMint,
          type: "sell",
          amount: tokenAmount,
          slippage: slippage,
          computeBudgetConfig,
          user: user,
        });
        volumeIxs = [...sellIxs];
        if (len === 1) {
          // await sendV0Transaction(keypair, volumeIxs);
          await sendAstralaneTransaction(keypair, volumeIxs, blockhash);
          return;
        } else {
          if (i === len - 1) {
            const jipAcc = ctx.service.jito.getTipAcc();
            const jitoTipIx = SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: jipAcc,
              lamports: fee * LAMPORTS_PER_SOL,
            });
            volumeIxs.push(jitoTipIx);
          }
        }
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
      if (sellTxns.length > 1) {
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
module.exports = RaydiumLaunch;
