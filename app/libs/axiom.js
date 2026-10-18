const {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const BN = require("bn.js");
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = require("@solana/spl-token");
const { Program } = require("@coral-xyz/anchor");
const PUMPSWAP_IDL = require("../IDL/pumpswap-idl.json");
const { buyQuoteInputInternal } = require("./pumpfun/sdk/buy");

const {
  PUMP_AMM_PROGRAM_ID,
  WSOL_TOKEN_ACCOUNT,
  connection,
} = require("../constants");
const {
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getUserVolumeAccumulatorPda,
} = require("./pool");

const AXIOM_PROGRAM_ID = new PublicKey(
  "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9",
);
const AXIOM_CREATE_DATA_SUFFIX = 0xff;
const AXIOM_BUY_DATA_SUFFIX = Buffer.from("00021f00183c", "hex");
const AXIOM_FEE_DESTINATION = new PublicKey(
  process.env.AXIOM_FEE_DESTINATION ||
    "EqGzowSp6cKAsMSRyyrFTaBxnZEVeNY81LC18YFy8Cx9",
);
const AXIOM_DEFAULT_FEE_LAMPORTS = Number(
  process.env.AXIOM_PLATFORM_FEE_LAMPORTS || 100000,
);
const AXIOM_ACCOUNT_2 = new PublicKey(
  process.env.AXIOM_ACCOUNT_2 ||
    "5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB",
);
const AXIOM_ACCOUNT_41 = new PublicKey(
  process.env.AXIOM_ACCOUNT_41 ||
    "9krj8YnMCgeEDdx4eiuxciiXsfcfJf8C28aUKWjgmm2u",
);
const AXIOM_PUMPFUN_ACCOUNT_2 = new PublicKey(
  process.env.AXIOM_PUMPFUN_ACCOUNT_2 ||
    "8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb",
);
const AXIOM_PUMPFUN_FEE_DESTINATION = new PublicKey(
  process.env.AXIOM_PUMPFUN_FEE_DESTINATION ||
    "ECDrSz47nXihe5kyK4oWEePPsPi9qz6u5d6Fa2sDj3uM",
);
const AXIOM_PUMPFUN_BUYBACK_RECIPIENT = new PublicKey(
  process.env.AXIOM_PUMPFUN_BUYBACK_RECIPIENT ||
    "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
);
const PUMPFUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
const PUMPFUN_EVENT_AUTHORITY = new PublicKey(
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
);
const PUMPFUN_FEE_CONFIG = new PublicKey(
  "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt",
);
const AXIOM_PUMPFUN_BUY_DATA_SUFFIX = Buffer.from("000134323c", "hex");
const GLOBAL_CONFIG = new PublicKey(
  "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw",
);
const EVENT_AUTHORITY = new PublicKey(
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR",
);
const FEE_CONFIG = new PublicKey(
  "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx",
);
const FEE_PROGRAM = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);
const BUYBACK_FEE_RECIPIENT = new PublicKey(
  process.env.AXIOM_BUYBACK_FEE_RECIPIENT ||
    "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
);
const BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT = new PublicKey(
  process.env.AXIOM_BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT ||
    "GAFuhgcd328SkkBYHpfadzmef9hTGAFRCi9QoCnsZQug",
);
const PROTOCOL_FEE_RECIPIENT = new PublicKey(
  process.env.AXIOM_PROTOCOL_FEE_RECIPIENT ||
    "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
);
const PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT = new PublicKey(
  process.env.AXIOM_PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT ||
    "7GFUN3bWzJMKMRZ34JLsvcqdssDbXnp589SiE33KVwcC",
);
const GLOBAL_VOLUME_ACCUMULATOR = new PublicKey(
  "C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw",
);
const pumpAmmProgram = new Program(PUMPSWAP_IDL, { connection });

// Axiom itself sets an almost-zero min_base_amount_out on-chain (observed 256)
// and relies on maxQuoteAmountIn + the jitodontfront anti-frontrun marker for
// protection, not on the min-out. Match that behaviour with a tiny floor so the
// buy never reverts with custom error 0x67 (103) because of dynamic pool fees.
const AXIOM_MIN_BASE_AMOUNT_OUT = new BN(
  process.env.AXIOM_MIN_BASE_AMOUNT_OUT || 256,
);

