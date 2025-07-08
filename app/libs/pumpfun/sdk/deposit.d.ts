import BN from "bn.js";
import { DepositLpTokenResult, DepositResult } from "../types/sdk";
export declare function depositToken0Internal(token0: BN, slippage: number, token0Reserve: BN, token1Reserve: BN, totalLpTokens: BN): DepositResult;
export declare function depositLpToken(lpToken: BN, slippage: number, baseReserve: BN, quoteReserve: BN, totalLpTokens: BN): DepositLpTokenResult;
