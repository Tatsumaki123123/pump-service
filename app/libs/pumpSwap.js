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
  NATIVE_MINT,
} = require("@solana/spl-token");

const BufferLayout = require("@solana/buffer-layout");

const { WSOL_TOKEN_ACCOUNT, PUMP_AMM_PROGRAM_ID } = require("../constants");

const {
  getPoolsWithPrices,
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getBuyTokenAmountBuyPoolDetail,
} = require("./pool");

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

class PumpSwapSDK {
  constructor() {}

  async createBuyInstruction(params) {
    const { tokenMint, user, buyAmount, slippage = 0.1, poolDetail } = params;

    const accounts = await this.getAccounts({
      poolDetail: poolDetail,
      tokenMint,
      user,
    });

    // console.log(
    //   accounts.map((account, index) => [index + 1, account.pubkey.toBase58()])
    // );

    const buyTokenAmount = getBuyTokenAmountBuyPoolDetail(
      buyAmount,
      poolDetail
    );

    const baseAmountOut = buyTokenAmount;
    const maxQuoteAmountIn = BigInt(
      Math.floor(buyAmount * (1 + slippage) * LAMPORTS_PER_SOL)
    );
    console.log("buyTokenAmount", buyAmount, buyTokenAmount, maxQuoteAmountIn);

    const data = Buffer.alloc(8 + 8 + 8); // 24 bytes total
    data.set(BUY_DISCRIMINATOR, 0);
    data.writeBigUInt64LE(BigInt(baseAmountOut), 8); // Write base_amount_in as little-endian u64
    data.writeBigUInt64LE(BigInt(maxQuoteAmountIn), 16); // Write min_quote_amount_out as little-endian u64

    return new TransactionInstruction({
      keys: accounts,
      programId: PUMP_AMM_PROGRAM_ID,
      data: data,
    });
  }

  async createSellInstruction(params) {
    const { tokenMint, user, tokenAmount, sellNewAccount, poolDetail } = params;

    const accounts = await this.getAccounts({
      poolDetail,
      tokenMint,
      user,
      sellNewAccount,
      type: "sell",
    });
    // console.log(
    //   accounts.map((account, index) => [index + 1, account.pubkey.toBase58()])
    // );
    const baseAmountIn = BigInt(Math.floor(tokenAmount * 10 ** 6));
    const minQuoteAmountOut = BigInt(0);
    const data = Buffer.alloc(8 + 8 + 8); // 24 bytes total
    data.set(SELL_DISCRIMINATOR, 0);
    data.writeBigUInt64LE(BigInt(baseAmountIn), 8); // Write base_amount_in as little-endian u64
    data.writeBigUInt64LE(BigInt(minQuoteAmountOut), 16);

    return new TransactionInstruction({
      keys: accounts,
      programId: PUMP_AMM_PROGRAM_ID,
      data: data,
    });
  }

  async getAccounts({
    poolDetail,
    tokenMint,
    user,
    type = "buy",
    sellNewAccount,
  }) {
    const accountObj = { ...defaultBuyAccounts };

    // Get user's token accounts
    const userBaseTokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      user
    );
    const userQuoteTokenAccount =
      type === "buy"
        ? await getAssociatedTokenAddress(WSOL_TOKEN_ACCOUNT, user)
        : sellNewAccount;

    const poolBaseTokenAccount = poolDetail.poolData.poolBaseTokenAccount;
    const poolQuoteTokenAccount = poolDetail.poolData.poolQuoteTokenAccount;

    const coin_creator_vault_authority = getCoinCreatorVaultAuthorityPda(
      poolDetail.poolData.coinCreator,
      PUMP_AMM_PROGRAM_ID
    );
    const coin_creator_vault_ata = getCoinCreatorVaultAtaPda(
      coin_creator_vault_authority[0],
      TOKEN_PROGRAM_ID,
      NATIVE_MINT
    );
    /**
     * pool, user, base_mint,
     * user_base_token_account, user_quote_token_account
     * pool_base_token_account, pool_quote_token_account,
     * coin_creator_vault_ata, coin_creator_vault_authority
     */
    accountObj.pool.account = poolDetail.address;
    accountObj.user.account = user;
    accountObj.base_mint.account = tokenMint;
    accountObj.user_base_token_account.account = userBaseTokenAccount;
    accountObj.user_quote_token_account.account = userQuoteTokenAccount;
    accountObj.pool_base_token_account.account = poolBaseTokenAccount;
    accountObj.pool_quote_token_account.account = poolQuoteTokenAccount;

    // new add
    accountObj.coin_creator_vault_ata.account = coin_creator_vault_ata[0];
    accountObj.coin_creator_vault_authority.account =
      coin_creator_vault_authority[0];

    const accounts = Object.values(accountObj).map((item) => ({
      pubkey: item.account,
      isSigner: item.signer,
      isWritable: item.writable,
    }));

    return accounts;
  }
}

module.exports = PumpSwapSDK;
