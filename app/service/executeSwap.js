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
  async sellToken(tid, type = "all", percent = 100) {
    const { ctx } = this;
    const tokenInfo = await ctx.model.ExecuteToken.findOne({ tid: tid });
    if (!tokenInfo) {
      throw new Error("Token  not checked");
    }
    const token = tokenInfo.token;
    const line = tokenInfo.line;
    const sellType = String(type).toLowerCase();
    const sellPercent = sellType === "all" ? 100 : percent;
    console.log(chalk.green(`Step 4: Selling ${token}, ${sellType}`));
    const wallets = await this.getWalletsWithSellConfig(
      line,
      sellType,
      sellPercent,
    );
    if (wallets && wallets.length > 0 && token) {
      if (tokenInfo.amm === RAYDIUM_CPMM_NAME) {
        await ctx.service.raydiumCpmm.batchSellToken(
          token,
          wallets,
          sellType,
          sellPercent,
        );
      } else if (tokenInfo.amm === RAYDIUM_LANUCH_NAME) {
        await ctx.service.raydiumLaunch.batchSellToken(
          token,
          wallets,
          sellType,
          sellPercent,
        );
      } else if (tokenInfo.amm === PUMP_AMM_NAME) {
        await ctx.service.pumpAMM.batchSellToken(
          token,
          wallets,
          sellType,
          sellPercent,
        );
      } else if (tokenInfo.amm === PUMP_FUN_NAME) {
        await ctx.service.pumpfun.batchSellToken(
          token,
          wallets,
          sellType,
          sellPercent,
        );
      } else {
        throw new Error("Not pump token");
      }
      if (sellType === "all") {
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

  async sellTokenByWallet(tid, walletAddress, percent = 100) {
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
        const res = await ctx.service.pumpAMM.batchSellToken(
          token,
          wallets,
          "",
          percent,
        );
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

  async sellTokenArr(tid, types, percent = 100) {
    for (const type of types) {
      await this.sellToken(tid, type, percent);
    }
    return true;
  }

  normalizeStageType(value = "first") {
    const normalized = String(value).toLowerCase();
    const typeMap = {
      first: "first",
      firstbuy: "first",
      firstsell: "first",
      second: "second",
      secondbuy: "second",
      secondsell: "second",
      third: "third",
      thirdbuy: "third",
      thirdsell: "third",
      multi: "multi",
      multibuy: "multi",
      multisell: "multi",
    };
    return typeMap[normalized] || normalized;
  }

  getStageKey(type, action) {
    const stageType = this.normalizeStageType(type);
    const keyMap = {
      first: `first${action}`,
      second: `second${action}`,
      third: `third${action}`,
      multi: `multi${action}`,
    };
    return keyMap[stageType];
  }

  normalizeSellRatio(value, defaultRatio = 1) {
    const rawRatio =
      typeof value === "undefined" || value === null ? defaultRatio : value;
    const ratio = Number(rawRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      throw new Error("sellRatio must be greater than 0");
    }
    if (ratio <= 1) {
      return ratio;
    }
    if (ratio <= 100) {
      return ratio / 100;
    }
    throw new Error(
      "sellRatio must be between 0 and 1, or between 0 and 100 percent",
    );
  }

  resolveStageBuyAmount(value, defaultBuyAmount, stageKey) {
    const rawValue = value ?? defaultBuyAmount;
    const rawAmounts = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (rawAmounts.length === 0) {
      throw new Error(`${stageKey}.buyAmount must not be an empty array`);
    }

    const buyAmounts = rawAmounts.map((amount) => Number(amount));
    if (buyAmounts.some((amount) => !Number.isFinite(amount) || amount <= 0)) {
      throw new Error(
        `${stageKey}.buyAmount must contain only positive numbers`,
      );
    }

    const randomIndex = Math.floor(Math.random() * buyAmounts.length);
    return {
      buyAmount: buyAmounts[randomIndex],
      buyAmountArr: buyAmounts,
    };
  }

  getBuyStageConfig(config, type = "all") {
    const stageKey = this.getStageKey(type, "Buy");
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
      if (!enable) {
        return {
          enable: false,
          config: {
            ...config,
            ...stageFlags,
            ...stageOverrides,
            [stageKey]: false,
          },
        };
      }
      const { buyAmount, buyAmountArr: stageBuyAmountArr } =
        this.resolveStageBuyAmount(
          stageOverrides.buyAmount,
          defaultBuyAmount,
          stageKey,
        );
      return {
        enable,
        config: {
          ...config,
          ...stageFlags,
          ...stageOverrides,
          buyAmount,
          buyAmountArr: stageBuyAmountArr,
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

  getSellStageConfig(config, type = "all", percent = 100) {
    const stageKey = this.getStageKey(type, "Sell");
    const stageConfig = stageKey ? config[stageKey] : null;
    const defaultSellRatio = this.normalizeSellRatio(percent);
    const stageFlags = {
      firstSell: false,
      secondSell: false,
      thirdSell: false,
      multiSell: false,
    };
    if (stageKey) {
      stageFlags[stageKey] = true;
    }

    if (stageConfig && typeof stageConfig === "object") {
      const { enable = false, ...stageOverrides } = stageConfig;
      const sellRatio = this.normalizeSellRatio(
        stageOverrides.sellRatio,
        defaultSellRatio,
      );
      return {
        enable,
        config: {
          ...config,
          ...stageFlags,
          ...stageOverrides,
          sellRatio,
          [stageKey]: enable,
        },
      };
    }

    return {
      enable: stageConfig === true,
      config: {
        ...config,
        ...stageFlags,
        sellRatio: defaultSellRatio,
      },
    };
  }

  normalizeWalletRouting(config) {
    const buyStages = ["firstBuy", "secondBuy", "thirdBuy", "multiBuy"]
      .map((key) => config[key])
      .filter(
        (stage) =>
          stage && typeof stage === "object" && stage.enable !== false,
      );
    const stageDflow = buyStages.some(
      (stage) => stage.isDflow === true || stage.isDlfow === true,
    );
    const stageJup = buyStages.some((stage) => stage.isJup === true);
    const stageTrogan = buyStages.some(
      (stage) => stage.isTrogan === true || stage.isTragon === true,
    );
    return {
      ...config,
      isDflow:
        config.isDflow ??
        config.isDlfow ??
        stageDflow,
      isJup: config.isJup ?? stageJup,
      isTrogan: config.isTrogan ?? config.isTragon ?? stageTrogan,
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

    let newWallets = data
      .filter((wallet) => wallet.stageEnable)
      .map((wallet) => this.normalizeWalletRouting(wallet));
    return newWallets;
  }

  async getWalletsWithSellConfig(line, type = "all", percent = 100) {
    console.log(chalk.green("getWalletsWithSellConfig:", line, type));
    const wallets = await this.getWallets(line);
    const walletConfigs = await this.getWalletConfig(line);
    if (String(type).toLowerCase() === "all") {
      const newWallets = wallets.map((wallet, index) =>
        this.normalizeWalletRouting({
          ...wallet,
          ...(walletConfigs[index] || {}),
          sellRatio: 1,
          stageEnable: true,
        }),
      );
      const lineData = await this.ctx.model.ExecuteLine.findOne({
        lineId: line,
      }).lean();
      const { firstWallet, needFirstWallet } = lineData;
      if (
        !firstWallet ||
        !needFirstWallet ||
        newWallets.some((wallet) => wallet.address === firstWallet.address)
      ) {
        return newWallets;
      }

      const firstWalletConfig = {
        ...this.buildFirstWalletConfig(firstWallet),
        sellRatio: 1,
        stageEnable: true,
      };
      return firstWallet.position === "after"
        ? [...newWallets, firstWalletConfig]
        : [firstWalletConfig, ...newWallets];
    }

    const stageTypes = [type];
    const data = walletConfigs.flatMap((config, index) => {
      const wallet = wallets[index];
      return stageTypes
        .map((stageType) => this.getSellStageConfig(config, stageType, percent))
        .filter((stage) => stage.enable)
        .map((stage) => ({
          ...wallet,
          ...stage.config,
          stageEnable: true,
        }));
    });

    return data
      .filter((wallet) => wallet.stageEnable)
      .map((wallet) => this.normalizeWalletRouting(wallet));
  }

  buildFirstWalletConfig(firstWallet) {
    const keypair = Keypair.fromSecretKey(bs58.decode(firstWallet.privateKey));
    const { privateKey, ...config } = firstWallet;
    return {
      address: firstWallet.address,
      publicKey: new PublicKey(firstWallet.address),
      buyAmount: firstWallet.buyAmount,
      buyAmountArr: [firstWallet.buyAmount],
      keypair,
      limit: 2000000,
      price: 0,
      fee: 0.00002,
      ...config,
      isDflow: config.isDflow ?? config.isDlfow ?? false,
      isFirstWallet: true,
      isBundle: firstWallet.isBundle !== false,
    };
  }

  async getWalletsWithLineFirstWallet(line, type = "all") {
    let newWallets = await this.getWalletsWithConfig(line, type);
    const lineData = await this.ctx.model.ExecuteLine.findOne({
      lineId: line,
    }).lean();
    const { firstWallet, needFirstWallet } = lineData;
    if (firstWallet && needFirstWallet) {
      const firstType = this.normalizeStageType(firstWallet.type);
      const typeKey = `${firstType}Buy`;
      if (type === firstType || type === "all") {
        const firstWalletConfig = this.buildFirstWalletConfig(firstWallet);
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
    const addAmounts = (value) => {
      if (Array.isArray(value)) {
        value.forEach(addAmount);
      } else {
        addAmount(value);
      }
    };

    addAmounts(config.buyAmount);

    ["firstBuy", "secondBuy", "thirdBuy", "multiBuy"].forEach((key) => {
      const stageConfig = config[key];
      if (stageConfig && typeof stageConfig === "object") {
        addAmounts(stageConfig.buyAmount);
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
    const lineData = await ctx.model.ExecuteLine.findOne({
      lineId: executeData.line,
    }).lean();

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
    let amm = tokenData.amm;
    let dev = "";
    let pool = tokenData.pool;

    // AVE already returns the token's main pair and AMM. Use it before doing
    // chain-wide Pump AMM/Raydium pool scans, especially when tokenData only
    // contains the mint address.
    let aveTokenInfo;
    if (!symbol || !pool || !amm) {
      try {
        aveTokenInfo = await ctx.service.ave.getTokenInfo(token);
      } catch (error) {
        console.log(
          `Failed to get AVE token info for ${token}: ${error.message}`,
        );
      }
    }
    symbol = symbol || aveTokenInfo?.symbol;
    pool = pool || aveTokenInfo?.pool;
    amm = amm || aveTokenInfo?.amm;

    if (!pool || !amm) {
      const oldData = await ctx.model.ExecuteToken.findOne({
        token: token,
      });
      if (oldData?.pool || oldData?.amm) {
        dev = "";
        pool = pool || oldData.pool;
        amm = amm || oldData.amm;
      }
    }

    if (!pool || !amm) {
      let poolDetail;
      try {
        poolDetail = await getPoolsWithPrices(new PublicKey(token), ctx);
      } catch (error) {
        // Keep the Raydium and Pump.fun fallbacks below for tokens AVE does
        // not index yet.
      }
      if (poolDetail) {
        amm = PUMP_AMM_NAME;
        dev = poolDetail.poolData.coinCreator;
        pool = poolDetail.address;
      } else {
        const poolId = await getRaydiumCpmmPoolId(new PublicKey(token));
        if (poolId) {
          pool = poolId.toBase58();
          amm = RAYDIUM_CPMM_NAME;
        } else {
          const pumpFunPoolDetail = await ctx.service.pumpfun.getPoolDetail(
            token,
          );
          if (pumpFunPoolDetail) {
            amm = PUMP_FUN_NAME;
            dev = pumpFunPoolDetail.dev;
            pool = "";
          } else {
            throw new Error("Cannot find pool data");
          }
        }
      }
    }

    if (!symbol) {
      throw new Error("Cannot find token metadata");
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
    const minFollowStates = Number(lineData?.minFollowStates || 0);
    if (
      minFollowStates > 0 &&
      Number(followStates.all || 0) <= minFollowStates
    ) {
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



