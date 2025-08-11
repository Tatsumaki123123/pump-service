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

const { connection } = require("../constants");

const JITO_RPC =
  process.env.JITO_RPC || "https://mainnet.block-engine.jito.wtf";

// const jitoClient = searcherClient(
//   "https://little-practical-lake.solana-mainnet.quiknode.pro/748dd52b1227a0602d41ef4ac30d2b4a01f39dc3/"
// );

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

const SLOT_API_KEY = "";
const slot0Connection = new Connection(
  `https://ny.0slot.trade?api-key=${SLOT_API_KEY}`,
  "confirmed"
);

const SLOT_TIP_ACCOUNTS = [
  "TpdxgNJBWZRL8UXF5mrEsyWxDWx9HQexA9P1eTWQ42p",
  "7y4whZmw388w1ggjToDLSBLv47drw5SUXcLk6jtmwixd",
  "4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4",
  "J9BMEWFbCBEjtQ1fG5Lo9kouX1HfrKQxeUxetwXrifBw",
  "FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe",
  "8mR3wB1nh4D6J9RUCugxUpc6ya8w38LPxZ3ZjcBhgzws",
];

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
  async sendTransaction(tx) {
    const transactions = serializeTransaction(tx);
    const request = {
      method: "sendTransaction",
      params: [transactions, "ny"],
    };
    const result = await connection._rpcRequest(request.method, request.params);

    return result;
  }

  async setQuickNodeBundle(bundledTxns) {
    console.log(chalk.green("Send bundle quick node"));
    const transactions = bundledTxns.map((tx) => serializeTransaction(tx));
    const request = {
      method: "sendBundle",
      params: [transactions, "ny"],
    };

    const result = await connection._rpcRequest(request.method, request.params);

    return result;
  }

  getTipAcc() {
    const index = Math.floor(Math.random() * tipAccounts.length);
    return new PublicKey(tipAccounts[index]);
  }

  get0slotTipAcc() {
    const index = Math.floor(Math.random() * SLOT_TIP_ACCOUNTS.length);
    return new PublicKey(SLOT_TIP_ACCOUNTS[index]);
  }

  async send0SlotTransaction(ixs, wallet, tipAmount = 0.001) {
    const tipReceiver = get0slotTipAcc();
    const tipTransferIx = SystemProgram.transfer({
      fromPubkey: wallet.publicKey, // Sender's public key.
      toPubkey: tipReceiver, // Tip receiver's public key.
      lamports: tipAmount * LAMPORTS_PER_SOL, // Amount to transfer as a tip (0.001 SOL in this case).
    });
    const volumeIxs = [...ixs, tipTransferIx];
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: volumeIxs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet]);

    const signature = await slot0Connection.sendTransaction(tx);
    await slot0Connection.confirmTransaction(signature, "processed");
    console.log(chalk.green("0Slot transaction signature:", signature));
    return true;
  }
}

module.exports = Jito;
