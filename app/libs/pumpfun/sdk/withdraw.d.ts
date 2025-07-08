import BN from "bn.js";
import { WithdrawResult } from "../types/sdk";
export declare function withdrawInternal(lpAmount: BN, slippage: number, baseReserve: BN, quoteReserve: BN, totalLpTokens: BN): WithdrawResult;
