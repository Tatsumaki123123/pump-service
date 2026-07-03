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
const NEXTBLOCK_WAIT_MS = Number(process.env.NEXTBLOCK_WAIT_MS || 12000);
const NEXTBLOCK_BATCH_WAIT_MS = Number(
  process.env.NEXTBLOCK_BATCH_WAIT_MS || 30000,
);
const JITO_WAIT_MS = Number(process.env.JITO_WAIT_MS || 30000);
const JITO_RESUBMIT_INTERVAL_MS = Number(
  process.env.JITO_RESUBMIT_INTERVAL_MS || 2000,
);
const DEFAULT_BUNDLE_TIP_SOL = 0.00001;
const NEXTBLOCK_RPC_FALLBACK = process.env.NEXTBLOCK_RPC_FALLBACK !== "false";
const RPC_FALLBACK_CONFIRM_MS = Number(
  process.env.RPC_FALLBACK_CONFIRM_MS || 30000,
);
const BUNDLE_PROVIDER = (
  process.env.BUNDLE_PROVIDER || "quicknode"
).toLowerCase();
const HELIUS_API_KEY =
  process.env.HELIUS_API_KEY || "297bd336-2262-41f0-beda-e19132c7afa6";
const HELIUS_ENDPOINT =
  process.env.HELIUS_ENDPOINT ||
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_BUNDLE_WAIT_MS = Number(
  process.env.HELIUS_BUNDLE_WAIT_MS || 30000,
);
const HELIUS_JITO_FALLBACK_PROVIDER = (
  process.env.HELIUS_JITO_FALLBACK_PROVIDER || "jito"
).toLowerCase();
const QUICKNODE_RPC_URL = process.env.QUICKNODE_RPC_URL || process.env.RPC_URL;
const QUICKNODE_REGION = process.env.QUICKNODE_REGION || "ny";
const QUICKNODE_ENCODING = (process.env.QUICKNODE_ENCODING || "base64").toLowerCase();
const QUICKNODE_PARAM_STYLE = (
  process.env.QUICKNODE_PARAM_STYLE || "both"
).toLowerCase();
const QUICKNODE_WAIT_MS = Number(process.env.QUICKNODE_WAIT_MS || 30000);
const quickNodeConnection = QUICKNODE_RPC_URL
  ? new Connection(QUICKNODE_RPC_URL, "confirmed")
  : connection;
const STANDARD_RPC_URL =
  process.env.STANDARD_RPC_URL ||
  process.env.NORMAL_RPC_URL ||
  process.env.RPC_FALLBACK_URL ||
  process.env.RPC_URL;
const standardConnection = STANDARD_RPC_URL
  ? new Connection(STANDARD_RPC_URL, "confirmed")
  : connection;
const DEFAULT_NEXTBLOCK_ENDPOINTS = [
  "http://ny.nextblock.io/api/v2/submit-batch",
  "http://fra.nextblock.io/api/v2/submit-batch",
];
const NEXTBLOCK_ENDPOINTS = (
  process.env.NEXTBLOCK_ENDPOINTS ||
  process.env.NEXTBLOCK_ENDPOINT ||
  DEFAULT_NEXTBLOCK_ENDPOINTS.join(",")
)
  .split(",")
  .map((endpoint) => endpoint.trim())
  .filter(Boolean);

// Jito Block Engine REST 端点（多地区�?
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

function serializeTransactionBase64(transaction) {
  return Buffer.from(transaction.serialize()).toString("base64");
}

function bundleWritesJitoTipAccount(transactions) {
  const tipSet = new Set(tipAccounts);
  return transactions.some((tx) =>
    tx.message.staticAccountKeys.some(
      (key, index) => tipSet.has(key.toBase58()) && tx.message.isAccountWritable(index),
    ),
  );
}
function getTransactionSignature(transaction) {
  if (!transaction.signatures?.[0]) {
    return "";
  }
  return bs58.encode(Buffer.from(transaction.signatures[0]));
}

