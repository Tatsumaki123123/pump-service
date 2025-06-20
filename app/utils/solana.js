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
} = require("@solana/spl-token");

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

/**
 * to addr: CX5QxTvRJJnLBQT8ppFhRW5jscuTUBqeTKGeLcRaFcEd
 * @param {*} connection
 * @param {*} keypair
 * @returns
 */
async function closeAllTokenAccounts(connection, keypair) {
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
    for (const account of tokenAccounts.value) {
      const accountPubkey = account.pubkey;
      const accountInfo = await getAccount(connection, accountPubkey);

      if (accountInfo.amount >= 1000) {
        throw new Error(
          `Token account ${wallet.publicKey.toBase58()} has balance ${
            accountInfo.amount
          }`
        );
      }
      // 检查余额是否为 0
      if (accountInfo.amount > 0 && accountInfo.amount < 1000) {
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
async function transferAllSol(connection, from, to) {
  const { blockhash } = await connection.getLatestBlockhash();
  const TRANSACTION_FEE = 5000;
  const balance = await connection.getBalance(from.publicKey);
  // const ataRent = await connection.getMinimumBalanceForRentExemption(165); // ATA 大小约为 165 字节
  // const minRent = await connection.getMinimumBalanceForRentExemption(0);
  const minRent = 0;

  if (balance <= minRent + TRANSACTION_FEE) {
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
    lamports: balance - minRent - TRANSACTION_FEE,
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
    await sleep(1);
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

module.exports = {
  getSPLBalance,
  closeAllTokenAccounts,
  transferAllSol,
  transferSol,
  isValidSolanaAddress,
  getTokenMeta,
};
