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
} = require("@solana/web3.js");
require("dotenv").config();
const chalk = require("chalk");

const {
  SearcherClient,
  searcherClient,
} = require("jito-ts/dist/sdk/block-engine/searcher");
const { Bundle } = require("jito-ts/dist/sdk/block-engine/types");

const JITO_RPC =
  process.env.JITO_RPC || "https://mainnet.block-engine.jito.wtf";

const jitoClient = searcherClient(JITO_RPC);

const tipAccounts = [
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

class Jito extends Service {
  async sendBundle(bundledTxns) {
    try {
      console.log(chalk.green("Send Bundle:"));
      const bundleResult = await jitoClient.sendBundle(
        new Bundle(bundledTxns, bundledTxns.length)
      );
      console.log(bundleResult);
      if (bundleResult.ok) {
        console.log(chalk.green(`Bundle ${bundleResult} sent.`));
        return true;
      } else {
        throw new Error(bundleResult.error);
      }
    } catch (error) {
      console.error(chalk.red("Error sending bundle:", error.message));
      throw error;
    }
  }

  getTipAcc() {
    const index = Math.floor(Math.random() * tipAccounts.length);
    return new PublicKey(tipAccounts[index]);
  }
}

module.exports = Jito;