function encodeAxiomCreateData(maxQuoteAmountIn, bump) {
  const data = Buffer.alloc(10);
  data.writeUInt8(1, 0);
  data.writeBigUInt64LE(BigInt(maxQuoteAmountIn), 1);
  data.writeUInt8(bump, 9);
  return data;
}

function encodeAxiomBuyData(maxQuoteAmountIn, baseAmountOut) {
  const data = Buffer.alloc(23);
  data.writeUInt8(0, 0);
  data.writeBigUInt64LE(BigInt(maxQuoteAmountIn), 1);
  data.writeBigUInt64LE(BigInt(baseAmountOut), 9);
  AXIOM_BUY_DATA_SUFFIX.copy(data, 17);
  return data;
}

async function getAxiomBaseAmountOut({
  quoteAmountIn,
  slippage,
  poolDetail,
  poolBaseTokenAccount,
  poolQuoteTokenAccount,
}) {
  const [baseBalance, quoteBalance, globalConfig, isCashback] =
    await Promise.all([
      connection.getTokenAccountBalance(poolBaseTokenAccount),
      connection.getTokenAccountBalance(poolQuoteTokenAccount),
      pumpAmmProgram.account.globalConfig.fetch(GLOBAL_CONFIG),
      getPoolCashbackFlag(poolDetail),
    ]);
  const poolBaseAmount = new BN(baseBalance.value.amount);
  const poolQuoteAmount = new BN(quoteBalance.value.amount);
  const quote = new BN(quoteAmountIn);
  const result = buyQuoteInputInternal(
    quote,
    slippage,
    poolBaseAmount,
    poolQuoteAmount,
    globalConfig.lpFeeBasisPoints,
    globalConfig.protocolFeeBasisPoints,
  );
  return {
    baseAmountOut: result.base,
    poolBaseAmount,
    poolQuoteAmount,
    lpFeeBasisPoints: globalConfig.lpFeeBasisPoints,
    protocolFeeBasisPoints: globalConfig.protocolFeeBasisPoints,
    isCashback,
  };
}

async function getPoolCashbackFlag(poolDetail) {
  const accountInfo = await connection.getAccountInfo(poolDetail.address);
  if (!accountInfo) {
    if (typeof poolDetail.poolData.is_cashback === "boolean") {
      return poolDetail.poolData.is_cashback;
    }
    throw new Error(
      `Cannot fetch pool account ${poolDetail.address.toBase58()}`,
    );
  }
  return accountInfo.data[244] === 1;
}

