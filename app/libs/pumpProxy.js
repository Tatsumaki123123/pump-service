const { PublicKey, TransactionInstruction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require("@solana/spl-token");
const PumpSwapSDK = require("./pumpSwap");

const PROXY_PROGRAM_ID = new PublicKey("m9obQHAPyZeZ88w7XUY8Te6a8rBmhXsfKco7u8G8tnB");
const PROXY_FEE_RECIPIENT = new PublicKey("wNRV9s4MgNsbe4MTiHnLL3rPHN94UjRN6GzT6CX8uBL");
const PROXY_BUYBACK_RECIPIENT = new PublicKey("3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR");
const BUY_DISCRIMINATOR = Buffer.from([31, 202, 123, 158, 209, 14, 126, 68]);
const PROXY_FEE_BPS = 100;
const U64_MAX = (1n << 64n) - 1n;
const pumpSwap = new PumpSwapSDK();

async function createProxyBuyInstruction({ user, tokenMint, buyAmount, poolDetail, tokenProgramId, minBaseAmountOut = U64_MAX }) {
  const amount = Number(buyAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("buyAmount must be a positive number");
  }
  const quoteAmountIn = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
  const minimum = BigInt(minBaseAmountOut);
  if (quoteAmountIn <= 0n || quoteAmountIn > U64_MAX || minimum < 0n || minimum > U64_MAX) {
    throw new Error("proxy buy amount must fit in a u64");
  }

  const pumpAccounts = await pumpSwap.getAccounts({ poolDetail, tokenMint, user, tokenProgramId });
  // The last three Pump AMM accounts are pool_v2 and its buyback recipient pair.
  // Cashback pools may insert accounts before pool_v2.
  const keys = [
    ...pumpAccounts.slice(0, -3),
    { pubkey: PROXY_FEE_RECIPIENT, isSigner: false, isWritable: true },
    pumpAccounts[pumpAccounts.length - 3],
    { pubkey: PROXY_BUYBACK_RECIPIENT, isSigner: false, isWritable: false },
    {
      pubkey: getAssociatedTokenAddressSync(NATIVE_MINT, PROXY_BUYBACK_RECIPIENT, true, TOKEN_PROGRAM_ID),
      isSigner: false,
      isWritable: true,
    },
  ];
  const data = Buffer.alloc(26);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(quoteAmountIn, 8);
  data.writeBigUInt64LE(minimum, 16);
  data.writeUInt16LE(PROXY_FEE_BPS, 24);
  return new TransactionInstruction({ programId: PROXY_PROGRAM_ID, keys, data });
}

function getProxyBuyInstruction(instructions) {
  return instructions.find((ix) => ix.programId.equals(PROXY_PROGRAM_ID) &&
    ix.data.length === 26 && ix.data.subarray(0, 8).equals(BUY_DISCRIMINATOR));
}

function setProxyBuyMinBaseAmountOut(instruction, minBaseAmountOut) {
  const minimum = BigInt(minBaseAmountOut);
  if (minimum < 0n || minimum > U64_MAX) {
    throw new Error("minBaseAmountOut must fit in a u64");
  }
  instruction.data.writeBigUInt64LE(minimum, 16);
}

module.exports = {
  PROXY_PROGRAM_ID,
  createProxyBuyInstruction,
  getProxyBuyInstruction,
  setProxyBuyMinBaseAmountOut,
};
