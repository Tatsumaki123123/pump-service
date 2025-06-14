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

const borsh = require("@coral-xyz/borsh");

const {
  Program,
  AnchorProvider,
  Idl,
  BN,
  BorshInstructionCoder,
} = require("@coral-xyz/anchor");
const {
  connection,
  WSOL_TOKEN_ACCOUNT,
  PUMP_AMM_PROGRAM_ID,
} = require("../constants");
const {
  RENT_SYSVAR,
  GLOBAL_CONFIG,
  PUMP_AMM_FEE,
  PUMP_AMM_FEE_TOKEN_ACCOUNT,
  EVENT_AUTHORITY,
} = require("./constants");

const OKX_PROGRAM_ID = new PublicKey(
  "6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma"
);

const buyDiscriminator = [248, 198, 158, 145, 225, 117, 135, 200];

const defaultBuyAccounts = {
  user: {
    label: "payer", // user
    order: 0,
    account: null,
    signer: true,
    writable: true,
  },
  user_quote_token_account: {
    label: "source_token_account",
    order: 1,
    account: null,
    signer: false,
    writable: true,
  },
  user_base_token_account: {
    label: "destination_token_account",
    order: 2,
    account: null,
    signer: false,
    writable: true,
  },
  quote_mint: {
    label: "source_mint",
    order: 3,
    account: WSOL_TOKEN_ACCOUNT,
    signer: false,
    writable: false,
  },
  base_mint: {
    label: "destination_mint",
    order: 4,
    account: null,
    signer: false,
    writable: false,
  },
  program: {
    label: "program",
    order: 5,
    account: PUMP_AMM_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  user: {
    label: "user",
    order: 6,
    account: null,
    signer: true,
    writable: true,
  },
  user_quote_token_account2: {
    label: "user_quote_token_account2",
    order: 7,
    account: null,
    signer: false,
    writable: true,
  },
  user_base_token_account2: {
    label: "user_base_token_account2",
    order: 8,
    account: null,
    signer: false,
    writable: true,
  },
  pool: {
    label: "pool",
    order: 9,
    account: null,
    signer: false,
    writable: false,
  },
  global_config: {
    label: "global_config",
    order: 10,
    account: GLOBAL_CONFIG,
    signer: false,
    writable: false,
  },
  base_mint2: {
    label: "base_mint",
    order: 11,
    account: null,
    signer: false,
    writable: false,
  },
  quote_mint2: {
    label: "quote_mint2",
    order: 12,
    account: WSOL_TOKEN_ACCOUNT,
    signer: false,
    writable: false,
  },
  pool_base_token_account: {
    label: "pool_base_token_account",
    order: 13,
    account: null,
    signer: false,
    writable: true,
  },
  pool_quote_token_account: {
    label: "pool_quote_token_account",
    order: 14,
    account: null,
    signer: false,
    writable: true,
  },
  protocol_fee_recipient: {
    label: "protocol_fee_recipient",
    order: 15,
    account: PUMP_AMM_FEE,
    signer: false,
    writable: false,
  },
  protocol_fee_recipient_token_account: {
    label: "protocol_fee_recipient_token_account",
    order: 16,
    account: PUMP_AMM_FEE_TOKEN_ACCOUNT,
    signer: false,
    writable: true,
  },
  quote_token_program: {
    label: "quote_token_program",
    order: 17,
    account: TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  base_token_program: {
    label: "base_token_program",
    order: 18,
    account: TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  system_program: {
    label: "system_program",
    order: 19,
    account: SystemProgram.programId,
    signer: false,
    writable: false,
  },
  associated_token_program: {
    label: "associated_token_program",
    order: 20,
    account: ASSOCIATED_TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  event_authority: {
    label: "event_authority",
    order: 21,
    account: EVENT_AUTHORITY,
    signer: false,
    writable: false,
  },
  coin_creator_vault_ata: {
    label: "coin_creator_vault_ata",
    order: 22,
    account: null,
    signer: false,
    writable: true,
  },
  coin_creator_vault_authority: {
    label: "coin_creator_vault_authority",
    order: 23,
    account: null,
    signer: false,
    writable: false,
  },
};

class OKXRouterSKD {
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

    // 序列化指令数据
    const instructionData = this.getInstructionData(
      buyAmount,
      buyTokenAmount,
      slippage
    );
    return new TransactionInstruction({
      keys: accounts,
      programId: OKX_PROGRAM_ID,
      data: instructionData,
    });
  }

  async getInstructionData(buyAmount, buyTokenAmount, slippage) {
    const pumpfunammBuySchema = borsh.struct([]);

    const routeSchema = borsh.struct([
      borsh.vec(
        borsh.union(borsh.u8("tag"), { PumpfunammBuy: pumpfunammBuySchema }),
        "dexes"
      ),
      borsh.vecU8("weights"),
    ]);

    const swapArgsSchema = borsh.struct([
      borsh.u64("amount_in"),
      borsh.u64("expect_amount_out"),
      borsh.u64("min_return"),
      borsh.vecU64("amounts"),
      borsh.vec(borsh.vec(routeSchema), "routes"),
    ]);

    const inputData = {
      amount_in: BigInt(buyAmount), // 示例：1 个代币（假设 10^9 精度）
      expect_amount_out: BigInt(buyTokenAmount), // 示例：900 个代币
      min_return: BigInt(buyTokenAmount * (1 - slippage)), // 示例：950 个代币（考虑滑点）
      amounts: [BigInt(buyAmount)], // 示例：单个值
    };

    // 固定 routes 数据（基于原始数据）
    const fixedRoutes = [
      [
        {
          dexes: [{ tag: 0, PumpfunammBuy: {} }], // 假设 PumpfunammBuy 为 tag 0
          weights: Buffer.from([100]), // 固定 weights 为 [100]
        },
      ],
    ];

    // 构造 SwapArgs
    const swapArgs = {
      amount_in: inputData.amount_in,
      expect_amount_out: inputData.expect_amount_out,
      min_return: inputData.min_return,
      amounts: inputData.amounts,
      routes: fixedRoutes,
    };

    // 序列化 SwapArgs
    const swapArgsBuffer = swapArgsSchema.encode(swapArgs);

    // 序列化 order_id（固定为 0，基于原始数据）
    const orderId = BigInt(0);
    const orderIdBuffer = Buffer.alloc(8);
    orderIdBuffer.writeBigUInt64LE(orderId);

    // 合并 instructionData
    const instructionData = Buffer.concat([
      buyDiscriminator,
      swapArgsBuffer,
      orderIdBuffer,
    ]);

    return inputData;
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
    const user_base_token_account = await getAssociatedTokenAddress(
      tokenMint,
      user
    );
    const user_quote_token_account =
      type === "buy"
        ? await getAssociatedTokenAddress(WSOL_TOKEN_ACCOUNT, user)
        : sellNewAccount;

    const pool_base_token_account = poolDetail.poolData.pool_base_token_account;
    const pool_quote_token_account =
      poolDetail.poolData.pool_quote_token_account;

    const coin_creator_vault_authority = getCoinCreatorVaultAuthorityPda(
      poolDetail.poolData.coinCreator,
      PUMP_AMM_PROGRAM_ID
    );
    const coin_creator_vault_ata = getCoinCreatorVaultAtaPda(
      coin_creator_vault_authority[0],
      TOKEN_PROGRAM_ID,
      NATIVE_MINT
    );

    const accountArr = [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: user_quote_token_account, isSigner: false, isWritable: true },
      { pubkey: user_base_token_account, isSigner: false, isWritable: true },
      { pubkey: WSOL_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
    ];
    return accountArr;

    /**
     * payer, user_quote_token_account, user_base_token_account
     * base_mint, user
     * user_quote_token_account2,
     * pool, base_mint2,pool_base_token_account,pool_quote_token_account
     * coin_creator_vault_ata, coin_creator_vault_authority
     */
    accountObj.payer.account = user;
    accountObj.user_quote_token_account.account = user_base_token_account;
    accountObj.user_base_token_account.account = user_base_token_account;
    accountObj.base_mint.account = tokenMint;
    accountObj.user.account = user;
    accountObj.user_quote_token_account2.account = user_base_token_account;
    accountObj.pool.account = poolDetail.address;
    accountObj.base_mint_2.account = tokenMint;
    accountObj.pool_base_token_account.account = pool_base_token_account;
    accountObj.pool_quote_token_account.account = pool_quote_token_account;

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

module.exports = OKXRouterSKD;
