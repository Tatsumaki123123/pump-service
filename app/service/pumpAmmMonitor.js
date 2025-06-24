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
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} = require("@solana/spl-token");

const bs58 = require("bs58");
const borsh = require("@coral-xyz/borsh");
const chalk = require("chalk");

const { PumpAmmSdk } = require("@pump-fun/pump-swap-sdk");

const {
  connection,
  PUMP_AMM_PROGRAM_ID,
  WSOL_TOKEN_ACCOUNT,
} = require("../constants/index");

const { getSPLBalance } = require("../utils/solana");

const {
  getPoolsWithQuoteMint,
  getPoolsWithPrices,
  getPriceAndLiquidity,
  getPoolsWithBaseMint,
} = require("../libs/pool");
const PumpSwapSDK = require("../libs/pumpSwap");

const pSwap = new PumpSwapSDK();
const pumpAmmSdk = new PumpAmmSdk(connection);

const addresses = ["8J5GUAf7hr3LTPHJSkwrKFDNJPtAXtLHhnNHq6XxTLrW"];

class PumpAmmMonitor extends Service {
  constructor(ctx) {
    super(ctx);
    this.subscriptionId = null;
    // this.user = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    this.user = null;
  }

  async buyToken({
    poolAddress,
    quoteAmountIn,
    baseAmountOut,
    monitorAddress,
  }) {
    const { ctx } = this;
    const wallet = this.user;
    const checkPrice = this.checkBuyPrice(quoteAmountIn, baseAmountOut);
    console.log("checkPrice", checkPrice);
    if (checkPrice) {
      try {
        const poolMint = new PublicKey(poolAddress);
        const poolData = await pumpAmmSdk.fetchPool(poolMint);
        const pool_detail = {
          address: new PublicKey(poolAddress),
          is_native_base: false,
          poolData: poolData,
        };
        const poolDetail = await getPriceAndLiquidity(pool_detail);

        const tokenMint = poolData.baseMint;
        // const buyAmount = Math.floor(quoteAmountIn / 10) / LAMPORTS_PER_SOL;
        const buyAmount = 0.1;
        const slippage = 0.2;

        console.log(chalk.green("Buy", buyAmount, tokenMint.toBase58()));
        const dbData = await ctx.model.MonitorToken.findOne({
          token: tokenMint.toBase58(),
          monitorAddress: monitorAddress,
        });
        if (!dbData) {
          await ctx.model.MonitorToken.create({
            token: tokenMint.toBase58(),
            monitorAddress: monitorAddress,
            buyAmount: buyAmount,
            createTime: new Date(),
          });
        }

        const { blockhash } = await connection.getLatestBlockhash();
        const volumeIxs = [];
        //  1: limit
        const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 150000,
        });
        volumeIxs.push(setComputeUnitLimitIx);

        //  2: price
        const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 970148,
        });
        volumeIxs.push(setComputeUnitPriceIx);

        const userBaseTokenAccount = await getAssociatedTokenAddress(
          tokenMint,
          wallet.publicKey
        );
        const accountInfo = await connection.getAccountInfo(
          userBaseTokenAccount
        );
        if (!accountInfo) {
          const createTokenAccountTx = createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            userBaseTokenAccount,
            wallet.publicKey,
            tokenMint
          );
          volumeIxs.push(createTokenAccountTx);
        }

        // 3 swap
        const swapIx = await pSwap.createBuyInstruction({
          tokenMint,
          user: wallet.publicKey,
          buyAmount,
          slippage,
          poolDetail,
        });
        volumeIxs.push(swapIx);
        const messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: blockhash,
          instructions: volumeIxs,
        }).compileToV0Message();

        const tx = new VersionedTransaction(messageV0);
        tx.sign([wallet]);

        const signature = await connection.sendTransaction(tx, {
          skipPreflight: false,
        });
        await connection.confirmTransaction(signature, "processed");
        console.log(
          chalk.green(`Success: Buy ${tokenMint.toBase58()} ${buyAmount}sol`)
        );
      } catch (error) {
        console.error(error);
      }
    } else {
      console.log(chalk.red("price not right"));
    }
  }
  async sellToken({ poolAddress, monitorAddress }) {
    const { ctx } = this;
    const wallet = this.user;
    try {
      const poolMint = new PublicKey(poolAddress);
      const poolData = await pumpAmmSdk.fetchPool(poolMint);
      const pool_detail = {
        address: new PublicKey(poolAddress),
        is_native_base: false,
        poolData: poolData,
      };
      const poolDetail = await getPriceAndLiquidity(pool_detail);

      const tokenMint = poolData.baseMint;
      const dbData = await ctx.model.MonitorToken.findOne({
        token: tokenMint.toBase58(),
        monitorAddress: monitorAddress,
      });
      if (!dbData) {
        throw new Error("Your do not buy this token:", tokenMint.toBase58());
      }
      console.log(chalk.yellow("Sell", tokenMint.toBase58()));

      const { blockhash } = await connection.getLatestBlockhash();

      const volumeIxs = [];
      //  1: limit
      const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 150000,
      });
      volumeIxs.push(setComputeUnitLimitIx);

      //  2: price
      const setComputeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 970148,
      });
      volumeIxs.push(setComputeUnitPriceIx);

      const tokenAmount = await getSPLBalance(
        connection,
        tokenMint,
        wallet.publicKey
      );
      if (tokenAmount === 0) {
        throw new Error("No amount");
      }

      const sellNewAccount = await getAssociatedTokenAddress(
        WSOL_TOKEN_ACCOUNT,
        wallet.publicKey
      );
      const swapTx = await pSwap.createSellInstruction({
        tokenMint,
        user: wallet.publicKey,
        tokenAmount,
        sellNewAccount,
        poolDetail,
      });

      volumeIxs.push(swapTx);

      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: volumeIxs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign([wallet]);

      const signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(signature, "processed");
      console.log(chalk.green(`Sell:  ${tokenMint.toBase58()}`));
    } catch (error) {
      console.error(error);
    }
  }

  checkBuyPrice(quoteAmountIn, baseAmountOut) {
    const MIN_PRICE_SOL = 0.0000003;
    const MAX_PRICE_SOL = 0.0000015;
    const price = quoteAmountIn / LAMPORTS_PER_SOL / (baseAmountOut / 10 ** 6);

    console.log("price:", price);
    if (price > MIN_PRICE_SOL && price < MAX_PRICE_SOL) {
      return true;
    } else {
      return false;
    }
  }

  async parseData(base64Data, signature) {
    const buffer = Buffer.from(base64Data, "base64");
    const discriminator = buffer.slice(0, 8);
    const buyDiscriminator = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
    const sellDiscriminator = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
    let type = "";
    if (discriminator.equals(buyDiscriminator)) {
      type = "buy";
    } else if (discriminator.equals(sellDiscriminator)) {
      type = "sell";
    }
    const u64Schema = borsh.u64();
    const timestamp = u64Schema.decode(buffer.slice(8, 8 + 8)).toString();
    const baseAmountOut = u64Schema.decode(buffer.slice(16, 16 + 8)).toString();
    const quoteAmountIn = u64Schema.decode(buffer.slice(64, 64 + 8)).toString();
    const offset1 = 120;
    const pool = buffer.slice(offset1, offset1 + 32);
    const offset2 = 152;
    const user = buffer.slice(offset2, offset2 + 32);
    const createdTime = parseInt(timestamp) * 1000;
    const userAddress = bs58.encode(user);
    const poolAddress = bs58.encode(pool);
    if (addresses.includes(userAddress)) {
      console.log(type, poolAddress, signature);
      if (type === "buy") {
        await this.buyToken({
          poolAddress,
          quoteAmountIn,
          baseAmountOut,
          monitorAddress: userAddress,
        });
      } else {
        await this.sellToken({ poolAddress, monitorAddress: userAddress });
      }
    }
    return;
  }

  async startMonitor() {
    // await this.wrapSolToWSol(2);
    // await this.wsolToSol();
    const { ctx } = this;
    try {
      // this.parseData(
      //   "Pi83CqUD3Cr0v1doAAAAABeHw6ETBAAAAAAAAAAAAAAXh8OhEwQAAA62Q0gqAAAAkm/A1OJXAQAa+PhjEQAAAEajKDQAAAAAFAAAAAAAAACNtBoAAAAAAAUAAAAAAAAAJK0GAAAAAAC57g00AAAAAHGUADQAAAAAhqtmhuSCEddmdsvuk+Dyq8XOs1pS30o900TrCwuyWmVsYYGxCnbU3esCbMTQfy/lFZQ1XQW6cnL2ld3lhvlhY040r51bHKuV9fsqKvXMp4UePZsxxrTN3GbmF8izNuEd1CpJB/WStyoQLC5lHiPO2X3xCsF3pY2cJycKEffqL3JKwvjQ3Vy8l+MonBl8tQYqVPPZVrnOblEV+WVnqlyz5nfZFZVfiIBzHOtKdaDMlsF0+kCVxOHZlnrPxChFrmeuE6eaMNeL3sDQFytYyx790D4KmHzxX4C/8ZAeeVVeBsQFAAAAAAAAACStBgAAAAAA"
      // );
      //   parseData(
      //     "Pi83CqUD3CrvKlFoAAAAANBI5GjjAQAAGIP1WgAAAADQSORo4wEAAAposrYrAAAAp8gfNWa/AADUHNHoJQAAAG6fz14AAAAAFAAAAAAAAAATizAAAAAAAAUAAAAAAAAAxSIMAAAAAABbFJ9eAAAAANHOhl4AAAAAWCOngP4Gv00Dt0wTp8Urzq+cPQErsL8ReHuqn3yXxvV0igiERM/OwQmwHxzP/+S8iH99oLBzT+P0TFGM+WmiwdoAnDUU8T23wpm7LrgOmkynIoAhGndV635XXBhkSrVTlxpn8fIsm84U1Nz5mknYtkcfEfs5HVMkpcjl+EEcUR/Xqo+wYNgpG0xNR12v92LJa9wNrOs2wBLq0S7TqUhBYQHIIfOo8I/viNwxQkp2gK6MloFwTPHl9ciOJ5m3+YIh4IGT3tZtkerXWkSSsPeFqXymloN5l407JgGuquq3llAFAAAAAAAAAMUiDAAAAAAA"
      //   );

      console.log(chalk.green("Pump amm monitor start------"));
      this.subscriptionId = connection.onLogs(
        PUMP_AMM_PROGRAM_ID,
        async (log) => {
          try {
            const { logs } = log;
            const buyLog = logs.find(
              (item) =>
                item === "Program log: Instruction: Buy" ||
                item === "Program log: Instruction: Sell"
            );
            if (buyLog) {
              const logPrefix = "Program data: ";
              const dataLog = logs.find((item) => item.indexOf(logPrefix) > -1);
              if (dataLog) {
                const base64Data = dataLog.slice(logPrefix.length).trim();
                this.parseData(base64Data, log.signature);
              }
            }
          } catch (error) {
            console.error("error", error);
          }
        },
        "processed"
      );

      console.log("pump monitor started");
    } catch (error) {}
  }

  async stopMonitorAMM() {
    if (this.subscriptionId !== null) {
      await this.connection.removeProgramAccountChangeListener(
        this.subscriptionId
      );
      this.subscriptionId = null;
      console.log("Believe monitor stopped");
    }
  }

  async wrapSolToWSol(amount = 0.1) {
    console.log(chalk.green("wrapSolToWSol"));
    const wallet = this.user;
    const associatedTokenAddress = await getAssociatedTokenAddress(
      WSOL_TOKEN_ACCOUNT,
      wallet.publicKey
    );

    const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
    const transaction = new Transaction();

    if (!accountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          associatedTokenAddress,
          wallet.publicKey,
          WSOL_TOKEN_ACCOUNT
        )
      );
    }

    const amountToWrap = amount * LAMPORTS_PER_SOL;

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: associatedTokenAddress,
        lamports: amountToWrap,
      }),
      createSyncNativeInstruction(associatedTokenAddress)
    );

    const signature = await connection.sendTransaction(transaction, [wallet]);
    await connection.confirmTransaction(signature, "confirmed");

    console.log(`成功将 0.1 SOL 转换为 WSOL！交易签名: ${signature}`);
    console.log(`WSOL 存储在: ${associatedTokenAddress.toBase58()}`);
  }

  async wsolToSol() {
    const wallet = this.user;
    const associatedTokenAddress = await getAssociatedTokenAddress(
      WSOL_TOKEN_ACCOUNT,
      wallet.publicKey
    );

    // 5. 检查 ATA 是否存在并有余额
    const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
    if (!accountInfo) {
      throw new Error("WSOL ATA 不存在，请确认钱包中是否有 WSOL");
    }

    const balance = await connection.getTokenAccountBalance(
      associatedTokenAddress
    );
    console.log(`当前 WSOL 余额: ${balance.value.uiAmount} WSOL`);

    // 6. 创建交易并添加关闭 ATA 的指令
    const transaction = new Transaction().add(
      createCloseAccountInstruction(
        associatedTokenAddress, // 要关闭的 WSOL ATA
        wallet.publicKey, // 接收 SOL 的目标账户
        wallet.publicKey // ATA 的所有者
      )
    );

    // 7. 发送交易
    const signature = await connection.sendTransaction(transaction, [wallet], {
      skipPreflight: false, // 启用预检以捕获模拟错误
    });
    await connection.confirmTransaction(signature, "confirmed");
  }
}

module.exports = PumpAmmMonitor;
