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
const { initSdk } = require("../constants/raydium");

const {
  getSPLBalance,
  closeAllTokenAccounts,
  transferAllSol,
  transferSol,
  isValidSolanaAddress,
  getTokenMeta,
} = require("../utils/solana");

const { getPoolsWithPrices, getPoolsWithBaseMint } = require("../libs/pool");
const { sleep, retryAsync } = require("../utils/utils");
const { getRaydiumCpmmPoolId } = require("../utils/raydium");

const BOSS_MIN_AMOUNT = 0;

const PUMP_AMM_NAME = "pumpfunamm";
const PUMP_FUN_NAME = "pump";

const RAYDIUM_CPMM_NAME = "raydiumcpmm";
const RAYDIUM_LANUCH_NAME = "raydiumlaunchlab";
const AFTER_WALLET_DELAY_MS = Number(process.env.AFTER_WALLET_DELAY_MS || 0);

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

  async end(line, force = false) {
    // await this.transferSolToWallets(line);
    await this.recycleSol(line, force);
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
      }),
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
      bs58.decode(lastExecuteData.privateKey),
    );
    const balance = await connection.getBalance(lastBoss.publicKey);
    const bossMinAmount = BOSS_MIN_AMOUNT;
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
      }),
    );
    await ctx.model.ExecuteData.updateMany(
      { active: true, line: lastExecuteData.line },
      { active: false },
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

    const bossMinAmount = BOSS_MIN_AMOUNT;
    if (balance / LAMPORTS_PER_SOL < bossMinAmount) {
      throw new Error(`Boss balance is not enough`);
    }
    const walletConfig = await this.getWalletConfig(line);
    if (walletConfig && executeData) {
      const wallets = [];
      const amounts = [];
      if (executeData.walletsExist) {
        const walletData = await this.getWallets(line);
        for (let index = 0; index < walletData.length; index++) {
          const item = walletData[index];
          const config = walletConfig[index];
          if (!config) {
            throw new Error(`walletConfig missing for wallet index ${index}`);
          }
          const balance = await connection.getBalance(item.publicKey);
          if (balance === 0) {
            wallets.push(item.publicKey);
            amounts.push(config.transferAmount);
          }
        }
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
        { walletsExist: true },
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
  async recycleSol(line, force = false) {
    console.log(chalk.green("Ended：recycle"));
    const { ctx } = this;
    const wallets = await this.getWallets(line, true);
    const executeData = await this.getExecuteData(line);

    if (wallets && executeData) {
      const fun = async (wallet) => {
        const res = await closeAllTokenAccounts(connection, wallet.keypair, force);

        console.log(
          chalk.green("transfer sol", wallet.address, executeData.bossAddress),
        );
        await transferAllSol(
          connection,
          wallet.keypair,
          new PublicKey(executeData.bossAddress),
        );
      };

      for (const wallet of wallets) {
        await fun(wallet);
      }

      // const res = await Promise.all(arr);
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

    const configWallets = await this.getWalletsWithLineFirstWallet(line, type);
    const wallets = [];
    configWallets.forEach((wallet) => {
      const { buyTimes = 1 } = wallet;
      for (let index = 0; index < buyTimes; index++) {
        wallets.push(wallet);
      }
    });
    if (wallets && wallets.length > 0 && token) {
      await this.batchBuyTokenByAmm(tokenInfo.amm, token, wallets, type);

      await ctx.model.ExecuteToken.updateOne(
        { tid: tokenInfo.tid },
        { status: "buy", buyStatus: type, buyStartTime: new Date() },
      );
      return true;
    } else {
      throw new Error("There are not wallets to buy");
    }
  }

  async dispatchBatchBuyToken(amm, token, wallets, type, sendOptions = {}) {
    const { ctx } = this;
    if (!wallets || wallets.length === 0) {
      return true;
    }

    if (amm === RAYDIUM_CPMM_NAME) {
      await ctx.service.raydiumCpmm.batchBuyToken(token, wallets, type);
    } else if (amm === RAYDIUM_LANUCH_NAME) {
      await ctx.service.raydiumLaunch.batchBuyToken(token, wallets, type);
    } else if (amm === PUMP_AMM_NAME) {
      await ctx.service.pumpAMM.batchBuyToken(
        token,
        wallets,
        type,
        sendOptions,
      );
    } else if (amm === PUMP_FUN_NAME) {
      await ctx.service.pumpfun.batchBuyToken(token, wallets, type);
    } else {
      throw new Error("Not pump token");
    }
    return true;
  }

  getWalletBuyType(wallet) {
    if (wallet.firstBuy) return "first";
    if (wallet.multiBuy) return "multi";
    if (wallet.secondBuy) return "second";
    if (wallet.thirdBuy) return "third";
    return "";
  }

  isStandaloneFirstWalletBuy(wallet) {
    return wallet.isFirstWallet && wallet.isBundle === false;
  }

  async waitForNextSlot(label = "after wallet") {
    const startSlot = await connection.getSlot("processed");
    let currentSlot = startSlot;
    while (currentSlot <= startSlot) {
      await sleep(0.05);
      currentSlot = await connection.getSlot("processed");
    }
    console.log(chalk.green(`${label}: slot ${startSlot} -> ${currentSlot}`));
    return currentSlot;
  }

  async dispatchStandaloneWallets(amm, token, wallets, type, sendOptions = {}) {
    for (const wallet of wallets) {
      await this.dispatchBatchBuyToken(amm, token, [wallet], type, sendOptions);
      if (sendOptions.sleepAfter !== false) {
        await sleep(0.5);
      }
    }
  }

  async dispatchAfterWalletsNextSlot(
    amm,
    token,
    bundledWallets,
    afterWallets,
    type,
  ) {
    const hasAfterWallets = afterWallets.length > 0;
    await this.dispatchBatchBuyToken(amm, token, bundledWallets, type, {
      waitForAnyLanding: hasAfterWallets,
      waitForLanding: true,
    });
    if (
      hasAfterWallets &&
      bundledWallets.length > 0 &&
      AFTER_WALLET_DELAY_MS > 0
    ) {
      console.log(
        chalk.green(
          `${type} after wallet: delay ${AFTER_WALLET_DELAY_MS}ms after first main tx landed`,
        ),
      );
      await sleep(AFTER_WALLET_DELAY_MS / 1000);
    }
    await this.dispatchStandaloneWallets(amm, token, afterWallets, type, {
      skipPreflight: true,
      sleepAfter: false,
      waitForLanding: false,
    });
  }

  async batchBuyTokenByAmm(amm, token, wallets, type) {
    const standaloneWallets = wallets.filter((wallet) =>
      this.isStandaloneFirstWalletBuy(wallet),
    );
    if (standaloneWallets.length === 0) {
      return this.dispatchBatchBuyToken(amm, token, wallets, type);
    }

    if (type !== "all") {
      const bundledWallets = wallets.filter(
        (wallet) => !this.isStandaloneFirstWalletBuy(wallet),
      );
      const beforeWallets = standaloneWallets.filter(
        (wallet) => wallet.position !== "after",
      );
      const afterWallets = standaloneWallets.filter(
        (wallet) => wallet.position === "after",
      );

      await this.dispatchStandaloneWallets(amm, token, beforeWallets, type);
      await this.dispatchAfterWalletsNextSlot(
        amm,
        token,
        bundledWallets,
        afterWallets,
        type,
      );
      return true;
    }

    const stageTypes = ["first", "multi", "second", "third"];
    for (const stageType of stageTypes) {
      const stageWallets = wallets.filter(
        (wallet) => this.getWalletBuyType(wallet) === stageType,
      );
      if (stageWallets.length === 0) {
        continue;
      }

      const beforeWallets = stageWallets.filter(
        (wallet) =>
          this.isStandaloneFirstWalletBuy(wallet) &&
          wallet.position !== "after",
      );
      const bundledWallets = stageWallets.filter(
        (wallet) => !this.isStandaloneFirstWalletBuy(wallet),
      );
      const afterWallets = stageWallets.filter(
        (wallet) =>
          this.isStandaloneFirstWalletBuy(wallet) &&
          wallet.position === "after",
      );

      await this.dispatchStandaloneWallets(
        amm,
        token,
        beforeWallets,
        stageType,
      );
      await this.dispatchAfterWalletsNextSlot(
        amm,
        token,
        bundledWallets,
        afterWallets,
        stageType,
      );
      await sleep(0.5);
    }

    return true;
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
    const wallets = await this.getWalletsWithLineFirstWallet(line, type);
    if (wallets && wallets.length > 0 && token) {
      if (tokenInfo.amm === RAYDIUM_CPMM_NAME) {
        await ctx.service.raydiumCpmm.batchSellToken(token, wallets, type);
      } else if (tokenInfo.amm === RAYDIUM_LANUCH_NAME) {
        await ctx.service.raydiumLaunch.batchSellToken(token, wallets, type);
      } else if (tokenInfo.amm === PUMP_AMM_NAME) {
        await ctx.service.pumpAMM.batchSellToken(token, wallets, type);
      } else if (tokenInfo.amm === PUMP_FUN_NAME) {
        await ctx.service.pumpfun.batchSellToken(token, wallets, type);
      } else {
        throw new Error("Not pump token");
      }
      if (type === "all") {
        await ctx.model.ExecuteToken.updateOne(
          { tid: tokenInfo.tid },
          { status: "sell" },
        );
      }
      return true;
    } else {
      throw new Error("There are not wallets to sell");
    }
  }

  async buyTokenByWallet(tid, walletAddress) {
    const { ctx } = this;
    const tokenInfo = await ctx.model.ExecuteToken.findOne({ tid: tid });
    if (!tokenInfo) {
      throw new Error("Token  not checked");
    }
    const token = tokenInfo.token;
    console.log(chalk.green(`Step 3: Buy ${token}, ${walletAddress} `));
    const wallets = await this.getWalletsWithConfig(tokenInfo.line);
    const wallet = wallets.find(
      (item) => item.publicKey.toBase58() === walletAddress,
    );
    if (wallet) {
      const wallets = [wallet];
      if (tokenInfo.amm === RAYDIUM_CPMM_NAME) {
        const res = await ctx.service.raydiumCpmm.batchBuyToken(token, wallets);
      } else if (tokenInfo.amm === PUMP_AMM_NAME) {
        const res = await ctx.service.pumpAMM.batchBuyToken(token, wallets);
      } else if (tokenInfo.amm === PUMP_FUN_NAME) {
        const res = await ctx.service.pumpfun.batchBuyToken(token, wallets);
      } else {
        throw new Error("Not amm");
      }
      return true;
    } else {
      throw new Error("There are not wallets to buy");
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
      (item) => item.publicKey.toBase58() === walletAddress,
    );
    if (wallet) {
      const wallets = [wallet];
      if (tokenInfo.amm === RAYDIUM_CPMM_NAME) {
        const res = await ctx.service.raydiumCpmm.batchSellToken(
          token,
          wallets,
        );
      } else if (tokenInfo.amm === PUMP_AMM_NAME) {
        const res = await ctx.service.pumpAMM.batchSellToken(token, wallets);
      } else if (tokenInfo.amm === PUMP_FUN_NAME) {
        const res = await ctx.service.pumpfun.batchSellToken(token, wallets);
      } else {
        throw new Error("Not amm");
      }
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

  getBuyStageConfig(config, type = "all") {
    const keyMap = {
      first: "firstBuy",
      second: "secondBuy",
      third: "thirdBuy",
      multi: "multiBuy",
    };
    const stageKey = keyMap[type];
    const stageConfig = stageKey ? config[stageKey] : null;
    const buyAmountArr = Array.isArray(config.buyAmount)
      ? config.buyAmount
      : [config.buyAmount];
    const indexMap = {
      first: 0,
      second: 1,
      third: 2,
      multi: 0,
    };
    const defaultBuyAmount =
      buyAmountArr[indexMap[type] ?? 0] ?? buyAmountArr[0];
    const stageFlags = {
      firstBuy: false,
      secondBuy: false,
      thirdBuy: false,
      multiBuy: false,
    };
    if (stageKey) {
      stageFlags[stageKey] = true;
    }

    if (stageConfig && typeof stageConfig === "object") {
      const { enable = false, ...stageOverrides } = stageConfig;
      return {
        enable,
        config: {
          ...config,
          ...stageFlags,
          ...stageOverrides,
          buyAmount: stageOverrides.buyAmount ?? defaultBuyAmount,
          buyAmountArr,
          [stageKey]: enable,
        },
      };
    }

    return {
      enable: type === "all" || stageConfig === true,
      config: {
        ...config,
        ...stageFlags,
        buyAmount: defaultBuyAmount,
        buyAmountArr,
      },
    };
  }
  /**
   * get keypair from db
   */
  async getWallets(line, isAll = false) {
    const { ctx } = this;
    const executeData = await this.getExecuteData(line);
    if (executeData) {
      let filter = {
        eid: executeData.eid,
      };
      if (!isAll) {
        filter = { ...filter, isActive: true };
      }
      const dbData = await ctx.model.ExecuteWallet.find(filter);
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

  async getWalletsWithConfig(line, type = "all") {
    console.log(chalk.green("getWalletsWithConfig:", line, type));
    const wallets = await this.getWallets(line);
    const walletConfigs = await this.getWalletConfig(line);
    const data = walletConfigs.flatMap((config, index) => {
      const wallet = wallets[index];
      if (type === "all") {
        return ["first", "second", "third", "multi"]
          .map((stageType) => this.getBuyStageConfig(config, stageType))
          .filter((stage) => stage.enable)
          .map((stage) => ({
            ...wallet,
            ...stage.config,
            stageEnable: true,
          }));
      }
      const stage = this.getBuyStageConfig(config, type);
      return [
        {
          ...wallet,
          ...stage.config,
          stageEnable: stage.enable,
        },
      ];
    });

    let newWallets = data.filter((wallet) => wallet.stageEnable);
    return newWallets;
  }

  async getWalletsWithLineFirstWallet(line, type = "all") {
    let newWallets = await this.getWalletsWithConfig(line, type);
    const lineData = await this.ctx.model.ExecuteLine.findOne({
      lineId: line,
    }).lean();
    const { firstWallet, needFirstWallet } = lineData;
    if (firstWallet && needFirstWallet) {
      const normalizeBuyType = (value = "first") => {
        const normalized = String(value).toLowerCase();
        const typeMap = {
          first: "first",
          firstbuy: "first",
          second: "second",
          secondbuy: "second",
          third: "third",
          thirdbuy: "third",
          multi: "multi",
          multibuy: "multi",
        };
        return typeMap[normalized] || normalized;
      };
      const firstType = normalizeBuyType(firstWallet.type);
      const typeKey = `${firstType}Buy`;
      if (type === firstType || type === "all") {
        const keypair = Keypair.fromSecretKey(
          bs58.decode(firstWallet.privateKey),
        );
        const { privateKey, ...config } = firstWallet;
        const firstWalletConfig = {
          address: firstWallet.address,
          publicKey: new PublicKey(firstWallet.address),
          buyAmount: firstWallet.buyAmount,
          buyAmountArr: [firstWallet.buyAmount],
          keypair,
          limit: 2000000,
          price: 0,
          fee: 0.00002,
          ...config,
          isFirstWallet: true,
          isBundle: firstWallet.isBundle !== false,
        };
        firstWalletConfig[typeKey] = true;
        if (firstWallet.position === "after") {
          if (type === "all") {
            const insertIndex =
              newWallets.findLastIndex((wallet) => wallet[typeKey]) + 1;
            newWallets = [
              ...newWallets.slice(0, insertIndex),
              firstWalletConfig,
              ...newWallets.slice(insertIndex),
            ];
          } else {
            newWallets = [...newWallets, firstWalletConfig];
          }
        } else {
          newWallets = [firstWalletConfig, ...newWallets];
        }
      }
    }
    return newWallets;
  }

  async getBossWithBalance(line) {
    const { ctx } = this;
    const executeData = await this.getExecuteData(line);
    const bossBalance = await connection.getBalance(
      new PublicKey(executeData.bossAddress),
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

  getWalletBalanceBuyAmount(config = {}) {
    const amounts = [];
    const addAmount = (value) => {
      if (typeof value === "number") {
        amounts.push(value);
      }
    };

    if (Array.isArray(config.buyAmount)) {
      config.buyAmount.forEach(addAmount);
    } else {
      addAmount(config.buyAmount);
    }

    ["firstBuy", "secondBuy", "thirdBuy", "multiBuy"].forEach((key) => {
      const stageConfig = config[key];
      if (stageConfig && typeof stageConfig === "object") {
        addAmount(stageConfig.buyAmount);
      }
    });

    return amounts.length ? Math.max(...amounts) : 0;
  }
  async getWalletsWithBalance(line) {
    const wallets = await this.getWallets(line);
    const walletConfigs = await this.getWalletConfig(line);
    const seenAddresses = new Set();

    const uniqueWallets = wallets.filter((wallet) => {
      if (seenAddresses.has(wallet.address)) {
        return false;
      }
      seenAddresses.add(wallet.address);
      return true;
    });

    const getWalletBalance = async (wallet, index) => {
      if (!wallet.publicKey) {
        throw new Error("Cannot find wallets");
      }

      const rawConfig = walletConfigs[index] || {};
      const { stageEnable, ...config } = rawConfig;
      const balance = await connection.getBalance(wallet.publicKey);
      const { privateKey, keypair, ...other } = wallet;

      return {
        ...other,
        ...config,
        buyAmount: this.getWalletBalanceBuyAmount(config),
        buyAmountArr: Array.isArray(config.buyAmount)
          ? config.buyAmount.filter((item) => typeof item === "number")
          : [config.buyAmount].filter((item) => typeof item === "number"),
        balance: balance / LAMPORTS_PER_SOL,
      };
    };

    const arr = uniqueWallets.map((wallet, index) =>
      getWalletBalance(wallet, index),
    );
    return Promise.all(arr);
  }

  async checkToken(tokenData, eid, forceCheck = false) {
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
        },
      );
    }
    const executeData = await ctx.model.ExecuteData.findOne({ eid: eid });

    if (!forceCheck) {
      const otherData = await ctx.model.ExecuteToken.findOne({
        eid: { $ne: eid },
        token: token,
        status: "buy",
      });
      if (otherData) {
        throw new Error("Other buy this token");
      }
      const lineBotAccounts = await this.getLineBotTokenBalance(
        executeData.line,
        token,
      );
      if (lineBotAccounts.total > 1000) {
        throw new Error("Bot has to many token");
      }
    }

    let symbol = tokenData.symbol;
    if (!symbol) {
      const metaData = await ctx.service.ave.getTokenInfo(token);
      symbol = metaData.symbol;
    }

    let amm = tokenData.amm;
    let dev, pool;
    if (tokenData.pool && amm) {
      dev = "";
      pool = tokenData.pool;
    } else {
      const oldData = await ctx.model.ExecuteToken.findOne({
        token: token,
      });
      if (oldData) {
        dev = "";
        pool = oldData.pool;
        amm = oldData.amm;
      } else {
        let poolDetail;
        try {
          poolDetail = await getPoolsWithPrices(new PublicKey(token), ctx);
        } catch (error) {
          // throw new Error(error);
        }
        if (poolDetail) {
          amm = PUMP_AMM_NAME;
          dev = poolDetail.poolData.coinCreator;
          pool = poolDetail.address;
        } else {
          const poolId = await getRaydiumCpmmPoolId(new PublicKey(token));
          if (poolId) {
            pool = poolId.toBase58();
            dev = "";
            amm = RAYDIUM_CPMM_NAME;
          } else {
            const poolDetail = await ctx.service.pumpfun.getPoolDetail(token);
            if (poolDetail) {
              amm = PUMP_FUN_NAME;
              dev = poolDetail.dev;
              pool = "";
            } else {
              throw new Error("Cannot find pool data");
            }
          }
        }
      }
    }

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
      amm,
      createTime: new Date(),
      eid: executeData.eid,
      line: executeData.line,
      status: "pending",
    };

    const followStates = await ctx.service.ave.getFollowAggregateStates(token);
    if (Number(followStates.all || 0) <= 0) {
      const reserveToken = await ctx.model.ReserveToken.findOne({
        token: tokenInfo.token,
        line: tokenInfo.line,
      });
      if (!reserveToken) {
        await ctx.model.ReserveToken.create({
          ...tokenInfo,
          tid: tokenDb?.tid || tokenInfo.tid,
          type: "bad",
        });
      } else {
        await ctx.model.ReserveToken.updateOne(
          {
            token: tokenInfo.token,
            line: tokenInfo.line,
          },
          { type: "bad" },
        );
      }
      throw new Error("\u6ca1\u6709\u5173\u6ce8\u5730\u5740");
    }

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

  async closeAllAccounts(line, force = false) {
    const { ctx } = this;
    const wallets = await this.getWallets(line, true);
    if (wallets && wallets.length > 0) {
      for (const wallet of wallets) {
        await closeAllTokenAccounts(connection, wallet.keypair, force);
        await sleep(1);
      }
      return true;
    } else {
      console.log(chalk.yellow("No wallet."));
    }
  }

  async withdraw(line, amount) {
    const { ctx } = this;
    const executeData = await this.getExecuteData(line);
    const lineData = await ctx.model.ExecuteLine.findOne({ lineId: line });
    console.log(chalk.green("withdraw", amount));
    if (lineData.withdrawAddress) {
      const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
      if (amount) {
        await transferSol(
          connection,
          boss,
          [new PublicKey(lineData.withdrawAddress)],
          [amount],
        );
      } else {
        await transferAllSol(
          connection,
          boss,
          new PublicKey(lineData.withdrawAddress),
        );
      }

      return true;
    } else {
      throw new Error("To address not exist");
    }
  }

  async getLineBotTokenBalance(line, token) {
    const { ctx } = this;
    const lineData = await ctx.model.ExecuteLine.findOne({
      lineId: line,
    }).lean();
    const defaultBots = [
      {
        address: "56S29mZ3wqvw8hATuUUFqKhGcSGYFASRRFNT38W8q7G3",
        name: "L1秒进",
      },
      {
        address: "8qvNUZf5p4Q15WNc64xZ5cLrLZU1ZDecKVpSDBkU3vbz",
        name: "L1 slow",
      },
      {
        address: "8J5GUAf7hr3LTPHJSkwrKFDNJPtAXtLHhnNHq6XxTLrW",
        name: "L1慢old",
      },
    ];
    const { lineBots = defaultBots } = lineData;
    if (lineBots.length > 0) {
      let list = lineBots.map((item) => ({ ...item, tokenBalance: 0 }));
      let total = 0;
      const fun = async (lineBot) => {
        const tokenBalance = await getSPLBalance(
          connection,
          new PublicKey(token),
          new PublicKey(lineBot.address),
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
        { eid: eid, isActive: true },
        { address: 1 },
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
            new PublicKey(wallet.address),
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

  async nextWallet(line) {
    const { ctx } = this;
    const wallets = await this.getWallets(line);
    const executeData = await this.getExecuteData(line);
    const oldAddress = [];
    const newAddress = [];
    const fun = async (wallet) => {
      // await closeAllTokenAccounts(connection, wallet.keypair);
      // await sleep(1);
      const keypair = Keypair.generate();
      const newWalletData = {
        address: keypair.publicKey.toBase58(),
        privateKey: bs58.encode(keypair.secretKey),
        eid: executeData.eid,
        active: false,
      };
      await ctx.model.ExecuteWallet.create(newWalletData);
      await retryAsync(async () => {
        await transferAllSol(
          connection,
          wallet.keypair,
          keypair.publicKey,
          0.01,
        );
      });
      oldAddress.push(wallet.address);
      newAddress.push(keypair.publicKey.toBase58());
    };

    for (const wallet of wallets) {
      await fun(wallet);
    }

    await ctx.model.ExecuteWallet.updateMany(
      { address: { $in: newAddress } },
      { isActive: true },
    );
    await ctx.model.ExecuteWallet.updateMany(
      { address: { $in: oldAddress } },
      { isActive: false },
    );
    return true;
  }
}

module.exports = ExecuteSwap;



