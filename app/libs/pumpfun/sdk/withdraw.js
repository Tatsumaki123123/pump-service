"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withdrawInternal = withdrawInternal;
const bn_js_1 = __importDefault(require("bn.js"));
function withdrawInternal(lpAmount, slippage, baseReserve, quoteReserve, totalLpTokens) {
    if (lpAmount.isZero() || totalLpTokens.isZero()) {
        throw new Error("LP amount or total LP tokens cannot be zero.");
    }
    // Calculate the base and quote amounts
    const base = baseReserve.mul(lpAmount).div(totalLpTokens);
    const quote = quoteReserve.mul(lpAmount).div(totalLpTokens);
    // Calculate the minimum amounts considering slippage
    const scaleFactor = new bn_js_1.default(1_000_000_000);
    const slippageFactor = new bn_js_1.default((1 - slippage / 100) * 1_000_000_000);
    const minBase = base.mul(slippageFactor).div(scaleFactor);
    const minQuote = quote.mul(slippageFactor).div(scaleFactor);
    return {
        base,
        quote,
        minBase,
        minQuote,
    };
}
//# sourceMappingURL=withdraw.js.map