const {
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

const {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const { WSOL_TOKEN_ACCOUNT, PUMP_AMM_PROGRAM_ID } = require("../constants");

const { calculateBuyAmount } = require("./pool");

const GLOBAL_CONFIG = new PublicKey(
  "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"
);

const PUMP_AMM_FEE = new PublicKey(
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX"
); // 3
const PUMP_AMM_FEE_TOKEN_ACCOUNT = new PublicKey(
  "X5QPJcpph4mBAJDzc4hRziFftSbcygV59kRb2Fu6Je1"
);
const EVENT_AUTHORITY = new PublicKey(
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR"
);
const feeRecipient = new PublicKey(
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV"
);
const feeRecipientAta = new PublicKey(
  "94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb"
);

const defaultBuyAccounts = {
  pool: {
    account: null,
    signer: false,
    writable: false,
    label: "pool",
  },
  user: {
    account: null,
    signer: true,
    writable: true,
    label: "user",
  },
  global_config: {
    account: GLOBAL_CONFIG,
    signer: false,
    writable: false,
    label: "global_config",
  },
  base_mint: {
    account: null,
    signer: false,
    writable: false,
    label: "base_mint",
  },
  quote_mint: {
    account: WSOL_TOKEN_ACCOUNT,
    signer: false,
    writable: false,
    label: "quote_mint",
  },
  user_base_token_account: {
    account: null,
    signer: false,
    writable: true,
    label: "user_base_token_account",
  },
  user_quote_token_account: {
    account: null,
    signer: false,
    writable: true,
    label: "user_quote_token_account",
  },
  pool_base_token_account: {
    account: null,
    signer: false,
    writable: true,
    label: "pool_base_token_account",
  },
  pool_quote_token_account: {
    account: null,
    signer: false,
    writable: true,
    label: "pool_quote_token_account",
  },
  protocol_fee_recipient: {
    account: PUMP_AMM_FEE,
    signer: false,
    writable: false,
    label: "protocol_fee_recipient",
  },
  protocol_fee_recipient_token_account: {
    account: PUMP_AMM_FEE_TOKEN_ACCOUNT,
    signer: false,
    writable: true,
    label: "protocol_fee_recipient_token_account",
  },
  base_token_program: {
    account: TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
    label: "base_token_program",
  },
  quote_token_program: {
    account: TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
    label: "quote_token_program",
  },
  system_program: {
    account: SystemProgram.programId,
    signer: false,
    writable: false,
    label: "system_program",
  },
  associated_token_program: {
    account: ASSOCIATED_TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
    label: "associated_token_program",
  },
  event_authority: {
    account: EVENT_AUTHORITY,
    signer: false,
    writable: false,
    label: "event_authority",
  },
  program: {
    account: PUMP_AMM_PROGRAM_ID,
    signer: false,
    writable: false,
    label: "program",
  },
  coin_creator_vault_ata: {
    account: null,
    signer: false,
    writable: true,
    label: "coin_creator_vault_ata",
  },
  coin_creator_vault_authority: {
    account: null,
    signer: false,
    writable: false,
    label: "coin_creator_vault_authority",
  },
};

const BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = new Uint8Array([
  51, 230, 133, 164, 1, 127, 131, 173,
]);

const DEFAULT_DECIMALS = 6;

class PumpSwapSDK {
  constructor() {}

  async createBuyInstruction(params) {
    const {
      pool,
      tokenMint,
      user,
      developer,
      buyAmount,
      slippage = 0.1,
    } = params;
    const res = await calculateBuyAmount(0.1, pool);
    console.log(res);
    return;
    const accounts = await this.getAccounts({
      pool,
      tokenMint,
      user,
      developer,
    });

    const baseAmountOut = BigInt(buyAmount * LAMPORTS_PER_SOL);
    const maxQuoteAmountIn = BigInt(
      Math.floor(buyAmount * (1 + slippage) * LAMPORTS_PER_SOL)
    );

    const data = Buffer.alloc(48);
    data.set(BUY_DISCRIMINATOR, 0);
    data.writeBigUInt64LE(BigInt(baseAmountOut), 24);
    data.writeBigUInt64LE(BigInt(maxQuoteAmountIn), 24);

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

  async getAccounts({ pool, tokenMint, user, developer }) {
    const accountObj = { ...defaultBuyAccounts };

    // Get user's token accounts
    const userBaseTokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      user
    );
    const userQuoteTokenAccount = await getAssociatedTokenAddress(
      WSOL_TOKEN_ACCOUNT,
      user
    );

    const poolBaseTokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      pool,
      true
    );
    const poolQuoteTokenAccount = await getAssociatedTokenAddress(
      WSOL_TOKEN_ACCOUNT,
      pool,
      true
    );

    const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator_vault"), developer.toBuffer()],
      PUMP_AMM_PROGRAM_ID
    );

    const coinCreatorVaultAta = getAssociatedTokenAddressSync(
      WSOL_TOKEN_ACCOUNT,
      coinCreatorVaultAuthority,
      true
    );
    /**
     * pool, user, base_mint,
     * user_base_token_account, user_quote_token_account
     * pool_base_token_account, pool_quote_token_account,
     * coin_creator_vault_ata, coin_creator_vault_authority
     */
    accountObj.pool.account = pool;
    accountObj.user.account = user;
    accountObj.base_mint.account = tokenMint;
    accountObj.user_base_token_account.account = userBaseTokenAccount;
    accountObj.user_quote_token_account.account = userQuoteTokenAccount;
    accountObj.pool_base_token_account.account = poolBaseTokenAccount;
    accountObj.pool_quote_token_account.account = poolQuoteTokenAccount;

    // new add
    accountObj.coin_creator_vault_ata.account = coinCreatorVaultAta;
    accountObj.coin_creator_vault_authority.account = coinCreatorVaultAuthority;

    const accounts = Object.values(accountObj).map((item) => ({
      pubkey: item.account,
      isSigner: item.signer,
      isWritable: item.writable,
    }));

    // console.log(accounts.map((item) => item.pubkey.toBase58()));

    return accounts;
  }
}

module.exports = PumpSwapSDK;
