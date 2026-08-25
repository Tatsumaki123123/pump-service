"use strict";

const { Service } = require("egg");
const bs58 = require("bs58");
const { PublicKey } = require("@solana/web3.js");
const {
  connection,
  AXIOM_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
} = require("../constants");

const RECENT_TRANSACTION_LIMIT = 10;
const CLAIM_CASHBACK_DISCRIMINATOR = Buffer.from([
  37, 58, 35, 126, 190, 53, 228, 197,
]);

function getPositiveEnvNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const WALLET_CONCURRENCY = Math.max(
  1,
  Math.floor(getPositiveEnvNumber("AXIOM_WALLET_CONCURRENCY", 10)),
);
const RPC_REQUESTS_PER_SECOND = Math.min(
  10,
  getPositiveEnvNumber("AXIOM_RPC_REQUESTS_PER_SECOND", 10),
);
const RPC_REQUEST_INTERVAL_MS = Math.ceil(1000 / RPC_REQUESTS_PER_SECOND);
const RPC_RETRY_ATTEMPTS = Math.max(
  1,
  Math.floor(getPositiveEnvNumber("AXIOM_RPC_RETRY_ATTEMPTS", 5)),
);
let rpcSchedule = Promise.resolve();
let nextRpcRequestAt = 0;

function sleepMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRateLimitError(error) {
  const message = String(error?.message || error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("request limit") ||
    message.includes("limited to") ||
    message.includes("too many requests") ||
    message.includes("exceeded")
  );
}

function getRetryDelay(error, attempt) {
  const retryAfter = Number(
    error?.response?.headers?.["retry-after"] ||
      error?.response?.headers?.get?.("retry-after"),
  );
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }

  const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
  return backoff + Math.floor(Math.random() * 250);
}

function enqueueRpcRequest(request) {
  const scheduledRequest = rpcSchedule.then(async () => {
    const wait = Math.max(0, nextRpcRequestAt - Date.now());
    if (wait > 0) await sleepMilliseconds(wait);
    nextRpcRequestAt =
      Math.max(nextRpcRequestAt, Date.now()) + RPC_REQUEST_INTERVAL_MS;

    try {
      return await request();
    } catch (error) {
      if (isRateLimitError(error)) {
        nextRpcRequestAt = Math.max(
          nextRpcRequestAt,
          Date.now() + Math.max(2000, getRetryDelay(error, 1)),
        );
      }
      throw error;
    }
  });

  rpcSchedule = scheduledRequest.catch(() => undefined);
  return scheduledRequest;
}

async function callRpc(method, request) {
  for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt++) {
    try {
      return await enqueueRpcRequest(request);
    } catch (error) {
      if (!isRateLimitError(error) || attempt === RPC_RETRY_ATTEMPTS) {
        throw error;
      }

      const delay = getRetryDelay(error, attempt);
      console.warn(
        `Axiom RPC ${method} rate limited; retry ${attempt}/${RPC_RETRY_ATTEMPTS - 1} in ${delay}ms`,
      );
      await sleepMilliseconds(delay);
    }
  }

  throw new Error(`Axiom RPC ${method} failed`);
}

function toPublicKeyString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  return value.toString();
}

function parseTime(value, name, isEndTime = false) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required`);
  }

  const text = String(value).trim();
  let date;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    date = new Date(text.length <= 10 ? numeric * 1000 : numeric);
  } else {
    date = new Date(text);
    if (isEndTime && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      date.setUTCHours(23, 59, 59, 999);
    }
  }

  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} is invalid`);
  }

  return date;
}

function hasAxiomInstruction(transaction) {
  const instructions = [
    ...(transaction?.transaction?.message?.instructions || []),
    ...(transaction?.meta?.innerInstructions || []).flatMap(
      (item) => item.instructions || [],
    ),
  ];
  const axiomProgram = AXIOM_PROGRAM_ID.toBase58();

  return instructions.some((instruction) => {
    const programId = toPublicKeyString(instruction.programId);
    return programId === axiomProgram || instruction.program === axiomProgram;
  });
}

