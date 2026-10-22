"use strict";

const { Service } = require("egg");
const bs58 = require("bs58");
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");
const { connection, RPC_URL, usdc } = require("../constants");
const { getJupiterSellTransaction } = require("../libs/jupiterSellFallback");

const RATIO_SCALE = 1000000000n;
const SELL_ATTEMPTS = 3;
const FOMO_SEND_INTERVAL_MS = 1500;
const FOMO_CONFIRMATION_TIMEOUT_MS = 90_000;
const FOMO_RPC_REQUEST_TIMEOUT_MS = 2000;

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createFomoSendConnections() {
  const seen = new Set([RPC_URL]);
  const connections = [connection];
  for (const value of (process.env.FOMO_SEND_RPC_URLS || "").split(",")) {
    const url = value.trim();
    if (!url || seen.has(url)) continue;
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) continue;
      connections.push(new Connection(url, "confirmed"));
      seen.add(url);
    } catch (error) {
      // Ignore malformed optional endpoints and keep the configured primary RPC.
    }
  }
  return connections;
}

const FOMO_SEND_CONNECTIONS = createFomoSendConnections();
const FOMO_MAX_PRIORITY_FEE_LAMPORTS = readPositiveIntegerEnv(
  "FOMO_MAX_PRIORITY_FEE_LAMPORTS",
  500_000,
);
const FOMO_COMPUTE_UNIT_PRICE_MICROLAMPORTS = readPositiveIntegerEnv(
  "FOMO_COMPUTE_UNIT_PRICE_MICROLAMPORTS",
  50_000,
);
const FOMO_BASE_SLIPPAGE_BPS = readPositiveIntegerEnv(
  "FOMO_BASE_SLIPPAGE_BPS",
  500,
);
const FOMO_MAX_SLIPPAGE_BPS = Math.max(
  FOMO_BASE_SLIPPAGE_BPS,
  readPositiveIntegerEnv("FOMO_MAX_SLIPPAGE_BPS", 1500),
);

function retryableSellError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.retryable = true;
  return error;
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function broadcastRawTransaction(rawTransaction, signature) {
  return Promise.any(
    FOMO_SEND_CONNECTIONS.map(async (rpc) => {
      const sentSignature = await withTimeout(
        rpc.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
          maxRetries: 10,
        }),
        FOMO_RPC_REQUEST_TIMEOUT_MS,
        "Transaction broadcast",
      );
      if (sentSignature !== signature) {
        throw new Error(`RPC returned unexpected transaction signature ${sentSignature}`);
      }
      return sentSignature;
    }),
  );
}

async function getKnownSignatureStatus(signature) {
  const results = await Promise.allSettled(
    FOMO_SEND_CONNECTIONS.map(async (rpc) => {
      const result = await withTimeout(
        rpc.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        }),
        FOMO_RPC_REQUEST_TIMEOUT_MS,
        "Signature status lookup",
      );
      return result.value[0] || null;
    }),
  );
  const statuses = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(Boolean);
  return statuses.find((status) =>
    status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized" ||
    status.confirmations === null,
  ) || statuses[0] || null;
}

async function getLatestKnownBlockHeight() {
  const results = await Promise.allSettled(
    FOMO_SEND_CONNECTIONS.map((rpc) =>
      withTimeout(
        rpc.getBlockHeight("confirmed"),
        FOMO_RPC_REQUEST_TIMEOUT_MS,
        "Block height lookup",
      ),
    ),
  );
  const heights = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  return heights.length ? Math.max(...heights) : null;
}

