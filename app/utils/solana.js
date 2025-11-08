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
  getOrCreateAssociatedTokenAccount,
} = require("@solana/spl-token");

const { WSOL_TOKEN_ACCOUNT, connection } = require("../constants/index");

const { sleep } = require("./utils");

async function getSPLBalance(
  connection,
  tokenMint,
  owner,
  allowOffCurve = false
) {
  try {
    let ata = getAssociatedTokenAddressSync(tokenMint, owner, allowOffCurve);
    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return balance.value.uiAmount || 0;
  } catch (e) {
    console.error(e.message);
  }
  return 0;
}

async function getSPLBalanceAmount(
  connection,
  tokenMint,
  owner,
  allowOffCurve = false
) {
  try {
    let ata = getAssociatedTokenAddressSync(tokenMint, owner, allowOffCurve);
    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return balance.value.amount || 0;
  } catch (e) {
    console.error(e.message);
  }
  return 0;
}

/**
 * to addr: CX5QxTvRJJnLBQT8ppFhRW5jscuTUBqeTKGeLcRaFcEd
 * @param {*} connection
 * @param {*} keypair
 * @returns
 */
const closeTokenRecAddress = new PublicKey(
  "914ieyzsV2wG4DDwqTTZ6be8TxZJ1s3cpRrz7LaviSrC"
);
async function closeAllTokenAccounts(connection, keypair, force = false) {
  try {
    const wallet = keypair;

    const tokenAccounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      {
        programId: TOKEN_PROGRAM_ID,
      }
    );

    console.log(
      chalk.green(
        "Close account:",
        wallet.publicKey.toBase58(),
        tokenAccounts.value.length
      )
    );
    const volumeIxs = [];
    if (tokenAccounts.value.length === 0) {
      console.log("no token account");
      return;
    }
    let transaction = new Transaction();
    let len = 0;
    const minAmount = 100 * 10 ** 6;
    for (const account of tokenAccounts.value) {
      const accountPubkey = account.pubkey;
      const accountInfo = await getAccount(connection, accountPubkey);

      if (accountInfo.amount >= minAmount) {
        if (force) {
          try {
            console.log(accountInfo);
            const dAccount = await getOrCreateAssociatedTokenAccount(
              connection,
              wallet,
              accountInfo.mint,
              closeTokenRecAddress
            );
            const signature = await transfer(
              connection,
              wallet,
              accountInfo.address,
              dAccount.address,
              wallet.publicKey,
              accountInfo.amount
            );
            await connection.confirmTransaction(signature, "confirmed");
          } catch (error) {
            console.log(error);
          }
        } else {
          throw new Error(
            `Token account ${wallet.publicKey.toBase58()} has balance ${
              accountInfo.amount
            }`
          );
        }
      } else if (accountInfo.amount > 0 && accountInfo.amount < minAmount) {
        console.log(
          chalk.red(
            `Token account ${wallet.publicKey.toBase58()} has balance ${
              accountInfo.amount
            }`
          )
        );
        const topHolder = await getTopLPTokenHolder(
          connection,
          accountInfo.mint
        );
        if (topHolder) {
          try {
            const signature = await transfer(
              connection,
              wallet,
              accountInfo.address,
              topHolder.address,
              wallet.publicKey,
              accountInfo.amount
            );
            await connection.confirmTransaction(signature, "confirmed");
          } catch (error) {
            console.log(error);
          }
        }
      }

      // close token account
      const ix = await createCloseAccountInstruction(
        accountPubkey,
        wallet.publicKey,
        wallet.publicKey
      );
      volumeIxs.push(ix);
    }
    const transactionArr = [];
    console.log(chalk.green("Account need close :", volumeIxs.length));
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
      const signature = await connection.sendTransaction(
        transaction,
        [wallet],
        {
          skipPreflight: false,
        }
      );
      await connection.confirmTransaction(signature, "confirmed");
    }

    console.log("all token account closed");
    return true;
  } catch (error) {
    throw new Error(error);
  }
}
async function transferAllSol(connection, from, to, remain = 0) {
  const { blockhash } = await connection.getLatestBlockhash();
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
        `Insufficient balance for ${from.publicKey.toBase58()}, skipping.`
      )
    );
    return;
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

  try {
    const signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
    });
    await connection.confirmTransaction(signature, "confirmed");
    // await sleep(1);
    console.log(chalk.green(`Transaction sent: ${signature}`));
  } catch (error) {
    throw new Error(`Failed to send transaction: ${error.message}`);
  }
}

async function transferSol(connection, from, wallets, amounts) {
  console.log(
    "transferSol",
    from.publicKey.toBase58(),
    wallets.map((item) => item.toBase58()),
    amounts
  );
  const { blockhash } = await connection.getLatestBlockhash();

  if (wallets && wallets.length > 0) {
    const transferIxs = wallets.map((wallet, index) =>
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: wallet,
        lamports: amounts[index] * LAMPORTS_PER_SOL,
      })
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
      console.log(chalk.green(`Transaction sent: ${signature}`));
    } catch (error) {
      console.error(chalk.red(`Failed to send transaction: ${error.message}`));
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
      TOKEN_2022_PROGRAM_ID
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
      TOKEN_2022_PROGRAM_ID
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
    "processed"
  );

  // Log the transaction URL on the Solana Explorer
  console.log(`https://solscan.io/tx/${txid}`);
}

async function wrapSolToWSol(connection, wallet, amount = 0.1) {
  console.log(chalk.green("wrapSolToWSol"));
  const associatedTokenAddress = await getAssociatedTokenAddress(
    WSOL_TOKEN_ACCOUNT,
    wallet.publicKey
  );

  const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
  const transaction = new Transaction();

  if (!accountInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        associatedTokenAddress,
        wallet.publicKey,
        WSOL_TOKEN_ACCOUNT
      )
    );
  }

  const amountToWrap = amount * LAMPORTS_PER_SOL;

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: associatedTokenAddress,
      lamports: amountToWrap,
    }),
    createSyncNativeInstruction(associatedTokenAddress)
  );

  const signature = await connection.sendTransaction(transaction, [wallet]);
  await connection.confirmTransaction(signature, "confirmed");

  console.log(`成功将 0.1 SOL 转换为 WSOL！交易签名: ${signature}`);
  console.log(`WSOL 存储在: ${associatedTokenAddress.toBase58()}`);
}

async function wsolToSol(connection, wallet) {
  const associatedTokenAddress = await getAssociatedTokenAddress(
    WSOL_TOKEN_ACCOUNT,
    wallet.publicKey
  );

  const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
  if (!accountInfo) {
    throw new Error("WSOL ATA not exist");
  }

  const balance = await connection.getTokenAccountBalance(
    associatedTokenAddress
  );
  console.log(` WSOL balance: ${balance.value.uiAmount} WSOL`);

  const transaction = new Transaction().add(
    createCloseAccountInstruction(
      associatedTokenAddress,
      wallet.publicKey,
      wallet.publicKey
    )
  );

  const signature = await connection.sendTransaction(transaction, [wallet], {
    skipPreflight: false,
  });
  await connection.confirmTransaction(signature, "confirmed");
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
};