function hasPumpCashbackInstruction(transaction) {
  const instructions = [
    ...(transaction?.transaction?.message?.instructions || []),
    ...(transaction?.meta?.innerInstructions || []).flatMap(
      (item) => item.instructions || [],
    ),
  ];
  const pumpAmmProgram = PUMP_AMM_PROGRAM_ID.toBase58();

  return instructions.some((instruction) => {
    const programId = toPublicKeyString(instruction.programId);
    const isPumpAmmInstruction =
      programId === pumpAmmProgram || instruction.program === "pump_amm";
    if (!isPumpAmmInstruction) return false;

    if (instruction.parsed?.type === "claim_cashback") return true;
    if (typeof instruction.data !== "string") return false;

    try {
      const data = Buffer.from(bs58.decode(instruction.data));
      return data
        .subarray(0, CLAIM_CASHBACK_DISCRIMINATOR.length)
        .equals(CLAIM_CASHBACK_DISCRIMINATOR);
    } catch (error) {
      return false;
    }
  });
}

function hasTransferToAddress(transaction, sourceAddress, destinationAddress) {
  const instructions = [
    ...(transaction?.transaction?.message?.instructions || []),
    ...(transaction?.meta?.innerInstructions || []).flatMap(
      (item) => item.instructions || [],
    ),
  ];

  return instructions.some((instruction) => {
    const parsed = instruction?.parsed;
    const info = parsed?.info;
    if (parsed?.type !== "transfer" || !info) return false;

    return (
      toPublicKeyString(info.destination) === destinationAddress &&
      toPublicKeyString(info.source) === sourceAddress
    );
  });
}

function isSigner(transaction, address) {
  return (transaction?.transaction?.message?.accountKeys || []).some(
    (account) =>
      account.signer === true && toPublicKeyString(account.pubkey) === address,
  );
}

async function runWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  };

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run(),
  );
  await Promise.all(runners);
  return results;
}

class AxiomWalletService extends Service {
  async getAxiomWallets({ startTime, endTime, eid } = {}) {
    const scanStartedAt = Date.now();
    const start = parseTime(startTime, "startTime");
    const end = parseTime(endTime, "endTime", true);
    const startTimestamp = Math.floor(start.getTime() / 1000);
    const endTimestamp = Math.floor(end.getTime() / 1000);

    if (startTimestamp > endTimestamp) {
      throw new Error("startTime must be less than or equal to endTime");
    }

    const executeDataFilter = {
      createTime: {
        $gte: start,
        $lte: end,
      },
    };
    if (eid !== undefined && eid !== null && String(eid).trim() !== "") {
      const numericEid = Number(eid);
      if (!Number.isInteger(numericEid)) {
        throw new Error("eid must be an integer");
      }
      executeDataFilter.eid = numericEid;
    }

    const executeDataList = await this.ctx.model.ExecuteData.find(
      executeDataFilter,
      { eid: 1, createTime: 1 },
    ).lean();
    const eids = [
      ...new Set(
        executeDataList
          .map((item) => item.eid)
          .filter((item) => Number.isInteger(item)),
      ),
    ];

    const wallets = eids.length
      ? await this.ctx.model.ExecuteWallet.find(
          {
            eid: { $in: eids },
            address: { $exists: true, $ne: "" },
          },
          {
            address: 1,
            eid: 1,
            isActive: 1,
          },
        ).lean()
      : [];
    const appData = await this.ctx.model.AppData.findOne(
      {},
      { receiveAddress: 1 },
    ).lean();
    const receiveAddress = String(appData?.receiveAddress || "").trim();

    this.logger.info(
      `[Axiom] execute data matched: batches=${executeDataList.length}, ` +
        `eids=${eids.length}, wallets=${wallets.length}`,
    );

    /*
     * ExecuteData.createTime selects the wallet batches. The transaction time
     * range is still applied below because the most recent 10 wallet
     * transactions may fall outside the requested interval.
     */
    this.logger.info(
      `[Axiom] scan started: wallets=${wallets.length}, ` +
        `start=${start.toISOString()}, end=${end.toISOString()}, ` +
        `concurrency=${WALLET_CONCURRENCY}, rpcRate=${RPC_REQUESTS_PER_SECOND}/s, ` +
        `excludeReceiveAddress=${receiveAddress || "none"}`,
    );

    const matchedWallets = await runWithConcurrency(
      wallets,
      (wallet) =>
        this.scanWallet(wallet, startTimestamp, endTimestamp, receiveAddress),
      WALLET_CONCURRENCY,
    );

    const list = matchedWallets
      .filter(Boolean)
      .sort((left, right) => right.lastTradeTime - left.lastTradeTime)
      .map((wallet) => ({
        ...wallet,
        firstTradeTime: new Date(wallet.firstTradeTime * 1000).toISOString(),
        lastTradeTime: new Date(wallet.lastTradeTime * 1000).toISOString(),
      }));

    this.logger.info(
      `[Axiom] scan completed: scanned=${wallets.length}, ` +
        `matched=${list.length}, elapsed=${Date.now() - scanStartedAt}ms`,
    );

    return {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      total: list.length,
      list,
    };
  }

