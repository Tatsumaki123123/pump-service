"use strict";

const { Service } = require("egg");
const bs58 = require("bs58");
const {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const { connection } = require("../constants");

const MULTIPLE_ACCOUNTS_LIMIT = 100;
const SIGNATURE_STATUS_POLL_MS = 500;
const SIGNATURE_CONFIRM_TIMEOUT_MS = 30000;

function normalizeAddress(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }

  try {
    return new PublicKey(value.trim()).toBase58();
  } catch (error) {
    throw new Error(`${name} is invalid`);
  }
}

function getWalletAddress(wallet, index) {
  if (typeof wallet === "string") return wallet;
  if (wallet && typeof wallet === "object") {
    return wallet.address || wallet.publicKey;
  }
  throw new Error(`wallets[${index}] is invalid`);
}

function keypairFromWallet(wallet) {
  let keypair;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(wallet.privateKey));
  } catch (error) {
    throw new Error("wallet privateKey is invalid");
  }

  if (keypair.publicKey.toBase58() !== wallet.address) {
    throw new Error("wallet privateKey does not match address");
  }

  return keypair;
}

function normalizeAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("amount must be a positive number");
  }

  const lamports = Math.round(value * LAMPORTS_PER_SOL);
  if (lamports <= 0) {
    throw new Error("amount is too small");
  }
  if (!Number.isSafeInteger(lamports)) {
    throw new Error("amount is too large");
  }

  return { amount: lamports / LAMPORTS_PER_SOL, lamports };
}

