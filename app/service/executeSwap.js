const { Service } = require("egg");
require("dotenv").config();
const chalk = require("chalk");
const fs = require("fs");
const {} = require("../constants/executeData");

const {
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  TransactionInstruction,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
} = require("@solana/web3.js");

const { boss, connection } = require("../constants");

const bs58 = require("bs58");

class ExecuteSwap extends Service {
  constructor(props) {
    super(props);
  }

  async start() {
    const lastExecuteData = await this.getExecuteData();
    console.log(lastExecuteData);
    if (!lastExecuteData) {
      return;
    }
    const { wallets } = lastExecuteData;
    let canStart = true;
    if (wallets && wallets.length > 0) {
      for (let index = 0; index < wallets.length; index++) {
        const keypair = wallets[index].keypair;
        const balance = await connection.getBalance(keypair.publicKey);
        if (balance > 0) {
          canStart = false;
          break;
        }
      }
    }
    if (!canStart) {
      throw new Error("Wallet has balance");
    }
    await this.generateBoss(lastExecuteData);
  }

  async end() {
    await this.recycleSol();
    return true;
  }

  async getExecuteData() {
    const { ctx } = this;
    const executeData = await ctx.model.ExecuteData.findOne({
      active: true,
    }).lean();
    if (executeData) {
      const wallets = await ctx.model.ExecuteWallet.find({
        eid: executeData.eid,
      }).lean();
      executeData.wallets = wallets;
    }
    return executeData;
  }

  async getWalletConfig() {
    const { ctx } = this;
    const appData = await ctx.service.appData.getData();
    const executeWalletConfig = JSON.parse(appData.executeWalletConfig);
    return executeWalletConfig;
  }

  /**
   * Step 1, start -> generateBoss
   * @param {} lastExecuteData
   */
  async generateBoss(lastExecuteData) {
    const { ctx } = this;
    const lastBoss = Keypair.fromSecretKey(
      bs58.decode(lastExecuteData.privateKey)
    );
    const boss = Keypair.generate();

    const newData = {
      eid: lastExecuteData.eid + 1,
      bossAddress: boss.publicKey.toBase58(),
      privateKey: bs58.encode(boss.secretKey),
      active: true,
      createTime: new Date(),
    };
    fs.writeFileSync(
      "keypair.json",
      JSON.stringify({
        bossAddress: boss.publicKey.toBase58(),
        privateKey: bs58.encode(boss.secretKey),
      })
    );
    console.log(newData);
    await ctx.model.ExecuteData.updateMany({ active: true }, { active: false });
    await ctx.model.ExecuteData.create(newData);
    // transfer
    await this.transferAllSol(lastBoss, boss.publicKey);
  }

  /**
   * Step 2, generateWallets
   * 生成一批新的地址
   */
  async generateWallets() {
    const { ctx } = this;
    const walletConfig = await this.getWalletConfig();
    const executeData = await this.getExecuteData();
    console.log(walletConfig, executeData);
    if (walletConfig && executeData && !executeData.walletsExist) {
      const wallets = [];
      const dbData = walletConfig.map((item, index) => {
        const keypair = Keypair.generate();
        wallets.push(keypair.publicKey);
        return {
          wid: index + 1,
          address: keypair.publicKey.toBase58(),
          privateKey: bs58.encode(keypair.secretKey),
          eid: executeData.eid,
        };
      });
      fs.writeFileSync("keypair.json", JSON.stringify(dbData));
      const boss = Keypair.fromSecretKey(executeData.privateKey);
      const amounts = walletConfig.map((item) => item.transferAmount);
      const res = await ctx.model.ExecuteWallet.insertMany(dbData);
      await this.transferSol(boss, wallets, amounts);
      await ctx.model.ExecuteData.updateOne(
        { eid: executeData.eid },
        { walletsExist: true }
      );
      return true;
    } else {
      throw new Error("generateWallet data error");
    }
  }

  async transferSol(from, wallets, amounts) {
    const { blockhash } = await connection.getLatestBlockhash();
    if (wallets && wallets.length > 0) {
      const transferIxs = wallets.map((wallet, index) =>
        SystemProgram.transfer({
          fromPubkey: from.publicKey,
          toPubkey: wallet,
          lamports: amounts[index] * LAMPORTS_PER_SOL,
        })
      );

      const transferMessage = new TransactionMessage({
        payerKey: boss.publicKey,
        recentBlockhash: blockhash,
        instructions: transferIxs,
      }).compileToV0Message();

      const transferTx = new VersionedTransaction(transferMessage);
      transferTx.sign([from]);

      try {
        const signature = await connection.sendTransaction(transferTx, {
          skipPreflight: false,
        });
        const tx = await connection.confirmTransaction(signature, "confirmed");
        console.log(chalk.green(`Transaction sent: ${signature}`));
      } catch (error) {
        console.error(
          chalk.red(`Failed to send transaction: ${error.message}`)
        );
      }
      console.log(chalk.green("SOL transfers completed."));
    } else {
      throw new Error("no active wallet");
    }
  }

