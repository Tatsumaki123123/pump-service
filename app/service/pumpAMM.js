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

const { getPoolsWithPrices } = require("../libs/pool");

const {
  connection,
  WSOL_TOKEN_ACCOUNT,
  BLOCK_RAZOR_1,
} = require("../constants");
const PumpSwapSDK = require("../libs/pumpSwap");
const ProxyPumpSwapSDK = require("../libs/proxyPumpSwap");
const OKXSwapSDK = require("../libs/okxRouterV2");
const JupSDK = require("../libs/jup");
const { getSPLBalance, sendV0Transaction } = require("../utils/solana");
const { createTroProxyInstruction } = require("../libs/trogan");
const moment = require("moment");
const { sleep } = require("../utils/utils");
const { getRandomAccount } = require("../utils/slot0trade");

const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);

const GMGN_FEES_VAULT = new PublicKey(
  "BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT"
);
const GMGN_FEE = 0.0004;

const TROGAN_FEE = 0.00036;

const TRANSACTION_FEE = 5000;
const JITO_TIP_AMOUNT = 0.0001 * LAMPORTS_PER_SOL;

const SLIPPAGE_BASIS_POINTS = 0.3;

const pSwap = new PumpSwapSDK();
const proxyPumpSwap = new ProxyPumpSwapSDK();
// const pSwap = new PumpAmmSdk(connection);

const okxSwap = new OKXSwapSDK();
const jupSwap = new JupSDK();

class PumpAMM extends Service {
  constructor(ctx) {
    super(ctx);
    this.subscriptionId = null;
  }