async function waitForSignatureConfirmation(signature) {
  const deadline = Date.now() + SIGNATURE_CONFIRM_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await connection.getSignatureStatuses(
      [signature],
      { searchTransactionHistory: true },
    );
    const status = response?.value?.[0];

    if (status?.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(status.err)}`,
      );
    }

    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return status;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, SIGNATURE_STATUS_POLL_MS),
    );
  }

  throw new Error(
    `Transaction sent but confirmation timed out: ${signature}`,
  );
}

class WalletAdmin extends Service {
  async getWalletBalances(wallets) {
    if (!Array.isArray(wallets) || wallets.length === 0) {
      throw new Error("wallets must be a non-empty array");
    }

    const addresses = [];
    for (let index = 0; index < wallets.length; index++) {
      const address = normalizeAddress(
        getWalletAddress(wallets[index], index),
        `wallets[${index}]`,
      );
      if (!addresses.includes(address)) addresses.push(address);
    }

    const list = [];
    for (
      let index = 0;
      index < addresses.length;
      index += MULTIPLE_ACCOUNTS_LIMIT
    ) {
      const batch = addresses.slice(index, index + MULTIPLE_ACCOUNTS_LIMIT);
      const accountInfos = await connection.getMultipleAccountsInfo(
        batch.map((address) => new PublicKey(address)),
        "confirmed",
      );

      accountInfos.forEach((accountInfo, batchIndex) => {
        const lamports = accountInfo?.lamports || 0;
        list.push({
          address: batch[batchIndex],
          exists: Boolean(accountInfo),
          balanceLamports: lamports,
          balance: lamports / LAMPORTS_PER_SOL,
          sol: lamports / LAMPORTS_PER_SOL,
        });
      });
    }

    const totalBalanceLamports = list.reduce(
      (total, item) => total + item.balanceLamports,
      0,
    );
    return {
      total: list.length,
      totalBalanceLamports,
      totalBalance: totalBalanceLamports / LAMPORTS_PER_SOL,
      totalSol: totalBalanceLamports / LAMPORTS_PER_SOL,
      list,
    };
  }

  async getWalletPrivateKey(address, key) {
    const walletAddress = normalizeAddress(address, "address");
    const accessKey = await this.ctx.service.appData.getWalletKey();
    if (typeof key !== "string" || key !== accessKey) {
      throw new Error("Invalid key");
    }

    const wallet = await this.ctx.model.ExecuteWallet.findOne(
      { address: walletAddress },
      { address: 1, privateKey: 1 },
    ).lean();
    if (!wallet) {
      throw new Error("Wallet not found");
    }

    keypairFromWallet(wallet);
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
    };
  }

  async transferWalletBalance(wallets) {
    const receiveAddress = await this.ctx.service.appData.getReceiveAddress();
    const recipient = new PublicKey(
      normalizeAddress(receiveAddress, "AppData.receiveAddress"),
    );
    if (!Array.isArray(wallets) || wallets.length === 0) {
      throw new Error("wallets must be a non-empty array");
    }

    const addresses = [];
    for (let index = 0; index < wallets.length; index++) {
      const address = normalizeAddress(
        getWalletAddress(wallets[index], index),
        `wallets[${index}]`,
      );
      if (!addresses.includes(address)) addresses.push(address);
    }

    const walletData = await this.ctx.model.ExecuteWallet.find(
      { address: { $in: addresses } },
      { address: 1, privateKey: 1 },
    ).lean();
    const walletMap = new Map(
      walletData.map((wallet) => [wallet.address, wallet]),
    );

    const list = [];
    for (const address of addresses) {
      if (address === recipient.toBase58()) {
        list.push({
          address,
          status: "skipped",
          message: "Source wallet is the recipient",
        });
        continue;
      }

      const wallet = walletMap.get(address);
      if (!wallet) {
        list.push({
          address,
          status: "not_found",
          message: "Wallet not found",
        });
        continue;
      }

      try {
        const keypair = keypairFromWallet(wallet);
        const balanceLamports = await connection.getBalance(
          keypair.publicKey,
          "confirmed",
        );
        const { blockhash } =
          await connection.getLatestBlockhash("confirmed");
        const feeInstruction = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipient,
          lamports: 1,
        });
        const feeMessage = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions: [feeInstruction],
        }).compileToV0Message();
        const feeResponse = await connection.getFeeForMessage(
          feeMessage,
          "confirmed",
        );
        if (!Number.isFinite(feeResponse.value)) {
          throw new Error("Unable to calculate transaction fee");
        }
        const feeLamports = feeResponse.value;
        const transferLamports = balanceLamports - feeLamports;

        if (transferLamports <= 0) {
          list.push({
            address,
            status: "skipped",
            balanceLamports,
            feeLamports,
            transferLamports: 0,
            message: "Balance is not enough to cover the transaction fee",
          });
          continue;
        }

        const instruction = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipient,
          lamports: transferLamports,
        });
        const message = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions: [instruction],
        }).compileToV0Message();
        const transaction = new VersionedTransaction(message);
        transaction.sign([keypair]);
        const signature = await connection.sendTransaction(transaction, {
          skipPreflight: false,
          maxRetries: 2,
        });
        await waitForSignatureConfirmation(signature);

        list.push({
          address,
          status: "success",
          balanceLamports,
          feeLamports,
          transferLamports,
          signature,
        });
      } catch (error) {
        list.push({
          address,
          status: "failed",
          message: error.message,
        });
      }
    }

    return {
      receiveAddress: recipient.toBase58(),
      total: list.length,
      success: list.filter((item) => item.status === "success").length,
      skipped: list.filter((item) => item.status === "skipped").length,
      failed: list.filter(
        (item) => item.status === "failed" || item.status === "not_found",
      ).length,
      list,
    };
  }

  async transferFromReceiveAddress(targetAddress, amount = 0.01) {
    const receiveWallet = await this.ctx.service.appData.getReceiveWallet();
    const configuredSourceAddress = normalizeAddress(
      receiveWallet.address,
      "AppData.receiveAddress",
    );
    const sourceKeypair = keypairFromWallet({
      ...receiveWallet,
      address: configuredSourceAddress,
    });
    const sourceAddress = sourceKeypair.publicKey.toBase58();
    const recipient = new PublicKey(normalizeAddress(targetAddress, "address"));
    const normalizedAmount = normalizeAmount(amount);

    if (sourceAddress === recipient.toBase58()) {
      throw new Error("Source wallet is the recipient");
    }

    const balanceLamports = await connection.getBalance(
      sourceKeypair.publicKey,
      "confirmed",
    );
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const feeInstruction = SystemProgram.transfer({
      fromPubkey: sourceKeypair.publicKey,
      toPubkey: recipient,
      lamports: 1,
    });
    const feeMessage = new TransactionMessage({
      payerKey: sourceKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [feeInstruction],
    }).compileToV0Message();
    const feeResponse = await connection.getFeeForMessage(
      feeMessage,
      "confirmed",
    );
    if (!Number.isFinite(feeResponse.value)) {
      throw new Error("Unable to calculate transaction fee");
    }

    const feeLamports = feeResponse.value;
    if (balanceLamports < normalizedAmount.lamports + feeLamports) {
      throw new Error(
        `Insufficient balance: ${balanceLamports} lamports available, ${
          normalizedAmount.lamports + feeLamports
        } required`,
      );
    }

    const instruction = SystemProgram.transfer({
      fromPubkey: sourceKeypair.publicKey,
      toPubkey: recipient,
      lamports: normalizedAmount.lamports,
    });
    const message = new TransactionMessage({
      payerKey: sourceKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [instruction],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([sourceKeypair]);
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 2,
    });
    await waitForSignatureConfirmation(signature);

    return {
      sourceAddress,
      targetAddress: recipient.toBase58(),
      amount: normalizedAmount.amount,
      amountLamports: normalizedAmount.lamports,
      feeLamports,
      signature,
    };
  }
}

module.exports = WalletAdmin;
