const crypto = require("crypto");
const {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} = require("@solana/web3.js");
const {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const { connection, PUMP_AMM_PROGRAM_ID } = require("../constants");
const {
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getUserVolumeAccumulatorPda,
} = require("./pool");
const { GlobalAccount } = require("./pumpfun/globalAccount");
const { BondingCurveAccount } = require("./pumpfun/bondingCurveAccount");

const OKX_ROUTER_PROGRAM_ID = new PublicKey(
  "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u",
);
const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
const ROUTER_DISCRIMINATOR = Buffer.from([
  187, 201, 212, 51, 16, 155, 236, 60,
]);
const PUMPFUN_BUY_EXACT_SOL_IN_DISCRIMINATOR = Buffer.from([
  56, 252, 116, 8, 158, 223, 205, 95,
]);
const PUMPFUN_EVENT_AUTHORITY = new PublicKey(
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
);
const PUMPFUN_FEE_CONFIG = new PublicKey(
  process.env.OKX_PUMPFUN_FEE_CONFIG ||
    "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt",
);
const PUMPFUN_FEE_PROGRAM = new PublicKey(
  process.env.OKX_PUMPFUN_FEE_PROGRAM ||
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);
const PUMPFUN_EXTRA_ACCOUNT = new PublicKey(
  process.env.OKX_PUMPFUN_EXTRA_ACCOUNT ||
    "XDo3UtHh3B9wEa57LR3DypgyhzhmXBzHQ1QP84zzZNH",
);
const PUMPFUN_BUYBACK_ACCOUNT = new PublicKey(
  process.env.OKX_PUMPFUN_BUYBACK_ACCOUNT ||
    "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
);
const DEFAULT_PLATFORM_FEE_ACCOUNT = new PublicKey(
  process.env.OKX_PLATFORM_FEE_ACCOUNT ||
    "Af35pWcCUZkXYpTGpEbakhrhtV1q86LTDF9hNmHiccph",
);
const PUMP_AMM_GLOBAL_CONFIG = new PublicKey(
  "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw",
);
const PUMP_AMM_EVENT_AUTHORITY = new PublicKey(
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR",
);
const PUMP_AMM_GLOBAL_VOLUME = new PublicKey(
  "C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw",
);
const PUMP_AMM_FEE_CONFIG = new PublicKey(
  "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx",
);
const PUMP_AMM_PROTOCOL_FEE_RECIPIENT = new PublicKey(
  process.env.PUMP_AMM_PROTOCOL_FEE_RECIPIENT ||
    "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
);
const PUMP_AMM_PROTOCOL_FEE_TOKEN_ACCOUNT = new PublicKey(
  process.env.PUMP_AMM_PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT ||
    "94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb",
);
const PUMP_AMM_BUYBACK_RECIPIENT = new PublicKey(
  process.env.PUMP_AMM_BUYBACK_FEE_RECIPIENT ||
    "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
);
const PUMP_AMM_BUYBACK_TOKEN_ACCOUNT = getAssociatedTokenAddressSync(
  NATIVE_MINT,
  PUMP_AMM_BUYBACK_RECIPIENT,
  true,
  TOKEN_PROGRAM_ID,
);
function parseLamports(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("OKX local buy amount must be a positive SOL amount");
  }
  return BigInt(Math.trunc(amount * 1_000_000_000));
}

function ceilDiv(value, divisor) {
  return (value + divisor - 1n) / divisor;
}

