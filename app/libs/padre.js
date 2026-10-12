const {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} = require("@solana/web3.js");
const { randomInt } = require("node:crypto");
const { BorshCoder } = require("@coral-xyz/anchor");
const pumpSwapIdl = require("../IDL/pumpswap-idl.json");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const { PUMP_AMM_PROGRAM_ID } = require("../constants");
const {
  getCoinCreatorVaultAuthorityPda,
  getUserVolumeAccumulatorPda,
} = require("./pool");

const PADRE_PROGRAM_ID = new PublicKey(
  "term9YPb9mzAsABaqN71A4xdbxHmpBNZavpBiQKZzN3",
);
const PADRE_FEE_RECIPIENT = new PublicKey(
  "J5XGHmzrRmnYWbmw45DbYkdZAU2bwERFZ11qCDXPvFB5",
);
const PADRE_FEE_BASIS_POINTS = 100;
const pumpSwapEventCoder = new BorshCoder(pumpSwapIdl);
const ROUTE_MIN_FINAL_OUT_OFFSET = 47;
const ROUTE_DISCRIMINATOR = Buffer.from([
  229, 23, 203, 151, 122, 227, 173, 42,
]);
const NONCE_INIT_DISCRIMINATOR = Buffer.from([
  175, 175, 109, 31, 13, 152, 155, 237,
]);
const NONCE_UPDATE_DISCRIMINATOR = Buffer.from([
  222, 68, 238, 59, 185, 182, 63, 136,
]);
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
const PUMP_AMM_FEE_PROGRAM = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);
const NORMAL_PROTOCOL_FEE = new PublicKey(
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
);
const MAYHEM_PROTOCOL_FEE = new PublicKey(
  "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS",
);
const PADRE_BUYBACK_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((address) => new PublicKey(address));

const u32 = (value) => {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value, 0);
  return data;
};

const u64 = (value) => {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(value), 0);
  return data;
};

const u16 = (value) => {
  const data = Buffer.alloc(2);
  data.writeUInt16LE(value, 0);
  return data;
};

// Padre's Route instruction creates the temporary WSOL account and the output
// ATA, invokes the Pump AMM hop, then closes the temporary WSOL account.
function createPadreRouteInstruction({
  user,
  inputAmount,
  minFinalOut,
  outputTokenAccount,
  inputTokenAccount,
  inputMint = NATIVE_MINT,
  outputMint,
  hopProtocol = 3,
  hopKeys,
  feeBasisPoints = 0,
  feeRecipient,
}) {
  if (!outputMint) {
    throw new Error("Padre route requires an output mint");
  }
  if (!Array.isArray(hopKeys) || hopKeys.length > 255) {
    throw new Error("Padre route requires valid hop accounts");
  }
  if (!Number.isInteger(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints > 10000 ||
      (feeBasisPoints > 0 && !feeRecipient)) {
    throw new Error("Padre route requires valid fee settings");
  }

  const setups = [
    { tokenAccount: inputTokenAccount, mint: inputMint, hydrate: inputAmount },
    { tokenAccount: outputTokenAccount, mint: outputMint, hydrate: 0n },
  ];
  const closes = [{ tokenAccount: inputTokenAccount, mint: inputMint }];
  const data = Buffer.concat([
    ROUTE_DISCRIMINATOR,
    u32(setups.length),
    Buffer.from([1, 0]),
    u64(inputAmount),
    Buffer.from([0]),
    u64(0),
    Buffer.from([0]),
    u32(1),
    Buffer.from([hopProtocol, hopKeys.length, 1]),
    u64(inputAmount),
    u64(minFinalOut),
    u16(feeBasisPoints),
    Buffer.from([closes.length]),
    Buffer.from([0, 0]),
  ]);

  const readonly = (pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  });
  const setupAccounts = setups.flatMap((setup) => [
    { pubkey: setup.tokenAccount, isSigner: false, isWritable: true },
    readonly(setup.mint),
  ]);
  const closeAccounts = closes.flatMap((close) => [
    { pubkey: close.tokenAccount, isSigner: false, isWritable: true },
    readonly(close.mint),
  ]);

  return new TransactionInstruction({
    programId: PADRE_PROGRAM_ID,
    data,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      readonly(SystemProgram.programId),
      readonly(TOKEN_PROGRAM_ID),
      readonly(TOKEN_2022_PROGRAM_ID),
      readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
      ...setupAccounts,
      ...hopKeys,
      ...(feeBasisPoints > 0 ? [
        { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        readonly(inputMint),
      ] : []),
      ...closeAccounts,
    ],
  });
}

function getPadreBuyBaseAmountOut(logs, pool, user) {
  for (let i = (logs || []).length - 1; i >= 0; i--) {
    const match = logs[i].match(/^Program data: ([A-Za-z0-9+/=]+)$/);
    if (!match) continue;
    let event;
    try {
      event = pumpSwapEventCoder.events.decode(match[1]);
    } catch (_) {
      continue;
    }
    if (
      event?.name === "BuyEvent" &&
      event.data.pool.equals(pool) &&
      event.data.user.equals(user)
    ) {
      return BigInt(event.data.base_amount_out.toString());
    }
  }
  return null;
}

function isPadreRouteInstruction(instruction) {
  return !!instruction &&
    instruction.programId.equals(PADRE_PROGRAM_ID) &&
    instruction.data.length === 60 &&
    instruction.data.subarray(0, 8).equals(ROUTE_DISCRIMINATOR);
}

