const {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const BN = require("bn.js");
const {
  TOKEN_PROGRAM_ID,
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
    "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
);
const BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT = new PublicKey(
  process.env.AXIOM_BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT ||
    "qkYdTGRPHbWTWuBMz45bCiU6a23axRqf6sBHm9295WY",
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
  console.log("Axiom quote calc", {
    quoteAmount: quoteAmount.toString(),
    platformFeeLamports: platformFeeLamports.toString(),
    quoteAmountIn: quoteAmountIn.toString(),
    baseReserve: quote.poolBaseAmount.toString(),
    quoteReserve: quote.poolQuoteAmount.toString(),
    lpFeeBasisPoints: quote.lpFeeBasisPoints.toString(),
    protocolFeeBasisPoints: quote.protocolFeeBasisPoints.toString(),
    isCashback: quote.isCashback,
    expectedBaseAmountOut: quote.baseAmountOut.toString(),
    baseAmountOut,
  });

  const createTokenAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    user,
    userBaseTokenAccount,
    user,
    tokenMint,
    tokenProgramId,
  );

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

  console.log("Axiom instruction", {
    programId: AXIOM_PROGRAM_ID.toBase58(),
    tempWsol: tempWsol.toBase58(),
    tempWsolBump,
    createData: createWsolIx.data.toString("hex"),
    buyData: buyIx.data.toString("hex"),
    feeLamports: platformFeeLamports.toString(),
    feeDestination: AXIOM_FEE_DESTINATION.toBase58(),
    buyAccounts: buyIx.keys.map((item) => item.pubkey.toBase58()),
  });

  const tokenAtaExists = await connection.getAccountInfo(userBaseTokenAccount);

  return {
    instructions: [
      ...(tokenAtaExists ? [] : [createTokenAtaIx]),
      createWsolIx,
      buyIx,
    ],
    signers: [],
  };
}

module.exports = {
  createAxiomBuyInstructions,
};
