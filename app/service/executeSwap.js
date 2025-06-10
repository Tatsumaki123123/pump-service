const { Service } = require("egg");
require("dotenv").config();
const chalk = require("chalk");
const fs = require("fs");
// const {} = require("../constants/executeData");

const bs58 = require("bs58");
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

const {
  getSPLBalance,
  closeAllTokenAccounts,
  transferAllSol,
  transferSol,
} = require("../utils/solana");

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
    // await this.transferSolToWallets();
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
    await transferAllSol(connection, lastBoss, boss.publicKey);
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
      const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
      const amounts = walletConfig.map((item) => item.transferAmount);
      const res = await ctx.model.ExecuteWallet.insertMany(dbData);
      await transferSol(connection, boss, wallets, amounts);
      await ctx.model.ExecuteData.updateOne(
        { eid: executeData.eid },
        { walletsExist: true }
      );
      return true;
    } else {
      throw new Error("generateWallet data error");
    }
  }

  async transferSolToWallets() {
    const wallets = await this.getWallets();
    const executeData = await this.getExecuteData();
    const walletConfig = await this.getWalletConfig();

    if (wallets && executeData) {
      const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
      console.log(boss.publicKey.toBase58());
      const amounts = walletConfig.map((item) => item.transferAmount);
      const newWallets = wallets.map((item) => new PublicKey(item.address));
      await transferSol(connection, boss, newWallets, amounts);
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
    const executeData = await this.getExecuteData();
    if (wallets && executeData) {
      for (const wallet of wallets) {
        // 先关闭账户
        // await closeAllTokenAccounts(connection, wallet.keypair);
        await transferAllSol(
          connection,
          wallet.keypair,
          new PublicKey(executeData.bossAddress)
        );
      }
    } else {
      console.log(chalk.yellow("No wallet."));
    }
  }

  /**
   *
   * @param {*} token
   * @param {*} type,  first, second, multi
   * @returns
   */
  async buyToken(token, type = "first") {
    console.log(chalk.green(`\nStep 3: Buying ${token}`));
    const { ctx } = this;

    const wallets = await this.getWalletsWithConfig(type);

    if (wallets && wallets.length > 0 && token) {
      const res = await ctx.service.pumpAMM.batchBuyToken(token, wallets);
    }
  }

  // sell token
  async sellToken(token, type = "all") {
    console.log(chalk.green(`Step 4: Selling ${token}`));
    const { ctx } = this;
    const wallets = await this.getWalletsWithConfig(type);
    if (wallets && token) {
      const res = await ctx.service.pumpAMM.batchSellToken(token, wallets);
    }
  }

  /**
   * get keypair from db
   */
  async getWallets() {
    const { ctx } = this;
    const executeData = await this.getExecuteData();
    if (executeData) {
      const dbData = await ctx.model.ExecuteWallet.find({
        eid: executeData.eid,
      });
      if (dbData && dbData.length > 0) {
        const wallets = dbData.map((wallet, index) => ({
          address: wallet.address,
          keypair: Keypair.fromSecretKey(bs58.decode(wallet.privateKey)),
        }));
        return wallets;
      } else {
        throw new Error("getWallets data error: No wallet");
      }
    } else {
      throw new Error("getWallets data error");
    }
  }

  async getWalletsWithConfig(type) {
    const wallets = await this.getWallets();
    const walletConfigs = await this.getWalletConfig();
    const data = wallets.map((wallet, index) => {
      const buyAmountArr = walletConfigs[index].buyAmount;
      const buyAmount =
        buyAmountArr[Math.floor(Math.random() * buyAmountArr.length)];
      return {
        ...wallet,
        ...walletConfigs[index],
        buyAmount: buyAmount,
      };
    });

    const newWallets = data.filter((wallet) => {
      if (type === "first") {
        return wallet.firstBuy === true;
      } else if (type === "second") {
        return wallet.secondBuy === true;
      } else if (type === "multi") {
        return wallet.multiBuy === true;
      } else {
        return true;
      }
    });

    return newWallets;
  }
}

module.exports = ExecuteSwap;
