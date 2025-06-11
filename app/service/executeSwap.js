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

const { connection } = require("../constants");

const {
  getSPLBalance,
  closeAllTokenAccounts,
  transferAllSol,
  transferSol,
  isValidSolanaAddress,
} = require("../utils/solana");

const { getPoolsWithPrices } = require("../libs/pool");

const BOSS_MIN_AMOUNT = 0.3;

class ExecuteSwap extends Service {
  constructor(props) {
    super(props);
  }

  async start(line) {
    const lastExecuteData = await this.getExecuteData(line);
    if (!lastExecuteData) {
      return;
    }
    const wallets = await this.getWallets(line);
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

  async end(line) {
    // await this.transferSolToWallets(line);
    await this.recycleSol(line);
    return true;
  }

  async getExecuteData(line) {
    const { ctx } = this;
    const executeData = await ctx.model.ExecuteData.findOne({
      active: true,
      line,
    }).lean();
    return executeData;
  }

  async getWalletConfig(line) {
    const { ctx } = this;
    const lineData = await ctx.model.ExecuteLine.findOne({ lineId: line });
    const executeWalletConfig = lineData.walletConfig;
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
    const balance = await connection.getBalance(lastBoss.publicKey);

    if (balance / LAMPORTS_PER_SOL < BOSS_MIN_AMOUNT) {
      throw new Error(`Boss balance is not enough`);
    }
    const boss = Keypair.generate();

    const newData = {
      eid: lastExecuteData.eid + 1,
      bossAddress: boss.publicKey.toBase58(),
      privateKey: bs58.encode(boss.secretKey),
      active: true,
      createTime: new Date(),
      line: lastExecuteData.line,
    };
    fs.writeFileSync(
      "keypair.json",
      JSON.stringify({
        bossAddress: boss.publicKey.toBase58(),
        privateKey: bs58.encode(boss.secretKey),
      })
    );
    console.log(newData);
    await ctx.model.ExecuteData.updateMany(
      { active: true, line: lastExecuteData.line },
      { active: false }
    );
    await ctx.model.ExecuteData.create(newData);
    // transfer
    await transferAllSol(connection, lastBoss, boss.publicKey);
  }

  /**
   * Step 2, generateWallets
   * 生成一批新的地址
   */
  async generateWallets(line) {
    const { ctx } = this;

    const executeData = await this.getExecuteData(line);

    const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
    const balance = await connection.getBalance(boss.publicKey);

    if (balance / LAMPORTS_PER_SOL < BOSS_MIN_AMOUNT) {
      throw new Error(`Boss balance is not enough`);
    }
    const walletConfig = await this.getWalletConfig(line);
    if (walletConfig && executeData) {
      const wallets = [];
      const amounts = [];
      if (executeData.walletsExist) {
        const walletData = await this.getWalletsWithBalance(line);
        walletData.forEach((item, index) => {
          if (item.balance === 0) {
            wallets.push(item.publicKey);
            amounts.push(walletConfig[index].transferAmount);
          }
        });
      } else {
        const dbData = walletConfig.map((item, index) => {
          const keypair = Keypair.generate();
          wallets.push(keypair.publicKey);
          amounts.push(walletConfig[index].transferAmount);
          return {
            wid: index + 1,
            address: keypair.publicKey.toBase58(),
            privateKey: bs58.encode(keypair.secretKey),
            eid: executeData.eid,
          };
        });
        fs.writeFileSync("keypair.json", JSON.stringify(dbData));
        const res = await ctx.model.ExecuteWallet.insertMany(dbData);
      }

      console.log(wallets, amounts);
      if (wallets.length === 0) {
        throw new Error("no wallet to transfer");
      }
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

  async transferSolToWallets(line) {
    const wallets = await this.getWallets(line);
    const executeData = await this.getExecuteData(line);
    const walletConfig = await this.getWalletConfig(line);

    if (wallets && executeData) {
      const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
      console.log(boss.publicKey.toBase58());
      const amounts = walletConfig.map((item) => item.transferAmount);
      const newWallets = wallets.map((item) => new PublicKey(item.address));
      await transferSol(connection, boss, newWallets, amounts);
    }
  }

  // Boss回收sol
  async recycleSol(line) {
    console.log(chalk.green("Ended：recycle"));
    const { ctx } = this;
    const wallets = await this.getWallets(line);
    const executeData = await this.getExecuteData(line);
    if (wallets && executeData) {
      for (const wallet of wallets) {
        const res = await closeAllTokenAccounts(connection, wallet.keypair);

        console.log(
          chalk.green("transfer sol", wallet.address, executeData.bossAddress)
        );
        await transferAllSol(
          connection,
          wallet.keypair,
          new PublicKey(executeData.bossAddress)
        );
      }
      return true;
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
  async buyToken(tid, type = "first") {
    const { ctx } = this;

    const tokenInfo = await ctx.model.ExecuteToken.findOne({ tid: tid });
    if (!tokenInfo) {
      throw new Error("Token  not checked");
    }
    if (tokenInfo.status === "pending") {
      if (type !== "first") {
        throw new Error("You should buy first");
      }
    }
    if (tokenInfo.status === "buy") {
      if (type === "first") {
        throw new Error("You have buy first...");
      }
    }

    if (tokenInfo.status === "end") {
      throw new Error("You have sell all,  Please check and start new Token");
    }

    const token = tokenInfo.token;
    const line = tokenInfo.line;
    console.log(chalk.green(`\nStep 3: Buying ${token}`));

    const wallets = await this.getWalletsWithConfig(line, type);
    if (wallets && wallets.length > 0 && token) {
      const res = await ctx.service.pumpAMM.batchBuyToken(token, wallets);
      if (type === "first") {
        await ctx.model.ExecuteToken.updateOne(
          { tid: tokenInfo.tid },
          { status: "buy" }
        );
      }
      return true;
    } else {
      throw new Error("There are not wallets to buy");
    }
  }

  // sell token
  async sellToken(tid, type = "all") {
    const { ctx } = this;
    const tokenInfo = await ctx.model.ExecuteToken.findOne({ tid: tid });
    if (!tokenInfo) {
      throw new Error("Token  not checked");
    }
    const token = tokenInfo.token;
    const line = tokenInfo.line;
    console.log(chalk.green(`Step 4: Selling ${token}, ${type}`));
    const wallets = await this.getWalletsWithConfig(line, type);
    if (wallets && wallets.length > 0 && token) {
      const res = await ctx.service.pumpAMM.batchSellToken(token, wallets);
      if (type === "all") {
        await ctx.model.ExecuteToken.updateOne(
          { tid: tokenInfo.tid },
          { status: "sell" }
        );
      }
      return true;
    } else {
      throw new Error("There are not wallets to sell");
    }
  }

  /**
   * get keypair from db
   */
  async getWallets(line) {
    const { ctx } = this;
    const executeData = await this.getExecuteData(line);
    if (executeData) {
      const dbData = await ctx.model.ExecuteWallet.find({
        eid: executeData.eid,
      });
      if (dbData && dbData.length > 0) {
        const wallets = dbData.map((wallet, index) => ({
          address: wallet.address,
          publicKey: new PublicKey(wallet.address),
          keypair: Keypair.fromSecretKey(bs58.decode(wallet.privateKey)),
        }));
        return wallets;
      } else {
        return [];
      }
    } else {
      throw new Error("wallets data error");
    }
  }

  async getWalletsWithConfig(line, type) {
    const wallets = await this.getWallets(line);
    const walletConfigs = await this.getWalletConfig(line);
    const data = wallets.map((wallet, index) => {
      const buyAmountArr = walletConfigs[index].buyAmount;
      const buyAmount =
        buyAmountArr[Math.floor(Math.random() * buyAmountArr.length)];
      return {
        ...wallet,
        ...walletConfigs[index],
        buyAmount: buyAmount,
        buyAmountArr,
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

  async getBossWithBalance(line) {
    const { ctx } = this;
    const executeData = await this.getExecuteData(line);
    const bossBalance = await connection.getBalance(
      new PublicKey(executeData.bossAddress)
    );

    return {
      address: executeData.bossAddress,
      balance: bossBalance / LAMPORTS_PER_SOL,
      createTime: executeData.createTime,
    };
  }

  async getWalletsWithBalance(line, token) {
    const { ctx } = this;
    const wallets = await this.getWalletsWithConfig(line);
    const data = [];
    console.log(line, token);
    for (const wallet of wallets) {
      const balance = await connection.getBalance(wallet.publicKey);
      let tokenBalance = 0;
      if (token) {
        tokenBalance = await getSPLBalance(
          connection,
          new PublicKey(token),
          wallet.publicKey
        );
      }
      const { privateKey, keypair, ...other } = wallet;
      data.push({
        balance: balance / LAMPORTS_PER_SOL,
        tokenBalance,
        ...other,
      });
    }

    return data;
  }

  async checkToken(token, eid) {
    const { ctx } = this;

    if (!isValidSolanaAddress(token)) {
      throw new Error("Valid solana address");
      return;
    }

    const tokenInfo = await ctx.service.ave.getTokenInfo(token);
    console.log(tokenInfo);

    if (tokenInfo) {
      const executeData = await ctx.model.ExecuteData.findOne({ eid: eid });

      const { token, dev, pool, symbol } = tokenInfo;
      const tokenDb = await ctx.model.ExecuteToken.findOne({
        token: token,
        status: "pending",
      });
      let tid = new Date().getTime();
      if (!tokenDb) {
        await ctx.model.ExecuteToken.create({
          tid: tid,
          token,
          dev,
          pool,
          symbol,
          createTime: new Date(),
          eid: executeData.eid,
          line: executeData.line,
          status: "pending",
        });
      } else {
        tid = tokenDb.tid;
      }
      const buyTimes = await ctx.model.ExecuteToken.count({
        token: token,
        status: "end",
      });
      return { ...tokenInfo, buyTimes, tid };
    } else {
      throw new Error("Can not find token info");
    }
  }

  async closeAllAccounts(line) {
    const wallets = await this.getWallets(line);
    if (wallets) {
      for (const wallet of wallets) {
        const res = await closeAllTokenAccounts(connection, wallet.keypair);
      }
      return true;
    } else {
      console.log(chalk.yellow("No wallet."));
    }
  }
}

module.exports = ExecuteSwap;
