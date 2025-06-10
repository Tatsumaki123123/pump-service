const {
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  TransactionInstruction,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
} = require("@solana/web3.js");
const chalk = require("chalk");
const {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  closeAccount,
} = require("@solana/spl-token");

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
  } catch (e) {}
  return 0;
}

async function closeAllTokenAccounts(connection, keypair) {
  try {
    const wallet = keypair;

    // 2. 获取所有 token account
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      {
        programId: TOKEN_PROGRAM_ID, // SPL Token 程序 ID
      }
    );

    if (tokenAccounts.value.length === 0) {
      console.log("没有找到 token account");
      return;
    }

    // 3. 遍历并关闭每个 token account
    for (const account of tokenAccounts.value) {
      const accountPubkey = account.pubkey;
      const accountInfo = await getAccount(connection, accountPubkey);

      // 检查余额是否为 0
      if (accountInfo.amount > 0) {
        console.log(
          `Token account ${accountPubkey.toBase58()} 仍有余额 ${
            accountInfo.amount
          }, 无法关闭`
        );
        continue;
      }

      // 关闭 token account
      console.log(`正在关闭 token account: ${accountPubkey.toBase58()}`);
      const transaction = await closeAccount(
        connection,
        wallet, // 签名者
        accountPubkey, // 要关闭的 token account
        wallet.publicKey, // 接收退款的地址（通常是 owner）
        wallet.publicKey // 授权者
      );

      console.log(
        `Token account ${accountPubkey.toBase58()} 已关闭，交易签名: ${transaction}`
      );
    }

    console.log("所有符合条件的 token account 已关闭");
  } catch (error) {
    console.error("关闭 token account 时出错:", error);
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
    throw new Error(
      `Insufficient balance for ${from.publicKey.toBase58()}, skipping.`
    );
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
    console.log(chalk.green(`Transaction sent: ${signature}`));
  } catch (error) {
    throw new Error(`Failed to send transaction: ${error.message}`);
  }
}

async function transferSol(connection, from, wallets, amounts) {
  console.log(from, wallets, amounts);
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
module.exports = {
  getSPLBalance,
  closeAllTokenAccounts,
  transferAllSol,
  transferSol,
};
