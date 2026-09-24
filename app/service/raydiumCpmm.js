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
const chalk = require("chalk");
const { NATIVE_MINT } = require("@solana/spl-token");
const { connection, BLOCK_RAZOR_1 } = require("../constants/");
const { getSwapInstructions, getPoolDetail } = require("../utils/raydium");
const { getSPLBalanceAmount, sendV0Transaction } = require("../utils/solana");
const { createTroProxyInstruction } = require("../libs/trogan");
const OKXSwapSDK = require("../libs/okxRouterV2");
const JupSDK = require("../libs/jup");
const DFlowSDK = require("../libs/dflow");
const RaydiumRouterSDK = require("../libs/raydiumRouter");
const { sendAstralaneTransaction } = require("../utils/astralane");
const { sleep, splitIntoBundles } = require("../utils/utils");

const okxSwap = new OKXSwapSDK();
const jupSwap = new JupSDK();
const dflowSwap = new DFlowSDK();
const rayRouterSwap = new RaydiumRouterSDK();

const GMGN_FEES_VAULT = new PublicKey(
  "BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT"
);
const GMGN_FEE = 0.0004;

const SLIPPAGE_BASIS_POINTS = 0.6;
class RaydiumCpmm extends Service {
  async batchBuyToken(token, wallets, type = "") {
    const { ctx } = this;
    console.log(chalk.green("\nRaydiumCpmm batchBuyToken----", wallets.length));
    if (token && wallets) {
      const tokenMint = new PublicKey(token);

      const func = async (wallets) => {
        const { blockhash } = await connection.getLatestBlockhash();
        const buyTxns = [];
        const jipAcc = ctx.service.jito.getTipAcc();

        const needsPoolDetail = wallets.some(
          (wallet) =>
            !wallet.isOkx &&
            !wallet.isDflow &&
            !wallet.isJup &&
            !wallet.isRayRouter,
        );
        const poolDetail = needsPoolDetail
          ? await getPoolDetail(tokenMint)
          : undefined;
        const dflowBuyData = await Promise.all(
          wallets.map((wallet, i) => {
            if (!wallet.isDflow) {
              return null;
            }
            const slippage = i === 0 ? 0.001 : SLIPPAGE_BASIS_POINTS;
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
          const slippage = i === 0 ? 0.001 : SLIPPAGE_BASIS_POINTS;
          const wallet = wallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const { buyAmount, limit, price, fee } = wallet;
          const computeBudgetConfig = {
            units: limit,
            microLamports: price,
          };
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
          } else if (wallet.isRayRouter) {
            const routerIxs = await rayRouterSwap.getBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount: buyAmount,
              slippage: slippage,
              computeBudgetConfig,
            });
            volumeIxs = [...routerIxs];
          } else {
            const buyIxs = await getSwapInstructions({
              tokenMint,
              type: "buy",
              amount: buyAmount * LAMPORTS_PER_SOL,
              slippage: slippage,
              computeBudgetConfig,
              user: user,
              poolDetail,
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
            const troganTipIx = createTroProxyInstruction(user, jipAcc);
            if (troganTipIx) {
              volumeIxs.push(troganTipIx);
            }
          }
          if (wallets.length > 1) {
            const jitoTipIx = SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: jipAcc,
              lamports: fee * LAMPORTS_PER_SOL,
            });
            volumeIxs.push(jitoTipIx);
          } else {
            await sendV0Transaction(keypair, volumeIxs, lookupTableAccounts);
            return true;
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
        if (buyTxns.length > 1) {
          const bundleResult = await ctx.service.jito.sendBundle(buyTxns);
          console.log(bundleResult);
          console.log(chalk.green("Buy transactions completed."));
        } else if (buyTxns.length === 1) {
          // const bundleResult = await ctx.service.jito.sendTransaction(
          //   buyTxns[0]
          // );
          // console.log(bundleResult);
          // console.log(chalk.green("Buy transactions completed."));
        }
        return true;
      };

      if (type === "all") {
        let buyAllObj = {
          firstBuy: [],
          multiBuy: [],
          secondBuy: [],
          thirdBuy: [],
        };
        wallets.forEach((wallet) => {
          if (wallet.firstBuy) {
            buyAllObj.firstBuy.push(wallet);
          } else if (wallet.multiBuy) {
            buyAllObj.multiBuy.push(wallet);
          } else if (wallet.secondBuy) {
            buyAllObj.secondBuy.push(wallet);
          } else if (wallet.thirdBuy) {
            buyAllObj.thirdBuy.push(wallet);
          }
        });
        console.log(buyAllObj);

        for (const wallets of Object.values(buyAllObj)) {
          if (wallets.length > 0) {
            await func(wallets);
            await sleep(0.5);
          }
        }
        return true;
      } else {
        return func(wallets);
      }
    } else {
      throw new Error("batchBuyToken: param error");
    }
  }

  async batchSellToken(token, wallets, type = "", percent = 100) {
    const { ctx } = this;
    console.log(chalk.green("\n Raydium cpmm batch sell Token----"));

    if (token && wallets) {
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
      const newWallets = [];
      const slippage = wallets.length === 1 ? 0.01 : SLIPPAGE_BASIS_POINTS;
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

        const shouldSell =
          (sellAll ? balanceRaw > 0n : balanceRaw >= 100n) &&
          tokenAmountRaw > 0n;
        if (shouldSell) {
          console.log(
            `${user.toBase58()} sell ${tokenAmount} (${sellPercent}%) ${token}`,
          );
          newWallets.push({ ...wallet, tokenAmount });
        } else {
          console.log(`${user.toBase58()} skip sell: token balance is 0`);
        }
      }
      newWallets.reverse();

      const func = async (wallets) => {
        const sellTxns = [];
        const { blockhash } = await connection.getLatestBlockhash();
        const jipAcc = ctx.service.jito.getTipAcc();
        const routedSellData = await Promise.all(
          wallets.map((wallet) => {
            const params = {
              user: wallet.keypair.publicKey,
              tokenMint,
              tokenAmount: wallet.tokenAmount,
              slippage,
              connection,
              price: wallet.price,
              useSharedAccounts: true,
            };
            if (wallet.isDflow) {
              return dflowSwap.getSellInstructions(ctx, params);
            }
            if (wallet.isJup) {
              return jupSwap.getSellInstructions(ctx, params);
            }
            return null;
          }),
        );
        for (let i = 0; i < wallets.length; i++) {
          const wallet = wallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const tokenAmount = wallet.tokenAmount;

          const { limit, price, fee } = wallet;

          let volumeIxs = [];
          let lookupTableAccounts;
          const computeBudgetConfig = {
            units: limit,
            microLamports: price,
          };
          if (wallet.isOkx && i === 0) {
            const okxIxs = await okxSwap.getSellInstructions(ctx, {
              user,
              tokenMint,
              tokenAmount: tokenAmount,
              slippage: slippage,
            });
            volumeIxs = [...okxIxs];
          } else if (wallet.isDflow) {
            const dflowSwapData = routedSellData[i];
            volumeIxs = [...dflowSwapData.instructions];
            lookupTableAccounts = dflowSwapData.lookupTableAccounts;
          } else if (wallet.isJup) {
            const jupSwapData = routedSellData[i];
            volumeIxs = [...jupSwapData.instructions];
            lookupTableAccounts = jupSwapData.lookupTableAccounts;
          } else {
            const sellIxs = await getSwapInstructions({
              tokenMint,
              type: "sell",
              amount: tokenAmount,
              slippage: slippage,
              computeBudgetConfig,
              user: user,
            });
            volumeIxs = [...sellIxs];
          }

          if (wallet.isTrogan || wallet.isTragon) {
            const troganTipIx = createTroProxyInstruction(user, jipAcc);
            if (troganTipIx) {
              volumeIxs.push(troganTipIx);
            }
          }

          if (wallets.length > 1) {
            const jitoTipIx = SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: jipAcc,
              lamports: fee * LAMPORTS_PER_SOL,
            });
            volumeIxs.push(jitoTipIx);
          } else {
            await sendV0Transaction(keypair, volumeIxs, lookupTableAccounts);
            return true;
          }
          try {
            const messageV0 = new TransactionMessage({
              payerKey: keypair.publicKey,
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
        } else if (sellTxns.length === 1) {
          // const bundleResult = await ctx.service.jito.sendTransaction(
          //   sellTxns[0]
          // );
          // console.log(bundleResult);
          // console.log(chalk.green("Buy transactions completed."));
        }
        return true;
      };

      const bundles = splitIntoBundles(newWallets);
      for (let i = 0; i < bundles.length; i++) {
        await func(bundles[i]);
        if (i < bundles.length - 1) {
          await sleep(0.5);
        }
      }
      return true;
    } else {
      throw new Error("batch sell Token: param error");
    }
  }
}
module.exports = RaydiumCpmm;
