const { Service } = require("egg");
require("dotenv").config();
const chalk = require("chalk");

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

const bs58 = require("bs58");

const RPC_URL =
  process.env.SOLANA_RPC ||
  "https://cassandra-bq5oqs-fast-mainnet.helius-rpc.com/";

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

const boss = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));

const connection = new Connection(RPC_URL, "confirmed");

const WALLET_AMOUNTS = [
  { transferAmount: 0.03, buyAmount: 0.01 },
  { transferAmount: 0.03, buyAmount: 0.01, canTwice: true },
  //   { transferAmount: 0.3, buyAmount: 0.1 },
  //   { transferAmount: 0.3, buyAmount: 0.1 },
  //   { transferAmount: 0.3, buyAmount: 0.1 },
  //   { transferAmount: 0.3, buyAmount: 0.1 },
];

// const BOSS_AMOUNT = 3;
const BOSS_AMOUNT = 0.3;

class ExecuteSwap extends Service {
  constructor(props) {
    super(props);
  }

  async start() {
    const bossBalance =
      (await connection.getBalance(boss.publicKey)) / LAMPORTS_PER_SOL;
    console.log("bossBalance:", bossBalance);
    if (bossBalance < BOSS_AMOUNT) {
      throw new Error("Insufficient SOL in main wallet");
    }
    console.log(chalk.green("\nStep1, generate new wallet"));
    await this.generateWallet();

    console.log(chalk.green("\nStep2, transfer out sol"));
    await this.distributeSol();

    return true;
  }

  async end() {
    await this.recycleSol();
    return true;
  }

  /**
   * 1. 生成一批新的地址
   */
  async generateWallet() {
    const { ctx } = this;
    const wallets = await this.getWallets();

    let canGen = true;
    if (wallets) {
      for (let index = 0; index < wallets.length; index++) {
        const keypair = wallets[index].keypair;
        const balance = await connection.getBalance(keypair.publicKey);
        if (balance > 0) {
          canGen = false;
          break;
        }
      }
    }
    if (!canGen) {
      console.log(chalk.red("Generate error, balance remain in wallets"));
      throw new Error("Generate error, balance remain in wallets");
    }
    const dbData = WALLET_AMOUNTS.map((item) => {
      const keypair = Keypair.generate();
      return {
        address: keypair.publicKey.toBase58(),
        privateKey: bs58.encode(keypair.secretKey),
        active: true,
        canTwice: item.canTwice,
        buyAmount: item.buyAmount,
      };
    });
    await ctx.model.ExecuteWallet.updateMany(
      { active: true },
      { active: false }
    );
    const res = await ctx.model.ExecuteWallet.insertMany(dbData);
    return true;
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
    const wallets = await this.getWallets(canTwice);
    if (wallets && token) {
      const res = await ctx.service.pumpAMM.batchBuyToken(token, wallets);
    }
  }

  // sell token
  async sellToken(token) {
    console.log(chalk.green(`Step 4: Selling ${token}`));
    const { ctx } = this;
    const keypairs = this.getKeypairs();
    if (keypairs && token) {
      const res = await ctx.service.pumpAMM.buyToken(token);
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
