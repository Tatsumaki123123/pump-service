import { BN } from "@coral-xyz/anchor";
export declare function getPumpSwapBuyPrices(quote: BN, slippage: number, // 1 => 1%
baseReserve: BN, quoteReserve: BN, lpFeeBps: BN, // LP fee in basis points (BN)
protocolFeeBps: BN): {
    maxQuote: BN;
    baseAmountOut: BN;
};
