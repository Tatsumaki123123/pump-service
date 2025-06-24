import BN from "bn.js";
import { SellBaseInputResult, SellQuoteInputResult } from "../types/sdk";
export declare function sellBaseInputInternal(base: BN, // The amount of base tokens the user wants to sell
slippage: number, // e.g. 1 => 1% slippage tolerance
baseReserve: BN, // Current reserve of base tokens in the pool
quoteReserve: BN, // Current reserve of quote tokens in the pool
lpFeeBps: BN, // LP fee in basis points (e.g., 30 => 0.30%)
protocolFeeBps: BN): SellBaseInputResult;
export declare function sellQuoteInputInternal(quote: BN, // Desired quote tokens (including fees)
slippage: number, // e.g. 1 => 1% slippage tolerance
baseReserve: BN, // Current reserve of base tokens in the pool
quoteReserve: BN, // Current reserve of quote tokens in the pool
lpFeeBps: BN, // LP fee in basis points (e.g., 30 => 0.30%)
protocolFeeBps: BN): SellQuoteInputResult;
//# sourceMappingURL=sell.d.ts.map