  async getPumpWallets({ startTime, endTime, eid } = {}) {
    const scanStartedAt = Date.now();
    const start = parseTime(startTime, "startTime");
    const end = parseTime(endTime, "endTime", true);

    if (start.getTime() > end.getTime()) {
      throw new Error("startTime must be less than or equal to endTime");
    }

    const executeDataFilter = {
      createTime: {
        $gte: start,
        $lte: end,
      },
    };
    if (eid !== undefined && eid !== null && String(eid).trim() !== "") {
      const numericEid = Number(eid);
      if (!Number.isInteger(numericEid)) {
        throw new Error("eid must be an integer");
      }
      executeDataFilter.eid = numericEid;
    }

    const executeDataList = await this.ctx.model.ExecuteData.find(
      executeDataFilter,
      { eid: 1, createTime: 1 },
    ).lean();
    const eids = [
      ...new Set(
        executeDataList
          .map((item) => item.eid)
          .filter((item) => Number.isInteger(item)),
      ),
    ];
    const wallets = eids.length
      ? await this.ctx.model.ExecuteWallet.find(
          {
            eid: { $in: eids },
            address: { $exists: true, $ne: "" },
          },
          {
            address: 1,
            eid: 1,
            isActive: 1,
          },
        ).lean()
      : [];
    const appData = await this.ctx.model.AppData.findOne(
      {},
      { receiveAddress: 1 },
    ).lean();
    const receiveAddress = String(appData?.receiveAddress || "").trim();

    this.logger.info(
      `[Pump] execute data matched: batches=${executeDataList.length}, ` +
        `eids=${eids.length}, wallets=${wallets.length}`,
    );
    this.logger.info(
      `[Pump] scan started: wallets=${wallets.length}, ` +
        `start=${start.toISOString()}, end=${end.toISOString()}, ` +
        `concurrency=${WALLET_CONCURRENCY}, rpcRate=${RPC_REQUESTS_PER_SECOND}/s, ` +
        `excludeReceiveAddress=${receiveAddress || "none"}`,
    );

    const matchedWallets = await runWithConcurrency(
      wallets,
      (wallet) => this.scanPumpWallet(wallet, receiveAddress),
      WALLET_CONCURRENCY,
    );
    const list = matchedWallets.filter(Boolean);

    this.logger.info(
      `[Pump] scan completed: scanned=${wallets.length}, ` +
        `matched=${list.length}, elapsed=${Date.now() - scanStartedAt}ms`,
    );

    return {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      total: list.length,
      list,
    };
  }

  async scanPumpWallet(wallet, receiveAddress) {
    let publicKey;
    try {
      publicKey = new PublicKey(wallet.address);
    } catch (error) {
      this.logger.warn(
        `Skip invalid execute wallet address: ${wallet.address}`,
      );
      return null;
    }

    const signatures = await callRpc("getSignaturesForAddress", () =>
      connection.getSignaturesForAddress(publicKey, {
        limit: RECENT_TRANSACTION_LIMIT,
      }),
    );
    const rpcSignatures = signatures.filter((item) => !item.err);

    if (rpcSignatures.length > 0) {
      const transactions = await callRpc("getParsedTransactions", () =>
        connection.getParsedTransactions(
          rpcSignatures.map((item) => item.signature),
          {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          },
        ),
      );
      const transactionBySignature = new Map(
        rpcSignatures.map((item, index) => [
          item.signature,
          transactions[index],
        ]),
      );

      if (
        receiveAddress &&
        rpcSignatures.some((item) =>
          hasTransferToAddress(
            transactionBySignature.get(item.signature),
            wallet.address,
            receiveAddress,
          ),
        )
      ) {
        this.logger.info(
          `[Pump] wallet skipped: address=${wallet.address}, ` +
            `reason=transfer_to_receive_address, receiveAddress=${receiveAddress}`,
        );
        return null;
      }

      // if (
      //   rpcSignatures.some((item) => {
      //     const transaction = transactionBySignature.get(item.signature);
      //     return transaction &&
      //       !transaction.meta?.err &&
      //       hasPumpCashbackInstruction(transaction);
      //   })
      // ) {
      //   this.logger.info(
      //     `[Pump] wallet skipped: address=${wallet.address}, ` +
      //       "reason=claim_cashback",
      //   );
      //   return null;
      // }
    }

    const result = {
      address: wallet.address,
      eid: wallet.eid,
      isActive: wallet.isActive,
    };
    this.logger.info(`[Pump] wallet matched: address=${result.address}`);
    return result;
  }

