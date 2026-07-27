const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const {
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const BN = require("bn.js");
const { Program } = require("@coral-xyz/anchor");

const {
  WSOL_TOKEN_ACCOUNT,
  PUMP_AMM_PROGRAM_ID,
  connection,
} = require("../constants");
const PUMPSWAP_IDL = require("../IDL/pumpswap-idl.json");
const { RENT_SYSVAR, GLOBAL_CONFIG, EVENT_AUTHORITY } = require("./constants");
const { buyQuoteInputInternal } = require("./pumpfun/sdk/buy");

const {
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getUserVolumeAccumulatorPda,
} = require("./pool");
const AVE_PROGRAM_ID = new PublicKey(
  "AveaiuA1emN71q9mS2QQ9BEWNAAHmp8sHSvwLFHQjufM",
);

const AVE_FEE_TOKEN_ACCOUNT_1 = new PublicKey(
  process.env.AVE_FEE_TOKEN_ACCOUNT_1 ||
    "4RAnsC6m5gqb6eod2RdW4mKqhTNBckJrsjf2Z9JD5N2s",
);
const AVE_FEE_TOKEN_ACCOUNT_2 = new PublicKey(
  process.env.AVE_FEE_TOKEN_ACCOUNT_2 ||
    "7kRfYgbpichh83KfYGubHrNrzNukesSzgD4xvf6CcB5D",
);
const AVE_PROTOCOL_FEE_RECIPIENT = new PublicKey(
  process.env.AVE_PROTOCOL_FEE_RECIPIENT ||
    "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
);
const AVE_PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT = new PublicKey(
  process.env.AVE_PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT ||
    "94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb",
);
const GLOBAL_VOLUME_ACCUMULATOR = new PublicKey(
  "C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw",
);
const FEE_CONFIG = new PublicKey(
  "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx",
);
const FEE_PROGRAM = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);
const BUYBACK_FEE_RECIPIENT = new PublicKey(
  process.env.AVE_BUYBACK_FEE_RECIPIENT ||
    "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
);
const BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT = new PublicKey(
  process.env.AVE_BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT ||
    "CASRL2zkwDnppxEFQ4LgdwgR9pdz5Q8R8nEMKVZ9QoLp",
);
const DEFAULT_AVE_FEE_BPS = Number(process.env.AVE_FEE_BPS || 60);
const pumpAmmProgram = new Program(PUMPSWAP_IDL, { connection });

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
  ave_fee_token_account_1: {
    label: "ave_fee_token_account_1",
    order: 5,
    account: AVE_FEE_TOKEN_ACCOUNT_1,
    signer: false,
    writable: true,
  },
  ave_fee_token_account_2: {
    label: "ave_fee_token_account_2",
    order: 6,
    account: AVE_FEE_TOKEN_ACCOUNT_2,
    signer: false,
    writable: true,
  },
  ave_fee_token_account_1_repeat: {
    label: "ave_fee_token_account_1_repeat",
    order: 7,
    account: AVE_FEE_TOKEN_ACCOUNT_1,
    signer: false,
    writable: true,
  },
  ave_fee_token_account_2_repeat: {
    label: "ave_fee_token_account_2_repeat",
    order: 8,
    account: AVE_FEE_TOKEN_ACCOUNT_2,
    signer: false,
    writable: true,
  },
  quote_token_program: {
    label: "quote_token_program",
    order: 9,
    account: TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  token_2022_program: {
    label: "token_2022_program",
    order: 10,
    account: TOKEN_2022_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  associated_token_program: {
    label: "associated_token_program",
    order: 11,
    account: ASSOCIATED_TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  memo_program_v2: {
    label: "memo_program_v2",
    order: 12,
    account: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    signer: false,
    writable: false,
  },
  system_program: {
    label: "system_program",
    order: 13,
    account: SystemProgram.programId,
    signer: false,
    writable: false,
  },
  rent_program: {
    label: "rent_program",
    order: 14,
    account: RENT_SYSVAR,
    signer: false,
    writable: false,
  },
  program: {
    label: "program",
    order: 15,
    account: PUMP_AMM_PROGRAM_ID,
    signer: false,
    writable: false,
  },
  pool: {
    label: "pool",
    order: 16,
    account: null,
    signer: false,
    writable: true,
  },
  global_config: {
    label: "global_config",
    order: 17,
    account: GLOBAL_CONFIG,
    signer: false,
    writable: true,
  },
  base_mint_2: {
    label: "base_mint_2",
    order: 18,
    account: null,
    signer: false,
    writable: true,
  },
  quote_mint_2: {
    label: "quote_mint_2",
    order: 19,
    account: WSOL_TOKEN_ACCOUNT,
    signer: false,
    writable: true,
  },
  pool_base_token_account: {
    label: "pool_base_token_account",
    order: 20,
    account: null,
    signer: false,
    writable: true,
  },
  pool_quote_token_account: {
    label: "pool_quote_token_account",
    order: 21,
    account: null,
    signer: false,
    writable: true,
  },
  protocol_fee_recipient: {
    label: "protocol_fee_recipient",
    order: 22,
    account: AVE_PROTOCOL_FEE_RECIPIENT,
    signer: false,
    writable: true,
  },
  protocol_fee_recipient_token_account: {
    label: "protocol_fee_recipient_token_account",
    order: 23,
    account: AVE_PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT,
    signer: false,
    writable: true,
  },
  event_authority: {
    label: "event_authority",
    order: 24,
    account: EVENT_AUTHORITY,
    signer: false,
    writable: false,
  },
  coin_creator_vault_ata: {
    label: "coin_creator_vault_ata",
    order: 25,
    account: null,
    signer: false,
    writable: true,
  },
  coin_creator_vault_authority: {
    label: "coin_creator_vault_authority",
    order: 26,
    account: null,
    signer: false,
    writable: false,
  },
  user_quote_token_account_2: {
    label: "user_quote_token_account_2",
    order: 27,
    account: null,
    signer: false,
    writable: true,
  },
  global_volume_accumulator: {
    label: "global_volume_accumulator",
    order: 28,
    account: GLOBAL_VOLUME_ACCUMULATOR,
    signer: false,
    writable: true,
  },
  user_volume_accumulator: {
    label: "user_volume_accumulator",
    order: 29,
    account: null,
    signer: false,
    writable: true,
  },
  fee_config: {
    label: "fee_config",
    order: 30,
    account: FEE_CONFIG,
    signer: false,
    writable: false,
  },
  fee_program: {
    label: "fee_program",
    order: 31,
    account: FEE_PROGRAM,
    signer: false,
    writable: false,
  },
  pool_v2: {
    label: "pool_v2",
    order: 32,
    account: null,
    signer: false,
    writable: false,
  },
  buyback_fee_recipient: {
    label: "buyback_fee_recipient",
    order: 34,
    account: BUYBACK_FEE_RECIPIENT,
    signer: false,
    writable: true,
  },
  buyback_fee_recipient_token_account: {
    label: "buyback_fee_recipient_token_account",
    order: 35,
    account: BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT,
    signer: false,
    writable: true,
  },
};

const discriminator = new Uint8Array([114, 150, 13, 192, 140, 252, 221, 31]);
const BUY_MIN_BASE_AMOUNT_OUT_OFFSET = 20;
const BUY_MIN_DATA_LENGTH = BUY_MIN_BASE_AMOUNT_OUT_OFFSET + 8;
const U64_MAX = (1n << 64n) - 1n;

function encodeAveExtraField(feeBps) {
  const normalizedFeeBps = Math.max(0, Math.trunc(Number(feeBps)));
  const data = Buffer.alloc(11);
  data.writeUInt32LE(Math.trunc(normalizedFeeBps / 10), 0);
  data.writeUInt8(0, 4);
  data.writeUInt8(1, 5);
  data.writeUInt8(1, 6);
  data.writeUInt32LE(normalizedFeeBps, 7);
  return data;
}

function applySlippageToBaseAmount(baseAmountOut, slippage) {
  // slippage is a percentage (0.1 = 10%), convert to basis points
  const slippageBps = Math.max(0, Math.floor(Number(slippage || 0) * 10000));
  const multiplierBps = Math.max(0, 10000 - slippageBps);
  return baseAmountOut.mul(new BN(multiplierBps)).div(new BN(10000));
}

function calculateAveFeeLamports(quoteAmount, aveFeeBps) {
  const feeBps = BigInt(Math.max(0, Math.trunc(Number(aveFeeBps || 0))));
  return (quoteAmount * feeBps + 9999n) / 10000n;
}

async function getAveBaseAmountOut({
  quoteAmountIn,
  slippage,
  poolBaseTokenAccount,
  poolQuoteTokenAccount,
}) {
  const [baseBalance, quoteBalance, globalConfig] = await Promise.all([
    connection.getTokenAccountBalance(poolBaseTokenAccount),
    connection.getTokenAccountBalance(poolQuoteTokenAccount),
    pumpAmmProgram.account.globalConfig.fetch(GLOBAL_CONFIG),
  ]);

  const result = buyQuoteInputInternal(
    new BN(quoteAmountIn.toString()),
    slippage,
    new BN(baseBalance.value.amount),
    new BN(quoteBalance.value.amount),
    globalConfig.lpFeeBasisPoints,
    globalConfig.protocolFeeBasisPoints,
  );

  return {
    expectedBaseAmountOut: result.base,
    baseAmountOut: applySlippageToBaseAmount(result.base, slippage),
    poolBaseAmount: baseBalance.value.amount,
    poolQuoteAmount: quoteBalance.value.amount,
    lpFeeBasisPoints: globalConfig.lpFeeBasisPoints,
    protocolFeeBasisPoints: globalConfig.protocolFeeBasisPoints,
  };
}
class AvePumpSwapSDK {
  async createBuyInstruction(params) {
    const {
      tokenMint,
      user,
      buyAmount,
      slippage = 0.1,
      poolDetail,
      tokenProgramId = TOKEN_PROGRAM_ID,
      aveFeeBps = DEFAULT_AVE_FEE_BPS,
    } = params;

    const accounts = await this.getAccounts({
      poolDetail,
      tokenMint,
      user,
      tokenProgramId,
    });

    const maxQuoteAmountIn = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL));
    const aveFeeLamports = calculateAveFeeLamports(maxQuoteAmountIn, aveFeeBps);
    const pumpQuoteAmountIn = maxQuoteAmountIn - aveFeeLamports;
    if (pumpQuoteAmountIn <= 0n) {
      throw new Error(
        `AVE buy amount ${maxQuoteAmountIn.toString()} is not enough for fee ${aveFeeLamports.toString()}`,
      );
    }

    const quote = await getAveBaseAmountOut({
      quoteAmountIn: pumpQuoteAmountIn,
      slippage,
      poolBaseTokenAccount: poolDetail.poolData.poolBaseTokenAccount,
      poolQuoteTokenAccount: poolDetail.poolData.poolQuoteTokenAccount,
    });
    const swapType = 1;
    const baseAmountOut = BigInt(quote.baseAmountOut.toString());

    const instructionData = Buffer.concat([
      Buffer.from(discriminator),
      Buffer.from(
        new Uint8Array(new BigUint64Array([maxQuoteAmountIn]).buffer),
      ),
      Buffer.from(new Uint8Array(new Uint32Array([swapType]).buffer)),
      Buffer.from(new Uint8Array(new BigUint64Array([baseAmountOut]).buffer)),
      encodeAveExtraField(aveFeeBps),
    ]);

    console.log("AVE instruction", {
      programId: AVE_PROGRAM_ID.toBase58(),
      buyAmount,
      maxQuoteAmountIn: maxQuoteAmountIn.toString(),
      aveFeeLamports: aveFeeLamports.toString(),
      pumpQuoteAmountIn: pumpQuoteAmountIn.toString(),
      expectedBaseAmountOut: quote.expectedBaseAmountOut.toString(),
      baseAmountOut: baseAmountOut.toString(),
      baseReserve: quote.poolBaseAmount,
      quoteReserve: quote.poolQuoteAmount,
      lpFeeBasisPoints: quote.lpFeeBasisPoints.toString(),
      protocolFeeBasisPoints: quote.protocolFeeBasisPoints.toString(),
      aveFeeBps,
      data: instructionData.toString("hex"),
      accounts: accounts.map((item) => item.pubkey.toBase58()),
    });

    return new TransactionInstruction({
      keys: accounts,
      programId: AVE_PROGRAM_ID,
      data: instructionData,
    });
  }

  getBuyInstruction(instructions) {
    return instructions.find((instruction) => {
      if (
        !instruction.programId.equals(AVE_PROGRAM_ID) ||
        instruction.data.length < BUY_MIN_DATA_LENGTH
      ) {
        return false;
      }

      return Buffer.from(instruction.data.subarray(0, 8)).equals(
        Buffer.from(discriminator),
      );
    });
  }

  setBuyMinBaseAmountOut(instruction, minBaseAmountOut) {
    const normalizedMinBaseAmountOut = BigInt(minBaseAmountOut);
    if (
      normalizedMinBaseAmountOut < 0n ||
      normalizedMinBaseAmountOut > U64_MAX
    ) {
      throw new Error("minBaseAmountOut must fit in a u64");
    }

    instruction.data.writeBigUInt64LE(
      normalizedMinBaseAmountOut,
      BUY_MIN_BASE_AMOUNT_OUT_OFFSET,
    );
  }

  async getAccounts({
    poolDetail,
    tokenMint,
    user,
    type = "buy",
    sellNewAccount,
    tokenProgramId = TOKEN_PROGRAM_ID,
  }) {
    const accountObj = { ...defaultBuyAccounts };

    const userBaseTokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      user,
      false,
      tokenProgramId,
    );
    const userQuoteTokenAccount =
      type === "buy"
        ? await getAssociatedTokenAddress(WSOL_TOKEN_ACCOUNT, user)
        : sellNewAccount;

    const poolBaseTokenAccount = poolDetail.poolData.poolBaseTokenAccount;
    const poolQuoteTokenAccount = poolDetail.poolData.poolQuoteTokenAccount;
    const [coinCreatorVaultAuthority] = getCoinCreatorVaultAuthorityPda(
      poolDetail.poolData.coinCreator,
      PUMP_AMM_PROGRAM_ID,
    );
    const [coinCreatorVaultAta] = getCoinCreatorVaultAtaPda(
      coinCreatorVaultAuthority,
      TOKEN_PROGRAM_ID,
      WSOL_TOKEN_ACCOUNT,
    );
    const [poolV2] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool-v2"), tokenMint.toBuffer()],
      PUMP_AMM_PROGRAM_ID,
    );

    accountObj.user.account = user;
    accountObj.user_quote_token_account.account = userQuoteTokenAccount;
    accountObj.user_quote_token_account_2.account = userQuoteTokenAccount;
    accountObj.user_base_token_account.account = userBaseTokenAccount;
    accountObj.base_mint.account = tokenMint;
    accountObj.base_mint_2.account = tokenMint;
    accountObj.pool.account = poolDetail.address;
    accountObj.pool_base_token_account.account = poolBaseTokenAccount;
    accountObj.pool_quote_token_account.account = poolQuoteTokenAccount;
    accountObj.token_2022_program.account = tokenProgramId;
    accountObj.coin_creator_vault_ata.account = coinCreatorVaultAta;
    accountObj.coin_creator_vault_authority.account = coinCreatorVaultAuthority;
    const userVolumeAccumulator = getUserVolumeAccumulatorPda(user);
    accountObj.user_volume_accumulator.account = userVolumeAccumulator;
    accountObj.pool_v2.account = poolV2;

    const accounts = Object.values(accountObj)
      .sort((a, b) => a.order - b.order)
      .map((item) => ({
        pubkey: item.account,
        isSigner: item.signer,
        isWritable: item.writable,
      }));

    // AVE RouteSwap 转发给 pump AMM 的账户数是固定的（21 个），
    // user_volume_accumulator 的 WSOL ATA 这一槽位必须始终存在，
    // 与 pool 是否 cashback 无关（原来的 is_cashback 条件会漏插并触发错误 6022）。
    accounts.splice(accounts.length - 2, 0, {
      pubkey: getAssociatedTokenAddressSync(
        WSOL_TOKEN_ACCOUNT,
        userVolumeAccumulator,
        true,
        TOKEN_PROGRAM_ID,
      ),
      isSigner: false,
      isWritable: true,
    });

    return accounts;
  }
}

module.exports = AvePumpSwapSDK;
