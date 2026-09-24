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
const { createTroProxyInstruction } = require("../libs/trogan");

const { sendV0Transaction, getSPLBalance } = require("../utils/solana");
const { splitIntoBundles } = require("../utils/utils");
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
    const { ctx } = this;
    try {
      // if (!this.canBuy) return false;
      // this.canBuy = false;
      console.log(
        chalk.green("Buy token", token, testWallet.publicKey.toBase58())
      );
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
      return;
      const tipIx = SystemProgram.transfer({
        fromPubkey: testWallet.publicKey,
        toPubkey: new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
        lamports: 0.0001 * LAMPORTS_PER_SOL,
      });
      const volumeIxs = [tipIx, ...buyTx.instructions];
      // const volumeIxs = [...buyTx.instructions];
      const bundleResult = await ctx.service.jito.sendBundle([volumeIxs]);
      console.log(bundleResult);

      // const res = await sendV0Transaction(connection, testWallet, volumeIxs);
      // setTimeout(() => {
      //   this.canBuy = true;
      // }, 10 * 1000);
      return true;
    } catch (error) {
      console.error(error);
    }
  }

  async quickBuyToken(tokenData, amount = 0.01) {
    const { ctx } = this;
    const { mint, creator } = tokenData;
    const buyTx = await pfSwap.getQuickBuyInstructions(
      testWallet.publicKey,
      mint,
      creator,
      BigInt(amount * LAMPORTS_PER_SOL),
      SLIPPAGE_BASIS_POINTS,
      {
        unitLimit: 250000,
        unitPrice: 250000,
      },
      "processed"
    );
    //  const tipIx = SystemProgram.transfer({
    //     fromPubkey: testWallet.publicKey,
    //     toPubkey: new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
    //     lamports: 0.0001 * LAMPORTS_PER_SOL,
    //   });
    //   const volumeIxs = [tipIx, ...buyTx.instructions];
    // const volumeIxs = [...buyTx.instructions];

    const tipIx = SystemProgram.transfer({
      fromPubkey: testWallet.publicKey,
      toPubkey: ctx.service.jito.getTipAcc(),
      lamports: ctx.service.jito.getTipAmount(),
    });
    const volumeIxs = [tipIx, ...buyTx.instructions];

    const { blockhash } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: testWallet.publicKey,
      recentBlockhash: blockhash,
      instructions: volumeIxs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([testWallet]);
    // const volumeIxs = [...buyTx.instructions];
    const bundleResult = await ctx.service.jito.sendBundle([tx]);
    console.log(bundleResult);

    // const res = await sendV0Transaction(connection, testWallet, volumeIxs);
    return true;
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

  async batchBuyToken(token, wallets) {
    const { ctx } = this;
    console.log(chalk.green("\nPump fun batchBuyToken----", wallets.length));
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
        const buyTx = await pfSwap.buy(
          user,
          tokenMint,
          BigInt(buyAmount * LAMPORTS_PER_SOL),
          SLIPPAGE_BASIS_POINTS,
          {
            unitLimit: limit,
            unitPrice: price,
          },
          "processed"
        );
        volumeIxs = [...buyTx.instructions];

        const jipAcc = ctx.service.jito.getTipAcc();
        if (wallet.isGmgn) {
          const gmgnTipTx = SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: GMGN_FEES_VAULT,
            lamports: GMGN_FEE * LAMPORTS_PER_SOL,
          });
          volumeIxs.push(gmgnTipTx);
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
        // for (let i = 0; i < buyTxns.length; i++) {
        //   console.log("buy txn -", i);
        //   const transferTx = buyTxns[i];
        //   const signature = await connection.sendTransaction(transferTx, {
        //     skipPreflight: false,
        //   });
        //   await connection.confirmTransaction(signature, "processed");
        // }
        // return;
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

  async batchSellToken(token, wallets, type = "", percent = 100) {
    const { ctx } = this;
    console.log(chalk.green("\n Pump fun batch sell Token----"));

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
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const balance = await getSPLBalance(
          connection,
          tokenMint,
          keypair.publicKey
        );
        const sellPercent = getWalletSellPercent(wallet);
        const tokenAmount = (balance * sellPercent) / 100;

        console.log(
          `${user.toBase58()} sell ${tokenAmount} (${sellPercent}%) ${token}`
        );
        if ((sellAll ? balance > 0 : balance >= 100) && tokenAmount > 0) {
          newWallets.push({ ...wallet, tokenAmount });
        }
      }

      const func = async (bundleWallets) => {
        const { blockhash } = await connection.getLatestBlockhash();
        const jipAcc = ctx.service.jito.getTipAcc();
        const sellTxns = [];
        for (let i = 0; i < bundleWallets.length; i++) {
          const wallet = bundleWallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const tokenAmount = wallet.tokenAmount;

          const { limit, price, fee } = wallet;

          let volumeIxs = [];
          const sellTx = await pfSwap.sell(
            user,
            tokenMint,
            BigInt(Math.trunc(tokenAmount * Math.pow(10, 6))),
            SLIPPAGE_BASIS_POINTS,
            {
              unitLimit: limit,
              unitPrice: price,
            },
            "processed",
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
                error.message,
              ),
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
      };

      const bundles = splitIntoBundles(newWallets);
      for (const bundleWallets of bundles) {
        await func(bundleWallets);
      }
      return true;
    } else {
      throw new Error("batch sell Token: param error");
    }
  }

  async getPoolDetail(token) {
    const { ctx } = this;

    const res = await pfSwap.getBondingCurveAccount(new PublicKey(token));
    return { dev: res.creator.toBase58() };
  }
}
module.exports = PumpFun;