async function createAxiomBuyInstructions({
  tokenMint,
  user,
  buyAmount,
  slippage = 0.1,
  poolDetail,
  tokenProgramId,
  feeLamports,
}) {
  const [tempWsol, tempWsolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("wrapped_sol_account"), user.toBuffer()],
    AXIOM_PROGRAM_ID,
  );
  const userBaseTokenAccount = getAssociatedTokenAddressSync(
    tokenMint,
    user,
    false,
    tokenProgramId,
  );
  const poolBaseTokenAccount = poolDetail.poolData.poolBaseTokenAccount;
  const poolQuoteTokenAccount = poolDetail.poolData.poolQuoteTokenAccount;
  const coinCreatorVaultAuthority = getCoinCreatorVaultAuthorityPda(
    poolDetail.poolData.coinCreator,
    PUMP_AMM_PROGRAM_ID,
  )[0];
  const coinCreatorVaultAta = getCoinCreatorVaultAtaPda(
    coinCreatorVaultAuthority,
    TOKEN_PROGRAM_ID,
    NATIVE_MINT,
  )[0];
  const [poolV2] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-v2"), tokenMint.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  );
  const userVolumeAccumulator = getUserVolumeAccumulatorPda(user);
  const wsolUserAccumulatorAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    userVolumeAccumulator,
    true,
    TOKEN_PROGRAM_ID,
  );
  const quoteAmount = new BN(Math.trunc(buyAmount * LAMPORTS_PER_SOL));
  const platformFeeLamports =
    feeLamports == null
      ? new BN(Math.trunc(AXIOM_DEFAULT_FEE_LAMPORTS))
      : new BN(Math.trunc(Number(feeLamports)));
  const quoteAmountIn = quoteAmount.sub(platformFeeLamports);
  if (quoteAmountIn.lte(new BN(0))) {
    throw new Error(
      `Axiom buy amount ${quoteAmount.toString()} is not enough for platform fee ${platformFeeLamports.toString()}`,
    );
  }
  const quote = await getAxiomBaseAmountOut({
    quoteAmountIn,
    slippage,
    poolDetail,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
  });
  const maxQuoteAmountIn = quoteAmountIn.toString();
  // Match Axiom: pass a near-zero min_base_amount_out instead of the computed
  // expected output. Protection comes from maxQuoteAmountIn (spend cap) and the
  // jitodontfront marker, not from this floor. Never exceed the expected output.
  const minBaseAmountOut = quote.baseAmountOut.lt(AXIOM_MIN_BASE_AMOUNT_OUT)
    ? quote.baseAmountOut
    : AXIOM_MIN_BASE_AMOUNT_OUT;
  const baseAmountOut = minBaseAmountOut.toString();
  const createTokenAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    user,
    userBaseTokenAccount,
    user,
    tokenMint,
    tokenProgramId,
  );

  // Pump AMM cashback is paid into the WSOL ATA owned by the user's volume
  // accumulator PDA. Create it before the CPI when the selected pool enables
  // cashback; the Pump instruction only receives the account as an input.
  const createCashbackAtaIx = quote.isCashback
    ? createAssociatedTokenAccountIdempotentInstruction(
        user,
        wsolUserAccumulatorAta,
        userVolumeAccumulator,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      )
    : null;

  const createWsolIx = new TransactionInstruction({
    programId: AXIOM_PROGRAM_ID,
    keys: [
      { pubkey: tempWsol, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: WSOL_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeAxiomCreateData(maxQuoteAmountIn, tempWsolBump),
  });

  const buyIx = new TransactionInstruction({
    programId: AXIOM_PROGRAM_ID,
    keys: [
      { pubkey: tempWsol, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: AXIOM_ACCOUNT_2, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: poolDetail.poolData.coinCreator,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: coinCreatorVaultAuthority,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: poolDetail.address, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: WSOL_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: tempWsol, isSigner: false, isWritable: true },
      { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },
      {
        pubkey: PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
      ...(quote.isCashback
        ? [
            {
              pubkey: wsolUserAccumulatorAta,
              isSigner: false,
              isWritable: true,
            },
          ]
        : []),
      { pubkey: poolV2, isSigner: false, isWritable: false },
      { pubkey: BUYBACK_FEE_RECIPIENT, isSigner: false, isWritable: false },
      {
        pubkey: BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tempWsol, isSigner: false, isWritable: true },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: AXIOM_FEE_DESTINATION, isSigner: false, isWritable: true },
      { pubkey: AXIOM_ACCOUNT_41, isSigner: false, isWritable: true },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeAxiomBuyData(maxQuoteAmountIn, baseAmountOut),
  });

  const tokenAtaExists = await connection.getAccountInfo(userBaseTokenAccount);

  return {
    instructions: [
      ...(tokenAtaExists ? [] : [createTokenAtaIx]),
      ...(createCashbackAtaIx ? [createCashbackAtaIx] : []),
      createWsolIx,
      buyIx,
    ],
    signers: [],
  };
}

async function createAxiomPumpfunBuyInstructions({
  tokenMint,
  user,
  buyAmount,
  curveAccount,
  feeLamports,
}) {
  const totalQuoteLamports = BigInt(
    Math.trunc(Number(buyAmount) * LAMPORTS_PER_SOL),
  );
  const platformFeeLamports = BigInt(
    Math.trunc(
      feeLamports == null ? AXIOM_DEFAULT_FEE_LAMPORTS : Number(feeLamports),
    ),
  );
  const quoteAmountIn = totalQuoteLamports - platformFeeLamports;
  if (quoteAmountIn <= 0n) {
    throw new Error(
      `Axiom Pump.fun buy amount ${totalQuoteLamports} is not enough for platform fee ${platformFeeLamports}`,
    );
  }
  if (!curveAccount) {
    throw new Error("Axiom Pump.fun buy requires the bonding curve account");
  }

  const bondingCurve = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), tokenMint.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
  const associatedBaseBondingCurve = getAssociatedTokenAddressSync(
    tokenMint,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  const associatedQuoteBondingCurve = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
  );
  const associatedBaseUser = getAssociatedTokenAddressSync(
    tokenMint,
    user,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const associatedQuoteUser = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    user,
    false,
    TOKEN_PROGRAM_ID,
  );
  const global = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMPFUN_PROGRAM_ID,
  )[0];
  // Pump.fun and Pump AMM use the same seed label for this account, but the
  // PDA is derived with different program IDs. The shared pool helper is for
  // Pump AMM, so derive the Pump.fun account with the Pump.fun program ID.
  const userVolumeAccumulator = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
  const expectedBaseAmount = curveAccount.getBuyPrice(quoteAmountIn);
  const minTokensOut = 1n;

  const axiomData = Buffer.alloc(22);
  axiomData.writeUInt8(0, 0);
  axiomData.writeBigUInt64LE(quoteAmountIn, 1);
  axiomData.writeBigUInt64LE(expectedBaseAmount, 9);
  AXIOM_PUMPFUN_BUY_DATA_SUFFIX.copy(axiomData, 17);

  const key = (pubkey, isWritable = false, isSigner = false) => ({
    pubkey,
    isWritable,
    isSigner,
  });
  const buyInstruction = new TransactionInstruction({
    programId: AXIOM_PROGRAM_ID,
    data: axiomData,
    keys: [
      key(user, true, true),
      key(user, true, true),
      key(AXIOM_PUMPFUN_ACCOUNT_2, true),
      key(SystemProgram.programId),
      key(AXIOM_PROGRAM_ID),
      key(PUMPFUN_PROGRAM_ID),
      key(global),
      key(tokenMint),
      key(NATIVE_MINT),
      key(TOKEN_2022_PROGRAM_ID),
      key(TOKEN_PROGRAM_ID),
      key(bondingCurve, true),
      key(associatedBaseBondingCurve, true),
      key(associatedQuoteBondingCurve, true),
      key(user, true, true),
      key(associatedBaseUser, true),
      key(associatedQuoteUser, true),
      key(userVolumeAccumulator, true),
      key(PUMPFUN_FEE_CONFIG),
      key(AXIOM_PUMPFUN_BUYBACK_RECIPIENT, true),
      key(SystemProgram.programId),
      key(PUMPFUN_EVENT_AUTHORITY),
      key(PUMPFUN_PROGRAM_ID),
      key(AXIOM_PROGRAM_ID),
      key(AXIOM_PUMPFUN_FEE_DESTINATION, true),
      key(AXIOM_ACCOUNT_41, true),
      key(AXIOM_PROGRAM_ID),
      key(AXIOM_PROGRAM_ID),
      key(AXIOM_PROGRAM_ID),
    ],
  });

  const baseUserInfo = await connection.getAccountInfo(associatedBaseUser);
  const quoteUserInfo = await connection.getAccountInfo(associatedQuoteUser);
  const instructions = [];
  if (!baseUserInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        associatedBaseUser,
        user,
        tokenMint,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (!quoteUserInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        associatedQuoteUser,
        user,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      ),
    );
  }
  instructions.push(buyInstruction);
  return {
    instructions,
    feeInstruction: SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: AXIOM_PUMPFUN_FEE_DESTINATION,
      lamports: Number(platformFeeLamports),
    }),
    feeLamports: platformFeeLamports,
    expectedBaseAmount,
    minTokensOut,
  };
}

module.exports = {
  createAxiomBuyInstructions,
  createAxiomPumpfunBuyInstructions,
};