  async transferAllSol(from, to) {
    const { blockhash } = await connection.getLatestBlockhash();
    const TRANSACTION_FEE = 5000;
    const balance = await connection.getBalance(from.publicKey);
    // const ataRent = await connection.getMinimumBalanceForRentExemption(165); // ATA 大小约为 165 字节
    // const minRent = await connection.getMinimumBalanceForRentExemption(0);
    const minRent = 0;

    if (balance <= minRent + TRANSACTION_FEE) {
      throw new Error(
        `Insufficient balance for ${from.publicKey.toBase58()}, skipping.`
      );
    }

    const ix = SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: balance - minRent - TRANSACTION_FEE,
    });

    const volumeIxs = [ix];

    const messageV0 = new TransactionMessage({
      payerKey: from.publicKey,
      recentBlockhash: blockhash,
      instructions: volumeIxs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([from]);

    try {
      const signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(signature, "confirmed");
      console.log(chalk.green(`Transaction sent: ${signature}`));
    } catch (error) {
      throw new Error(`Failed to send transaction: ${error.message}`);
    }
  }

  // Boss转出sol
  async distributeSol() {
    const { ctx } = this;
    const wallets = await this.getWallets();

    if (wallets && wallets.length > 0) {
      const { blockhash } = await connection.getLatestBlockhash();

      const transferIxs = wallets.map((wallet, index) =>
        SystemProgram.transfer({
          fromPubkey: boss.publicKey,
          toPubkey: wallet.keypair.publicKey,
          lamports: WALLET_AMOUNTS[index].transferAmount * LAMPORTS_PER_SOL,
        })
      );

      const transferMessage = new TransactionMessage({
        payerKey: boss.publicKey,
        recentBlockhash: blockhash,
        instructions: transferIxs,
      }).compileToV0Message();

      const transferTx = new VersionedTransaction(transferMessage);
      transferTx.sign([boss]);

      try {
        const signature = await connection.sendTransaction(transferTx, {
          skipPreflight: false,
        });
        const tx = await connection.confirmTransaction(signature, "confirmed");
        console.log(chalk.green(`Transaction sent: ${signature}`));
      } catch (error) {
        console.error(
          chalk.red(`Failed to send transaction: ${error.message}`)
        );
      }
      //   const res = await this.sendBundle([transferTx]);
      console.log(chalk.green("SOL transfers completed."));
    } else {
      throw new Error("no active wallet");
    }
  }

  // Boss回收sol
  async recycleSol() {
    console.log(chalk.green("Ended：recycle"));
    const { ctx } = this;
    const wallets = await this.getWallets();
    if (wallets) {
      const { blockhash } = await connection.getLatestBlockhash();
      const TRANSACTION_FEE = 5000;

      const returnTxns = [];
      for (let i = 0; i < wallets.length; i++) {
        const keypair = wallets[i].keypair;
        const balance = await connection.getBalance(keypair.publicKey);
        // const ataRent = await connection.getMinimumBalanceForRentExemption(165); // ATA 大小约为 165 字节
        // const minRent = await connection.getMinimumBalanceForRentExemption(0);
        const minRent = 0;

        if (balance <= minRent + TRANSACTION_FEE) {
          console.log(
            chalk.yellow(
              `Insufficient balance for ${keypair.publicKey.toString()}, skipping.`
            )
          );
          continue;
        }

        const returnIx = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: boss.publicKey,
          lamports: balance - minRent - TRANSACTION_FEE,
        });

        const volumeIxs = [returnIx];
        // if (i === keypairs.length - 1) {
        //   volumeIxs.push(
        //     SystemProgram.transfer({
        //       fromPubkey: wallet.publicKey,
        //       toPubkey: tipAcct,
        //       lamports: BigInt(JITO_TIP_AMOUNT),
        //     })
        //   );
        //   signer = [keypair, wallet];
        // }

        const messageV0 = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions: volumeIxs,
        }).compileToV0Message();

        const tx = new VersionedTransaction(messageV0);
        tx.sign([keypair]);

        returnTxns.push(tx);
      }

      if (returnTxns.length > 0) {
        // await this.sendBundle(returnTxns);
        for (const returnTxn of returnTxns) {
          try {
            const signature = await connection.sendTransaction(returnTxn, {
              skipPreflight: false,
            });
            const tx = await connection.confirmTransaction(
              signature,
              "confirmed"
            );
            console.log(chalk.green(`Transaction sent: ${signature}`));
          } catch (error) {
            console.error(
              chalk.red(`Failed to send transaction: ${error.message}`)
            );
          }
        }
        console.log(chalk.green("SOL balances returned to main wallet."));
      } else {
        console.log(chalk.yellow("No SOL balances to return."));
      }
    } else {
      console.log(chalk.yellow("No wallet."));
    }
  }

  /**
   *
   * @param {*} token
   * @param {*} canTwice,  true: buy twice,  little amount
   * @returns
   */
  async buyToken(token, canTwice = false) {
    console.log(chalk.green(`\nStep 3: Buying ${token}`));
    const { ctx } = this;
    // const tokenInfo = await ctx.service.ave.getTokenInfo(token);
    // console.log(tokenInfo);
    // return;
    const wallets = await this.getWallets(canTwice);
    if (wallets && token) {
      const res = await ctx.service.pumpAMM.batchBuyToken(token, wallets);
    }
  }

  // sell token
  async sellToken(token) {
    console.log(chalk.green(`Step 4: Selling ${token}`));
    const { ctx } = this;
    const wallets = await this.getWallets();
    if (wallets && token) {
      const res = await ctx.service.pumpAMM.batchSellToken(token, wallets);
    }
  }

  /**
   * get keypair from db
   */
  async getWallets(canTwice = false) {
    const { ctx } = this;
    const filter = { active: true };
    if (canTwice) {
      filter.canTwice = true;
    }
    const dbData = await ctx.model.ExecuteWallet.find(filter);
    if (dbData && dbData.length > 0) {
      const wallets = dbData.map((wallet, index) => ({
        keypair: Keypair.fromSecretKey(bs58.decode(wallet.privateKey)),
        buyAmount: wallet.buyAmount,
      }));
      return wallets;
    } else {
      return null;
    }
  }
}

module.exports = ExecuteSwap;
