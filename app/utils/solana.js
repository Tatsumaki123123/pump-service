const {
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  TransactionInstruction,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
  Transaction,
} = require("@solana/web3.js");
const chalk = require("chalk");
const bs58 = require("bs58");
const {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  closeAccount,
  transfer,
  getMint,
  getMetadataPointerState,
  getTokenMetadata,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");

const { WSOL_TOKEN_ACCOUNT, connection } = require("../constants/index");

const TRANSFER_CONFIRM_TIMEOUT_MS = 10_000;
const TRANSFER_STATUS_POLL_MS = 500;

async function getSPLBalance(
  connection,
  tokenMint,
  owner,
) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      owner,
      { mint: tokenMint },
      "confirmed",
    );

    return tokenAccounts.value.reduce((total, { account }) => {
      const uiAmountString =
        account.data?.parsed?.info?.tokenAmount?.uiAmountString;
      const uiAmount = Number(uiAmountString);
      return Number.isFinite(uiAmount) ? total + uiAmount : total;
    }, 0);
  } catch (e) {
    // console.error(e);
  }
  return 0;
}

async function getSPLBalanceAmount(
  connection,
  tokenMint,
  owner,
) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      owner,
      { mint: tokenMint },
      "confirmed",
    );
    return tokenAccounts.value
      .reduce((total, { account }) => {
        const amount = account.data?.parsed?.info?.tokenAmount?.amount;
        return amount == null ? total : total + BigInt(amount);
      }, 0n)
      .toString();
  } catch (e) {
    console.error(e.message);
  }
  return "0";
}