function quotePumpfunBuy(spendableSol, globalAccount, curveAccount, slippage) {
  const protocolFeeBps = BigInt(globalAccount.feeBasisPoints || 0);
  const creatorFeeBps = BigInt(
    process.env.OKX_PUMPFUN_CREATOR_FEE_BPS || 30,
  );
  const totalFeeBps = protocolFeeBps + creatorFeeBps;
  let netSol = (spendableSol * 10_000n) / (10_000n + totalFeeBps);
  const protocolFee = ceilDiv(netSol * protocolFeeBps, 10_000n);
  const creatorFee = ceilDiv(netSol * creatorFeeBps, 10_000n);
  const feeAdjustedSpend = netSol + protocolFee + creatorFee;
  if (feeAdjustedSpend > spendableSol) {
    netSol -= feeAdjustedSpend - spendableSol;
  }

  const expectedAmountOut =
    netSol > 0n
      ? ((netSol - 1n) * curveAccount.virtualTokenReserves) /
        (curveAccount.virtualSolReserves + netSol - 1n)
      : 0n;
  const normalizedSlippage = Number(slippage ?? 0.05);
  const slippageBps = BigInt(
    Math.max(0, Math.min(10_000, Math.floor(normalizedSlippage * 10_000))),
  );
  const minAmountOut =
    (expectedAmountOut * (10_000n - slippageBps)) / 10_000n;

  return { expectedAmountOut, minAmountOut };
}

