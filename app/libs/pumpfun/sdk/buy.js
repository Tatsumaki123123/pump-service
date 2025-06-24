"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buyBaseInputInternal = buyBaseInputInternal;
exports.buyQuoteInputInternal = buyQuoteInputInternal;
const bn_js_1 = __importDefault(require("bn.js"));
const util_1 = require("./util");
/**
 * Calculates a "buy" in a constant-product AMM with fees.
 * Slippage is handled as a percentage where slippage=1 => 1%.
 *
 * @param base - Base tokens requested (out).
 * @param slippage - Slippage tolerance in % (1 => 1%).
 * @param baseReserve - Reserve of base token in the pool.
 * @param quoteReserve - Reserve of quote token in the pool.
 * @param lpFeeBps - LP fee in basis points (BN).
 * @param protocolFeeBps - Protocol fee in basis points (BN).
 */
function buyBaseInputInternal(base, slippage, // 1 => 1%
baseReserve, quoteReserve, lpFeeBps, // LP fee in basis points (BN)
protocolFeeBps // Protocol fee in basis points (BN)
) {
    // -----------------------------------------------------
    // 1) Basic validations
    // -----------------------------------------------------
    if (base.isZero()) {
        throw new Error("Invalid input: 'base' cannot be zero.");
    }
    if (baseReserve.isZero() || quoteReserve.isZero()) {
        throw new Error("Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.");
    }
    if (base.gt(baseReserve)) {
        throw new Error("Cannot buy more base tokens than the pool reserves.");
    }
    if (lpFeeBps.isNeg() || protocolFeeBps.isNeg()) {
        throw new Error("Fee basis points cannot be negative.");
    }
    // -----------------------------------------------------
    // 2) Calculate the raw quote needed (Raydium-like formula)
    //    quote_amount_in = ceil_div(quote_reserve * base, base_reserve - base)
    // -----------------------------------------------------
    const numerator = quoteReserve.mul(base);
    const denominator = baseReserve.sub(base);
    if (denominator.isZero()) {
        throw new Error("Pool would be depleted; denominator is zero.");
    }
    const quoteAmountIn = (0, util_1.ceilDiv)(numerator, denominator);
    // -----------------------------------------------------
    // 3) Calculate fees
    //    - LP Fee = floor((quoteAmountIn * lpFeeBps) / 10000)
    //    - Protocol Fee = floor((quoteAmountIn * protocolFeeBps) / 10000)
    // -----------------------------------------------------
    const lpFee = (0, util_1.fee)(quoteAmountIn, lpFeeBps);
    const protocolFee = (0, util_1.fee)(quoteAmountIn, protocolFeeBps);
    const totalQuote = quoteAmountIn.add(lpFee).add(protocolFee);
    // -----------------------------------------------------
    // 4) Calculate maxQuote with slippage
    //    If slippage=1 => factor = (1 + 1/100) = 1.01
    // -----------------------------------------------------
    const precision = new bn_js_1.default(1_000_000_000); // For slippage calculations
    const slippageFactorFloat = (1 + slippage / 100) * 1_000_000_000;
    const slippageFactor = new bn_js_1.default(Math.floor(slippageFactorFloat));
    // maxQuote = totalQuote * slippageFactor / 1e9
    const maxQuote = totalQuote.mul(slippageFactor).div(precision);
    return {
        internalQuoteAmount: quoteAmountIn,
        uiQuote: totalQuote, // Final total quote after fees
        maxQuote,
    };
}
/**
 * Calculates a "buy" in a constant-product AMM with fees, where the input is quote tokens.
 * Slippage is handled as a percentage where slippage=1 => 1%.
 *
 * @param quote - Quote tokens provided (in), including fees.
 * @param slippage - Slippage tolerance in % (1 => 1%).
 * @param baseReserve - Reserve of base token in the pool.
 * @param quoteReserve - Reserve of quote token in the pool.
 * @param lpFeeBps - LP fee in basis points (BN).
 * @param protocolFeeBps - Protocol fee in basis points (BN).
 */
function buyQuoteInputInternal(quote, slippage, // 1 => 1%
baseReserve, quoteReserve, lpFeeBps, // LP fee in basis points (BN)
protocolFeeBps // Protocol fee in basis points (BN)
) {
    // -----------------------------------------------------
    // 1) Basic validations
    // -----------------------------------------------------
    console.log("poolBaseAmount", baseReserve.toString());
    console.log("poolQuoteAmount", quoteReserve.toString());
    console.log("base", quote.toString());
    console.log("lpFeeBps", lpFeeBps.toString());
    console.log("protocolFeeBps", protocolFeeBps.toString());
    if (quote.isZero()) {
        throw new Error("Invalid input: 'quote' cannot be zero.");
    }
    if (baseReserve.isZero() || quoteReserve.isZero()) {
        throw new Error("Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.");
    }
    if (lpFeeBps.isNeg() || protocolFeeBps.isNeg()) {
        throw new Error("Fee basis points cannot be negative.");
    }
    // -----------------------------------------------------
    // 2) Calculate total fee basis points and denominator
    // -----------------------------------------------------
    const totalFeeBps = lpFeeBps.add(protocolFeeBps);
    const denominator = new bn_js_1.default(10_000).add(totalFeeBps);
    // -----------------------------------------------------
    // 3) Calculate effective quote amount
    // -----------------------------------------------------
    const effectiveQuote = quote.mul(new bn_js_1.default(10_000)).div(denominator);
    // -----------------------------------------------------
    // 4) Calculate the base tokens received using effectiveQuote
    //    base_amount_out = floor(base_reserve * effectiveQuote / (quote_reserve + effectiveQuote))
    // -----------------------------------------------------
    const numerator = baseReserve.mul(effectiveQuote);
    const denominatorEffective = quoteReserve.add(effectiveQuote);
    if (denominatorEffective.isZero()) {
        throw new Error("Pool would be depleted; denominator is zero.");
    }
    const baseAmountOut = numerator.div(denominatorEffective);
    // -----------------------------------------------------
    // 5) Calculate maxQuote with slippage
    //    If slippage=1 => factor = (1 + 1/100) = 1.01
    // -----------------------------------------------------
    const precision = new bn_js_1.default(1_000_000_000); // For slippage calculations
    const slippageFactorFloat = (1 + slippage / 100) * 1_000_000_000;
    const slippageFactor = new bn_js_1.default(Math.floor(slippageFactorFloat));
    // maxQuote = quote * slippageFactor / 1e9
    const maxQuote = quote.mul(slippageFactor).div(precision);
    return {
        base: baseAmountOut, // Base tokens received after fees
        internalQuoteWithoutFees: effectiveQuote,
        maxQuote, // Maximum quote tokens to pay (with slippage)
    };
}
//# sourceMappingURL=buy.js.map