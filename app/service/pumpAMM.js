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
} = require("@solana/spl-token");

const bs58 = require("bs58");
const chalk = require("chalk");

const { connection, WSOL_TOKEN_ACCOUNT } = require("../constants");
const { getPumpSwapPool, fetchPumpSwapPool } = require("../libs/pool");
const PumpSwapSDK = require("../libs/pumpSwap");

const Direction = { quoteToBase: "quoteToBase", baseToQuote: "baseToQuote" };

const TRANSACTION_FEE = 5000;
const JITO_TIP_AMOUNT = 0.0001 * LAMPORTS_PER_SOL;
const SLIPPAGE_BASIS_POINTS = 0.1; // 10% 滑点

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
    console.log(chalk.green("\n batchBuyToken----"));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const info = await ctx.service.moralis.getTokenPrice(token);
      const pool = info.pairAddress;
      if (!info) {
        throw new Error("Token info error");
        return;
      }
      // const pool = await fetchPumpSwapPool(tokenMint);
      // console.log(pool);

      const developer = new PublicKey(
        "3ntQEGgNknofu8WMAA8SH7emf8cJdxCui1HpFu4CAcgR"
      );

      const { blockhash } = await connection.getLatestBlockhash();
      const jipAcc = ctx.service.jito.getTipAcc();
      const ATA_RENT = await connection.getMinimumBalanceForRentExemption(165); // ATA 租金

      const buyTxns = [];

      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const buyAmount = wallet.buyAmount;
        const wSolATA = getAssociatedTokenAddressSync(
          WSOL_TOKEN_ACCOUNT,
          keypair.publicKey,
          false
        );
        const tokenAta = getAssociatedTokenAddressSync(
          tokenMint,
          keypair.publicKey,
          false
        );

        // 指令 1: 设置计算单位限制
        const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 200000,
        });

        // 指令 2: 设置计算单位价格
        const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 69890,
        });

        // 指令 3: 创建 wSOL ATA, 获取账户 token account
        const createWSOLAtaIx =
          createAssociatedTokenAccountIdempotentInstruction(
            keypair.publicKey,
            wSolATA,
            keypair.publicKey,
            WSOL_TOKEN_ACCOUNT
          );

        // 指令 4: 创建 tokenA ATA
        const createTokenAtaIx =
          createAssociatedTokenAccountIdempotentInstruction(
            keypair.publicKey,
            tokenAta,
            keypair.publicKey,
            tokenMint
          );
        // 指令 5: 转账 SOL 到 wSOL ATA
        const transferLamportsWSOLIx = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: wSolATA,
          lamports: Math.trunc(buyAmount * LAMPORTS_PER_SOL),
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
          pool: pool,
          tokenMint: tokenMint,
          user: keypair.publicKey,
          developer: developer,
          buyAmount: buyAmount,
          slippage: SLIPPAGE_BASIS_POINTS,
        });

        return;

        // 指令 8: 关闭 wSOL ATA
        const closeWSOLAtaIx = createCloseAccountInstruction(
          wSolATA,
          keypair.publicKey,
          keypair.publicKey
        );
        // 指令 9: Jito 提示（由子钱包支付）
        const jitoTipIx = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: jipAcc,
          lamports: JITO_TIP_AMOUNT,
        });

        const volumeIxs = [
          setComputeUnitLimitIx,
          setComputeUnitPriceIx,
          createWSOLAtaIx,
          createTokenAtaIx,
          transferLamportsWSOLIx,
          syncNativeIx,
          swapIxs,
          closeWSOLAtaIx,
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

          //simulation tx
          const simulationResult = await connection.simulateTransaction(tx, {
            commitment: "confirmed",
          });
          if (simulationResult.value.err) {
            console.error(
              chalk.red(
                `Simulation error for ${keypair.publicKey.toString()}:`,
                JSON.stringify(simulationResult.value.err)
              )
            );
            continue;
          }

          console.log(
            chalk.green("simulation success", keypair.publicKey.toString())
          );

          buyTxns.push(tx);
        } catch (error) {
          console.error(
            chalk.red(
              `Error compiling transaction for ${keypair.publicKey.toString()}:`,
              error.message
            )
          );
          continue;
        }
      }

      // for end
      // return;
      if (buyTxns.length > 0) {
        // const transferTx = buyTxns[0];
        // const signature = await connection.sendTransaction(transferTx, {
        //   skipPreflight: false,
        // });
        // const tx = await connection.confirmTransaction(signature, "confirmed");
        const bundleResult = await ctx.service.jito.sendBundle(buyTxns);
        console.log(bundleResult);
        console.log(chalk.green("Buy transactions completed."));
      }
    } else {
      throw new Error("batchBuyToken: param error");
    }
  }

  async batchSellToken() {}
}

module.exports = PumpAMM;