async function closeAllTokenAccounts(connection, keypair, force = false) {
  try {
    const wallet = keypair;

    const [tokenAccounts, token2022Accounts] = await Promise.all([
      connection.getTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      }),
      connection.getTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    ]);
    tokenAccounts.value.push(...token2022Accounts.value);

    console.log(
      chalk.green(
        "Close account:",
        wallet.publicKey.toBase58(),
        tokenAccounts.value.length,
      ),
    );
    const volumeIxs = [];
    if (tokenAccounts.value.length === 0) {
      console.log("no token account");
      return;
    }
    let transaction = new Transaction();
    let len = 0;
    const minAmount = 100 * 10 ** 6;
    let skippedWithBalance = 0;
    for (const account of tokenAccounts.value) {
      const accountPubkey = account.pubkey;
      // 判断所属 program（Token 或 Token-2022）
      const ownerProgram = account.account.owner;
      const accountInfo = await getAccount(
        connection,
        accountPubkey,
        "confirmed",
        ownerProgram,
      );

      if (force && accountInfo.amount > 0) {
        skippedWithBalance++;
        console.log(
          chalk.yellow("Force recycle skip token account with balance:"),
          accountPubkey.toBase58(),
          accountInfo.amount.toString(),
        );
        continue;
      }

      if (accountInfo.amount >= minAmount) {
        throw new Error(
          `Token account ${accountPubkey.toBase58()} has balance ${accountInfo.amount}`,
        );
      } else if (accountInfo.amount > 0 && accountInfo.amount < minAmount) {
        console.log(
          chalk.red(
            `Token account ${accountPubkey.toBase58()} has balance ${accountInfo.amount}`,
          ),
        );
        const topHolder = await getTopLPTokenHolder(
          connection,
          accountInfo.mint,
        );
        let transferred = false;
        if (topHolder) {
          try {
            const signature = await transfer(
              connection,
              wallet,
              accountInfo.address,
              topHolder.address,
              wallet.publicKey,
              accountInfo.amount,
              [],
              undefined,
              ownerProgram,
            );
            await connection.confirmTransaction(signature, "confirmed");
            transferred = true;
          } catch (error) {
            console.log(
              chalk.red("Transfer failed, skip close:"),
              error.message,
            );
          }
        }
        if (!transferred) continue; // 转账失败或无接收方，不关闭
      }

      // close token account（传正确的 programId，兼容 Token-2022）
      const ix = await createCloseAccountInstruction(
        accountPubkey,
        wallet.publicKey,
        wallet.publicKey,
        [],
        ownerProgram,
      );
      volumeIxs.push(ix);
    }
    const transactionArr = [];
    console.log(chalk.green("Account need close :", volumeIxs.length));
    if (skippedWithBalance > 0) {
      console.log(
        chalk.yellow("Force recycle skipped token accounts:"),
        skippedWithBalance,
      );
    }
    for (let index = 0; index < volumeIxs.length; index++) {
      const ix = volumeIxs[index];
      transaction.add(ix);
      if ((index + 1) % 10 === 0 || index + 1 === volumeIxs.length) {
        transactionArr.push(transaction);
        transaction = new Transaction();
      }
    }
    for (let index = 0; index < transactionArr.length; index++) {
      console.log(chalk.green("Close account: ", index, index + 1 + 10));
      const transaction = transactionArr[index];
      try {
        const signature = await connection.sendTransaction(
          transaction,
          [wallet],
          {
            skipPreflight: false,
          },
        );
        await connection.confirmTransaction(signature, "confirmed");
      } catch (error) {
        if (!force) throw error;
        console.log(
          chalk.yellow("Close account batch failed, retry one by one:"),
          error.message,
        );
        for (const ix of transaction.instructions) {
          try {
            const singleTx = new Transaction().add(ix);
            const signature = await connection.sendTransaction(
              singleTx,
              [wallet],
              {
                skipPreflight: false,
              },
            );
            await connection.confirmTransaction(signature, "confirmed");
          } catch (singleError) {
            console.log(
              chalk.yellow("Force recycle skip close failed account:"),
              ix.keys[0].pubkey.toBase58(),
              singleError.message,
            );
          }
        }
      }
    }

    console.log("all token account closed");
    return true;
  } catch (error) {
    throw new Error(error);
  }
}
async function transferAllSol(connection, from, to, remain = 0, onPrepared) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const TRANSACTION_FEE = 5000;
  const balance = await connection.getBalance(from.publicKey);
  // const ataRent = await connection.getMinimumBalanceForRentExemption(165); // ATA 大小约为 165 字节
  // const minRent = await connection.getMinimumBalanceForRentExemption(0);
  const minRent = 0;

  const remainAmount = remain * LAMPORTS_PER_SOL;

  const minAmount = minRent + TRANSACTION_FEE + remainAmount;

  if (balance <= minAmount) {
    console.log(
      chalk.yellow(
        `Insufficient balance for ${from.publicKey.toBase58()}, skipping.`,
      ),
    );
    return false;
  }

  const ix = SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: to,
    lamports: balance - minAmount,
  });

  const volumeIxs = [ix];

  const messageV0 = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions: volumeIxs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([from]);

  const signature = bs58.encode(Buffer.from(tx.signatures[0]));
  await onPrepared?.({ signature, blockhash, lastValidBlockHeight });
  try {
    const sentSignature = await connection.sendTransaction(tx, {
      skipPreflight: false,
    });
    if (sentSignature !== signature) {
      throw new Error(`Unexpected transfer signature: ${sentSignature}`);
    }
    const deadline = Date.now() + TRANSFER_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      let timeoutId;
      let statusResponse;
      try {
        statusResponse = await Promise.race([
          connection.getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          }),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              const timeout = new Error("Transfer status request timed out");
              timeout.code = "TRANSFER_CONFIRMATION_UNKNOWN";
              reject(timeout);
            }, remainingMs);
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
      const status = statusResponse.value?.[0];
      if (status?.err) {
        const error = new Error(
          `Transfer transaction ${signature} failed: ${JSON.stringify(status.err)}`,
        );
        error.code = "TRANSFER_FAILED";
        throw error;
      }
      if (
        status &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized" ||
          status.confirmations === null)
      ) {
        console.log(chalk.green(`Transaction sent: ${signature}`));
        return true;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(TRANSFER_STATUS_POLL_MS, deadline - Date.now()),
        ),
      );
    }
    const unknown = new Error(
      `Transfer confirmation timed out after ${TRANSFER_CONFIRM_TIMEOUT_MS}ms: ${signature}`,
    );
    unknown.code = "TRANSFER_CONFIRMATION_UNKNOWN";
    throw unknown;
  } catch (error) {
    if (
      error.code === "TRANSFER_FAILED" ||
      error.code === "TRANSFER_CONFIRMATION_UNKNOWN"
    ) {
      throw error;
    }
    try {
      const [{ value }, blockHeight] = await Promise.all([
        connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        }),
        connection.getBlockHeight("confirmed"),
      ]);
      const status = value?.[0];
      if (status?.err) {
        const failed = new Error(
          `Transfer transaction ${signature} failed: ${JSON.stringify(status.err)}`,
        );
        failed.code = "TRANSFER_FAILED";
        throw failed;
      }
      if (
        status &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized" ||
          status.confirmations === null)
      ) {
        return true;
      }
      if (blockHeight > lastValidBlockHeight) {
        const expired = new Error(
          `Transfer transaction ${signature} expired before landing`,
        );
        expired.code = "TRANSFER_FAILED";
        throw expired;
      }
    } catch (statusError) {
      if (statusError.code === "TRANSFER_FAILED") throw statusError;
    }
    const unknown = new Error(
      `Transfer status is unknown for ${signature}; keep the pending boss and reconcile before retrying`,
    );
    unknown.code = "TRANSFER_CONFIRMATION_UNKNOWN";
    throw unknown;
  }
}