  /**
   * buy token  bundle
   * @param {*} token
   * @param {*} wallets [{keypair: keypair, amount: 0.1}]
   */
  async batchBuyToken(token, wallets, type = "") {
    const { ctx } = this;
    console.log(chalk.green("\npump amm batchBuyToken----", wallets.length));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const { blockhash } = await connection.getLatestBlockhash();

      const func = async (wallets) => {
        const poolDetail = await getPoolsWithPrices(tokenMint, ctx);
        const buyTxns = [];
        const jipAcc = ctx.service.jito.getTipAcc();
        for (let i = 0; i < wallets.length; i++) {
          const slippage = i === 0 ? 0.1 : SLIPPAGE_BASIS_POINTS;
          const wallet = wallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const { buyAmount, limit, price, fee, isAxiom } = wallet;
          let volumeIxs = [];
          console.log(`${user.toBase58()} buy ${buyAmount} ${token}`);
          if (wallet.isOkx) {
            const okxIxs = await okxSwap.getBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount: buyAmount,
              slippage,
              poolDetail,
            });
            volumeIxs = [...okxIxs];
          } else if (wallet.isJup) {
            const jupIxs = await jupSwap.getBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount: buyAmount,
              slippage,
            });
            volumeIxs = [...jupIxs];
          } else {
            //  1: limit
            const setComputeUnitLimitIx =
              ComputeBudgetProgram.setComputeUnitLimit({
                units: limit,
              });

            //  2: price
            const setComputeUnitPriceIx =
              ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: price,
              });

            const proxyBuyIxs = await this.genBuyProxyIxs(
              tokenMint,
              wallet,
              poolDetail,
              slippage,
              isAxiom
            );
            volumeIxs = [
              setComputeUnitLimitIx,
              setComputeUnitPriceIx,
              ...proxyBuyIxs,
            ];

            // 9, gmgn, trogan, jito
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
            if (wallet.isAxiom) {
              const tipTx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: new PublicKey(
                  "5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg"
                ),
                lamports: 0.0001 * LAMPORTS_PER_SOL,
              });
              volumeIxs.push(tipTx);
            }
            if (i === wallets.length - 1) {
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
            const simulationResult = await connection.simulateTransaction(tx, {
              commitment: "confirmed",
            });
            if (simulationResult.value.err) {
              console.error("simulation", simulationResult.value);
              throw new Error(simulationResult.value);
            }

            console.log(
              chalk.green("simulation success", keypair.publicKey.toString())
            );
            buyTxns.push(tx);
          } catch (error) {
            console.error(error);
            break;
          }
        }

        // for end
        console.log("buyTxns", buyTxns.length);
        // return;
        if (buyTxns.length > 1) {
          const bundleResult = await ctx.service.jito.sendBundle(buyTxns);
          console.log(bundleResult);
          console.log(chalk.green("Buy transactions completed."));
        } else if (buyTxns.length === 1) {
          const bundleResult = await ctx.service.jito.sendTransaction(
            buyTxns[0]
          );
          console.log(bundleResult);
          console.log(chalk.green("Buy transactions completed."));
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
          } else if (wallet.thirdBuy) {
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

  async batchSellToken(token, wallets, type = "") {
    const { ctx } = this;
    console.log(chalk.green("\n batch sell Token----"));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);

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

      newWallets.reverse();

      const { blockhash } = await connection.getLatestBlockhash();
      const func = async (wallets) => {
        const poolDetail = await getPoolsWithPrices(tokenMint, ctx);
        const sellTxns = [];
        const jipAcc = ctx.service.jito.getTipAcc();
        for (let i = 0; i < wallets.length; i++) {
          const wallet = wallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const tokenAmount = wallet.tokenAmount;

          const { limit, price, fee } = wallet;

          let volumeIxs = [];

          // 1, setComputeUnitLimitIx
          const setComputeUnitLimitIx =
            ComputeBudgetProgram.setComputeUnitLimit({
              units: limit,
            });

          // 2,
          const setComputeUnitPriceIx =
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: price,
            });

          // 3, createAccountWithSeed
          const seed = new Date().getTime().toString();
          // const seed = "1749356034021";

          const newAccount = await PublicKey.createWithSeed(
            user,
            seed,
            TOKEN_PROGRAM_ID
          );
          const createAccountWithSeedIx = SystemProgram.createAccountWithSeed({
            fromPubkey: user,
            newAccountPubkey: newAccount,
            basePubkey: user,
            seed: seed,
            lamports: 2039280,
            space: 165,
            programId: TOKEN_PROGRAM_ID,
          });

          // 4, initializeAccount
          const initializeAccountIx = createInitializeAccountInstruction(
            newAccount,
            WSOL_TOKEN_ACCOUNT,
            user,
            TOKEN_PROGRAM_ID
          );

          // 5, pump sell
          const swapTx = await pSwap.createSellInstruction({
            user,
            tokenMint,
            tokenAmount,
            sellNewAccount: newAccount,
            poolDetail: poolDetail,
          });

          // 6. Token Program: closeAccount
          const closeAccountIx = createCloseAccountInstruction(
            newAccount,
            user,
            user
          );

          volumeIxs = [
            setComputeUnitLimitIx,
            setComputeUnitPriceIx,
            createAccountWithSeedIx,
            initializeAccountIx,
            swapTx,
            closeAccountIx,
          ];
          if (i === wallets.length - 1) {
            const jitoTipIx = SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: jipAcc,
              lamports: fee * LAMPORTS_PER_SOL,
            });
            volumeIxs.push(jitoTipIx);
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
        if (sellTxns.length > 1) {
          const bundleResult = await ctx.service.jito.sendBundle(sellTxns);
          console.log(bundleResult);
          console.log(chalk.green("Sell transactions completed."));
        } else if (sellTxns.length === 1) {
          const bundleResult = await ctx.service.jito.sendTransaction(
            sellTxns[0]
          );
          console.log(bundleResult);
          console.log(chalk.green("Buy transactions completed."));
        }
        return true;
      };
      if (type === "all") {
        let sellAllObj = {
          thirdBuy: [],
          secondBuy: [],
          multiBuy: [],
          firstBuy: [],
          otherBuy: [],
        };
        newWallets.forEach((wallet) => {
          if (wallet.firstBuy) {
            sellAllObj.firstBuy.push(wallet);
          } else if (wallet.secondBuy) {
            sellAllObj.secondBuy.push(wallet);
          } else if (wallet.multiBuy) {
            sellAllObj.multiBuy.push(wallet);
          } else if (wallet.thirdBuy) {
            sellAllObj.thirdBuy.push(wallet);
          } else {
            sellAllObj.otherBuy.push(wallet);
          }
        });

        for (const wallets of Object.values(sellAllObj)) {
          if (wallets.length > 0) {
            await func(wallets);
            await sleep(0.5);
          }
        }
        return true;
      } else {
        return func(newWallets);
      }
    } else {
      throw new Error("batch sell Token: param error");
    }
  }

  async getBuyAmmIxs(
    tokenMint,
    user,
    buyAmount,
    poolDetail,
    slippage,
    isAxiom
  ) {
    // 1
    const wSolATA = getAssociatedTokenAddressSync(
      WSOL_TOKEN_ACCOUNT,
      user,
      false
    );
    //2
    const tokenAta = getAssociatedTokenAddressSync(tokenMint, user, false);

    //3
    const createWSOLAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      wSolATA,
      user,
      WSOL_TOKEN_ACCOUNT
    );

    // 指令 4: 创建 tokenA ATA
    const createTokenAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      tokenAta,
      user,
      tokenMint
    );
    // 指令 5: 转账 SOL 到 wSOL ATA
    const transferLamportsWSOLIx = SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: wSolATA,
      lamports: Math.trunc(buyAmount * (1 + slippage) * LAMPORTS_PER_SOL),
      // lamports:
      //   Math.trunc(buyAmount * LAMPORTS_PER_SOL) +
      //   ATA_RENT * 2 +
      //   TRANSACTION_FEE,
    });
    // 指令 6: 同步 wSOL ATA
    const syncNativeIx = createSyncNativeInstruction(wSolATA, TOKEN_PROGRAM_ID);

    // 指令 7: Pump AMM buy
    let swapIxs = await pSwap.createBuyInstruction({
      tokenMint: tokenMint,
      user: user,
      buyAmount: buyAmount,
      slippage: slippage,
      poolDetail: poolDetail,
      isAxiom,
    });

    // 指令 8: 关闭 wSOL ATA
    const closeWSOLAtaIx = createCloseAccountInstruction(wSolATA, user, user);

    const Ixs = [
      createWSOLAtaIx,
      createTokenAtaIx,
      transferLamportsWSOLIx,
      syncNativeIx,
      swapIxs,
      closeWSOLAtaIx,
    ];
    return Ixs;
  }

  async genBuyProxyIxs(tokenMint, wallet, poolDetail, slippage, isAxiom) {
    const { ctx } = this;

    let proxyBuyIxs = [];

    const keypair = wallet.keypair;
    const user = keypair.publicKey;
    console.log(chalk.green("Proxy buy:", user.toBase58()));
    const { buyAmount } = wallet;
    if (wallet.isProxyBuy) {
      const proxyBuyIx = await proxyPumpSwap.createBuyInstruction({
        tokenMint: tokenMint,
        user: user,
        buyAmount: buyAmount,
        slippage: slippage,
        poolDetail: poolDetail,
      });
      proxyBuyIxs = [proxyBuyIx];
    } else {
      proxyBuyIxs = await this.getBuyAmmIxs(
        tokenMint,
        user,
        buyAmount,
        poolDetail,
        slippage,
        isAxiom
      );
    }

    return proxyBuyIxs;
  }
}

module.exports = PumpAMM;