function getPda(seed, programId, extraSeed) {
  const seeds = [Buffer.from(seed)];
  if (extraSeed) seeds.push(extraSeed.toBuffer());
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function writeU64(data, offset, value) {
  const normalized = BigInt(value);
  if (normalized < 0n || normalized > (1n << 64n) - 1n) {
    throw new Error("OKX local router u64 value is out of range");
  }
  data.writeBigUInt64LE(normalized, offset);
}

function setLocalOkxAmmExpectedAmountOut(instructions, amountOut) {
  const swap = instructions.find(
    (ix) =>
      ix.programId.equals(OKX_ROUTER_PROGRAM_ID) &&
      ix.data.length === 48 &&
      ix.data.subarray(0, 8).equals(ROUTER_DISCRIMINATOR) &&
      ix.data[38] === 112,
  );
  if (!swap || BigInt(amountOut) <= 0n) {
    throw new Error("Cannot apply Pump AMM output quote to OKX swap");
  }
  writeU64(swap.data, 24, amountOut);
}

function createSwapTocInstruction({
  payer,
  sourceTokenAccount,
  destinationTokenAccount,
  tokenMint,
  commissionAccount,
  platformFeeAccount,
  saAuthority,
  sourceTokenSa,
  destinationTokenSa,
  destinationTokenProgram,
  eventAuthority,
  remainingAccounts,
  amountIn,
  expectedAmountOut,
  routeDexIndex,
  slippageBps,
  commissionInfo,
  platformFeeRate,
}) {
  // swap_toc args: SwapArgs, commission_info:u32, platform_fee_rate:u16.
  const data = Buffer.alloc(48);
  ROUTER_DISCRIMINATOR.copy(data, 0);
  const orderId = BigInt(Date.now()) * 1_000n + BigInt(crypto.randomInt(1000));
  writeU64(data, 8, orderId);
  writeU64(data, 16, amountIn);
  writeU64(data, 24, expectedAmountOut);
  data.writeUInt16LE(slippageBps, 32);
  data.writeUInt32LE(1, 34);
  data.writeUInt8(routeDexIndex, 38);
  data.writeUInt16LE(10_000, 39);
  data.writeUInt8(1, 41);
  data.writeUInt32LE(commissionInfo >>> 0, 42);
  data.writeUInt16LE(platformFeeRate, 46);

  const key = (pubkey, isWritable = false, isSigner = false) => ({
    pubkey,
    isWritable,
    isSigner,
  });
  return new TransactionInstruction({
    programId: OKX_ROUTER_PROGRAM_ID,
    data,
    keys: [
      key(payer, true, true),
      key(sourceTokenAccount, true),
      key(destinationTokenAccount, true),
      key(NATIVE_MINT),
      key(tokenMint),
      key(commissionAccount),
      key(platformFeeAccount, true),
      key(saAuthority, true),
      key(sourceTokenSa, true),
      key(destinationTokenSa, true),
      key(TOKEN_PROGRAM_ID),
      key(destinationTokenProgram),
      key(ASSOCIATED_TOKEN_PROGRAM_ID),
      key(SystemProgram.programId),
      key(eventAuthority),
      key(OKX_ROUTER_PROGRAM_ID),
      ...remainingAccounts,
    ],
  });
}

async function getPumpfunAccounts(
  tokenMint,
  saAuthority,
  sourceTokenSa,
  destinationTokenSa,
  destinationTokenProgram,
) {
  const globalAddress = getPda("global", PUMP_PROGRAM_ID);
  const bondingCurve = getPda("bonding-curve", PUMP_PROGRAM_ID, tokenMint);
  const [globalInfo, curveInfo] = await Promise.all([
    connection.getAccountInfo(globalAddress, "confirmed"),
    connection.getAccountInfo(bondingCurve, "confirmed"),
  ]);
  if (!globalInfo || !curveInfo) {
    throw new Error(
      `Pumpfun bonding curve is unavailable for ${tokenMint.toBase58()}`,
    );
  }

  const globalAccount = GlobalAccount.fromBuffer(globalInfo.data);
  const curveAccount = BondingCurveAccount.fromBuffer(curveInfo.data);
  if (curveAccount.complete) {
    throw new Error(
      `Pumpfun bonding curve is complete for ${tokenMint.toBase58()}`,
    );
  }
  const associatedBondingCurve = getAssociatedTokenAddressSync(
    tokenMint,
    bondingCurve,
    true,
    destinationTokenProgram,
  );
  const globalVolumeAccumulator = getPda(
    "global_volume_accumulator",
    PUMP_PROGRAM_ID,
  );
  const userVolumeAccumulator = getPda(
    "user_volume_accumulator",
    PUMP_PROGRAM_ID,
    saAuthority,
  );
  const creatorVault = getPda(
    "creator-vault",
    PUMP_PROGRAM_ID,
    curveAccount.creator,
  );

  const account = (pubkey, isWritable = false) => ({
    pubkey,
    isSigner: false,
    isWritable,
  });
  return {
    globalAccount,
    curveAccount,
    accounts: [
      account(PUMP_PROGRAM_ID),
      account(saAuthority, true),
      account(sourceTokenSa, true),
      account(destinationTokenSa, true),
      account(globalAddress),
      account(globalAccount.feeRecipient, true),
      account(tokenMint),
      account(bondingCurve, true),
      account(associatedBondingCurve, true),
      account(SystemProgram.programId),
      account(TOKEN_PROGRAM_ID),
      account(destinationTokenProgram),
      account(creatorVault, true),
      account(PUMPFUN_EVENT_AUTHORITY),
      account(globalVolumeAccumulator, true),
      account(userVolumeAccumulator, true),
      account(PUMPFUN_FEE_CONFIG),
      account(PUMPFUN_FEE_PROGRAM),
      account(PUMPFUN_EXTRA_ACCOUNT),
      account(PUMPFUN_BUYBACK_ACCOUNT, true),
    ],
  };
}

function getPumpAmmAccounts({
  tokenMint,
  saAuthority,
  sourceTokenSa,
  destinationTokenSa,
  tokenProgramId,
  poolDetail,
}) {
  if (!poolDetail?.address || !poolDetail.poolData) {
    throw new Error("Pump AMM pool detail is required for the OKX route");
  }
  const { poolData } = poolDetail;
  const coinCreatorVaultAuthority = getCoinCreatorVaultAuthorityPda(
    poolData.coinCreator,
    PUMP_AMM_PROGRAM_ID,
  )[0];
  const coinCreatorVaultAta = getCoinCreatorVaultAtaPda(
    coinCreatorVaultAuthority,
    TOKEN_PROGRAM_ID,
    NATIVE_MINT,
  )[0];
  const userVolumeAccumulator = getUserVolumeAccumulatorPda(saAuthority);
  const poolV2 = getPda("pool-v2", PUMP_AMM_PROGRAM_ID, tokenMint);
  const account = (pubkey, isWritable = false) => ({
    pubkey,
    isSigner: false,
    isWritable,
  });
  const accounts = [
    account(PUMP_AMM_PROGRAM_ID),
    account(saAuthority, true),
    account(sourceTokenSa, true),
    account(destinationTokenSa, true),
    account(poolDetail.address, true),
    account(PUMP_AMM_GLOBAL_CONFIG),
    account(tokenMint),
    account(NATIVE_MINT),
    account(poolData.poolBaseTokenAccount, true),
    account(poolData.poolQuoteTokenAccount, true),
    account(PUMP_AMM_PROTOCOL_FEE_RECIPIENT),
    account(PUMP_AMM_PROTOCOL_FEE_TOKEN_ACCOUNT, true),
    account(tokenProgramId),
    account(TOKEN_PROGRAM_ID),
    account(SystemProgram.programId),
    account(ASSOCIATED_TOKEN_PROGRAM_ID),
    account(PUMP_AMM_EVENT_AUTHORITY),
    account(coinCreatorVaultAta, true),
    account(coinCreatorVaultAuthority),
    account(PUMP_AMM_GLOBAL_VOLUME, true),
    account(userVolumeAccumulator, true),
    account(PUMP_AMM_FEE_CONFIG),
    account(PUMPFUN_FEE_PROGRAM),
  ];
  if (poolData.is_cashback) {
    accounts.push(
      account(
        getAssociatedTokenAddressSync(
          NATIVE_MINT,
          userVolumeAccumulator,
          true,
          TOKEN_PROGRAM_ID,
        ),
        true,
      ),
    );
  }
  accounts.push(
    account(poolV2),
    account(PUMP_AMM_BUYBACK_RECIPIENT),
    account(PUMP_AMM_BUYBACK_TOKEN_ACCOUNT, true),
  );
  return accounts;
}

async function createLocalOkxBuyInstructions({
  user,
  tokenMint,
  buyAmount,
  slippage = 0.05,
  tokenProgramId = TOKEN_2022_PROGRAM_ID,
  route = "pumpfun",
  poolDetail,
}) {
  const buyLamports = parseLamports(buyAmount);
  const platformFeeLamports = BigInt(
    Math.max(
      0,
      Math.trunc(
        Number(
          process.env.OKX_PLATFORM_FEE_LAMPORTS || 0,
        ),
      ),
    ),
  );
  const amountIn = buyLamports - platformFeeLamports;
  if (amountIn <= 0n) {
    throw new Error("OKX local buy amount is smaller than the platform fee");
  }

  const saAuthority = getPda("okx_sa", OKX_ROUTER_PROGRAM_ID);
  const destinationTokenAccount = getAssociatedTokenAddressSync(
    tokenMint,
    user,
    false,
    tokenProgramId,
  );
  const destinationTokenSa = getAssociatedTokenAddressSync(
    tokenMint,
    saAuthority,
    true,
    tokenProgramId,
  );
  if (route !== "pumpfun" && route !== "pumpAmm") {
    throw new Error(`Unsupported OKX local buy route: ${route}`);
  }
  if (route === "pumpAmm" && !poolDetail?.poolData) {
    throw new Error("Pump AMM pool detail is required for the OKX route");
  }
  const slippageBps = Math.max(
    0,
    Math.min(10_000, Math.floor(Number(slippage) * 10_000)),
  );
  const platformFeeRate = Number(process.env.OKX_PLATFORM_FEE_RATE || 0);
  const commissionInfo = Number(process.env.OKX_COMMISSION_INFO || 0);
  const platformFeeAccount = DEFAULT_PLATFORM_FEE_ACCOUNT;
  const sourceSeed = `okx-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const sourceTokenAccount = await PublicKey.createWithSeed(
    user,
    sourceSeed,
    TOKEN_PROGRAM_ID,
  );
  const rent = await connection.getMinimumBalanceForRentExemption(
    AccountLayout.span,
  );
  const createSource = SystemProgram.createAccountWithSeed({
    fromPubkey: user,
    basePubkey: user,
    seed: sourceSeed,
    newAccountPubkey: sourceTokenAccount,
    lamports: rent,
    space: AccountLayout.span,
    programId: TOKEN_PROGRAM_ID,
  });
  let sourceTokenSa;
  let sourceSaInstructions;
  let remainingAccounts;
  let expectedAmountOut;
  let routeDexIndex;
  if (route === "pumpAmm") {
    sourceTokenSa = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      saAuthority,
      true,
      TOKEN_PROGRAM_ID,
    );
    sourceSaInstructions = [
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        sourceTokenSa,
        saAuthority,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      ),
    ];
    remainingAccounts = getPumpAmmAccounts({
      tokenMint,
      saAuthority,
      sourceTokenSa,
      destinationTokenSa,
      tokenProgramId,
      poolDetail,
    });
    // pumpAmm's on-chain output can differ from pool-balance arithmetic.
    // The caller simulates this draft and replaces the quote before sending.
    expectedAmountOut = 1n;
    routeDexIndex = 112; // Dex::PumpfunammBuy2
  } else {
    const sourceSaSeed = `okxs-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    sourceTokenSa = await PublicKey.createWithSeed(
      user,
      sourceSaSeed,
      TOKEN_PROGRAM_ID,
    );
    sourceSaInstructions = [
      SystemProgram.createAccountWithSeed({
        fromPubkey: user,
        basePubkey: user,
        seed: sourceSaSeed,
        newAccountPubkey: sourceTokenSa,
        lamports: rent,
        space: AccountLayout.span,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        sourceTokenSa,
        NATIVE_MINT,
        saAuthority,
        TOKEN_PROGRAM_ID,
      ),
    ];
    const pumpfun = await getPumpfunAccounts(
      tokenMint,
      saAuthority,
      sourceTokenSa,
      destinationTokenSa,
      tokenProgramId,
    );
    expectedAmountOut = quotePumpfunBuy(
      amountIn,
      pumpfun.globalAccount,
      pumpfun.curveAccount,
      slippage,
    ).expectedAmountOut;
    remainingAccounts = pumpfun.accounts;
    routeDexIndex = 110; // Dex::PumpfunBuy3
  }
  const eventAuthority = getPda("__event_authority", OKX_ROUTER_PROGRAM_ID);
  const swap = createSwapTocInstruction({
    payer: user,
    sourceTokenAccount,
    destinationTokenAccount,
    tokenMint,
    commissionAccount: OKX_ROUTER_PROGRAM_ID,
    platformFeeAccount,
    saAuthority,
    sourceTokenSa,
    destinationTokenSa,
    destinationTokenProgram: tokenProgramId,
    eventAuthority,
    remainingAccounts,
    amountIn,
    expectedAmountOut,
    routeDexIndex,
    slippageBps,
    commissionInfo,
    platformFeeRate,
  });

  return [
    createSource,
    createInitializeAccountInstruction(
      sourceTokenAccount,
      NATIVE_MINT,
      user,
      TOKEN_PROGRAM_ID,
    ),
    SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: sourceTokenAccount,
      lamports: Number(amountIn),
    }),
    createSyncNativeInstruction(sourceTokenAccount, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      destinationTokenAccount,
      user,
      tokenMint,
      tokenProgramId,
    ),
    ...sourceSaInstructions,
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      destinationTokenSa,
      saAuthority,
      tokenMint,
      tokenProgramId,
    ),
    ...(route === "pumpAmm" && poolDetail.poolData.is_cashback
      ? [
          createAssociatedTokenAccountIdempotentInstruction(
            user,
            getAssociatedTokenAddressSync(
              NATIVE_MINT,
              getUserVolumeAccumulatorPda(saAuthority),
              true,
              TOKEN_PROGRAM_ID,
            ),
            getUserVolumeAccumulatorPda(saAuthority),
            NATIVE_MINT,
            TOKEN_PROGRAM_ID,
          ),
        ]
      : []),
    swap,
    createCloseAccountInstruction(
      sourceTokenAccount,
      user,
      user,
      undefined,
      TOKEN_PROGRAM_ID,
    ),
  ];
}

module.exports = {
  createLocalOkxBuyInstructions,
  setLocalOkxAmmExpectedAmountOut,
  OKX_ROUTER_PROGRAM_ID,
  PUMPFUN_BUY_EXACT_SOL_IN_DISCRIMINATOR,
};