class Jito extends Service {
  async waitForBundleTransactions(signatures, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const statuses = await connection.getSignatureStatuses(signatures, {
        searchTransactionHistory: true,
      });
      const values = statuses.value || [];
      const landed = values.filter(Boolean);
      const failed = landed.find((status) => status.err);
      if (failed) {
        throw new Error(
          `Bundle transaction failed: ${JSON.stringify(failed.err)}`,
        );
      }
      if (landed.length === signatures.length) {
        console.log(chalk.green(`Bundle landed: ${signatures.join(", ")}`));
        return values;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(
      `Bundle accepted but not landed within ${timeoutMs}ms: ${signatures.join(", ")}`,
    );
  }

  isBundleNotLandedError(error) {
    return /Bundle accepted but not landed within \d+ms/.test(
      error?.message || "",
    );
  }

  async sendTransactionsByRpc(bundledTxns, signatures) {
    signatures = signatures || bundledTxns.map((tx) => getTransactionSignature(tx));
    console.log(
      chalk.yellow(
        `Fallback broadcast via RPC (${bundledTxns.length} txns): ${signatures.join(", ")}`,
      ),
    );

    const sentSignatures = [];
    for (let i = 0; i < bundledTxns.length; i++) {
      const tx = bundledTxns[i];
      const signature = signatures[i] || getTransactionSignature(tx);
      try {
        const serialized = tx.serialize();
        VersionedTransaction.deserialize(serialized);
        console.log(
          chalk.yellow(
            `RPC tx ${i} serialized size: ${serialized.length} bytes`,
          ),
        );
        const base64Tx = Buffer.from(serialized).toString("base64");
        const rpcResult = await standardConnection._rpcRequest(
          "sendTransaction",
          [
            base64Tx,
            {
              encoding: "base64",
              skipPreflight: false,
              maxRetries: 3,
              preflightCommitment: "confirmed",
            },
          ],
        );
        if (rpcResult.error) {
          throw new Error(
            `sendTransaction RPC error: ${JSON.stringify(rpcResult.error)}`,
          );
        }
        const sentSignature = rpcResult.result;
        sentSignatures.push(sentSignature);
        console.log(chalk.green(`RPC sent tx ${i}: ${sentSignature}`));
      } catch (error) {
        const statuses = await standardConnection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const status = statuses.value?.[0];
        if (status && !status.err) {
          sentSignatures.push(signature);
          console.log(chalk.green(`RPC tx ${i} already landed: ${signature}`));
          continue;
        }

        console.error(chalk.red(`RPC send tx ${i} failed:`), error.message);
        throw error;
      }
    }

    await this.waitForBundleTransactions(
      sentSignatures,
      RPC_FALLBACK_CONFIRM_MS,
    );
    return sentSignatures;
  }
  async sendBundle(bundledTxns) {
    if (BUNDLE_PROVIDER === "helius_jito" || BUNDLE_PROVIDER === "helius") {
      return await this.sendBundleHeliusJito(bundledTxns);
    }
    if (BUNDLE_PROVIDER === "jito") {
      return await this.sendBundleJito(bundledTxns);
    }
    if (BUNDLE_PROVIDER === "quicknode") {
      return await this.setQuickNodeBundle(bundledTxns);
    }
    return await this.sendBundleNextBlock(bundledTxns);
  }

  async waitForHeliusBundle(bundleId, signatures, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resp = await fetch(HELIUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get-bundle-status",
          method: "getBundleStatuses",
          params: [[bundleId]],
        }),
      });
      const data = await resp.json();
      if (data.error) {
        throw new Error(
          `Helius getBundleStatuses error: ${JSON.stringify(data.error)}`,
        );
      }

      const status = data.result?.value?.[0];
      if (status) {
        console.log("Helius bundle status", status);
        const confirmationStatus =
          status.confirmation_status || status.confirmationStatus;
        if (status.err || status.error) {
          throw new Error(
            `Helius bundle failed: ${JSON.stringify(status.err || status.error)}`,
          );
        }
        if (
          ["processed", "confirmed", "finalized"].includes(confirmationStatus)
        ) {
          return status;
        }
      }

      const statuses = await connection.getSignatureStatuses(signatures, {
        searchTransactionHistory: true,
      });
      const values = statuses.value || [];
      const landed = values.filter(Boolean);
      const failed = landed.find((status) => status.err);
      if (failed) {
        throw new Error(
          `Helius bundle transaction failed: ${JSON.stringify(failed.err)}`,
        );
      }
      if (landed.length === signatures.length) {
        console.log(
          chalk.green(`Helius bundle landed: ${signatures.join(", ")}`),
        );
        return values;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(
      `Helius bundle accepted but not landed within ${timeoutMs}ms: ${bundleId} ${signatures.join(", ")}`,
    );
  }

  isHeliusPlanError(error) {
    return /business plans or above|upgrade/i.test(error?.message || "");
  }

  async sendHeliusJitoFallback(bundledTxns) {
    if (HELIUS_JITO_FALLBACK_PROVIDER === "jito") {
      console.log(
        chalk.yellow(
          "Helius Jito is not available for this plan; fallback to Jito Block Engine bundle.",
        ),
      );
      return await this.sendBundleJito(bundledTxns);
    }
    if (HELIUS_JITO_FALLBACK_PROVIDER === "nextblock") {
      console.log(
        chalk.yellow(
          "Helius Jito is not available for this plan; fallback to NextBlock bundle.",
        ),
      );
      return await this.sendBundleNextBlock(bundledTxns);
    }
    throw new Error(
      `Helius Jito is not available for this plan and fallback is disabled: ${HELIUS_JITO_FALLBACK_PROVIDER}`,
    );
  }
  async sendBundleHeliusJito(bundledTxns) {
    try {
      if (bundledTxns.length > 5) {
        throw new Error(
          `Helius Jito bundle supports up to 5 transactions, got ${bundledTxns.length}`,
        );
      }
      const signatures = bundledTxns.map((tx) => getTransactionSignature(tx));
      const transactions = bundledTxns.map((tx) =>
        Buffer.from(tx.serialize()).toString("base64"),
      );
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: "send-bundle",
        method: "sendBundle",
        params: [transactions, { encoding: "base64" }],
      });

      console.log(
        chalk.green(
          `Send Bundle via Helius Jito (${transactions.length} txns):`,
        ),
      );
      console.log("Bundle tx signatures", signatures);

      const resp = await fetch(HELIUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = await resp.json();
      console.log(data);
      if (!resp.ok || data.error) {
        throw new Error(
          `Helius sendBundle error: ${JSON.stringify(data.error || data)}`,
        );
      }

      const bundleId = data.result;
      if (!bundleId) {
        throw new Error(
          `Helius sendBundle missing bundle id: ${JSON.stringify(data)}`,
        );
      }
      console.log(chalk.green(`Helius bundle accepted, id: ${bundleId}`));
      await this.waitForHeliusBundle(
        bundleId,
        signatures,
        HELIUS_BUNDLE_WAIT_MS,
      );
      return bundleId;
    } catch (error) {
      console.error(
        chalk.red("Error sending bundle via Helius Jito:"),
        error.message,
      );
      if (this.isHeliusPlanError(error)) {
        return await this.sendHeliusJitoFallback(bundledTxns);
      }
      throw error;
    }
  }
  async submitBundleJito(body) {
    const results = await Promise.allSettled(
      JITO_BUNDLE_ENDPOINTS.map(async (url) => {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const data = await resp.json();
        if (!resp.ok || data.error) {
          throw new Error(
            `Jito ${url} error: ${JSON.stringify(data.error || data)}`,
          );
        }
        return { url, data };
      }),
    );

    const accepted = results.find((result) => result.status === "fulfilled");
    if (!accepted) {
      const errs = results.map((result) =>
        result.status === "fulfilled"
          ? JSON.stringify(result.value)
          : result.reason?.message,
      );
      throw new Error(`All Jito endpoints failed: ${errs.join(" | ")}`);
    }

    return accepted.value;
  }

  /**
   * 使用 Jito Block Engine REST API 发�?bundle（最便宜，min tip ~1000 lamports�?
   */
  async sendBundleJito(bundledTxns) {
    try {
      if (bundledTxns.length > 5) {
        throw new Error(
          `Jito bundle supports up to 5 transactions, got ${bundledTxns.length}`,
        );
      }

      const signatures = bundledTxns.map((tx) => getTransactionSignature(tx));
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
      console.log("Bundle tx signatures", signatures);

      const deadline = Date.now() + JITO_WAIT_MS;
      let bundleId = null;
      let attempt = 0;
      while (Date.now() < deadline) {
        attempt += 1;
        const { url, data } = await this.submitBundleJito(body);
        bundleId = data.result || bundleId;
        console.log(
          chalk.green(
            `Jito bundle accepted by ${url}, attempt ${attempt}, id: ${bundleId}`,
          ),
        );

        const remainingMs = Math.max(0, deadline - Date.now());
        const waitMs = Math.min(JITO_RESUBMIT_INTERVAL_MS, remainingMs);
        try {
          await this.waitForBundleTransactions(signatures, waitMs);
          return bundleId;
        } catch (waitError) {
          if (!this.isBundleNotLandedError(waitError)) {
            throw waitError;
          }
          if (Date.now() >= deadline) {
            break;
          }
          console.log(
            chalk.yellow(
              `Jito bundle not landed yet; resubmitting same signed bundle in ${JITO_RESUBMIT_INTERVAL_MS}ms window.`,
            ),
          );
        }
      }

      throw new Error(
        `Jito bundle accepted but not landed within ${JITO_WAIT_MS}ms: ${signatures.join(", ")}`,
      );
    } catch (error) {
      console.error(chalk.red("Error sending bundle via Jito:"), error.message);
      throw error;
    }
  }

  async sendTransaction(tx) {
    if (
      BUNDLE_PROVIDER === "quicknode" ||
      BUNDLE_PROVIDER === "jito" ||
      BUNDLE_PROVIDER === "helius_jito" ||
      BUNDLE_PROVIDER === "helius" ||
      BUNDLE_PROVIDER === "nextblock"
    ) {
      return await this.sendBundle([tx]);
    }

    const signature = getTransactionSignature(tx);
    console.log(chalk.yellow(`Send single transaction via RPC: ${signature}`));
    const sentSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    });
    await this.waitForBundleTransactions(
      [sentSignature],
      RPC_FALLBACK_CONFIRM_MS,
    );
    return sentSignature;
  }

  async setQuickNodeBundle(bundledTxns) {
    console.log(chalk.green("Send bundle quick node"));
    if (bundledTxns.length > 5) {
      throw new Error(
        `QuickNode/Jito bundle supports up to 5 transactions, got ${bundledTxns.length}`,
      );
    }

    if (!bundleWritesJitoTipAccount(bundledTxns)) {
      throw new Error(
        "QuickNode/Jito bundle must include a transaction that writes to a Jito tip account. Add a SystemProgram.transfer tip instruction before sending the bundle.",
      );
    }

    const signatures = bundledTxns.map((tx) => getTransactionSignature(tx));
    console.log("Bundle tx signatures", signatures);
    const buildTransactions = (encoding) =>
      bundledTxns.map((tx) =>
        encoding === "base58"
          ? serializeTransaction(tx)
          : serializeTransactionBase64(tx),
      );
    const buildParams = (encoding, style = QUICKNODE_PARAM_STYLE) => {
      const transactions = buildTransactions(encoding);
      if (style === "encoding") {
        return [transactions, { encoding }];
      }
      if (style === "region") {
        return [transactions, QUICKNODE_REGION];
      }
      return [transactions, { encoding, region: QUICKNODE_REGION }];
    };
    const isDecodeError = (error) =>
      /could not be decoded/i.test(
        error?.message || JSON.stringify(error || {}),
      );
    const attempts = [
      { encoding: QUICKNODE_ENCODING, style: QUICKNODE_PARAM_STYLE },
      { encoding: "base64", style: "both" },
      { encoding: "base64", style: "encoding" },
      { encoding: "base58", style: "region" },
      { encoding: "base58", style: "both" },
    ].filter(
      (attempt, index, arr) =>
        arr.findIndex(
          (item) =>
            item.encoding === attempt.encoding && item.style === attempt.style,
        ) === index,
    );

    let result;
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const params = buildParams(attempt.encoding, attempt.style);
      console.log(
        chalk.yellow(
          `QuickNode sendBundle attempt ${i + 1}: encoding=${attempt.encoding}, style=${attempt.style}`,
        ),
      );
      try {
        result = await quickNodeConnection._rpcRequest("sendBundle", params);
      } catch (error) {
        if (isDecodeError(error) && i < attempts.length - 1) {
          console.log(
            chalk.yellow(
              `QuickNode could not decode ${attempt.encoding}/${attempt.style}; retrying with another encoding.`,
            ),
          );
          continue;
        }
        if (isDecodeError(error)) {
          console.log(
            chalk.yellow(
              "QuickNode could not decode transaction with any known parameter style; falling back to normal RPC broadcast.",
            ),
          );
          return await this.sendTransactionsByRpc(bundledTxns, signatures);
        }
        throw error;
      }
      if (
        result.error &&
        isDecodeError(result.error) &&
        i < attempts.length - 1
      ) {
        console.log(
          chalk.yellow(
            `QuickNode could not decode ${attempt.encoding}/${attempt.style}; retrying with another encoding.`,
          ),
        );
        continue;
      }
      break;
    }
    console.log(result);
    if (result.error && isDecodeError(result.error)) {
      console.log(
        chalk.yellow(
          "QuickNode could not decode transaction with any known parameter style; falling back to normal RPC broadcast.",
        ),
      );
      return await this.sendTransactionsByRpc(bundledTxns, signatures);
    }

    if (result.error) {
      throw new Error(
        `QuickNode sendBundle error: ${JSON.stringify(result.error)}. ` +
          "If the error is Method not found, enable the Lil' JIT/Jito bundle add-on on this QuickNode endpoint or set QUICKNODE_RPC_URL to the add-on endpoint.",
      );
    }

    const bundleId = result.result || result.bundle_id || result.signature;
    if (!bundleId) {
      throw new Error(`QuickNode sendBundle missing bundle id: ${JSON.stringify(result)}`);
    }
    console.log(chalk.green(`QuickNode bundle accepted, id: ${bundleId}`));
    await this.waitForBundleTransactions(signatures, QUICKNODE_WAIT_MS);
    return bundleId;
  }

  /**
   * 使用 NextBlock API 发�?bundle，兼容官方文档格�?
   * @param {Array<Transaction|VersionedTransaction>} bundledTxns
   * @returns {Promise<string>} bundleId
   */
  async sendBundleNextBlock(bundledTxns) {
    try {
      const apiKey =
        process.env.NEXTBLOCK_API_KEY ||
        "trial1773813120-20KZRalS09daDtkSAHYGiSD7ao/dUZWb1XD1BLiotn8=";
      const endpoints = NEXTBLOCK_ENDPOINTS;
      const signatures = bundledTxns.map((tx) => getTransactionSignature(tx));
      console.log("Bundle tx signatures", signatures);

      // NextBlock requires base64 content in entries[].transaction.content.
      const entries = bundledTxns.map((tx) => ({
        transaction: {
          content: Buffer.from(tx.serialize()).toString("base64"),
        },
      }));

      if (!entries.length) {
        throw new Error("No valid transactions to send in bundle");
      }

      console.log(
        chalk.green(
          `Send Bundle via NextBlock (${entries.length} txns, ${endpoints.length} endpoints):`,
        ),
      );

      const body = JSON.stringify({ entries });
      const results = await Promise.allSettled(
        endpoints.map(async (endpoint) => {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: apiKey,
            },
            body,
          });

          const text = await resp.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            throw new Error(
              `NextBlock ${endpoint} returned non-JSON response, status: ${resp.status}: ${text}`,
            );
          }

          if (!resp.ok || data.code) {
            throw new Error(
              `NextBlock ${endpoint} error: ${data.message || JSON.stringify(data)}`,
            );
          }
          return { endpoint, data };
        }),
      );

      const accepted = results.find((result) => result.status === "fulfilled");
      if (!accepted) {
        const errors = results.map((result) =>
          result.status === "rejected" ? result.reason?.message : "unknown",
        );
        throw new Error(
          `All NextBlock endpoints failed: ${errors.join(" | ")}`,
        );
      }

      const { endpoint, data } = accepted.value;
      console.log(chalk.green(`NextBlock accepted by ${endpoint}:`), data);
      const bundleId = data.signature || data.bundle_id || data.result;
      console.log(chalk.green(`Bundle accepted, id: ${bundleId}`));
      try {
        const waitMs =
          bundledTxns.length > 1 ? NEXTBLOCK_BATCH_WAIT_MS : NEXTBLOCK_WAIT_MS;
        await this.waitForBundleTransactions(signatures, waitMs);
      } catch (waitError) {
        if (
          !NEXTBLOCK_RPC_FALLBACK ||
          !this.isBundleNotLandedError(waitError)
        ) {
          throw waitError;
        }

        if (bundledTxns.length > 1) {
          console.log(
            chalk.yellow(
              "Batch bundle was not landed; skip RPC split fallback for multi-transaction bundle.",
            ),
          );
          throw waitError;
        }

        console.log(
          chalk.yellow(
            `NextBlock accepted but did not land in ${NEXTBLOCK_WAIT_MS}ms; trying normal RPC fallback.`,
          ),
        );
        const fallbackSignatures = await this.sendTransactionsByRpc(
          bundledTxns,
          signatures,
        );
        return {
          bundleId,
          fallback: "rpc",
          signatures: fallbackSignatures,
        };
      }
      return bundleId;
    } catch (error) {
      console.error(
        chalk.red("Error sending bundle via NextBlock:"),
        error.message,
      );
      throw error;
    }
  }

  getTipAmount() {
    return Math.floor(
      Number(
        process.env.BUNDLE_TIP_SOL ||
          process.env.NEXTBLOCK_TIP_SOL ||
          DEFAULT_BUNDLE_TIP_SOL,
      ) * LAMPORTS_PER_SOL,
    );
  }

  getTipAcc() {
    if (
      BUNDLE_PROVIDER === "jito" ||
      BUNDLE_PROVIDER === "quicknode" ||
      BUNDLE_PROVIDER === "helius_jito" ||
      BUNDLE_PROVIDER === "helius"
    ) {
      return this.getJitoTipAcc();
    }
    return this.getNextBlockTipAcc();
  }

  getJitoTipAcc() {
    const index = Math.floor(Math.random() * tipAccounts.length);
    return new PublicKey(tipAccounts[index]);
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
