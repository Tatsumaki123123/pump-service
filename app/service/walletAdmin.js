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
const {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { connection } = require("../constants");
const { WSOL_TOKEN_ACCOUNT } = require("../constants");
const PumpSwapSDK = require("../libs/pumpSwap");

const MULTIPLE_ACCOUNTS_LIMIT = 100;
const CLAIM_CASHBACK_FUNDING_AMOUNT = 0.01;
const SIGNATURE_STATUS_POLL_MS = 500;
const SIGNATURE_CONFIRM_TIMEOUT_MS = 30000;
const pumpSwap = new PumpSwapSDK();

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
    if (Array.isArray(targetAddress)) {
      if (targetAddress.length === 0) {
        throw new Error("address must be a non-empty array");
      }

      const list = [];
      for (const address of targetAddress) {
        try {
          const result = await this.transferFromReceiveAddress(address, amount);
          list.push({
            address: result.targetAddress,
            status: "success",
            ...result,
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
        total: list.length,
        success: list.filter((item) => item.status === "success").length,
        failed: list.filter((item) => item.status === "failed").length,
        list,
      };
    }

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

  async claimCashback(wallets) {
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
      const wallet = walletMap.get(address);
      if (!wallet) {
        list.push({
          address,
          status: "not_found",
          message: "Wallet not found",
        });
        continue;
      }

      let funding;
      try {
        const keypair = keypairFromWallet(wallet);
        const claim = pumpSwap.createClaimCashbackInstruction(
          keypair.publicKey,
        );
        const [
          userWsolAccountInfo,
          userVolumeAccumulatorWsolAccountInfo,
        ] = await connection.getMultipleAccountsInfo(
          [
            claim.userWsolTokenAccount,
            claim.userVolumeAccumulatorWsolTokenAccount,
          ],
          "confirmed",
        );

        // The accumulator ATA is the source of the cashback transfer. It must
        // have been funded by prior cashback-enabled Pump AMM swaps; creating
        // an empty one here only spends rent and cannot produce a claim.
        if (!userVolumeAccumulatorWsolAccountInfo) {
          list.push({
            address,
            status: "skipped",
            message: "No Pump AMM cashback account found",
            userVolumeAccumulator: claim.userVolumeAccumulator.toBase58(),
            userVolumeAccumulatorWsolTokenAccount:
              claim.userVolumeAccumulatorWsolTokenAccount.toBase58(),
          });
          continue;
        }

        const accumulatorBalance = await connection.getTokenAccountBalance(
          claim.userVolumeAccumulatorWsolTokenAccount,
          "confirmed",
        );
        const claimableLamports = BigInt(accumulatorBalance.value.amount);
        if (claimableLamports === 0n) {
          list.push({
            address,
            status: "skipped",
            message: "No Pump AMM cashback available",
            userVolumeAccumulator: claim.userVolumeAccumulator.toBase58(),
            userVolumeAccumulatorWsolTokenAccount:
              claim.userVolumeAccumulatorWsolTokenAccount.toBase58(),
            claimableLamports: "0",
            claimableSol: "0",
          });
          continue;
        }

        const balanceLamports = await connection.getBalance(
          keypair.publicKey,
          "confirmed",
        );
        if (balanceLamports === 0) {
          funding = await this.transferFromReceiveAddress(
            address,
            CLAIM_CASHBACK_FUNDING_AMOUNT,
          );
        }

        const createWsolAccount = !userWsolAccountInfo;
        const instructions = [];

        if (createWsolAccount) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              keypair.publicKey,
              claim.userWsolTokenAccount,
              keypair.publicKey,
              WSOL_TOKEN_ACCOUNT,
              TOKEN_PROGRAM_ID,
            ),
          );
        }

        instructions.push(claim.instruction);

        if (createWsolAccount) {
          instructions.push(
            createCloseAccountInstruction(
              claim.userWsolTokenAccount,
              keypair.publicKey,
              keypair.publicKey,
              [],
              TOKEN_PROGRAM_ID,
            ),
          );
        }

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const message = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message();
        const transaction = new VersionedTransaction(message);
        transaction.sign([keypair]);

        console.log(
          `[Pump AMM] claim_cashback sending: address=${address}, claimableLamports=${claimableLamports}, createWsolAccount=${createWsolAccount}`,
        );
        const signature = await connection.sendTransaction(transaction, {
          skipPreflight: false,
          maxRetries: 2,
        });
        await waitForSignatureConfirmation(signature);
        console.log(
          `[Pump AMM] claim_cashback confirmed: address=${address}, signature=${signature}`,
        );

        list.push({
          address,
          status: "success",
          signature,
          userWsolTokenAccount: claim.userWsolTokenAccount.toBase58(),
          userVolumeAccumulator: claim.userVolumeAccumulator.toBase58(),
          userVolumeAccumulatorWsolTokenAccount:
            claim.userVolumeAccumulatorWsolTokenAccount.toBase58(),
          claimableLamports: claimableLamports.toString(),
          claimableSol: accumulatorBalance.value.uiAmountString,
          createdWsolAccount: createWsolAccount,
          closedWsolAccount: createWsolAccount,
          ...(funding ? { funding } : {}),
        });
      } catch (error) {
        console.log(
          `[Pump AMM] claim_cashback failed: address=${address}, error=${error.message}`,
        );
        list.push({
          address,
          status: "failed",
          message: error.message,
          ...(funding ? { funding } : {}),
        });
      }
    }

    return {
      total: list.length,
      success: list.filter((item) => item.status === "success").length,
      skipped: list.filter((item) => item.status === "skipped").length,
      failed: list.filter(
        (item) => item.status === "failed" || item.status === "not_found",
      ).length,
      list,
    };
  }
}

module.exports = WalletAdmin;
