const { Service } = require("egg");
const BN = require("bn.js");
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

const { connection, WSOL_TOKEN_ACCOUNT } = require("../constants");
const PumpSwapSDK = require("../libs/pumpSwap");
const { getSPLBalance } = require("../utils/solana");

const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);

const GMGN_FEES_VAULT = new PublicKey(
  "BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT"
);
const GMGN_FEE = 0.001;

const TROGAN_FEES_VAULT = new PublicKey(
  "9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco"
);

const TROGAN_FEE = 0.00036;

const TRANSACTION_FEE = 5000;
const JITO_TIP_AMOUNT = 0.0001 * LAMPORTS_PER_SOL;
const SLIPPAGE_BASIS_POINTS = 0.1; // 10% 滑点
// const SLIPPAGE_BASIS_POINTS = 0.1; // 10% 滑点

const pSwap = new PumpSwapSDK();
// const pSwap = new PumpAmmSdk(connection);

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
  async batchBuyToken(token, wallets) {
    const { ctx } = this;
    console.log(chalk.green("\n batchBuyToken----", wallets.length));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);

      const { blockhash } = await connection.getLatestBlockhash();
      const jipAcc = ctx.service.jito.getTipAcc();
      // const ATA_RENT = await connection.getMinimumBalanceForRentExemption(165);
      const poolDetail = await getPoolsWithPrices(tokenMint);

      const buyTxns = [];

      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const { buyAmount, limit, price, fee } = wallet;

        console.log(`${user.toBase58()} buy ${buyAmount} ${token}`);

        const wSolATA = getAssociatedTokenAddressSync(
          WSOL_TOKEN_ACCOUNT,
          user,
          false
        );
        const tokenAta = getAssociatedTokenAddressSync(tokenMint, user, false);

        // 指令 1: 设置计算单位限制
        const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: limit,
        });

        // 指令 2: 设置计算单位价格
        const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: price,
        });

        // 指令 3: 创建 wSOL ATA, 获取账户 token account
        const createWSOLAtaIx =
          createAssociatedTokenAccountIdempotentInstruction(
            user,
            wSolATA,
            user,
            WSOL_TOKEN_ACCOUNT
          );

        // 指令 4: 创建 tokenA ATA
        const createTokenAtaIx =
          createAssociatedTokenAccountIdempotentInstruction(
            user,
            tokenAta,
            user,
            tokenMint
          );
        // 指令 5: 转账 SOL 到 wSOL ATA
        const transferLamportsWSOLIx = SystemProgram.transfer({
          fromPubkey: user,
          toPubkey: wSolATA,
          lamports: Math.trunc(
            buyAmount * (1 + SLIPPAGE_BASIS_POINTS) * LAMPORTS_PER_SOL
          ),
          // lamports:
          //   Math.trunc(buyAmount * LAMPORTS_PER_SOL) +
          //   ATA_RENT * 2 +
          //   TRANSACTION_FEE,
        });
        // 指令 6: 同步 wSOL ATA
        const syncNativeIx = createSyncNativeInstruction(
          wSolATA,
          TOKEN_PROGRAM_ID
        );

        // 指令 7: Pump AMM buy
        let swapIxs = await pSwap.createBuyInstruction({
          tokenMint: tokenMint,
          user: user,
          buyAmount: buyAmount,
          slippage: SLIPPAGE_BASIS_POINTS,
          poolDetail: poolDetail,
        });

        // 指令 8: 关闭 wSOL ATA
        const closeWSOLAtaIx = createCloseAccountInstruction(
          wSolATA,
          user,
          user
        );
        const volumeIxs = [
          setComputeUnitLimitIx,
          setComputeUnitPriceIx,
          createWSOLAtaIx,
          createTokenAtaIx,
          transferLamportsWSOLIx,
          syncNativeIx,
          swapIxs,
          closeWSOLAtaIx,
        ];

        // 指令 9: Jito 提示（由子钱包支付）
        if (wallet.isGmgn) {
          const gmgnTipTx = SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: GMGN_FEES_VAULT,
            lamports: GMGN_FEE * LAMPORTS_PER_SOL,
          });
          volumeIxs.push(gmgnTipTx);
        }
        if (wallet.isTrogan) {
          const troganTipIx = SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: TROGAN_FEES_VAULT,
            lamports: TROGAN_FEE * LAMPORTS_PER_SOL,
          });

          volumeIxs.push(troganTipIx);

          if (wallets.length > 1 && i === wallets.length - 1) {
            const jitoTipIx = SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: jipAcc,
              lamports: fee * LAMPORTS_PER_SOL,
            });
            volumeIxs.push(jitoTipIx);
          }
        } else {
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
          continue;
        }
      }

      // for end
      console.log("buyTxns", buyTxns.length);
      if (buyTxns.length > 0) {
        if (buyTxns.length === 1) {
          const transferTx = buyTxns[0];
          const signature = await connection.sendTransaction(transferTx, {
            skipPreflight: false,
          });
          // await connection.confirmTransaction(signature, "processed");
          return;
        }
        const bundleResult = await ctx.service.jito.sendBundle(buyTxns);
        console.log(bundleResult);

        console.log(chalk.green("Buy transactions completed."));
      }
    } else {
      throw new Error("batchBuyToken: param error");
    }
  }

  async batchSellToken(token, wallets) {
    const { ctx } = this;
    console.log(chalk.green("\n batch sell Token----"));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const poolDetail = await getPoolsWithPrices(tokenMint);
      const { blockhash } = await connection.getLatestBlockhash();
      const jipAcc = ctx.service.jito.getTipAcc();

      const sellTxns = [];

      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;

        const { limit, price, fee } = wallet;
        // const user = new PublicKey(
        //   "CL3NczTBZh4mGfvLFVEb4LMrvg92QrpNXHwDuZ54Jq8g"
        // );
        const tokenAmount = await getSPLBalance(
          connection,
          tokenMint,
          keypair.publicKey
        );

        console.log(`${user.toBase58()} sell ${tokenAmount} ${token}`);
        if (tokenAmount >= 10000) {
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

          //7
          const jitoTipIx = SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: jipAcc,
            lamports: fee * LAMPORTS_PER_SOL,
          });

          const volumeIxs = [
            setComputeUnitLimitIx,
            setComputeUnitPriceIx,
            createAccountWithSeedIx,
            initializeAccountIx,
            swapTx,
            closeAccountIx,
            jitoTipIx,
          ];

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
      }
      console.log("sellTxns", sellTxns.length);
      if (sellTxns.length > 0) {
        if (sellTxns.length === 1) {
          const transferTx = sellTxns[0];
          const signature = await connection.sendTransaction(transferTx, {
            skipPreflight: false,
          });
          // await connection.confirmTransaction(signature, "confirmed");
          return;
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

module.exports = PumpAMM;
