"use strict";

const { Service } = require("egg");
const bs58 = require("bs58");
const {
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
const { connection, usdc } = require("../constants");
const JupSDK = require("../libs/jup");

const jup = new JupSDK();
const RATIO_SCALE = 1000000000n;

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

    const mintAccount = await connection.getAccountInfo(mint, "confirmed");
    const programId = mintAccount?.owner;
    if (!programId || (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID))) {
      throw new Error("token is not an SPL token mint");
    }
    const tokenAccount = getAssociatedTokenAddressSync(mint, owner, false, programId);
    const accountInfo = await connection.getAccountInfo(tokenAccount, "confirmed");
    if (!accountInfo) throw new Error("Fomo wallet token account not found");
    const tokenBalance = await connection.getTokenAccountBalance(tokenAccount, "confirmed");
    const balanceRaw = BigInt(tokenBalance.value.amount);
    const amountRaw = balanceRaw * ratio / RATIO_SCALE;
    if (amountRaw === 0n) throw new Error("Sell amount is zero");

    const { instructions, lookupTableAccounts } = await jup.getSellInstructions(this.ctx, {
      user: owner,
      tokenMint: mint,
      tokenAmount: amountRaw.toString(),
      outputMint,
      slippage: 0.01,
      connection,
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(lookupTableAccounts);
    const transaction = new VersionedTransaction(message);
    transaction.sign([keypair]);
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 2,
    });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(`Fomo swap transaction failed: ${signature} ${JSON.stringify(confirmation.value.err)}`);
    }
    return {
      lineId,
      address: owner.toBase58(),
      token: mint.toBase58(),
      outputMint: outputMint.toBase58(),
      sellRatio: Number(ratio) / Number(RATIO_SCALE),
      amountRaw: amountRaw.toString(),
      amount: decimalAmount(amountRaw, tokenBalance.value.decimals),
      signature,
    };
  }
}

module.exports = Fomo;
