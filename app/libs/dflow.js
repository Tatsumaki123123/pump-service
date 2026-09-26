const { PublicKey, TransactionInstruction } = require("@solana/web3.js");

const BASE_URL = process.env.DFLOW_API_URL || "https://quote-api.dflow.net";
const API_KEY = process.env.DFLOW_API_KEY || "";
const DEV_API_HOST = "dev-quote-api.dflow.net";
const QUOTE_CACHE_TTL_MS = Number(process.env.DFLOW_QUOTE_CACHE_TTL_MS || 1500);
// DFlow receives slippage in basis points. The public service methods in this
// project use a fraction (0.01 = 1%). Override with DFLOW_MAX_SLIPPAGE_BPS
// when a deployment wants a stricter ceiling.
const MAX_SLIPPAGE_BPS = Number(
  process.env.DFLOW_MAX_SLIPPAGE_BPS || 10000,
);
const MAX_PRICE_IMPACT_PCT = Number(
  process.env.DFLOW_MAX_PRICE_IMPACT_PCT || 10,
);
const quoteCache = new Map();

function parsePriceImpactPct(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }
  // Jupiter-compatible quote APIs commonly encode this field as a fraction
  // (0.01 = 1%), while some providers return a percentage directly.
  return numericValue <= 1 ? numericValue * 100 : numericValue;
}

function assertQuoteQuality(quote) {
  const impacts = [];
  const addImpact = (value) => {
    const impact = parsePriceImpactPct(value);
    if (impact !== null) impacts.push(impact);
  };

  addImpact(quote?.priceImpactPct);
  for (const route of Array.isArray(quote?.routePlan) ? quote.routePlan : []) {
    addImpact(route?.priceImpactPct);
    addImpact(route?.swapInfo?.priceImpactPct);
  }

  const maxImpact = Number.isFinite(MAX_PRICE_IMPACT_PCT)
    ? Math.max(0, MAX_PRICE_IMPACT_PCT)
    : 10;
  const worstImpact = impacts.length ? Math.max(...impacts) : null;
  if (worstImpact !== null && worstImpact > maxImpact) {
    throw new Error(
      `DFlow quote rejected: price impact ${worstImpact.toFixed(4)}% exceeds ${maxImpact}%`,
    );
  }
}

function toTransactionInstruction(instruction) {
  if (!instruction?.programId || !Array.isArray(instruction.accounts)) {
    throw new Error("DFlow returned an invalid instruction");
  }
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.data || "", "base64"),
  });
}

class DFlowSDK {
  getHeaders() {
    const apiHost = new URL(BASE_URL).hostname;
    if (!API_KEY && apiHost !== DEV_API_HOST) {
      throw new Error("DFLOW_API_KEY is required");
    }
    const headers = {
      "Content-Type": "application/json",
    };
    if (API_KEY) {
      headers["x-api-key"] = API_KEY;
    }
    return headers;
  }

  async getBuyInstructions(ctx, params) {
    const { user, tokenMint, buyAmount, slippage, connection, price } = params;
    const amount = Math.trunc(Number(buyAmount) * 1e9);
    return this.getSwapInstructions(ctx, {
      user,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: tokenMint.toBase58(),
      amount,
      slippage,
      connection,
      price,
    });
  }

  async getSellInstructions(ctx, params) {
    const { user, tokenMint, tokenAmount, slippage, connection, price } = params;
    return this.getSwapInstructions(ctx, {
      user,
      inputMint: tokenMint.toBase58(),
      outputMint: "So11111111111111111111111111111111111111112",
      amount: tokenAmount,
      slippage,
      connection,
      price,
    });
  }