async function confirmAndRebroadcast(ctx, rawTransaction, signature, lastValidBlockHeight) {
  let rebroadcasting = false;
  let blockhashExpired = false;
  const rebroadcastTimer = setInterval(async () => {
    if (blockhashExpired || rebroadcasting) return;
    rebroadcasting = true;
    try {
      await broadcastRawTransaction(rawTransaction, signature);
    } catch (error) {
      ctx.logger.debug(`[Fomo sell] rebroadcast pending (${signature}): ${error.message}`);
    } finally {
      rebroadcasting = false;
    }
  }, FOMO_SEND_INTERVAL_MS);
  rebroadcastTimer.unref?.();

  try {
    const deadline = Date.now() + FOMO_CONFIRMATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await getKnownSignatureStatus(signature).catch(() => null);
      if (status) {
        const isConfirmed = status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized" ||
          status.confirmations === null;
        if (isConfirmed && status.err) {
          throw retryableSellError(
            `Fomo sell transaction failed on chain: ${signature} ${JSON.stringify(status.err)}`,
          );
        }
        if (isConfirmed) return { signature };
      }

      const blockHeight = await getLatestKnownBlockHeight().catch(() => null);
      if (blockHeight !== null && blockHeight > lastValidBlockHeight) {
        blockhashExpired = true;
        if (!status) {
          throw retryableSellError(
            `Fomo sell transaction expired without a recorded status: ${signature}`,
          );
        }
      }

      await pause(1000);
    }

    throw new Error(
      `Fomo sell transaction outcome is still unknown: ${signature}; refusing to submit another transaction`,
    );
  } finally {
    clearInterval(rebroadcastTimer);
  }
}

function parseAddress(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  try {
    return new PublicKey(value.trim());
  } catch (error) {
    throw new Error(`${name} is invalid`);
  }
}

function parseLineId(value) {
  const lineId = Number(value);
  if (!Number.isSafeInteger(lineId) || lineId <= 0) {
    throw new Error("lineId must be a positive integer");
  }
  return lineId;
}

function parseKeypair(privateKey) {
  if (typeof privateKey !== "string" || !privateKey.trim()) {
    throw new Error("privateKey is required");
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKey.trim()));
  } catch (error) {
    throw new Error("privateKey is invalid (expected Base58 Solana secret key)");
  }
}

