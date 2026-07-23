const { NATIVE_MINT } = require("@solana/spl-token");
const {
  PublicKey,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const BASE_URL = "https://lite-api.jup.ag";
const JUP_PROGRAM_V6 = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);
const ROUTE_V2_DISCRIMINATOR = Buffer.from([
  187, 100, 250, 204, 49, 196, 175, 20,
]);

function toTransactionInstruction(instruction) {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(instruction.data, "base64"),
  });
}

class JupSDK {
  async getBuyInstructions(ctx, params) {
    const { user, tokenMint, buyAmount, slippage, connection } = params;
    const amount = Math.trunc(Number(buyAmount) * LAMPORTS_PER_SOL);
    const quoteResponse = await this.getQuote(
      ctx,
      NATIVE_MINT.toBase58(),
      tokenMint.toBase58(),
      amount,
      slippage,
    );
    return this.getSwapInstructions(ctx, user, quoteResponse, connection);
  }

  async getSellInstructions(ctx, params) {
    const { user, tokenMint, tokenAmount, slippage, connection } = params;
    const quoteResponse = await this.getQuote(
      ctx,
      tokenMint.toBase58(),
      NATIVE_MINT.toBase58(),
      tokenAmount,
      slippage,
    );
    return this.getSwapInstructions(ctx, user, quoteResponse, connection);
  }

  async getSwapInstructions(ctx, user, quoteResponse, connection) {
    const uri = `${BASE_URL}/swap/v1/swap-instructions`;
    const res = await ctx.curl(uri, {
      dataType: "json",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        quoteResponse,
        userPublicKey: user.toBase58 ? user.toBase58() : String(user),
        useSharedAccounts: false,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      },
    });
    const swapData = res.data;
    if (!swapData || swapData.error) {
      throw new Error(
        `Cannot get Jupiter route_v2 instructions: ${swapData?.error || "empty response"}`,
      );
    }

    const swapInstruction = toTransactionInstruction(swapData.swapInstruction);
    this.assertRouteV2Instruction(swapInstruction);

    const instructions = [
      swapData.tokenLedgerInstruction,
      ...(swapData.computeBudgetInstructions || []),
      ...(swapData.otherInstructions || []),
      ...(swapData.setupInstructions || []),
      swapData.swapInstruction,
      swapData.cleanupInstruction,
    ]
      .filter(Boolean)
      .map(toTransactionInstruction);

    const lookupTableAccounts = await this.getLookupTableAccounts(
      connection,
      swapData.addressLookupTableAddresses,
    );

    return { instructions, lookupTableAccounts };
  }

  assertRouteV2Instruction(instruction) {
    const isRouteV2 =
      instruction.programId.equals(JUP_PROGRAM_V6) &&
      instruction.data.length >= ROUTE_V2_DISCRIMINATOR.length &&
      instruction.data
        .subarray(0, ROUTE_V2_DISCRIMINATOR.length)
        .equals(ROUTE_V2_DISCRIMINATOR);
    if (!isRouteV2) {
      throw new Error(
        `Jupiter swap instruction is not route_v2: ${instruction.programId.toBase58()} ${instruction.data.subarray(0, 8).toString("hex")}`,
      );
    }
  }

  async getLookupTableAccounts(connection, addresses = []) {
    const uniqueAddresses = [...new Set(addresses || [])];
    if (uniqueAddresses.length === 0) {
      return [];
    }
    if (!connection) {
      throw new Error("Solana connection is required for Jupiter lookup tables");
    }

    const lookupTables = await Promise.all(
      uniqueAddresses.map(async (address) => {
        const result = await connection.getAddressLookupTable(
          new PublicKey(address),
        );
        if (!result.value) {
          throw new Error(`Jupiter lookup table not found: ${address}`);
        }
        return result.value;
      }),
    );
    return lookupTables;
  }

  async getQuote(ctx, input, output, amount, slippage) {
    const slippageBps = Math.floor(Number(slippage) * 10000);
    if (!Number.isFinite(slippageBps) || slippageBps < 0) {
      throw new Error("Invalid Jupiter slippage");
    }

    const query = new URLSearchParams({
      inputMint: input,
      outputMint: output,
      amount: String(amount),
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: "true",
      instructionVersion: "V2",
    });
    const uri = `${BASE_URL}/swap/v1/quote?${query.toString()}`;
    const res = await ctx.curl(uri, {
      dataType: "json",
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (!res.data || res.data.error) {
      throw new Error(
        `Cannot get Jupiter V2 quote: ${res.data?.error || "empty response"}`,
      );
    }
    return res.data;
  }
}

module.exports = JupSDK;