  async scanWallet(wallet, startTimestamp, endTimestamp, receiveAddress) {
    let publicKey;
    try {
      publicKey = new PublicKey(wallet.address);
    } catch (error) {
      this.logger.warn(
        `Skip invalid execute wallet address: ${wallet.address}`,
      );
      return null;
    }

    return this.scanWalletByRpc(
      wallet,
      publicKey,
      startTimestamp,
      endTimestamp,
      receiveAddress,
    );
  }

  async scanWalletByRpc(
    wallet,
    publicKey,
    startTimestamp,
    endTimestamp,
    receiveAddress,
  ) {
    const signatures = await callRpc("getSignaturesForAddress", () =>
      connection.getSignaturesForAddress(publicKey, {
        limit: RECENT_TRANSACTION_LIMIT,
      }),
    );
    const candidates = signatures.filter(
      (item) =>
        !item.err &&
        Number.isFinite(item.blockTime) &&
        item.blockTime >= startTimestamp &&
        item.blockTime <= endTimestamp,
    );
    const matchedTransactions = [];

    const rpcSignatures = signatures.filter((item) => !item.err);
    if (rpcSignatures.length > 0 && (candidates.length > 0 || receiveAddress)) {
      const transactions = await callRpc("getParsedTransactions", () =>
        connection.getParsedTransactions(
          rpcSignatures.map((item) => item.signature),
          {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          },
        ),
      );
      const transactionBySignature = new Map(
        rpcSignatures.map((item, index) => [
          item.signature,
          transactions[index],
        ]),
      );

      if (
        receiveAddress &&
        rpcSignatures.some((item) =>
          hasTransferToAddress(
            transactionBySignature.get(item.signature),
            wallet.address,
            receiveAddress,
          ),
        )
      ) {
        this.logger.info(
          `[Axiom] wallet skipped: address=${wallet.address}, ` +
            `reason=transfer_to_receive_address, receiveAddress=${receiveAddress}`,
        );
        return null;
      }

      const transactionIndex = candidates.findIndex((signatureInfo) => {
        const transaction = transactionBySignature.get(signatureInfo.signature);
        return (
          transaction &&
          !transaction.meta?.err &&
          hasAxiomInstruction(transaction) &&
          isSigner(transaction, wallet.address)
        );
      });
      if (transactionIndex >= 0) {
        const signatureInfo = candidates[transactionIndex];
        matchedTransactions.push({
          signature: signatureInfo.signature,
          blockTime: signatureInfo.blockTime,
        });
      }
    }

    const result = this.buildWalletResult(wallet, matchedTransactions);
    if (result) {
      this.logger.info(
        `[Axiom] wallet matched: address=${result.address}, ` +
          `signature=${result.lastSignature}`,
      );
    }
    return result;
  }

  buildWalletResult(wallet, matchedTransactions) {
    if (matchedTransactions.length === 0) return null;
    matchedTransactions.sort((left, right) => left.blockTime - right.blockTime);
    const first = matchedTransactions[0];
    const last = matchedTransactions[matchedTransactions.length - 1];

    return {
      address: wallet.address,
      eid: wallet.eid,
      isActive: wallet.isActive,
      tradeCount: matchedTransactions.length,
      firstTradeTime: first.blockTime,
      lastTradeTime: last.blockTime,
      lastSignature: last.signature,
    };
  }
}

module.exports = AxiomWalletService;
