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

const {
  PUMP_AMM_PROGRAM_ID,
  WSOL_TOKEN_ACCOUNT,
  connection,
} = require("../constants");
const { PumpAmmInternalSdk } = require("./pumpfun/sdk/pumpAmmInternal");
const {
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getUserVolumeAccumulatorPda,
} = require("./pool");

const AXIOM_PROGRAM_ID = new PublicKey(
  "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9",
);
const AXIOM_CREATE_DATA_SUFFIX = 0xff;
const AXIOM_BUY_DATA_SUFFIX = Buffer.from("00021f00323c", "hex");
const AXIOM_FEE_DESTINATION = new PublicKey(
  process.env.AXIOM_FEE_DESTINATION || "4XjzLKgH5RHdf5qqSsze4dhTKs4e7CATDoGhckyzk16L",
);
const AXIOM_DEFAULT_FEE_LAMPORTS = 143500;
const AXIOM_ACCOUNT_2 = new PublicKey(
  process.env.AXIOM_ACCOUNT_2 || "4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd",
);
const AXIOM_ACCOUNT_6 = new PublicKey(
  process.env.AXIOM_ACCOUNT_6 || "K2x235UkVnVN6CxiXqWWsEdLrToWGAAMHeHfVmmpvaf",
);
const AXIOM_ACCOUNT_7 = new PublicKey(
  process.env.AXIOM_ACCOUNT_7 || "FMyYa2FTMa5AJ2td9gaz54PnLhTCVtMeauaLjww5NtqW",
);
const AXIOM_POOL_AUTHORITY = new PublicKey(
  process.env.AXIOM_POOL_AUTHORITY || "CyJP99twrHW5iPfTo8zjr2wj6yyHUQrE6ERjD6obmz2Y",
);
const GLOBAL_CONFIG = new PublicKey(
  "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw",
);
const EVENT_AUTHORITY = new PublicKey(
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR",
);
const FEE_CONFIG = new PublicKey("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
const FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const BUYBACK_FEE_RECIPIENT = new PublicKey(
  process.env.AXIOM_BUYBACK_FEE_RECIPIENT || "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
);
const BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT = new PublicKey(
  process.env.AXIOM_BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT || "CA7v8gHfbquYXyDnDx6QxWW8hmL1H7X6Y2RYDrGLnuck",
);
const PROTOCOL_FEE_RECIPIENT = new PublicKey(
  process.env.AXIOM_PROTOCOL_FEE_RECIPIENT || "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
);
const PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT = new PublicKey(
  process.env.AXIOM_PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT || "BWXT6RUhit9FfJQM3pBmqeFLPYmuxgmyhMGC5sGr8RbA",
);
const GLOBAL_VOLUME_ACCUMULATOR = new PublicKey(
  "C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw",
);
const AXIOM_CASHBACK_RECIPIENT = new PublicKey(
  process.env.AXIOM_CASHBACK_RECIPIENT || "2ApLdwLrGayEmxgpLX9BTR47Q2QprfMg5SpjrLeaK8s7",
);
const AXIOM_REFERRAL_RECIPIENT = new PublicKey(
  process.env.AXIOM_REFERRAL_RECIPIENT || "4vxJwQxjit7D8TBneQuDQBdyNrSEQznnsx2gwtjRPaCD",
);

const pumpAmmInternal = new PumpAmmInternalSdk(connection);

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

async function createAxiomBuyInstructions({
  tokenMint,
  user,
  buyAmount,
  slippage = 0.1,
  poolDetail,
  tokenProgramId,
  feeLamports = AXIOM_DEFAULT_FEE_LAMPORTS,
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
  const quoteAmount = new BN(Math.trunc(buyAmount * LAMPORTS_PER_SOL));
  const [baseBalance, quoteBalance] = await Promise.all([
    connection.getTokenAccountBalance(poolBaseTokenAccount),
    connection.getTokenAccountBalance(poolQuoteTokenAccount),
  ]);
  const { base, maxQuote } = await pumpAmmInternal.buyQuoteInputInternalNoPool(
    quoteAmount,
    slippage,
    new BN(baseBalance.value.amount),
    new BN(quoteBalance.value.amount),
  );
  const baseBufferBps = Math.max(
    0,
    Math.floor(Number(process.env.AXIOM_MIN_BASE_BUFFER_BPS || 100)),
  );
  const quoteReserve = new BN(quoteBalance.value.amount);
  const priceImpactBps = quoteReserve.isZero()
    ? 10000
    : quoteAmount.mul(new BN(10000)).add(quoteReserve).subn(1).div(quoteReserve).toNumber();
  const impactMultiplier = Math.max(
    1,
    Number(process.env.AXIOM_PRICE_IMPACT_BUFFER_MULTIPLIER || 3),
  );
  const dynamicBufferBps = Math.ceil(priceImpactBps * impactMultiplier);
  const minBaseBufferBps = Math.min(
    9000,
    Math.max(baseBufferBps, dynamicBufferBps),
  );
  const slippageBps = Math.max(0, Math.floor(slippage * 100));
  const minBaseBps = Math.max(0, 10000 - slippageBps - minBaseBufferBps);
  const minBaseOut = base.mul(new BN(minBaseBps)).div(new BN(10000));
  const maxQuoteAmountIn = maxQuote.toString();
  const baseAmountOut = minBaseOut.toString();
  console.log("Axiom quote calc", {
    quoteAmount: quoteAmount.toString(),
    quoteReserve: quoteReserve.toString(),
    base: base.toString(),
    maxQuote: maxQuote.toString(),
    priceImpactBps,
    minBaseBufferBps,
    minBaseBps,
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
      { pubkey: AXIOM_ACCOUNT_6, isSigner: false, isWritable: false },
      { pubkey: AXIOM_ACCOUNT_7, isSigner: false, isWritable: false },
      { pubkey: AXIOM_POOL_AUTHORITY, isSigner: false, isWritable: true },
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
      { pubkey: PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: poolV2, isSigner: false, isWritable: false },
      { pubkey: BUYBACK_FEE_RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: BUYBACK_FEE_RECIPIENT_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tempWsol, isSigner: false, isWritable: true },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: AXIOM_CASHBACK_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: AXIOM_REFERRAL_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: AXIOM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeAxiomBuyData(maxQuoteAmountIn, baseAmountOut),
  });

  const feeIx = SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: AXIOM_FEE_DESTINATION,
    lamports: Number(feeLamports),
  });

  console.log("Axiom instruction", {
    programId: AXIOM_PROGRAM_ID.toBase58(),
    tempWsol: tempWsol.toBase58(),
    tempWsolBump,
    createData: createWsolIx.data.toString("hex"),
    buyData: buyIx.data.toString("hex"),
    buyAccounts: buyIx.keys.map((item) => item.pubkey.toBase58()),
  });

  return {
    instructions: [createTokenAtaIx, createWsolIx, buyIx, feeIx],
    signers: [],
  };
}

module.exports = {
  createAxiomBuyInstructions,
};
