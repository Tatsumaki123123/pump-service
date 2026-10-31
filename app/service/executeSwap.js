const { Service } = require("egg");
const chalk = require("chalk");
const fs = require("fs");
const { randomUUID } = require("crypto");

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

const { connection, usdc } = require("../constants");
const { initSdk } = require("../constants/raydium");

const {
  getSPLBalance,
  closeAllTokenAccounts,
  transferAllSol,
  transferSol,
  isValidSolanaAddress,
  getTokenMeta,
} = require("../utils/solana");

const {
  getPoolsWithPrices,
  getPoolsWithBaseMint,
  getPumpPoolsWithBaseMint,
} = require("../libs/pool");
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");
const { sleep, retryAsync } = require("../utils/utils");
const { getRaydiumCpmmPoolId } = require("../utils/raydium");

const BOSS_MIN_AMOUNT = 0;

const PUMP_AMM_NAME = "pumpfunamm";
const PUMP_FUN_NAME = "pump";

const RAYDIUM_CPMM_NAME = "raydiumcpmm";
const RAYDIUM_LANUCH_NAME = "raydiumlaunchlab";
const AFTER_WALLET_DELAY_MS = Number(process.env.AFTER_WALLET_DELAY_MS || 0);
const BOSS_LOCK_TTL_MS = 2 * 60 * 1000;
const BOSS_LOCK_RENEW_MS = 30 * 1000;
const EXECUTE_EID_SEQUENCE_ID = "execute-data-eid";

class ExecuteSwap extends Service {
  constructor(props) {
    super(props);
  }

