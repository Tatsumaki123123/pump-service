import { Commitment, Connection, PublicKey, Transaction } from "@solana/web3.js";
import { Program, Provider } from "@coral-xyz/anchor";
import { PumpSwap } from "./IDL/index";
import { PumpSwapPool } from "./poolswap";
export interface SwapParams {
    poolId: PublicKey;
    user: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    protocolFeeRecipient: PublicKey;
}
export declare class PumpSwapSDK {
    program: Program<PumpSwap>;
    connection: Connection;
    pumpSwapPool: PumpSwapPool;
    constructor(provider?: Provider);
    poolKey(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): [PublicKey, number];
    private swapAccounts;
    private getMintTokenPrograms;
    createBuyInstruction(poolId: PublicKey, user: PublicKey, mint: PublicKey, amount: bigint, solAmount: bigint, commitment?: Commitment): Promise<Transaction>;
    createSellInstruction(poolId: PublicKey, user: PublicKey, mint: PublicKey, baseAmountIn: bigint, // Use bigint for u64
    minQuoteAmountOut: bigint, closeTokenAccount?: boolean, commitment?: Commitment): Promise<Transaction>;
}
