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
const bs58 = require("bs58");
require("dotenv").config();
const chalk = require("chalk");

const {
  SearcherClient,
  searcherClient,
} = require("jito-ts/dist/sdk/block-engine/searcher");
const { Bundle } = require("jito-ts/dist/sdk/block-engine/types");

const JITO_RPC =
  process.env.JITO_RPC || "https://mainnet.block-engine.jito.wtf";

const jitoClient = searcherClient(
  "https://little-practical-lake.solana-mainnet.quiknode.pro/748dd52b1227a0602d41ef4ac30d2b4a01f39dc3/"
);

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

const quickNodeConnection = new Connection(
  "https://little-practical-lake.solana-mainnet.quiknode.pro/748dd52b1227a0602d41ef4ac30d2b4a01f39dc3/",
  "confirmed"
);

function serializeTransaction(transaction) {
  const serialized = transaction.serialize();
  return bs58.encode(serialized);
}

class Jito extends Service {
  async sendBundle(bundledTxns) {
    return await this.setQuickNodeBundle(bundledTxns);
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

  async setQuickNodeBundle(bundledTxns) {
    console.log(chalk.green("Send bundle quick node"));
    const transactions = bundledTxns.map((tx) => serializeTransaction(tx));
    const request = {
      method: "sendBundle",
      params: [transactions, "ny"],
    };

    const result = await quickNodeConnection._rpcRequest(
      request.method,
      request.params
    );

    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  getTipAcc() {
    const index = Math.floor(Math.random() * tipAccounts.length);
    return new PublicKey(tipAccounts[index]);
  }
}

module.exports = Jito;
