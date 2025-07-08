"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sellBaseInputInternal = sellBaseInputInternal;
exports.sellQuoteInputInternal = sellQuoteInputInternal;
const bn_js_1 = __importDefault(require("bn.js"));
const util_1 = require("./util");
function sellBaseInputInternal(base, // The amount of base tokens the user wants to sell
slippage, // e.g. 1 => 1% slippage tolerance
baseReserve, // Current reserve of base tokens in the pool
quoteReserve, // Current reserve of quote tokens in the pool
lpFeeBps, // LP fee in basis points (e.g., 30 => 0.30%)
protocolFeeBps) {
    // -----------------------------------------
    // 1) Basic validations
    // -----------------------------------------
    if (base.isZero()) {
        throw new Error("Invalid input: 'base' (base_amount_in) cannot be zero.");
    }
    if (baseReserve.isZero() || quoteReserve.isZero()) {
        throw new Error("Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.");
    }
    if (lpFeeBps.isNeg() || protocolFeeBps.isNeg()) {
        throw new Error("Fee basis points cannot be negative.");
    }
    // -----------------------------------------
    // 2) Calculate the raw quote output (no fees)
    //    This matches a typical constant-product formula for selling base to get quote:
    //      quote_amount_out = floor( (quoteReserve * base) / (baseReserve + base) )
    // -----------------------------------------
    const quoteAmountOut = quoteReserve.mul(base).div(baseReserve.add(base)); // floor by BN.div
    // -----------------------------------------
    // 3) Calculate fees
    //    LP fee and protocol fee are both taken from 'quoteAmountOut'
    // -----------------------------------------
    const lpFee = (0, util_1.fee)(quoteAmountOut, lpFeeBps);
    const protocolFee = (0, util_1.fee)(quoteAmountOut, protocolFeeBps);
    // Subtract fees to get the actual user receive
    const finalQuote = quoteAmountOut.sub(lpFee).sub(protocolFee);
    if (finalQuote.isNeg()) {
        // Theoretically shouldn't happen unless fees exceed quoteAmountOut
        throw new Error("Fees exceed total output; final quote is negative.");
    }
    // -----------------------------------------
    // 4) Calculate minQuote with slippage
    //    - If slippage=1 => 1%, we allow receiving as low as 99% of finalQuote
    // -----------------------------------------
    const precision = new bn_js_1.default(1_000_000_000); // For safe integer math
    // (1 - slippage/100) => e.g. slippage=1 => factor= 0.99
    const slippageFactorFloat = (1 - slippage / 100) * 1_000_000_000;
    const slippageFactor = new bn_js_1.default(Math.floor(slippageFactorFloat));
    // minQuote = finalQuote * (1 - slippage/100)
    const minQuote = finalQuote.mul(slippageFactor).div(precision);
    return {
        uiQuote: finalQuote, // actual tokens user receives after fees
        minQuote, // minimum acceptable tokens after applying slippage
        internalQuoteAmountOut: quoteAmountOut,
    };
}
const MAX_FEE_BASIS_POINTS = new bn_js_1.default(10_000); // Assuming MAX_FEE_BASIS_POINTS is 10,000 (100%)
function calculateQuoteAmountOut(userQuoteAmountOut, lpFeeBasisPoints, protocolFeeBasisPoints) {
    // Calculate the total fee basis points
    const totalFeeBasisPoints = lpFeeBasisPoints.add(protocolFeeBasisPoints);
    // Calculate the denominator
    const denominator = MAX_FEE_BASIS_POINTS.sub(totalFeeBasisPoints);
    // Calculate the quote_amount_out
    return (0, util_1.ceilDiv)(userQuoteAmountOut.mul(MAX_FEE_BASIS_POINTS), denominator);
}
function sellQuoteInputInternal(quote, // Desired quote tokens (including fees)
slippage, // e.g. 1 => 1% slippage tolerance
baseReserve, // Current reserve of base tokens in the pool
quoteReserve, // Current reserve of quote tokens in the pool
lpFeeBps, // LP fee in basis points (e.g., 30 => 0.30%)
protocolFeeBps) {
    // -----------------------------------------
    // 1) Basic validations
    // -----------------------------------------
    if (quote.isZero()) {
        throw new Error("Invalid input: 'quote' cannot be zero.");
    }
    if (baseReserve.isZero() || quoteReserve.isZero()) {
        throw new Error("Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.");
    }
    if (quote.gt(quoteReserve)) {
        throw new Error("Cannot receive more quote tokens than the pool quote reserves.");
    }
    if (lpFeeBps.isNeg() || protocolFeeBps.isNeg()) {
        throw new Error("Fee basis points cannot be negative.");
    }
    // -----------------------------------------
    // 2) Calculate the fees included in the quote
    // -----------------------------------------
    const rawQuote = calculateQuoteAmountOut(quote, lpFeeBps, protocolFeeBps);
    // -----------------------------------------
    // 3) Calculate the base amount needed for the raw quote output
    //    Invert the constant product formula:
    //    base_amount_in = ceil((baseReserve * rawQuote) / (quoteReserve - rawQuote))
    // -----------------------------------------
    if (rawQuote.gte(quoteReserve)) {
        throw new Error("Invalid input: Desired quote amount exceeds available reserve.");
    }
    const baseAmountIn = (0, util_1.ceilDiv)(baseReserve.mul(rawQuote), quoteReserve.sub(rawQuote));
    // -----------------------------------------
    // 4) Calculate minQuote with slippage
    //    - If slippage=1 => 1%, we allow receiving as low as 99% of the desired quote
    // -----------------------------------------
    const precision = new bn_js_1.default(1_000_000_000); // For slippage calculations
    const slippageFactorFloat = (1 - slippage / 100) * 1_000_000_000;
    const slippageFactor = new bn_js_1.default(Math.floor(slippageFactorFloat));
    const minQuote = quote.mul(slippageFactor).div(precision);
    return {
        internalRawQuote: rawQuote,
        base: baseAmountIn, // amount of base tokens required to get the desired quote
        minQuote, // minimum acceptable tokens after applying slippage
    };
}