  async getSwapInstructions(
    ctx,
    { user, inputMint, outputMint, amount, slippage, connection, price },
  ) {
    const headers = this.getHeaders();
    const slippageBps = Math.floor(Number(slippage) * 10000);
    const maxSlippageBps = Number.isFinite(MAX_SLIPPAGE_BPS)
      ? Math.max(0, Math.floor(MAX_SLIPPAGE_BPS))
      : 10000;
    if (
      !Number.isFinite(slippageBps) ||
      slippageBps < 0 ||
      slippageBps > maxSlippageBps
    ) {
      throw new Error(
        `Invalid DFlow slippage: ${slippageBps} bps; maximum is ${maxSlippageBps} bps`,
      );
    }

    const quoteParams = {
      inputMint,
      outputMint,
      amount: String(amount),
      slippageBps: String(slippageBps),
      transactionVersion: "v0",
    };
    const quote = await this.getQuote(ctx, quoteParams, headers);
    assertQuoteQuality(quote);

    const swapBody = {
      userPublicKey: user.toBase58 ? user.toBase58() : String(user),
      quoteResponse: quote,
      transactionVersion: "v0",
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "disabled",
    };
    const computeUnitPrice = Number(price);
    if (Number.isFinite(computeUnitPrice) && computeUnitPrice > 0) {
      delete swapBody.prioritizationFeeLamports;
      swapBody.computeUnitPriceMicroLamports = Math.trunc(computeUnitPrice);
    }

    const swapResponse = await ctx.curl(
      new URL("/swap-instructions", BASE_URL).toString(),
      {
        dataType: "json",
        method: "POST",
        headers,
        contentType: "json",
        data: swapBody,
      },
    );
    const swapData = swapResponse.data;
    if (!swapData || swapData.error || swapData.code) {
      throw new Error(
        `Cannot get DFlow swap instructions: ${swapData?.msg || swapData?.error || "empty response"}`,
      );
    }

    const instructionGroups = [
      swapData.computeBudgetInstructions,
      swapData.setupInstructions,
      swapData.otherInstructions,
      [swapData.swapInstruction],
      swapData.cleanupInstructions,
    ];
    const instructions = instructionGroups
      .flatMap((group) => group || [])
      .filter(Boolean)
      .map(toTransactionInstruction);
    if (instructions.length === 0) {
      throw new Error("DFlow returned no swap instructions");
    }

    const lookupTableAccounts = await this.getLookupTableAccounts(
      connection,
      swapData.addressLookupTableAddresses,
    );
    return { instructions, lookupTableAccounts };
  }

  async getQuote(ctx, params, headers) {
    const key = JSON.stringify(params);
    const now = Date.now();
    const cached = quoteCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }
    if (cached) {
      quoteCache.delete(key);
    }

    const quoteUrl = new URL("/quote", BASE_URL);
    quoteUrl.search = new URLSearchParams(params).toString();
    const promise = ctx
      .curl(quoteUrl.toString(), {
        dataType: "json",
        method: "GET",
        headers,
      })
      .then((quoteResponse) => {
        const quote = quoteResponse.data;
        if (!quote || quote.error || quote.code) {
          throw new Error(
            `Cannot get DFlow quote: ${quote?.msg || quote?.error || "empty response"}`,
          );
        }
        return quote;
      })
      .catch((error) => {
        const current = quoteCache.get(key);
        if (current?.promise === promise) {
          quoteCache.delete(key);
        }
        throw error;
      });

    quoteCache.set(key, {
      promise,
      expiresAt: now + Math.max(0, QUOTE_CACHE_TTL_MS),
    });
    return promise;
  }

  async getLookupTableAccounts(connection, addresses = []) {
    const uniqueAddresses = [...new Set(addresses || [])];
    if (uniqueAddresses.length === 0) {
      return [];
    }
    if (!connection) {
      throw new Error("Solana connection is required for DFlow lookup tables");
    }

    return Promise.all(
      uniqueAddresses.map(async (address) => {
        const result = await connection.getAddressLookupTable(
          new PublicKey(address),
        );
        if (!result.value) {
          throw new Error(`DFlow lookup table not found: ${address}`);
        }
        return result.value;
      }),
    );
  }
}

module.exports = DFlowSDK;
