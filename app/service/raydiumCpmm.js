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
const { MARKET_STATE_LAYOUT_V3 } = require("@raydium-io/raydium-sdk-v2");
const { connection, BLOCK_RAZOR_1 } = require("../constants/");
const { getSwapInstructions } = require("../utils/raydium");
const { getSPLBalanceAmount, sendV0Transaction } = require("../utils/solana");
const { createTroProxyInstruction } = require("../libs/trogan");
const OKXSwapSDK = require("../libs/okxRouterV2");
const JupSDK = require("../libs/jup");
const RaydiumRouterSDK = require("../libs/raydiumRouter");
const { sendAstralaneTransaction } = require("../utils/astralane");
const { sleep } = require("../utils/utils");

const okxSwap = new OKXSwapSDK();
const jupSwap = new JupSDK();
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
        let existJitoIx = false;
        const jipAcc = ctx.service.jito.getTipAcc();

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
          console.log(`${user.toBase58()} buy ${buyAmount} ${token}`);

          if (wallet.isOkx) {
            const okxIxs = await okxSwap.getBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount: buyAmount,
              slippage: slippage,
            });
            volumeIxs = [...okxIxs];
          } else if (wallet.isJup) {
            const jupIxs = await jupSwap.getBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount: buyAmount,
              slippage: slippage,
            });
            volumeIxs = [...jupIxs];
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
            if (wallet.isTrogan) {
              const troganTipIx = createTroProxyInstruction(user, jipAcc);
              volumeIxs.push(troganTipIx);
            }
          }
          if (wallets.length === 1) {
            await sendV0Transaction(keypair, volumeIxs);
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
            console.error("messageV0", error.message);
            break;
          }
        }
        if (buyTxns.length > 1) {
          const bundleResult = await ctx.service.jito.sendBundle(buyTxns);
          console.log(bundleResult);
          console.log(chalk.green("Buy transactions completed."));
          return true;
        }
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
          } else if (wallet.secondBuy) {
            buyAllObj.secondBuy.push(wallet);
          } else if (wallet.multiBuy) {
            buyAllObj.multiBuy.push(wallet);
          } else if (wallet.firstBuy) {
            buyAllObj.thirdBuy.push(wallet);
          }
        });

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

  async batchSellToken(token, wallets) {
    const { ctx } = this;
    console.log(chalk.green("\n Raydium cpmm batch sell Token----"));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const { blockhash } = await connection.getLatestBlockhash();
      const sellTxns = [];
      const newWallets = [];
      const slippage = wallets.length === 1 ? 0.01 : SLIPPAGE_BASIS_POINTS;
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const tokenAmount = await getSPLBalanceAmount(
          connection,
          tokenMint,
          keypair.publicKey
        );

        console.log(`${user.toBase58()} sell ${tokenAmount} ${token}`);
        if (tokenAmount >= 100) {
          newWallets.push({ ...wallet, tokenAmount });
        }
      }
      newWallets.reverse();
      const len = newWallets.length > 5 ? 5 : newWallets.length;
      for (let i = 0; i < len; i++) {
        const wallet = newWallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const tokenAmount = wallet.tokenAmount;

        const { limit, price, fee } = wallet;

        let volumeIxs = [];
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
        } else if (wallet.isJup && i === 0) {
          const jupIxs = await jupSwap.getSellInstructions(ctx, {
            user,
            tokenMint,
            tokenAmount: tokenAmount,
            slippage: slippage,
          });
          volumeIxs = [...jupIxs];
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
        if (len === 1) {
          await sendV0Transaction(keypair, volumeIxs);
          // await sendAstralaneTransaction(keypair, volumeIxs, blockhash);
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

  async checkSellOrder(pool) {
    const poolId = new PublicKey(pool);
    const poolAccountInfo = await connection.getAccountInfo(poolId);
    if (!poolAccountInfo) {
      throw new Error("cannot get pool");
    }

    const poolState = MARKET_STATE_LAYOUT_V3.decode(poolAccountInfo.data);
    console.log(poolState);

    const marketId = poolState.marketId;
    const marketAsks = poolState.marketAsks;
  }
}
module.exports = RaydiumCpmm;