function setPadreRouteMinFinalOut(instruction, minFinalOut) {
  if (!isPadreRouteInstruction(instruction)) {
    throw new Error("Invalid Padre route instruction");
  }
  instruction.data.writeBigUInt64LE(BigInt(minFinalOut), ROUTE_MIN_FINAL_OUT_OFFSET);
}

function getPadreSwapAccounts(user, tokenMint, tokenProgramId) {
  const [inputTokenAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("temp"),
      user.toBuffer(),
      NATIVE_MINT.toBuffer(),
      Buffer.from([0]),
    ],
    PADRE_PROGRAM_ID,
  );
  return {
    inputTokenAccount,
    outputTokenAccount: getAssociatedTokenAddressSync(
      tokenMint,
      user,
      false,
      tokenProgramId,
    ),
  };
}

function padreHash(value) {
  let a = 3735928559;
  let b = 1103547991;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    a = Math.imul(a ^ char, 2654435761);
    b = Math.imul(b ^ char, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^
    Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^
    Math.imul(a ^ (a >>> 13), 3266489909);
  return 4294967296 * (2097151 & b) + (a >>> 0);
}

function createPadrePumpAmmHopKeys({
  user,
  tokenMint,
  poolDetail,
  inputTokenAccount,
  outputTokenAccount,
}) {
  const { poolData } = poolDetail;
  const readonly = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
  const writable = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
  const protocolFee = poolData.is_mayhem
    ? MAYHEM_PROTOCOL_FEE
    : NORMAL_PROTOCOL_FEE;
  const protocolFeeAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    protocolFee,
    true,
    TOKEN_PROGRAM_ID,
  );
  const coinCreator = poolData.coinCreator;
  const coinCreatorVault = getCoinCreatorVaultAuthorityPda(
    coinCreator,
    PUMP_AMM_PROGRAM_ID,
  )[0];
  const coinCreatorVaultAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    coinCreatorVault,
    true,
    TOKEN_PROGRAM_ID,
  );
  const userVolume = getUserVolumeAccumulatorPda(user);
  const buyback = PADRE_BUYBACK_RECIPIENTS[
    padreHash(user.toBase58()) % PADRE_BUYBACK_RECIPIENTS.length
  ];
  const buybackAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    buyback,
    true,
    TOKEN_PROGRAM_ID,
  );
  const [pumpSwapExtraAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-v2"), tokenMint.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  );
  const keys = [
    readonly(PUMP_AMM_PROGRAM_ID),
    writable(poolDetail.address),
    readonly(PUMP_AMM_GLOBAL_CONFIG),
    readonly(tokenMint),
    readonly(NATIVE_MINT),
    writable(inputTokenAccount),
    writable(outputTokenAccount),
    writable(poolData.poolBaseTokenAccount),
    writable(poolData.poolQuoteTokenAccount),
    readonly(protocolFee),
    writable(protocolFeeAta),
    readonly(PUMP_AMM_EVENT_AUTHORITY),
    writable(coinCreatorVaultAta),
    readonly(coinCreatorVault),
    readonly(PUMP_AMM_FEE_CONFIG),
    readonly(PUMP_AMM_FEE_PROGRAM),
    readonly(PUMP_AMM_GLOBAL_VOLUME),
    writable(userVolume),
  ];
  if (poolData.is_cashback) {
    keys.push(
      writable(
        getAssociatedTokenAddressSync(
          NATIVE_MINT,
          userVolume,
          true,
          TOKEN_PROGRAM_ID,
        ),
      ),
    );
  }
  if (!coinCreator.equals(SystemProgram.programId)) {
    keys.push(readonly(pumpSwapExtraAccount));
  }
  keys.push(readonly(buyback), writable(buybackAta));
  return keys;
}

function getPadreNonceAccount(user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nonce_account"), user.toBuffer()],
    PADRE_PROGRAM_ID,
  )[0];
}

function createPadreNonceInstructions(
  user,
  nonce = randomInt(0, 65536),
  exists = true,
) {
  const nonceAccount = getPadreNonceAccount(user);
  const instructions = [];
  if (!exists) {
    instructions.push(
      new TransactionInstruction({
        programId: PADRE_PROGRAM_ID,
        data: NONCE_INIT_DISCRIMINATOR,
        keys: [
          { pubkey: nonceAccount, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    );
  }
  const updateData = Buffer.alloc(10);
  NONCE_UPDATE_DISCRIMINATOR.copy(updateData, 0);
  updateData.writeUInt16LE(nonce, 8);
  instructions.push(
    new TransactionInstruction({
      programId: PADRE_PROGRAM_ID,
      data: updateData,
      keys: [
        { pubkey: nonceAccount, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: true, isWritable: true },
      ],
    }),
  );
  return instructions;
}

module.exports = {
  PADRE_PROGRAM_ID,
  PADRE_FEE_RECIPIENT,
  PADRE_FEE_BASIS_POINTS,
  createPadreRouteInstruction,
  createPadrePumpAmmHopKeys,
  createPadreNonceInstructions,
  getPadreNonceAccount,
  getPadreSwapAccounts,
  getPadreBuyBaseAmountOut,
  isPadreRouteInstruction,
  setPadreRouteMinFinalOut,
};