async function transferSol(
  connection,
  from,
  wallets,
  amounts,
  { throwOnError = false } = {},
) {
  console.log(
    "transferSol",
    from.publicKey.toBase58(),
    wallets.map((item) => item.toBase58()),
    amounts,
  );
  const { blockhash } = await connection.getLatestBlockhash();

  if (wallets && wallets.length > 0) {
    const transferIxs = wallets.map((wallet, index) =>
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: wallet,
        lamports: amounts[index] * LAMPORTS_PER_SOL,
      }),
    );

    const transferMessage = new TransactionMessage({
      payerKey: from.publicKey,
      recentBlockhash: blockhash,
      instructions: transferIxs,
    }).compileToV0Message();

    const transferTx = new VersionedTransaction(transferMessage);
    transferTx.sign([from]);

    try {
      const signature = await connection.sendTransaction(transferTx, {
        skipPreflight: false,
      });
      const tx = await connection.confirmTransaction(signature, "confirmed");
      if (tx.value?.err) {
        throw new Error(
          `Transfer transaction ${signature} failed: ${JSON.stringify(tx.value.err)}`,
        );
      }
      console.log(chalk.green(`Transaction sent: ${signature}`));
    } catch (error) {
      console.error(chalk.red(`Failed to send transaction: ${error.message}`));
      if (throwOnError) throw error;
    }
    console.log(chalk.green("SOL transfers completed."));
  } else {
    throw new Error("no active wallet");
  }
}

function isValidSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch (error) {
    return false;
  }
}

async function getTopLPTokenHolder(connection, lpTokenMint) {
  const largestAccounts = await connection.getTokenLargestAccounts(lpTokenMint);
  const topHolder = largestAccounts.value[0];
  return topHolder;
}

async function getTokenMeta(connection, mintAddress) {
  try {
    console.log("getTokenMeta", mintAddress);
    const mintPublicKey = new PublicKey(mintAddress);

    const mint = await getMint(
      connection,
      mintPublicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );

    const metadataPointer = getMetadataPointerState(mint);

    if (!metadataPointer?.metadataAddress) {
      throw new Error("No metadata address found for this token.");
    }

    // 获取代币元数据
    const metadata = await getTokenMetadata(
      connection,
      mintPublicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );

    if (!metadata) {
      throw new Error("No metadata found for this token.");
    }

    return {
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    };
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function sendV0Transaction(user, instructions, lookupTableAccounts) {
  // Get the latest blockhash and last valid block height
  const { lastValidBlockHeight, blockhash } =
    await connection.getLatestBlockhash({ commitment: "confirmed" });

  const messageV0 = new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: blockhash,
    instructions: instructions,
  }).compileToV0Message(lookupTableAccounts ? lookupTableAccounts : undefined);

  const transaction = new VersionedTransaction(messageV0);

  transaction.sign([user]);
  // const jitoConnection = new Connection(
  //   "https://mainnet.block-engine.jito.wtf/api/v1/transactions",
  //   "confirmed"
  // )
  // Send the transaction to the cluster

  const txid = await connection.sendTransaction(transaction, {
    skipPreflight: true,
    maxRetries: 2,
  });

  await connection.confirmTransaction(
    {
      blockhash: blockhash,
      lastValidBlockHeight: lastValidBlockHeight,
      signature: txid,
    },
    "processed",
  );

  // Log the transaction URL on the Solana Explorer
  console.log(`https://solscan.io/tx/${txid}`);
}

async function wrapSolToWSol(connection, wallet, amount = 0.1) {
  console.log(chalk.green("wrapSolToWSol"));
  const associatedTokenAddress = await getAssociatedTokenAddress(
    WSOL_TOKEN_ACCOUNT,
    wallet.publicKey,
  );

  const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
  const transaction = new Transaction();

  if (!accountInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        associatedTokenAddress,
        wallet.publicKey,
        WSOL_TOKEN_ACCOUNT,
      ),
    );
  }

  const amountToWrap = amount * LAMPORTS_PER_SOL;

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: associatedTokenAddress,
      lamports: amountToWrap,
    }),
    createSyncNativeInstruction(associatedTokenAddress),
  );

  const signature = await connection.sendTransaction(transaction, [wallet]);
  await connection.confirmTransaction(signature, "confirmed");

  console.log(`成功将 0.1 SOL 转换为 WSOL！交易签名: ${signature}`);
  console.log(`WSOL 存储在: ${associatedTokenAddress.toBase58()}`);
}

async function wsolToSol(connection, wallet) {
  const associatedTokenAddress = await getAssociatedTokenAddress(
    WSOL_TOKEN_ACCOUNT,
    wallet.publicKey,
  );

  const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
  if (!accountInfo) {
    throw new Error("WSOL ATA not exist");
  }

  const balance = await connection.getTokenAccountBalance(
    associatedTokenAddress,
  );
  console.log(` WSOL balance: ${balance.value.uiAmount} WSOL`);

  const transaction = new Transaction().add(
    createCloseAccountInstruction(
      associatedTokenAddress,
      wallet.publicKey,
      wallet.publicKey,
    ),
  );

  const signature = await connection.sendTransaction(transaction, [wallet], {
    skipPreflight: false,
  });
  await connection.confirmTransaction(signature, "confirmed");
}

async function getTokenProgramId(tokenMint) {
  const accountInfo = await connection.getParsedAccountInfo(tokenMint);
  const programId = accountInfo.value.owner;
  return programId || TOKEN_PROGRAM_ID;
}

module.exports = {
  getSPLBalance,
  getSPLBalanceAmount,
  closeAllTokenAccounts,
  transferAllSol,
  transferSol,
  isValidSolanaAddress,
  getTokenMeta,
  sendV0Transaction,
  wrapSolToWSol,
  wsolToSol,
  getTokenProgramId,
};