  async start(line, times = 1) {
    return this.ctx.service.bossLifecycle.generate(line, times, true);
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
    }).read("primary").lean();
    return executeData;
  }

  async addLine() {
    const { ctx } = this;
    const latestLine = await ctx.model.ExecuteLine.findOne()
      .sort({ lineId: -1 })
      .lean();
    const lineId = Number(latestLine?.lineId || 0) + 1;
    const eid = await this.getNextEid();
    const boss = Keypair.generate();
    const linePayload = {
      lineId,
      lineName: `line-${lineId}`,
      walletConfig: [],
      groupSort: {},
      autoStep: [],
      lineBots: [],
      autoSwap: false,
      needFirstWallet: false,
      minFollowStates: 0,
    };
    const dataPayload = {
      eid,
      bossAddress: boss.publicKey.toBase58(),
      privateKey: bs58.encode(boss.secretKey),
      active: false,
      bossStatus: "awaiting_funds",
      bossPending: true,
      createTime: new Date(),
      walletsExist: false,
      line: lineId,
    };
    let createdLine;
    try {
      return await this.withBossGenerationLock(lineId, async (assertLock) => {
        await ctx.service.bossLifecycle.prepareStorage();
        await assertLock();
        createdLine = await ctx.model.ExecuteLine.create(linePayload);
        await assertLock();
        const [createdData] = await ctx.model.ExecuteData.create(
          [dataPayload], { writeConcern: { w: 1, j: true } },
        );
        return {
          executeLine: createdLine,
          executeData: createdData,
        };
      });
    } catch (error) {
      if (createdLine?._id) {
        const hasExecuteData = await ctx.model.ExecuteData.exists({ line: lineId });
        if (!hasExecuteData) {
          await ctx.model.ExecuteLine.deleteOne({ _id: createdLine._id });
        }
      }
      throw error;
    }
  }

  async getWalletConfig(line) {
    const { ctx } = this;
    const lineData = await ctx.model.ExecuteLine.findOne({ lineId: line });
    const executeWalletConfig = lineData.walletConfig;
    return executeWalletConfig;
  }

  normalizeLineSlippage(value) {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const slippage = Number(value);
    if (!Number.isFinite(slippage) || slippage < 0 || slippage > 1) {
      throw new Error("slippage must be between 0 and 1");
    }
    return slippage;
  }

  async getLineSlippage(line) {
    const lineData = await this.ctx.model.ExecuteLine.findOne({
      lineId: line,
    })
      .select("slippage")
      .lean();
    return this.normalizeLineSlippage(lineData?.slippage);
  }

  async getNextEid() {
    const { ctx } = this;
    const latestExecuteData = await ctx.model.ExecuteData.findOne()
      .sort({ eid: -1 })
      .select("eid")
      .lean();
    const maxEid = Number(latestExecuteData?.eid || 0);
    if (!Number.isSafeInteger(maxEid) || maxEid < 0) {
      throw new Error("Existing ExecuteData eid is outside the safe integer range");
    }
    const sequenceFilter = { _id: EXECUTE_EID_SEQUENCE_ID };

    try {
      await ctx.model.ExecuteSequence.updateOne(
        sequenceFilter,
        { $max: { value: maxEid } },
        { upsert: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      await ctx.model.ExecuteSequence.updateOne(sequenceFilter, {
        $max: { value: maxEid },
      });
    }

    const sequence = await ctx.model.ExecuteSequence.findOneAndUpdate(
      sequenceFilter,
      { $inc: { value: 1 } },
      { new: true, upsert: true },
    );
    if (!Number.isSafeInteger(sequence?.value)) {
      throw new Error("ExecuteData eid sequence is invalid");
    }
    return sequence.value;
  }

  async withBossGenerationLock(line, action, { skipLock = false } = {}) {
    const lineId = Number(line);
    if (
      !["string", "number"].includes(typeof line) ||
      !Number.isSafeInteger(lineId) || lineId < 1
    ) {
      throw new Error("line must be a positive integer");
    }
    if (skipLock) {
      return action(async () => {});
    }
    return this.withLineOperationLock(lineId, "boss-funds", action);
  }

  async withBossFundsLock(line, action, options) {
    return this.withBossGenerationLock(line, async (assertLock) => {
      await this.ctx.service.bossLifecycle.assertNoPending(line);
      await assertLock();
      return action(assertLock);
    }, options);
  }

  async withLineOperationLock(line, operation, action) {
    const { ctx } = this;
    const lockId = `${operation}:${line}`;
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + BOSS_LOCK_TTL_MS);
    let lock = await ctx.model.ExecuteLineLock.findOneAndUpdate(
      { _id: lockId, expiresAt: { $lte: new Date() } },
      { $set: { token, expiresAt } },
      { new: true },
    ).lean();

    if (!lock) {
      try {
        lock = await ctx.model.ExecuteLineLock.create({
          _id: lockId,
          token,
          expiresAt,
        });
      } catch (error) {
        if (error.code === 11000) {
          const locked = new Error(`${operation} is already running for line ${line}`);
          locked.code = "LINE_OPERATION_LOCKED";
          throw locked;
        }
        throw error;
      }
    }

    let lockLost = false;
    const renewTimer = setInterval(async () => {
      try {
        const result = await ctx.model.ExecuteLineLock.updateOne(
          { _id: lockId, token },
          { $set: { expiresAt: new Date(Date.now() + BOSS_LOCK_TTL_MS) } },
        );
        if (result.matchedCount !== 1) lockLost = true;
      } catch (error) {
        lockLost = true;
        ctx.logger.error(`Failed to renew ${operation} lock`, error);
      }
    }, BOSS_LOCK_RENEW_MS);
    renewTimer.unref?.();

    try {
      const assertLock = async () => {
        if (lockLost) {
          throw new Error(`${operation} lock was lost for line ${line}`);
        }
        const currentLock = await ctx.model.ExecuteLineLock.exists({
          _id: lockId,
          token,
          expiresAt: { $gt: new Date() },
        });
        if (!currentLock) {
          lockLost = true;
          throw new Error(`${operation} lock was lost for line ${line}`);
        }
      };
      return await action(assertLock);
    } finally {
      clearInterval(renewTimer);
      await ctx.model.ExecuteLineLock.deleteOne({ _id: lockId, token }).catch(
        (error) => ctx.logger.error(`Failed to release ${operation} lock`, error),
      );
    }
  }

  async generateNewBoss(line, times = 1) {
    return this.ctx.service.bossLifecycle.generate(line, times);
  }

  async generateBoss(lastExecuteData, recoverOnly = false) {
    return this.ctx.service.bossLifecycle.generate(lastExecuteData.line, 1, false, recoverOnly);
  }

  /**
   * Step 2, generateWallets
   * 生成一批新的地址
   */
  async generateWallets(line, isOld = false) {
    return this.withBossFundsLock(line, (assertLock) =>
      this.generateWalletsUnderLock(line, isOld, assertLock),
    );
  }

  async generateWalletsUnderLock(line, isOld, assertLock) {
    if (isOld === true) {
      return this.generateWalletsFromAddressPool(line, assertLock);
    }

    const { ctx } = this;

    const executeData = await this.getExecuteData(line);

    if (!executeData) throw new Error("No active boss; fund the pending boss and call start first");

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
      await assertLock();
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

  async generateWalletAddresses(num) {
    const { ctx } = this;
    const count = Number(num);
    const maxCount = 500;
    if (!Number.isSafeInteger(count) || count < 1 || count > maxCount) {
      throw new Error(`num must be an integer between 1 and ${maxCount}`);
    }

    const records = Array.from({ length: count }, () => {
      const keypair = Keypair.generate();
      return {
        address: keypair.publicKey.toBase58(),
        privateKey: bs58.encode(keypair.secretKey),
        status: "unused",
        createTime: new Date(),
      };
    });
    await ctx.model.ExecuteWalletAddress.insertMany(records);
    return { count, addresses: records.map(({ address }) => address) };
  }

  async getWalletAddresses({
    status,
    lineId,
    page = 1,
    pageSize = 50,
    sortOrder = "desc",
  } = {}) {
    const { ctx } = this;
    const currentPage = Number(page);
    const limit = Number(pageSize);
    if (!Number.isSafeInteger(currentPage) || currentPage < 1) {
      throw new Error("page must be a positive integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("pageSize must be an integer between 1 and 200");
    }
    if (!["asc", "desc"].includes(sortOrder)) {
      throw new Error("sortOrder must be asc or desc");
    }

    const allowedStatuses = ["unused", "in_use", "ended"];
    const statuses =
      status == null || status === ""
        ? ["unused", "in_use"]
        : Array.isArray(status)
          ? status
          : String(status)
              .split(",")
              .map((item) => item.trim());
    if (
      statuses.length === 0 ||
      statuses.some((item) => !allowedStatuses.includes(item))
    ) {
      throw new Error("status must contain unused, in_use, or ended");
    }

    const filter = { status: { $in: [...new Set(statuses)] } };
    if (lineId !== undefined && lineId !== null && lineId !== "") {
      const parsedLineId = Number(lineId);
      if (
        !["string", "number"].includes(typeof lineId) ||
        !Number.isSafeInteger(parsedLineId)
      ) {
        throw new Error("lineId must be an integer");
      }
      filter.useLine = parsedLineId;
    }
    const [list, total] = await Promise.all([
      ctx.model.ExecuteWalletAddress.find(filter)
        .select("address status createTime useEid useLine useTime endTime")
        .sort({ createTime: sortOrder === "asc" ? 1 : -1, _id: 1 })
        .skip((currentPage - 1) * limit)
        .limit(limit)
        .lean(),
      ctx.model.ExecuteWalletAddress.countDocuments(filter),
    ]);
    return { list, total, page: currentPage, pageSize: limit };
  }

  async deleteWalletAddresses(ids) {
    const { ctx } = this;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
      throw new Error("ids must contain between 1 and 500 address ids");
    }
    const uniqueIds = [...new Set(ids.map(String))];
    const validIds = uniqueIds.filter((id) =>
      ctx.app.mongoose.Types.ObjectId.isValid(id),
    );
    const deleted = validIds.length
      ? await ctx.model.ExecuteWalletAddress.deleteMany({
          _id: { $in: validIds },
          status: "unused",
        })
      : { deletedCount: 0 };
    const remaining = validIds.length
      ? await ctx.model.ExecuteWalletAddress.find({ _id: { $in: validIds } })
          .select("_id status")
          .lean()
      : [];
    return {
      deletedCount: deleted.deletedCount,
      rejected: [
        ...uniqueIds
          .filter((id) => !validIds.includes(id))
          .map((id) => ({ id, reason: "invalid id" })),
        ...remaining.map((item) => ({
          id: String(item._id),
          reason: item.status === "unused" ? "not found" : `status is ${item.status}`,
        })),
      ],
    };
  }

  async generateWalletsFromAddressPool(line, assertLock) {
    const { ctx } = this;
    const executeData = await this.getExecuteData(line);
    if (!executeData) throw new Error("execute data not found");

    const walletConfig = await this.getWalletConfig(line);
    if (!Array.isArray(walletConfig) || walletConfig.length === 0) {
      throw new Error("walletConfig is empty");
    }
    const amounts = walletConfig.map((item, index) => {
      const amount = Number(item.transferAmount);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`Invalid transferAmount for wallet index ${index}`);
      }
      return amount;
    });
    const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
    if (executeData.walletsExist) {
      const walletData = await this.getWallets(line);
      const wallets = [];
      const transferAmounts = [];
      for (let index = 0; index < walletData.length; index++) {
        const wallet = walletData[index];
        if (!walletConfig[index]) {
          throw new Error(`walletConfig missing for wallet index ${index}`);
        }
        const balance = await connection.getBalance(wallet.publicKey);
        if (balance === 0) {
          wallets.push(wallet.publicKey);
          transferAmounts.push(amounts[index]);
        }
      }
      if (wallets.length === 0) throw new Error("no wallet to transfer");

      await assertLock();
      await transferSol(connection, boss, wallets, transferAmounts, {
        throwOnError: true,
      });
      await ctx.model.ExecuteWalletAddress.updateMany(
        {
          address: { $in: wallets.map((wallet) => wallet.toBase58()) },
          useEid: executeData.eid,
          status: { $in: ["in_use", "ended"] },
        },
        {
          $set: { status: "in_use", useTime: new Date() },
          $unset: { endTime: 1 },
        },
      );
      return true;
    }

    const existingWalletCount = await ctx.model.ExecuteWallet.countDocuments({
      eid: executeData.eid,
    });
    if (existingWalletCount > 0) {
      throw new Error("wallets already exist for this execute batch");
    }

    const candidates = await ctx.model.ExecuteWalletAddress.find({ status: "unused" })
      .sort({ createTime: 1, _id: 1 })
      .limit(walletConfig.length)
      .lean();
    if (candidates.length < walletConfig.length) {
      throw new Error(
        `Not enough unused wallet addresses: need ${walletConfig.length}, found ${candidates.length}`,
      );
    }

    const now = new Date();
    const claimed = [];
    const releaseClaimed = async () => {
      if (claimed.length === 0) return;
      await ctx.model.ExecuteWalletAddress.updateMany(
        {
          _id: { $in: claimed.map((item) => item._id) },
          status: "in_use",
          useEid: executeData.eid,
        },
        {
          $set: { status: "unused" },
          $unset: { useEid: 1, useLine: 1, useTime: 1 },
        },
      );
    };
    try {
      for (const candidate of candidates) {
        const updated = await ctx.model.ExecuteWalletAddress.findOneAndUpdate(
          { _id: candidate._id, status: "unused" },
          {
            $set: {
              status: "in_use",
              useEid: executeData.eid,
              useLine: line,
              useTime: now,
            },
          },
          { new: true },
        ).lean();
        if (updated) claimed.push(updated);
      }
    } catch (error) {
      await releaseClaimed();
      throw error;
    }

    if (claimed.length !== walletConfig.length) {
      await releaseClaimed();
      throw new Error("Wallet addresses were claimed concurrently; retry generateWallets");
    }

    const dbData = claimed.map((item, index) => ({
      wid: index + 1,
      address: item.address,
      privateKey: item.privateKey,
      walletAddressId: item._id,
      eid: executeData.eid,
    }));
    try {
      await ctx.model.ExecuteWallet.insertMany(dbData);
    } catch (error) {
      await ctx.model.ExecuteWallet.deleteMany({
        eid: executeData.eid,
        walletAddressId: { $in: claimed.map((item) => item._id) },
      });
      await releaseClaimed();
      throw error;
    }

    const wallets = claimed.map((item) => new PublicKey(item.address));

    // Keep addresses reserved if transfer confirmation fails; retrying could double-fund them.
    await assertLock();
    await transferSol(connection, boss, wallets, amounts, {
      throwOnError: true,
    });
    await ctx.model.ExecuteData.updateOne(
      { eid: executeData.eid },
      { $set: { walletsExist: true } },
    );
    return true;
  }

  async transferSolToWallets(line) {
    return this.withBossFundsLock(line, (assertLock) => this.transferSolToWalletsUnderLock(line, assertLock));
  }

  async transferSolToWalletsUnderLock(line, assertLock) {
    const wallets = await this.getWallets(line);
    const executeData = await this.getExecuteData(line);
    const walletConfig = await this.getWalletConfig(line);

    if (wallets && executeData) {
      const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
      const amounts = walletConfig.map((item) => item.transferAmount);
      const newWallets = wallets.map((item) => new PublicKey(item.address));
      await assertLock();
      await transferSol(connection, boss, newWallets, amounts);
    }
  }

  // Boss回收sol
  async recycleSol(line, force = false) {
    return this.withBossFundsLock(
      line,
      (assertLock) => this.recycleSolUnderLock(line, force, assertLock),
      { skipLock: force === true },
    );
  }

  async recycleSolUnderLock(line, force, assertLock) {
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
        await assertLock();
        await transferAllSol(
          connection,
          wallet.keypair,
          new PublicKey(executeData.bossAddress),
        );
      };

      for (const wallet of wallets) {
        await fun(wallet);
      }

      const assignedWallets = await ctx.model.ExecuteWallet.find({
        eid: executeData.eid,
        walletAddressId: { $ne: null },
      }).select("walletAddressId").lean();
      const walletAddressIds = assignedWallets
        .map((wallet) => wallet.walletAddressId)
        .filter(Boolean);
      if (walletAddressIds.length > 0) {
        await ctx.model.ExecuteWalletAddress.updateMany(
          {
            _id: { $in: walletAddressIds },
            status: "in_use",
            useEid: executeData.eid,
          },
          { $set: { status: "ended", endTime: new Date() } },
        );
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
    const lineData = await ctx.model.ExecuteLine.findOne({ lineId: line })
      .select("batchPlatform")
      .lean();
    const sendOptions = {
      batchPlatform: lineData?.batchPlatform,
    };

    const configWallets = await this.getWalletsWithLineFirstWallet(line, type);
    const wallets = [];
    configWallets.forEach((wallet) => {
      const { buyTimes = 1 } = wallet;
      for (let index = 0; index < buyTimes; index++) {
        wallets.push(wallet);
      }
    });
    if (wallets && wallets.length > 0 && token) {
      await this.batchBuyTokenByAmm(
        tokenInfo.amm,
        token,
        wallets,
        type,
        sendOptions,
      );

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
      await ctx.service.raydiumCpmm.batchBuyToken(
        token,
        wallets,
        type,
        sendOptions,
      );
    } else if (amm === RAYDIUM_LANUCH_NAME) {
      await ctx.service.raydiumLaunch.batchBuyToken(
        token,
        wallets,
        type,
        sendOptions,
      );
    } else if (amm === PUMP_AMM_NAME) {
      await ctx.service.pumpAMM.batchBuyToken(
        token,
        wallets,
        type,
        sendOptions,
      );
    } else if (amm === PUMP_FUN_NAME) {
      await ctx.service.pumpfun.batchBuyToken(
        token,
        wallets,
        type,
        sendOptions,
      );
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
    sendOptions = {},
  ) {
    const hasAfterWallets = afterWallets.length > 0;
    await this.dispatchBatchBuyToken(amm, token, bundledWallets, type, {
      ...sendOptions,
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
      ...sendOptions,
      skipPreflight: true,
      sleepAfter: false,
      waitForLanding: false,
    });
  }

  async batchBuyTokenByAmm(amm, token, wallets, type, sendOptions = {}) {
    const standaloneWallets = wallets.filter((wallet) =>
      this.isStandaloneFirstWalletBuy(wallet),
    );
    if (standaloneWallets.length === 0) {
      return this.dispatchBatchBuyToken(
        amm,
        token,
        wallets,
        type,
        sendOptions,
      );
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

      await this.dispatchStandaloneWallets(
        amm,
        token,
        beforeWallets,
        type,
        sendOptions,
      );
      await this.dispatchAfterWalletsNextSlot(
        amm,
        token,
        bundledWallets,
        afterWallets,
        type,
        sendOptions,
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
        sendOptions,
      );
      await this.dispatchAfterWalletsNextSlot(
        amm,
        token,
        bundledWallets,
        afterWallets,
        stageType,
        sendOptions,
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
    const lineData = await ctx.model.ExecuteLine.findOne({ lineId: tokenInfo.line })
      .select("batchPlatform")
      .lean();
    const sendOptions = { batchPlatform: lineData?.batchPlatform };
    const wallets = await this.getWalletsWithConfig(tokenInfo.line);
    const wallet = wallets.find(
      (item) => item.publicKey.toBase58() === walletAddress,
    );
    if (wallet) {
      const wallets = [wallet];
      if (tokenInfo.amm === RAYDIUM_CPMM_NAME) {
        const res = await ctx.service.raydiumCpmm.batchBuyToken(
          token,
          wallets,
          "",
          sendOptions,
        );
      } else if (tokenInfo.amm === PUMP_AMM_NAME) {
        const res = await ctx.service.pumpAMM.batchBuyToken(
          token,
          wallets,
          "",
          sendOptions,
        );
      } else if (tokenInfo.amm === PUMP_FUN_NAME) {
        const res = await ctx.service.pumpfun.batchBuyToken(
          token,
          wallets,
          "",
          sendOptions,
        );
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
    const wallets = await this.getWalletsWithSellConfig(
      tokenInfo.line,
      "all",
      percent,
    );
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
    const defaultBuyAmount =
      config.buyAmount === undefined || config.buyAmount === null
        ? undefined
        : this.resolveStageBuyAmount(
            config.buyAmount,
            buyAmountArr[0],
            stageKey || "wallet",
          ).buyAmount;
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
    const stagePadre = buyStages.some(
      (stage) => stage.isPadre === true || stage.isPardre === true,
    );
    return {
      ...config,
      isDflow:
        config.isDflow ??
        config.isDlfow ??
        stageDflow,
      isJup: config.isJup ?? stageJup,
      isTrogan: config.isTrogan ?? config.isTragon ?? stageTrogan,
      isPadre: config.isPadre ?? config.isPardre ?? stagePadre,
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
      const dbData = await ctx.model.ExecuteWallet.find(filter).sort({
        wid: 1,
        _id: 1,
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

  async getWalletsWithConfig(line, type = "all") {
    console.log(chalk.green("getWalletsWithConfig:", line, type));
    const wallets = await this.getWallets(line);
    const walletConfigs = await this.getWalletConfig(line);
    const lineSlippage = await this.getLineSlippage(line);
    const data = walletConfigs.flatMap((config, index) => {
      const wallet = wallets[index];
      if (type === "all") {
        return ["first", "second", "third", "multi"]
          .map((stageType) => this.getBuyStageConfig(config, stageType))
          .filter((stage) => stage.enable)
          .map((stage) => ({
            ...wallet,
            ...stage.config,
            ...(lineSlippage === undefined
              ? {}
              : { slippage: lineSlippage }),
            stageEnable: true,
          }));
      }
      const stage = this.getBuyStageConfig(config, type);
      return [
        {
          ...wallet,
          ...stage.config,
          ...(lineSlippage === undefined ? {} : { slippage: lineSlippage }),
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
      const lineData = await this.ctx.model.ExecuteLine.findOne({
        lineId: line,
      }).lean();
      const lineSlippage = this.normalizeLineSlippage(lineData?.slippage);
      const newWallets = wallets.map((wallet, index) =>
        this.normalizeWalletRouting({
          ...wallet,
          ...(walletConfigs[index] || {}),
          ...(lineSlippage === undefined
            ? {}
            : { slippage: lineSlippage }),
          sellRatio: 1,
          stageEnable: true,
        }),
      );
      const { firstWallet, needFirstWallet } = lineData;
      if (
        !firstWallet ||
        !needFirstWallet ||
        newWallets.some((wallet) => wallet.address === firstWallet.address)
      ) {
        return newWallets;
      }

      const firstWalletConfig = {
        ...this.buildFirstWalletConfig(firstWallet, lineSlippage),
        sellRatio: 1,
        stageEnable: true,
      };
      return firstWallet.position === "after"
        ? [...newWallets, firstWalletConfig]
        : [firstWalletConfig, ...newWallets];
    }

    const stageTypes = [type];
    const lineSlippage = await this.getLineSlippage(line);
    const data = walletConfigs.flatMap((config, index) => {
      const wallet = wallets[index];
      return stageTypes
        .map((stageType) => this.getSellStageConfig(config, stageType, percent))
        .filter((stage) => stage.enable)
        .map((stage) => ({
          ...wallet,
          ...stage.config,
          ...(lineSlippage === undefined ? {} : { slippage: lineSlippage }),
          stageEnable: true,
        }));
    });

    return data
      .filter((wallet) => wallet.stageEnable)
      .map((wallet) => this.normalizeWalletRouting(wallet));
  }

  buildFirstWalletConfig(firstWallet, lineSlippage) {
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
      ...(lineSlippage === undefined ? {} : { slippage: lineSlippage }),
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
        const lineSlippage = this.normalizeLineSlippage(lineData.slippage);
        const firstWalletConfig = this.buildFirstWalletConfig(
          firstWallet,
          lineSlippage,
        );
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
    const active = await this.getExecuteData(line);
    const pending = await ctx.service.bossLifecycle.findPending(line, active);
    const executeData = active || pending;
    if (!executeData) throw new Error("No boss exists for this line; call start first");
    const bossBalance = await connection.getBalance(
      new PublicKey(executeData.bossAddress),
      "finalized",
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
      active: executeData.active,
      ready: Boolean(active && !pending && bossBalance >= ctx.service.bossLifecycle.minimumBalance()),
      bossStatus: executeData.bossStatus || (executeData.active ? "active" : "pending"),
      minimumBalanceLamports: ctx.service.bossLifecycle.minimumBalance(),
      pending: pending ? {
        address: pending.bossAddress,
        eid: pending.eid,
        bossStatus: pending.bossStatus || "pending",
        transferSignature: pending.transferSignature || null,
      } : null,
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
        const pumpPools = await getPumpPoolsWithBaseMint(new PublicKey(token));
        const selectedPumpPool =
          pumpPools.find(
            (item) => item.address.toBase58() === aveTokenInfo?.pool,
          ) || (pumpPools.length === 1 ? pumpPools[0] : null);
        if (selectedPumpPool) {
          amm = PUMP_AMM_NAME;
          dev = selectedPumpPool.poolData.coinCreator;
          pool = selectedPumpPool.address.toBase58();
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
    }

    let routeInfo;
    if (amm === PUMP_AMM_NAME && pool) {
      const pumpPools = await getPumpPoolsWithBaseMint(new PublicKey(token));
      const pumpPool =
        pumpPools.find((item) => item.address.toBase58() === String(pool)) ||
        pumpPools.find(
          (item) => item.address.toBase58() === aveTokenInfo?.pool,
        ) ||
        (pumpPools.length === 1 ? pumpPools[0] : null);
      if (!pumpPool) {
        throw new Error(`Cannot identify Pump AMM pool for ${token}`);
      }
      pool = pumpPool.address.toBase58();
      const quoteMint = pumpPool.poolData.quoteMint;
      if (!quoteMint.equals(NATIVE_MINT)) {
        if (!aveTokenInfo) {
          aveTokenInfo = await ctx.service.ave.getTokenInfo(token);
        }
        const pumpPair = aveTokenInfo.pairs.find(
          (item) => item.pair === pumpPool.address.toBase58(),
        );
        const quoteTokenInfo = await ctx.service.ave.getTokenInfo(
          quoteMint.toBase58(),
        );
        const isUsdcQuote = quoteMint.toBase58() === usdc;
        const quotePair = isUsdcQuote
          ? null
          : quoteTokenInfo.pairs.find(
              (item) => item.pair === quoteTokenInfo.tokenDetail.main_pair,
            );
        if (!isUsdcQuote && !quotePair) {
          throw new Error(`AVE main pair missing for ${quoteMint.toBase58()}`);
        }
        routeInfo = {
          pumpPool: pumpPool.address.toBase58(),
          quoteMint: quoteMint.toBase58(),
          quotePool: quotePair?.pair || null,
          quoteAmm: quotePair?.amm || null,
          token: aveTokenInfo.tokenDetail,
          pumpPair: pumpPair || null,
          quoteToken: quoteTokenInfo.tokenDetail,
          quotePair: quotePair || null,
        };
        await ctx.model.PoolStore.updateOne(
          { token },
          { $set: { routeInfo } },
          { upsert: true },
        );
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
      routeInfo,
      createTime: new Date(),
      eid: executeData.eid,
      line: executeData.line,
      status: "pending",
    };

    const hasMaxBuyTax =
      lineData?.maxBuyTax !== undefined &&
      lineData?.maxBuyTax !== null &&
      lineData?.maxBuyTax !== "";
    if (hasMaxBuyTax) {
      const maxBuyTax = Number(lineData.maxBuyTax);
      const extraDetail = await ctx.service.ave.getTokenExtraDetail(token);
      const totalBuyTax = Number(extraDetail.total_buy_tax);
      if (!Number.isFinite(totalBuyTax)) {
        throw new Error("Cannot get token buy tax by AVE");
      }
      if (totalBuyTax > maxBuyTax) {
        throw new Error(
          `Buy tax ${totalBuyTax} exceeds maxBuyTax ${maxBuyTax}`,
        );
      }
    }

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
      await ctx.model.ExecuteToken.updateOne(
        { tid },
        { $set: { symbol, pool, amm, routeInfo } },
      );
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
    return this.withBossFundsLock(line, (assertLock) => this.withdrawUnderLock(line, amount, assertLock));
  }

  async withdrawUnderLock(line, amount, assertLock) {
    const { ctx } = this;
    const executeData = await this.getExecuteData(line);
    if (!executeData) throw new Error("No active boss; call start to reconcile first");
    const lineData = await ctx.model.ExecuteLine.findOne({ lineId: line });
    console.log(chalk.green("withdraw", amount));
    if (lineData.withdrawAddress) {
      const boss = Keypair.fromSecretKey(bs58.decode(executeData.privateKey));
      await assertLock();
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

  async nextWallet(line, force = false) {
    return this.withBossFundsLock(line, async (assertLock) => {
      return this.rotateWallets(line, force, assertLock);
    });
  }

  async rotateWallets(line, force = false, assertLock) {
    const { ctx } = this;
    const wallets = await this.getWallets(line);
    const executeData = await this.getExecuteData(line);

    if (force !== true) {
      for (const wallet of wallets) {
        const [tokenAccounts, token2022Accounts] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { programId: TOKEN_PROGRAM_ID },
            "confirmed",
          ),
          connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { programId: TOKEN_2022_PROGRAM_ID },
            "confirmed",
          ),
        ]);
        const tokenAccount = [
          ...tokenAccounts.value,
          ...token2022Accounts.value,
        ].find(({ account }) => {
          const amount = account.data?.parsed?.info?.tokenAmount?.amount;
          return amount != null && BigInt(amount) > 100n;
        });

        if (tokenAccount) {
          const amount =
            tokenAccount.account.data.parsed.info.tokenAmount.amount;
          throw new Error(
            `Wallet ${wallet.address} has token account ${tokenAccount.pubkey.toBase58()} with balance ${amount}. Set force=true to switch anyway.`,
          );
        }
      }
    }

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
        isActive: false,
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

    await assertLock();
    await ctx.model.ExecuteWallet.updateMany(
      { address: { $in: oldAddress } },
      { isActive: false },
    );
    await ctx.model.ExecuteWallet.updateMany(
      { address: { $in: newAddress } },
      { isActive: true },
    );
    return true;
  }
}

module.exports = ExecuteSwap;



