"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.depositToken0Internal = depositToken0Internal;
exports.depositLpToken = depositLpToken;
const bn_js_1 = __importDefault(require("bn.js"));
function depositToken0Internal(token0, slippage, token0Reserve, token1Reserve, totalLpTokens) {
    if (slippage < 0 || slippage > 100) {
        throw new Error("Slippage must be between 0 and 100 (0% to 100%)");
    }
    // Calculate the corresponding output amount based on the pool's reserves
    const token1 = token0.mul(token1Reserve).div(token0Reserve);
    // Apply slippage tolerance
    const slippageFactor = new bn_js_1.default((1 + slippage / 100) * 1_000_000_000);
    const maxToken0 = token0.mul(slippageFactor).div(new bn_js_1.default(1_000_000_000));
    const maxToken1 = token1.mul(slippageFactor).div(new bn_js_1.default(1_000_000_000));
    // Calculate the LP tokens to mint, proportional to the deposit amount
    const lpToken = token0.mul(totalLpTokens).div(token0Reserve);
    return {
        token1,
        lpToken,
        maxToken0,
        maxToken1,
    };
}
function ceilDiv(numerator, denominator) {
    return numerator.add(denominator).sub(new bn_js_1.default(1)).div(denominator);
}
function depositLpToken(lpToken, slippage, baseReserve, quoteReserve, totalLpTokens) {
    if (totalLpTokens.isZero()) {
        throw new Error("Division by zero: totalLpTokens cannot be zero");
    }
    const baseAmountIn = ceilDiv(baseReserve.mul(lpToken), totalLpTokens);
    const quoteAmountIn = ceilDiv(quoteReserve.mul(lpToken), totalLpTokens);
    const slippageFactor = new bn_js_1.default((1 + slippage / 100) * 1_000_000_000);
    const slippageDenominator = new bn_js_1.default(1_000_000_000);
    const maxBase = baseAmountIn.mul(slippageFactor).div(slippageDenominator);
    const maxQuote = quoteAmountIn.mul(slippageFactor).div(slippageDenominator);
    return {
        maxBase,
        maxQuote,
    };
}
