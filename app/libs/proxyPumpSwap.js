const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} = require("@solana/spl-token");

const { WSOL_TOKEN_ACCOUNT, PUMP_AMM_PROGRAM_ID } = require("../constants");
const {
  RENT_SYSVAR,
  GLOBAL_CONFIG,
  PUMP_AMM_FEE,
  PUMP_AMM_FEE_TOKEN_ACCOUNT,
  EVENT_AUTHORITY,
} = require("./constants");

const {
  getPoolsWithPrices,
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getBuyTokenAmountBuyPoolDetail,
} = require("./pool");

const PROXY_PROGRAM_ID = new PublicKey(
  "AveaiuA1emN71q9mS2QQ9BEWNAAHmp8sHSvwLFHQjufM"
);

const defaultBuyAccounts = {
  user: {
    label: "user",
    order: 0,
    account: null,
    signer: true,
    writable: true,
  },
  user_quote_token_account: {
    label: "user_quote_token_account",
    order: 1,
    account: null,
    signer: false,
    writable: true,
  },
  quote_mint: {
    label: "quote_mint",
    order: 2,
    account: WSOL_TOKEN_ACCOUNT,
    signer: false,
    writable: true,
  },
  user_base_token_account: {
    label: "user_base_token_account",
    order: 3,
    account: null,
    signer: false,
    writable: true,
  },
  base_mint: {
    label: "base_mint",
    order: 4,
    account: null,
    signer: false,
    writable: true,
  },
  unknown_5: {
    label: "unknown_5", // WSOL账户，手续费相关，固定
    order: 5,
    account: new PublicKey("4RAnsC6m5gqb6eod2RdW4mKqhTNBckJrsjf2Z9JD5N2s"),
    signer: false,
    writable: true,
  },
  unknown_6: {
    label: "unknown_6", // WSOL账户，手续费相关，固定
    order: 6,
    account: new PublicKey("7kRfYgbpichh83KfYGubHrNrzNukesSzgD4xvf6CcB5D"),
    signer: false,
    writable: true,
  },
  quote_token_program: {
    label: "quote_token_program",
    order: 7,
    account: TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  unknown_8: {
    label: "token_2022", // Token 2022, 固定
    order: 8,
    account: TOKEN_2022_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  associated_token_program: {
    label: "associated_token_program",
    order: 9,
    account: ASSOCIATED_TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  memo_program_v2: {
    label: "memo_program_v2",
    order: 10,
    account: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    signer: false,
    writable: false,
  },
  system_program: {
    label: "system_program",
    order: 11,
    account: SystemProgram.programId,
    signer: false,
    writable: false,
  },
  rent_program: {
    label: "rent_program",
    order: 12,
    account: RENT_SYSVAR,
    signer: false,
    writable: false,
  },
  program: {
    label: "program",
    order: 13,
    account: PUMP_AMM_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  pool: {
    label: "pool",
    order: 14,
    account: null,
    signer: false,
    writable: true,
  },
  global_config: {
    label: "global_config",
    order: 15,
    account: GLOBAL_CONFIG,
    signer: false,
    writable: true,
  },
  base_mint_2: {
    label: "base_mint_2",
    order: 16,
    account: null,
    signer: false,
    writable: true,
  },
  quote_mint_2: {
    label: "quote_mint_2",
    order: 17,
    account: WSOL_TOKEN_ACCOUNT,
    signer: false,
    writable: true,
  },
  pool_base_token_account: {
    label: "pool_base_token_account",
    order: 18,
    account: null,
    signer: false,
    writable: true,
  },
  pool_quote_token_account: {
    label: "pool_quote_token_account",
    order: 19,
    account: null,
    signer: false,
    writable: true,
  },
  protocol_fee_recipient: {
    label: "protocol_fee_recipient",
    order: 20,
    account: PUMP_AMM_FEE,
    signer: false,
    writable: true,
  },
  protocol_fee_recipient_token_account: {
    label: "protocol_fee_recipient_token_account",
    order: 21,
    account: PUMP_AMM_FEE_TOKEN_ACCOUNT,
    signer: false,
    writable: true,
  },
  event_authority: {
    label: "event_authority",
    order: 22,
    account: EVENT_AUTHORITY,
    signer: false,
    writable: false,
  },
  coin_creator_vault_ata: {
    label: "coin_creator_vault_ata",
    order: 23,
    account: null,
    signer: false,
    writable: true,
  },
  coin_creator_vault_authority: {
    label: "coin_creator_vault_authority",
    order: 24,
    account: null,
    signer: false,
    writable: false,
  },
};

const a1 =
  "72960dc08cfcdd1f 005a620200000000 01000000 dac41b0ea5000000 060000000001013200";
const a2 =
  "72960dc08cfcdd1f 005a620200000000 01000000 c77317475f010000 060000000001013200";

const v1 = {
  base_amount_out: {
    type: "u64",
    data: "775167305536",
  },
  max_quote_amount_in: {
    type: "u64",
    data: "39800000",
  },
};

const v2 = {
  base_amount_out: {
    type: "u64",
    data: "1670980601377",
  },
  max_quote_amount_in: {
    type: "u64",
    data: "39800000",
  },
};

const discriminator = new Uint8Array([114, 150, 13, 192, 140, 252, 221, 31]);

class ProxyPumpSwapSDK {
  async createBuyInstruction(params) {
    const { tokenMint, user, buyAmount, slippage = 0.1, poolDetail } = params;

    const accounts = await this.getAccounts({
      poolDetail: poolDetail,
      tokenMint,
      user,
    });

    const buyTokenAmount = getBuyTokenAmountBuyPoolDetail(
      buyAmount,
      poolDetail
    );

    // 指令参数（示例使用 a1 的参数）
    const maxQuoteAmountIn = BigInt(
      Math.floor(buyAmount * (1 + slippage) * LAMPORTS_PER_SOL)
    );
    const swapType = 1; // u32
    const baseAmountOut = BigInt(buyTokenAmount);
    const extraField = new Uint8Array([6, 0, 0, 0, 0, 1, 1, 50, 0]);

    // 序列化指令数据
    const instructionData = Buffer.concat([
      Buffer.from(discriminator),
      Buffer.from(
        new Uint8Array(new BigUint64Array([maxQuoteAmountIn]).buffer)
      ),
      Buffer.from(new Uint8Array(new Uint32Array([swapType]).buffer)),
      Buffer.from(new Uint8Array(new BigUint64Array([baseAmountOut]).buffer)),
      Buffer.from(extraField),
    ]);
    return new TransactionInstruction({
      keys: accounts,
      programId: PROXY_PROGRAM_ID,
      data: instructionData,
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
     * user, user_quote_token_account, user_base_token_account,
     * base_mint
     * pool
     * base_mint_2,
     * pool_base_token_account, pool_quote_token_account,
     * coin_creator_vault_ata, coin_creator_vault_authority
     */
    accountObj.user.account = user;
    accountObj.user_quote_token_account.account = userQuoteTokenAccount;
    accountObj.user_base_token_account.account = userBaseTokenAccount;
    accountObj.base_mint.account = tokenMint;
    accountObj.pool.account = poolDetail.address;
    accountObj.base_mint_2.account = tokenMint;
    accountObj.pool_base_token_account.account = poolBaseTokenAccount;
    accountObj.pool_quote_token_account.account = poolQuoteTokenAccount;

    // new add
    accountObj.coin_creator_vault_ata.account = coin_creator_vault_ata[0];
    accountObj.coin_creator_vault_authority.account =
      coin_creator_vault_authority[0];

    const accounts = Object.values(accountObj)
      .map((item) => ({
        pubkey: item.account,
        isSigner: item.signer,
        isWritable: item.writable,
      }))
      .sort((a, b) => a.order - b.order);

    return accounts;
  }
}

module.exports = ProxyPumpSwapSDK;
