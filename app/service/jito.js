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

const { connection } = require("../constants");

// Jito Block Engine REST 端点（多地区）
const JITO_BUNDLE_ENDPOINTS = [
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
];

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
  "confirmed",
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
    // return await this.sendBundleJito(bundledTxns);
    return await this.sendBundleNextBlock(bundledTxns);
  }

  /**
   * 使用 Jito Block Engine REST API 发送 bundle（最便宜，min tip ~1000 lamports）
   */
  async sendBundleJito(bundledTxns) {
    try {
      // base58 编码
      const transactions = bundledTxns.map((tx) => serializeTransaction(tx));
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [transactions],
      });

      console.log(
        chalk.green(`Send Bundle via Jito (${transactions.length} txns):`),
      );

      // 广播到所有端点，取第一个成功的
      const results = await Promise.allSettled(
        JITO_BUNDLE_ENDPOINTS.map((url) =>
          fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }).then((r) => r.json()),
        ),
      );

      let bundleId = null;
      for (const r of results) {
        if (r.status === "fulfilled" && r.value?.result) {
          bundleId = r.value.result;
          break;
        }
      }
      if (!bundleId) {
        const errs = results.map((r) =>
          r.status === "fulfilled"
            ? JSON.stringify(r.value)
            : r.reason?.message,
        );
        throw new Error(`All Jito endpoints failed: ${errs.join(" | ")}`);
      }
      console.log(chalk.green(`Bundle accepted, id: ${bundleId}`));
      return bundleId;
    } catch (error) {
      console.error(chalk.red("Error sending bundle via Jito:"), error.message);
      throw error;
    }
  }
  async sendTransaction(tx) {
    const transactions = serializeTransaction(tx);
    const request = {
      method: "sendTransaction",
      params: [
        transactions,
        {
          encoding: "base58",
          skipPreflight: true,
          maxRetries: 0,
          preflightCommitment: "confirmed",
        },
      ],
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

  /**
   * 使用 NextBlock API 发送 bundle，兼容官方文档格式
   * @param {Array<Transaction|VersionedTransaction>} bundledTxns
   * @returns {Promise<string>} bundleId
   */
  async sendBundleNextBlock(bundledTxns) {
    try {
      const apiKey =
        process.env.NEXTBLOCK_API_KEY ||
        "trial1773813120-20KZRalS09daDtkSAHYGiSD7ao/dUZWb1XD1BLiotn8=";
      const endpoint = "https://fra.nextblock.io/api/v2/submit-batch";

      // NextBlock 要求 base64 编码，且格式为 entries[].transaction.content
      const entries = bundledTxns.map((tx) => ({
        transaction: {
          content: Buffer.from(tx.serialize()).toString("base64"),
        },
      }));

      if (!entries.length) {
        throw new Error("No valid transactions to send in bundle");
      }

      console.log(
        chalk.green(`Send Bundle via NextBlock (${entries.length} txns):`),
      );

      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: JSON.stringify({ entries }),
      });

      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error(chalk.red("NextBlock returned non-JSON response:"));
        console.error(text);
        throw new Error(
          `NextBlock returned non-JSON response, status: ${resp.status}`,
        );
      }
      console.log(data);
      if (!resp.ok || data.code) {
        throw new Error(
          `NextBlock error: ${data.message || JSON.stringify(data)}`,
        );
      }
      const bundleId = data.signature || data.bundle_id || data.result;
      console.log(chalk.green(`Bundle accepted, id: ${bundleId}`));
      return bundleId;
    } catch (error) {
      console.error(
        chalk.red("Error sending bundle via NextBlock:"),
        error.message,
      );
      throw error;
    }
  }

  getTipAcc() {
    // 当前使用 NextBlock，返回 NextBlock 官方 tip 地址
    return this.getNextBlockTipAcc();
  }

  getNextBlockTipAcc() {
    // NextBlock 官方 tip 地址
    return new PublicKey("nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG");
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
