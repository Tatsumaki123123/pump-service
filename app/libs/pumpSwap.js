const {
  Commitment,
  Connection,
  Finality,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const { Program, Provider } = require("@coral-xyz/anchor");
const {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = require("@solana/spl-token");
const { connection, boss } = require("../constants");
const { sendNozomiTx } = require("./nozomi/tx-submission");
const { sendBundle } = require("./jito");
const {
  getBuyTokenAmount,
  calculateWithSlippageBuy,
  getPumpSwapPool,
} = require("./pool");
const { getSPLBalance, logger } = require("./utils");

const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const WSOL_TOKEN_ACCOUNT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
const global = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const eventAuthority = new PublicKey(
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR"
);
const feeRecipient = new PublicKey(
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV"
);
const feeRecipientAta = new PublicKey(
  "94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb"
);
const BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = new Uint8Array([
  51, 230, 133, 164, 1, 127, 131, 173,
]);

const DEFAULT_DECIMALS = 6;

class PumpSwapSDK {
  constructor() {}

  async buy(mint, user, solToBuy) {
    const slippage = 0.3; // Default: 30%
    const bought_token_amount = await getBuyTokenAmount(
      BigInt(solToBuy * LAMPORTS_PER_SOL),
      mint
    );
    logger.info({
      status: `finding pumpswap pool for ${mint}`,
    });
    const pool = await getPumpSwapPool(mint);
    const pumpswap_buy_tx = await this.createBuyInstruction(
      pool,
      user,
      mint,
      bought_token_amount,
      BigInt(Math.floor(solToBuy * (1 + slippage) * LAMPORTS_PER_SOL))
    );
    const ata = getAssociatedTokenAddressSync(mint, user);
    const ix_list = [
      ...[
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 300000,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 696969,
        }),
      ],
      createAssociatedTokenAccountIdempotentInstruction(
        wallet_1.publicKey,
        ata,
        wallet_1.publicKey,
        mint
      ),
      pumpswap_buy_tx,
    ];

    const latestBlockhash = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: wallet_1.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: ix_list,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet_1]);
    // sendNozomiTx(ix_list, wallet_1, latestBlockhash, "PumpSwap", "buy");
    sendBundle(false, latestBlockhash.blockhash, transaction, pool, wallet_1);
  }

  async sell_exactAmount(mint, user, tokenAmount) {
    const sell_token_amount = tokenAmount;
    logger.info({
      status: `finding pumpswap pool for ${mint}`,
    });
    const pool = await getPumpSwapPool(mint);
    const pumpswap_buy_tx = await this.createSellInstruction(
      pool,
      user,
      mint,
      BigInt(Math.floor(sell_token_amount * 10 ** 6)),
      BigInt(0)
    );
    const ata = getAssociatedTokenAddressSync(mint, user);
    const ix_list = [
      ...[
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 100000,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 696969,
        }),
      ],
      createAssociatedTokenAccountIdempotentInstruction(
        wallet_1.publicKey,
        ata,
        wallet_1.publicKey,
        mint
      ),
      pumpswap_buy_tx,
    ];

    const latestBlockhash = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: wallet_1.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: ix_list,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet_1]);
    // sendNozomiTx(ix_list, wallet_1, latestBlockhash, "PumpSwap", "sell");
    sendBundle(false, latestBlockhash.blockhash, transaction, pool, wallet_1);
  }

  async sell_percentage(mint, user, percentage_to_sell) {
    const holding_token_amount = await getSPLBalance(connection, mint, user);
    const sell_token_amount = percentage_to_sell * holding_token_amount;
    logger.info({
      status: `finding pumpswap pool for ${mint}`,
    });
    const pool = await getPumpSwapPool(mint);
    const pumpswap_buy_tx = await this.createSellInstruction(
      pool,
      user,
      mint,
      BigInt(Math.floor(sell_token_amount * 10 ** 6)),
      BigInt(0)
    );
    const ata = getAssociatedTokenAddressSync(mint, user);
    const ix_list = [
      ...[
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 100000,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 696969,
        }),
      ],
      createAssociatedTokenAccountIdempotentInstruction(
        wallet_1.publicKey,
        ata,
        wallet_1.publicKey,
        mint
      ),
      pumpswap_buy_tx,
    ];

    const latestBlockhash = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: wallet_1.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: ix_list,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet_1]);
    // sendNozomiTx(ix_list, wallet_1, latestBlockhash, "PumpSwap", "sell");
    sendBundle(false, latestBlockhash.blockhash, transaction, pool, wallet_1);
  }

  async createBuyInstruction(
    poolId,
    user,
    mint,
    baseAmountOut,
    maxQuoteAmountIn
  ) {
    const userBaseTokenAccount = await getAssociatedTokenAddress(mint, user);
    const userQuoteTokenAccount = await getAssociatedTokenAddress(
      WSOL_TOKEN_ACCOUNT,
      user
    );
    const poolBaseTokenAccount = await getAssociatedTokenAddress(
      mint,
      poolId,
      true
    );
    const poolQuoteTokenAccount = await getAssociatedTokenAddress(
      WSOL_TOKEN_ACCOUNT,
      poolId,
      true
    );

    const accounts = [
      { pubkey: poolId, isSigner: false, isWritable: false },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: WSOL_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: feeRecipient, isSigner: false, isWritable: false },
      { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const data = Buffer.alloc(8 + 8 + 8);
    data.set(BUY_DISCRIMINATOR, 0);
    data.writeBigUInt64LE(BigInt(baseAmountOut), 8);
    data.writeBigUInt64LE(BigInt(maxQuoteAmountIn), 16);

    return new TransactionInstruction({
      keys: accounts,
      programId: PUMP_AMM_PROGRAM_ID,
      data: data,
    });
  }

  async createSellInstruction(
    poolId,
    user,
    mint,
    baseAmountIn,
    minQuoteAmountOut
  ) {
    const userBaseTokenAccount = await getAssociatedTokenAddress(mint, user);
    const userQuoteTokenAccount = await getAssociatedTokenAddress(
      WSOL_TOKEN_ACCOUNT,
      user
    );
    const poolBaseTokenAccount = await getAssociatedTokenAddress(
      mint,
      poolId,
      true
    );
    const poolQuoteTokenAccount = await getAssociatedTokenAddress(
      WSOL_TOKEN_ACCOUNT,
      poolId,
      true
    );

    const accounts = [
      { pubkey: poolId, isSigner: false, isWritable: false },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: WSOL_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: feeRecipient, isSigner: false, isWritable: false },
      { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const data = Buffer.alloc(8 + 8 + 8);
    data.set(SELL_DISCRIMINATOR, 0);
    data.writeBigUInt64LE(BigInt(baseAmountIn), 8);
    data.writeBigUInt64LE(BigInt(minQuoteAmountOut), 16);

    return new TransactionInstruction({
      keys: accounts,
      programId: PUMP_AMM_PROGRAM_ID,
      data: data,
    });
  }
}

module.exports = PumpSwapSDK;