function decimalAmount(rawAmount, decimals) {
  const amount = String(rawAmount).padStart(decimals + 1, "0");
  if (!decimals) return amount;
  const whole = amount.slice(0, -decimals);
  const fraction = amount.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseRatio(value) {
  const ratio = typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")
    : String(value);
  if (!/^(?:0(?:\.\d{1,9})?|1(?:\.0{1,9})?)$/.test(ratio)) {
    throw new Error("sellRatio must be greater than 0 and at most 1, with up to 9 decimals");
  }
  const [whole, fraction = ""] = ratio.split(".");
  const scaled = BigInt(whole) * RATIO_SCALE + BigInt(fraction.padEnd(9, "0") || "0");
  if (scaled === 0n) throw new Error("sellRatio must be greater than 0");
  return scaled;
}

class Fomo extends Service {
  async checkKey(key) {
    const walletKey = await this.ctx.service.appData.getWalletKey();
    if (typeof key !== "string" || key !== walletKey) {
      throw new Error("Invalid key");
    }
  }

  async ensureLine(lineId) {
    const line = await this.ctx.model.ExecuteLine.findOne({ lineId }).select("_id").lean();
    if (!line) throw new Error("Line not found");
  }

  async importWallet(lineIdValue, privateKey, key) {
    await this.checkKey(key);
    const lineId = parseLineId(lineIdValue);
    await this.ensureLine(lineId);
    const keypair = parseKeypair(privateKey);
    const address = keypair.publicKey.toBase58();
    const existing = await this.ctx.model.FomoWallet.findOne({ lineId, address }).lean();
    if (existing) throw new Error("Fomo wallet already imported");
    await this.ctx.model.FomoWallet.create({
      lineId,
      address,
      privateKey: privateKey.trim(),
    });
    return { lineId, address };
  }

  async updateWallet(lineIdValue, addressValue, newPrivateKey, key) {
    await this.checkKey(key);
    const lineId = parseLineId(lineIdValue);
    await this.ensureLine(lineId);
    const address = parseAddress(addressValue, "address").toBase58();
    const newAddress = parseKeypair(newPrivateKey).publicKey.toBase58();

    try {
      const result = await this.ctx.model.FomoWallet.updateOne(
        { lineId, address },
        { $set: { address: newAddress, privateKey: newPrivateKey.trim() } },
      );
      if (result.matchedCount === 0) throw new Error("Fomo wallet not found");
    } catch (error) {
      if (error.code === 11000) {
        throw new Error("Fomo wallet already imported on this line");
      }
      throw error;
    }

    return { lineId, address: newAddress };
  }

  async deleteWallet(lineIdValue, addressValue, key) {
    await this.checkKey(key);
    const lineId = parseLineId(lineIdValue);
    await this.ensureLine(lineId);
    const address = parseAddress(addressValue, "address").toBase58();
    const wallet = await this.ctx.model.FomoWallet.findOneAndDelete({
      lineId,
      address,
    });
    if (!wallet) throw new Error("Fomo wallet not found");
    return { lineId, address };
  }

  async getWallets(lineIdValue, address) {
    const lineId = parseLineId(lineIdValue);
    await this.ensureLine(lineId);
    const filter = address
      ? { lineId, address: parseAddress(address, "address").toBase58() }
      : { lineId };
    const wallets = await this.ctx.model.FomoWallet.find(filter, { address: 1 })
      .sort({ createTime: 1 })
      .lean();
    if (address && wallets.length === 0) throw new Error("Fomo wallet not found");

    const list = await Promise.all(wallets.map(async (wallet) => {
      const owner = new PublicKey(wallet.address);
      const [lamports, usdcAccounts] = await Promise.all([
        connection.getBalance(owner, "confirmed"),
        connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(usdc) }, "confirmed"),
      ]);
      const usdcRaw = usdcAccounts.value.reduce(
        (total, item) => total + BigInt(item.account.data.parsed.info.tokenAmount.amount),
        0n,
      );
      return {
        lineId,
        address: wallet.address,
        sol: lamports / LAMPORTS_PER_SOL,
        usdc: decimalAmount(usdcRaw, 6),
      };
    }));
    return { total: list.length, list };
  }

  async getTokenBalance(addressValue, tokenValue) {
    const owner = parseAddress(addressValue, "address");
    const mint = parseAddress(tokenValue, "token");
    const [mintInfo, tokenAccounts] = await Promise.all([
      connection.getParsedAccountInfo(mint, "confirmed"),
      connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed"),
    ]);
    const mintAccount = mintInfo.value;
    const decimals = mintAccount?.data?.parsed?.info?.decimals;
    if (
      !mintAccount ||
      (!mintAccount.owner.equals(TOKEN_PROGRAM_ID) &&
        !mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)) ||
      mintAccount.data?.parsed?.type !== "mint" ||
      !Number.isInteger(decimals)
    ) {
      throw new Error("token is not an SPL token mint");
    }
    const amountRaw = tokenAccounts.value.reduce(
      (total, item) => total + BigInt(item.account.data.parsed.info.tokenAmount.amount),
      0n,
    );
    return {
      address: owner.toBase58(),
      token: mint.toBase58(),
      amountRaw: amountRaw.toString(),
      decimals,
      amount: decimalAmount(amountRaw, decimals),
    };
  }

  async sellToken({ lineId, address, token, sellRatio = 1 }) {
    return this.swapToken({
      lineId,
      address,
      token,
      outputMint: new PublicKey(usdc),
      sellRatio,
    });
  }

  async swapUsdcToSol({ lineId, address, sellRatio = 1 }) {
    return this.swapToken({
      lineId,
      address,
      token: usdc,
      outputMint: NATIVE_MINT,
      sellRatio,
    });
  }

  async swapToken({ lineId: lineIdValue, address, token, outputMint, sellRatio }) {
    const startedAt = Date.now();
    let stageStartedAt = startedAt;
    const logDuration = (stage) => {
      const now = Date.now();
      this.ctx.logger.info(
        `[Fomo sell] ${stage} took ${now - stageStartedAt}ms (total ${now - startedAt}ms)`,
      );
      stageStartedAt = now;
    };
    const lineId = parseLineId(lineIdValue);
    await this.ensureLine(lineId);
    const owner = parseAddress(address, "address");
    const mint = parseAddress(token, "token");
    if (mint.equals(outputMint)) throw new Error("Input and output tokens must differ");
    const ratio = parseRatio(sellRatio);
    const wallet = await this.ctx.model.FomoWallet.findOne({
      lineId,
      address: owner.toBase58(),
    })
      .select("+privateKey")
      .lean();
    if (!wallet) throw new Error("Fomo wallet not found");
    const keypair = parseKeypair(wallet.privateKey);
    if (!keypair.publicKey.equals(owner)) throw new Error("Fomo wallet privateKey does not match address");

    const [mintAccount, tokenAccounts] = await Promise.all([
      connection.getAccountInfo(mint, "confirmed"),
      connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed"),
    ]);
    const programId = mintAccount?.owner;
    if (!programId || (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID))) {
      throw new Error("token is not an SPL token mint");
    }
    const tokenAccount = getAssociatedTokenAddressSync(mint, owner, false, programId);
    const tokenAccountInfo = tokenAccounts.value.find(({ pubkey }) => pubkey.equals(tokenAccount));
    if (!tokenAccountInfo) throw new Error("Fomo wallet token account not found");
    const initialTokenAmount = tokenAccountInfo.account.data.parsed.info.tokenAmount;
    const decimals = initialTokenAmount.decimals;
    if (!Number.isInteger(decimals)) throw new Error("Fomo wallet token account has invalid decimals");
    if (BigInt(initialTokenAmount.amount) === 0n) throw new Error("Sell amount is zero");
    logDuration("wallet and token balance lookup");

    let lastError;
    for (let attempt = 0; attempt < SELL_ATTEMPTS; attempt++) {
      const currentTokenAmount = attempt === 0
        ? initialTokenAmount
        : (await connection.getTokenAccountBalance(tokenAccount, "confirmed")).value;
      const balanceRaw = BigInt(currentTokenAmount.amount);
      const amountRaw = balanceRaw * ratio / RATIO_SCALE;
      if (amountRaw === 0n) {
        throw new Error(
          `Sell retry stopped because the associated token account has no sellable balance${lastError ? `: ${lastError.message}` : ""}`,
        );
      }

      const slippageBps = Math.min(
        FOMO_MAX_SLIPPAGE_BPS,
        FOMO_BASE_SLIPPAGE_BPS + attempt * 500,
      );
      try {
        const swapData = await getJupiterSellTransaction(this.ctx, {
          user: owner,
          tokenMint: mint,
          tokenAmount: amountRaw.toString(),
          outputMint,
          slippage: slippageBps / 10000,
          connection,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              priorityLevel: "veryHigh",
              maxLamports: FOMO_MAX_PRIORITY_FEE_LAMPORTS,
            },
          },
          price: FOMO_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
        }, {
          fallbackOnAnyError: true,
          preferDFlow: attempt % 2 === 1,
          includeProvider: true,
        });
        logDuration(`sell route (${swapData.routeProvider}, attempt ${attempt + 1}, ${slippageBps} bps)`);

        let transaction;
        let lastValidBlockHeight = swapData.lastValidBlockHeight;
        if (swapData.swapTransaction) {
          transaction = VersionedTransaction.deserialize(
            Buffer.from(swapData.swapTransaction, "base64"),
          );
          if (!transaction.message.staticAccountKeys[0].equals(owner)) {
            throw new Error("Jupiter swap transaction payer does not match Fomo wallet");
          }
        } else {
          const latestBlockhash = await connection.getLatestBlockhash("confirmed");
          lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
          const message = new TransactionMessage({
            payerKey: owner,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: swapData.instructions,
          }).compileToV0Message(swapData.lookupTableAccounts);
          transaction = new VersionedTransaction(message);
        }
        transaction.sign([keypair]);
        const rawTransaction = transaction.serialize();
        const signature = bs58.encode(Buffer.from(transaction.signatures[0]));

        try {
          await broadcastRawTransaction(rawTransaction, signature);
        } catch (broadcastError) {
          this.ctx.logger.warn(
            `[Fomo sell] initial broadcast failed (${signature}): ${broadcastError.message}`,
          );
        }
        logDuration(`broadcast (${signature})`);

        await confirmAndRebroadcast(
          this.ctx,
          rawTransaction,
          signature,
          lastValidBlockHeight,
        );
        logDuration(`confirmed (${signature})`);
        return {
          lineId,
          address: owner.toBase58(),
          token: mint.toBase58(),
          outputMint: outputMint.toBase58(),
          sellRatio: Number(ratio) / Number(RATIO_SCALE),
          amountRaw: amountRaw.toString(),
          amount: decimalAmount(amountRaw, decimals),
          signature,
          routeProvider: swapData.routeProvider,
          attempts: attempt + 1,
        };
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt + 1 >= SELL_ATTEMPTS) throw error;
        this.ctx.logger.warn(
          `[Fomo sell] attempt ${attempt + 1}/${SELL_ATTEMPTS} failed; refreshing balance and route: ${error.message}`,
        );
      }
    }

    throw lastError || new Error("Fomo sell failed");
  }
}

module.exports = Fomo;
