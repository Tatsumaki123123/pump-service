const { Service } = require("egg");

const chalk = require("chalk");

const { getSPLBalance } = require("../utils/solana");
const { sleep, retryAsync } = require("../utils/utils");

const tokenList = require("../data/tokenList.json");
const { connection } = require("../constants");
const { PublicKey } = require("@solana/web3.js");

const BOT_ADDRESS = "8qvNUZf5p4Q15WNc64xZ5cLrLZU1ZDecKVpSDBkU3vbz";

class AutoSwap extends Service {
  constructor(ctx) {
    super(ctx);
    this.line = 0;
    this.tokenIndex = 0;
    this.executeData = null;
    this.lineData = null;
    this.tokenInfo = null;

    this.waitTimer = null;
  }

  async start(line) {
    console.log(chalk.green("Start:", line));
    const { ctx } = this;
    this.line = line;
    this.lineData = await ctx.model.ExecuteLine.findOne({ lineId: line });

    if (!this.lineData.autoSwap) {
      console.log(chalk.red("Auto swap is off "));
      return;
    }

    const isEnough = await this.checkWalletBalance();
    console.log(chalk.green("Wallet balance is Enough: ", isEnough));
    if (isEnough) {
      this.executeData = await ctx.service.executeSwap.getExecuteData(line);
      await this.startCycle();
    } else {
      console.log(chalk.green("-recycleSol"));
      await retryAsync(async () => {
        await ctx.service.executeSwap.recycleSol(this.line);
      }, 10);
      await sleep(3);
      console.log(chalk.green("-generateNewBoss"));
      await retryAsync(async () => {
        await ctx.service.executeSwap.generateNewBoss(this.line);
      }, 10);
      await sleep(3);
      console.log(chalk.green("-generateWallets"));
      await retryAsync(async () => {
        await ctx.service.executeSwap.generateWallets(this.line);
      }, 10);
      await sleep(3);
      await this.start(line);
    }
  }

  async startCycle() {
    console.log(chalk.green("Start Cycle----"));
    const { ctx } = this;
    this.tokenIndex = Math.floor(Math.random() * tokenList.length);
    const tokenData = tokenList[this.tokenIndex];
    if (!tokenData) {
      this.startCycle();
      return;
    }
    console.log(chalk.green("Token:", tokenData.symbol, tokenData.token));
    // init

    // 1. check and get token
    const res1 = await this.checkToken(tokenData);
    console.log(chalk.green("Check token:", res1));
    if (!res1) {
      await this.startCycle();
      return;
    }

    // 2. buy first
    const res2 = await retryAsync(async () => {
      return await ctx.service.executeSwap.buyToken(
        this.tokenInfo.tid,
        "first"
      );
    }, 10);
    console.log(chalk.green("Buy token:", res2));
    if (!res2) {
      await this.startCycle();
      return;
    }

    // 3. wait bot enter or 1 min
    const botBalance = await this.waitBotEnter();
    console.log(chalk.green("Bot  enter", botBalance));
    if (botBalance) {
      // 4. sell multi
      console.log(chalk.green("Step 4: sell multi----"));

      const res4 = await retryAsync(async () => {
        return await ctx.service.executeSwap.sellToken(
          this.tokenInfo.tid,
          "multi"
        );
      }, 10);

      // 5. wait bot enter 2 or 1min
      console.log(chalk.green("Step 5: wait enter 2----"));
      const botBalance2 = await this.waitBotEnter(botBalance);
      console.log(chalk.green("Bot  enter 222", botBalance2));
    } else {
      console.log(chalk.red("Bot not enter"));
    }

    // 6. sell all
    console.log(chalk.green("Step 6: sell all----"));
    const res6 = await retryAsync(async () => {
      return await ctx.service.executeSwap.sellToken(this.tokenInfo.tid, "all");
    }, 10);
    console.log(chalk.green("Sell all----", res6));

    // 7. close token accounts
    sleep(20);
    console.log(chalk.green("Step 7: closeAllAccounts----"));
    const res7 = await retryAsync(async () => {
      return await ctx.service.executeSwap.closeAllAccounts(this.line);
    }, 10);
    console.log(chalk.green("close token accounts----", res7));

    // 7. end
    sleep(20);
    await this.start(this.line);
  }

  async checkToken(tokenData) {
    console.log(chalk.green("Step 1----Check Token:"));
    const { ctx } = this;
    try {
      const tokenInfo = await ctx.service.executeSwap.checkToken(
        tokenData,
        this.executeData.eid,
        false
      );
      if (tokenInfo) {
        this.tokenInfo = tokenInfo;
        return true;
      } else {
        throw new Error("Check token false");
      }
    } catch (error) {
      this.tokenInfo = null;
      return false;
    }
  }

  async waitBotEnter(initAmount = 1000) {
    const { ctx } = this;

    const maxSecond = 60;
    let second = 0;
    let timer = null;

    timer = setInterval(() => {
      second++;
      if (second === maxSecond) {
        clearInterval(timer);
      }
    }, 1000);

    let balance = 0;
    const func = async () => {
      if (second >= maxSecond) {
        return 0;
      }
      await sleep(10);
      balance = await this.getBotTokenBalances();

      if (balance > initAmount + 1000) {
        clearInterval(timer);
        if (initAmount > 1000) {
          balance = initAmount + 1;
        }
        return;
      } else {
        await func();
      }
    };
    await func();
    return balance;
  }

  async getBuyerTokenBalances() {
    console.log(chalk.green("-Get buyer accounts"));
    const { ctx } = this;
    const result = await ctx.service.executeSwap.getWalletTokenBalance(
      this.executeData.eid,
      this.tokenInfo.token
    );
  }

  async getBotTokenBalances() {
    console.log(chalk.green("-Get bot accounts"));
    const { ctx } = this;

    const result = await getSPLBalance(
      connection,
      new PublicKey(this.tokenInfo.token),
      new PublicKey(BOT_ADDRESS)
    );
    return result;
  }

  async checkWalletBalance() {
    console.log(chalk.green("Check Wallet Balance"));
    const { ctx } = this;
    let isEnough = true;

    const count = await ctx.model.ExecuteToken.count({
      eid: this.executeData.eid,
    });
    if (count > 50) {
      return false;
    }
    const wallets = await ctx.service.executeSwap.getWalletsWithBalance(
      this.line
    );
    wallets.forEach((wallet) => {
      const { balance, buyAmount } = wallet;
      if (balance < buyAmount + 0.1) {
        isEnough = false;
      }
    });
    return isEnough;
  }

  /**
   *
   */
}

module.exports = AutoSwap;
