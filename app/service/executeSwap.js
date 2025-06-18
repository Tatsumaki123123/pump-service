const { Service } = require("egg");
const chalk = require("chalk");
const fs = require("fs");

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
  getTokenMeta,
} = require("../utils/solana");

const { getPoolsWithPrices } = require("../libs/pool");

const BOSS_MIN_AMOUNT = 2.8;

class ExecuteSwap extends Service {
  constructor(props) {
    super(props);
  }

  async start(line) {
    const lastExecuteData = await this.getExecuteData(line);
    if (!lastExecuteData) {
      const res = this.generateNewBoss(line);
      return res;
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

  async generateNewBoss(line) {
    const { ctx } = this;
    const boss = Keypair.generate();

    const newData = {
      eid: line * 1000,
      bossAddress: boss.publicKey.toBase58(),
      privateKey: bs58.encode(boss.secretKey),
      active: true,
      createTime: new Date(),
      line: line,
    };

    fs.writeFileSync(
      "keypair.json",
      JSON.stringify({
        bossAddress: boss.publicKey.toBase58(),
        privateKey: bs58.encode(boss.secretKey),
      })
    );
    await ctx.model.ExecuteData.create(newData);
    return true;
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
    const bossMinAmount =
      lastExecuteData.line === 10000 ? 0.3 : BOSS_MIN_AMOUNT;
    if (balance / LAMPORTS_PER_SOL < bossMinAmount) {
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

    const isTest = line === 10000;

    const bossMinAmount = isTest ? 0.3 : BOSS_MIN_AMOUNT;
    if (balance / LAMPORTS_PER_SOL < bossMinAmount) {
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
      const fun = async (wallet) => {
        const res = await closeAllTokenAccounts(connection, wallet.keypair);

        console.log(
          chalk.green("transfer sol", wallet.address, executeData.bossAddress)
        );
        await transferAllSol(
          connection,
          wallet.keypair,
          new PublicKey(executeData.bossAddress)
        );
      };
      const arr = wallets.map((wallet) => fun(wallet));

      const res = await Promise.all(arr);
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

    if (tokenInfo.status === "end") {
      throw new Error("You have sell all,  Please check and start new Token");
    }

    const token = tokenInfo.token;
    const line = tokenInfo.line;
    console.log(chalk.green(`\nStep 3: Buying ${token}`));

    const wallets = await this.getWalletsWithConfig(line, type);
    if (wallets && wallets.length > 0 && token) {
      const res = await ctx.service.pumpAMM.batchBuyToken(token, wallets);

      await ctx.model.ExecuteToken.updateOne(
        { tid: tokenInfo.tid },
        { status: "buy", buyStatus: type, buyStartTime: new Date() }
      );
      return true;
    } else {
      throw new Error("There are not wallets to buy");
    }
  }

  async buyTokenArr(tid, types) {
    for (const type of types) {
      await this.buyToken(tid, type);
    }
    return true;
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

  async sellTokenByWallet(tid, walletAddress) {
    const { ctx } = this;
    const tokenInfo = await ctx.model.ExecuteToken.findOne({ tid: tid });
    if (!tokenInfo) {
      throw new Error("Token  not checked");
    }
    const token = tokenInfo.token;
    console.log(chalk.green(`Step 4: Selling ${token}, `));
    const wallets = await this.getWalletsWithConfig(tokenInfo.line);
    const wallet = wallets.find(
      (item) => item.publicKey.toBase58() === walletAddress
    );
    if (wallet) {
      const wallets = [wallet];
      const res = await ctx.service.pumpAMM.batchSellToken(token, wallets);
      return true;
    } else {
      throw new Error("There are not wallets to sell");
    }
  }

  async sellTokenArr(tid, types) {
    for (const type of types) {
      await this.sellToken(tid, type);
    }
    return true;
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
    console.log(chalk.green("getWalletsWithConfig:", line, type));
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
      } else if (type === "third") {
        return wallet.thirdBuy === true;
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

    const tokenCount = await ctx.model.ExecuteToken.count({
      eid: executeData.eid,
    });

    return {
      address: executeData.bossAddress,
      balance: bossBalance / LAMPORTS_PER_SOL,
      createTime: executeData.createTime,
      eid: executeData.eid,
      tokenCount: tokenCount,
      line: executeData.line,
    };
  }

  async getWalletsWithBalance(line, token) {
    const { ctx } = this;
    const wallets = await this.getWalletsWithConfig(line);

    const getWalletBalance = async (wallet) => {
      const balance = await connection.getBalance(wallet.publicKey);

      const { privateKey, keypair, ...other } = wallet;
      return {
        balance: balance / LAMPORTS_PER_SOL,
        ...other,
      };
    };

    const arr = wallets.map((wallet) => getWalletBalance(wallet));
    const data = await Promise.all(arr);

    return data;
  }

  async checkToken(tokenData, eid) {
    console.log(chalk.green("checkToken"));
    const { ctx } = this;
    const { token } = tokenData;

    if (!isValidSolanaAddress(token)) {
      throw new Error("Valid solana address");
      return;
    }

    const sellData = await ctx.model.ExecuteToken.findOne({
      eid: eid,
      token: token,
      status: "sell",
    });
    if (sellData) {
      await ctx.model.ExecuteToken.updateOne(
        { tid: sellData.tid },
        {
          status: "buy",
        }
      );
    }

    const otherData = await ctx.model.ExecuteToken.findOne({
      eid: { $ne: eid },
      token: token,
      status: "buy",
    });
    if (otherData) {
      throw new Error("Other buy this token");
    }

    const executeData = await ctx.model.ExecuteData.findOne({ eid: eid });

    const lineBotAccounts = await this.getLineBotTokenBalance(
      executeData.line,
      token
    );
    if (lineBotAccounts.total > 1000) {
      throw new Error("Bot has to many token");
    }

    const poolDetail = await getPoolsWithPrices(new PublicKey(token));

    if (!poolDetail) {
      throw new Error("Cannot find pool data");
    }

    let symbol = tokenData.symbol;
    if (!symbol) {
      const metaData = await ctx.service.debot.getTokenInfo(token);
      symbol = metaData.symbol;
    }

    const dev = poolDetail.poolData.coinCreator;
    const pool = poolDetail.address;
    const tokenDb = await ctx.model.ExecuteToken.findOne({
      eid: eid,
      token: token,
      status: { $in: ["pending", "buy"] },
    });
    let tid = new Date().getTime();
    const tokenInfo = {
      tid: tid,
      symbol: symbol,
      token,
      dev,
      pool,
      createTime: new Date(),
      eid: executeData.eid,
      line: executeData.line,
      status: "pending",
    };
    if (!tokenDb) {
      await ctx.model.ExecuteToken.create(tokenInfo);
    } else {
      tid = tokenDb.tid;
    }
    const buyTimes = await ctx.model.ExecuteToken.count({
      token: token,
      status: "end",
    });
    return { ...tokenInfo, buyTimes, tid };
  }

  async closeAllAccounts(line) {
    const { ctx } = this;
    const wallets = await this.getWallets(line);
    if (wallets && wallets.length > 0) {
      for (const wallet of wallets) {
        await closeAllTokenAccounts(connection, wallet.keypair);
      }
      return true;
    } else {
      console.log(chalk.yellow("No wallet."));
    }
  }

  async withdraw(line) {
    const { ctx } = this;
    const executeData = await this.getExecuteData(line);
    const lineData = await ctx.model.ExecuteLine.findOne({ lineId: line });
    if (lineData.withdrawAddress) {
      const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
      await transferAllSol(
        connection,
        boss,
        new PublicKey(lineData.withdrawAddress)
      );
      return true;
    } else {
      throw new Error("To address not exist");
    }
  }

  async getLineBotTokenBalance(line, token) {
    const { ctx } = this;
    const lineBots = [
      {
        address: "56S29mZ3wqvw8hATuUUFqKhGcSGYFASRRFNT38W8q7G3",
        name: "L1秒进",
      },
      {
        address: "FdDeJeoaZpUjABTcFF1NrByLeBuqgHQ454Ag7kKbPxW4",
        name: "L1慢1-2",
      },
      {
        address: "8qvNUZf5p4Q15WNc64xZ5cLrLZU1ZDecKVpSDBkU3vbz",
        name: "L1最慢",
      },
      {
        address: "8J5GUAf7hr3LTPHJSkwrKFDNJPtAXtLHhnNHq6XxTLrW",
        name: "L1慢old",
      },
      { address: "A8QTd66meFihdau6Ex1fVGbXTzFkGkaNm7KfNCUGiArm", name: "反L1" },
    ];
    if (lineBots.length > 0) {
      let list = lineBots.map((item) => ({ ...item, tokenBalance: 0 }));
      let total = 0;
      const fun = async (lineBot) => {
        const tokenBalance = await getSPLBalance(
          connection,
          new PublicKey(token),
          new PublicKey(lineBot.address)
        );

        return {
          name: lineBot.name,
          address: lineBot.address,
          tokenBalance: tokenBalance,
        };
      };

      const arr = lineBots.map((lineBot) => fun(lineBot));
      list = await Promise.all(arr);
      list.forEach((item) => {
        total += item.tokenBalance;
      });
      return { total: total, list: list };
    } else {
      throw new Error("getLineBotTokenBalance error");
    }
  }

  async getWalletTokenBalance(eid, token) {
    const { ctx } = this;
    if (eid && token) {
      const wallets = await ctx.model.ExecuteWallet.find(
        { eid: eid },
        { address: 1 }
      );
      let list = [];
      if (wallets && wallets.length > 0) {
        // for (const wallet of wallets) {
        // }
        list = wallets.map((item) => ({
          address: item.address,
          tokenBalance: 0,
        }));
        const fun = async (wallet) => {
          const tokenBalance = await getSPLBalance(
            connection,
            new PublicKey(token),
            new PublicKey(wallet.address)
          );
          return { address: wallet.address, tokenBalance: tokenBalance };
        };

        const arr = wallets.map((wallet) => fun(wallet));
        list = await Promise.all(arr);
      }
      return list;
    } else {
      throw new Error("getWalletTokenBalance error");
    }
  }
}

module.exports = ExecuteSwap;
