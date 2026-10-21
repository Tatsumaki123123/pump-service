const { NATIVE_MINT } = require("@solana/spl-token");
const {
  PublicKey,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const BASE_URL = "https://lite-api.jup.ag";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [250, 500, 1000];
const JUP_PROGRAM_V6 = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);
const SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR = Buffer.from([
  187, 100, 250, 204, 49, 196, 175, 20,
]);
const SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = Buffer.from([
  209, 152, 83, 147, 124, 254, 216, 233,
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
  httpError(operation, status, attempts, cause) {
    const error = new Error(`Jupiter ${operation} failed with HTTP ${status} after ${attempts} attempt(s)`,
      cause ? { cause } : undefined);
    error.status = status;
    return error;
  }

  async requestJson(ctx, uri, options, operation) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let response;
      try {
        // Jupiter can return an HTML error page. Read the body as text so the
        // HTTP status is available before attempting to parse JSON.
        response = await ctx.curl(uri, { ...options, dataType: "text" });
      } catch (error) {
        const status = error.status || error.res?.status;
        if (!RETRYABLE_STATUS.has(status) || attempt === RETRY_DELAYS_MS.length) {
          if (status) {
            throw this.httpError(operation, status, attempt + 1, error);
          }
          throw error;
        }
      }

      if (response) {
        const status = response.status || response.statusCode;
        if (status >= 200 && status < 300) {
          try {
            return JSON.parse(response.data);
          } catch (error) {
            throw new Error(`Jupiter ${operation} returned invalid JSON (HTTP ${status})`, {
              cause: error,
            });
          }
        }
        if (!RETRYABLE_STATUS.has(status) || attempt === RETRY_DELAYS_MS.length) {
          throw this.httpError(operation, status, attempt + 1);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }

  async getBuyInstructions(ctx, params) {
    const {
      user,
      tokenMint,
      buyAmount,
      slippage,
      connection,
      useSharedAccounts = false,
    } = params;
    const amount = Math.trunc(Number(buyAmount) * LAMPORTS_PER_SOL);
    const quoteResponse = await this.getQuote(
      ctx,
      NATIVE_MINT.toBase58(),
      tokenMint.toBase58(),
      amount,
      slippage,
    );
    return this.getSwapInstructions(ctx, user, quoteResponse, connection, {
      useSharedAccounts,
    });
  }

  async getSellInstructions(ctx, params) {
    const {
      user,
      tokenMint,
      tokenAmount,
      slippage,
      connection,
      useSharedAccounts = false,
      outputMint = NATIVE_MINT,
      prioritizationFeeLamports,
    } = params;
    const quoteResponse = await this.getQuote(
      ctx,
      tokenMint.toBase58(),
      outputMint.toBase58 ? outputMint.toBase58() : String(outputMint),
      tokenAmount,
      slippage,
    );
    return this.getSwapInstructions(ctx, user, quoteResponse, connection, {
      useSharedAccounts,
      prioritizationFeeLamports,
    });
  }

  async getSwapInstructions(
    ctx,
    user,
    quoteResponse,
    connection,
    { useSharedAccounts = false, prioritizationFeeLamports } = {},
  ) {
    const uri = `${BASE_URL}/swap/v1/swap-instructions`;
    const swapData = await this.requestJson(ctx, uri, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        quoteResponse,
        userPublicKey: user.toBase58 ? user.toBase58() : String(user),
        useSharedAccounts,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        ...(prioritizationFeeLamports === undefined
          ? {}
          : { prioritizationFeeLamports }),
      },
    }, "swap instructions");
    if (!swapData || swapData.error) {
      throw new Error(
        `Cannot get Jupiter instructions: ${swapData?.error || "empty response"}`,
      );
    }

    const swapInstruction = toTransactionInstruction(swapData.swapInstruction);
    this.assertRouteInstruction(swapInstruction, useSharedAccounts);

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

  assertRouteInstruction(instruction, useSharedAccounts) {
    const expectedDiscriminator = useSharedAccounts
      ? SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR
      : SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR;
    const routeName = useSharedAccounts
      ? "shared_accounts_route_v2"
      : "shared_accounts_route";
    const isExpectedRoute =
      instruction.programId.equals(JUP_PROGRAM_V6) &&
      instruction.data.length >= expectedDiscriminator.length &&
      instruction.data
        .subarray(0, expectedDiscriminator.length)
        .equals(expectedDiscriminator);
    if (!isExpectedRoute) {
      throw new Error(
        `Jupiter swap instruction is not ${routeName}: ${instruction.programId.toBase58()} ${instruction.data.subarray(0, 8).toString("hex")}`,
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
    const quote = await this.requestJson(ctx, uri, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    }, "quote");
    if (!quote || quote.error) {
      throw new Error(
        `Cannot get Jupiter V2 quote: ${quote?.error || "empty response"}`,
      );
    }
    return quote;
  }
}

module.exports = JupSDK;
