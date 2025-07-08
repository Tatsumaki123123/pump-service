import { BN, Program, Provider } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { PumpSwap } from "./IDL";
interface Pool {
    address: PublicKey;
    is_native_base: boolean;
    poolData: any;
}
interface PoolWithPrice extends Pool {
    price: number;
    reserves: {
        native: string;
        token: string;
    };
    globalConfig: {
        admin: PublicKey;
        lpFeeBasisPoints: BN;
        protocolFeeBasisPoints: BN;
        disableFlags: number;
        protocolFeeRecipients: PublicKey[];
    };
}
export declare function globalConfigPda(programId?: PublicKey): [PublicKey, number];
export declare class PumpSwapPool {
    program: Program<PumpSwap>;
    connection: Connection;
    private readonly globalConfig;
    constructor(provider?: Provider);
    getPoolsWithBaseMint(mintAddress: PublicKey): Promise<{
        address: PublicKey;
        is_native_base: boolean;
        poolData: any;
    }[]>;
    getPoolsWithQuoteMint(mintAddress: PublicKey): Promise<{
        address: PublicKey;
        is_native_base: boolean;
        poolData: any;
    }[]>;
    getPoolsWithBaseMintQuoteWSOL(mintAddress: PublicKey): Promise<{
        address: PublicKey;
        is_native_base: boolean;
        poolData: any;
    }[]>;
    getPriceAndLiquidity(pool: Pool): Promise<PoolWithPrice>;
    getPoolDataFromPoolId(poolId: PublicKey): Promise<Pool | undefined>;
    getPoolsWithPrices(mintAddress: PublicKey): Promise<PoolWithPrice[]>;
    getBuyTokenAmount(solAmount: bigint, mint: PublicKey, slippage: number, pool?: PoolWithPrice): Promise<{
        maxQuote: BN;
        baseAmountOut: BN;
    }>;
    getBuyTokenAmounts(solAmounts: bigint[], mint: PublicKey, slippage: number, pool?: PoolWithPrice): Promise<{
        maxQuote: BN;
        baseAmountOut: BN;
    }[]>;
    getSellTokenAmount(tokenAmount: bigint, mint: PublicKey, slippage: number, pool?: PoolWithPrice): Promise<BN>;
    getSellTokenAmounts(tokenAmounts: bigint[], mint: PublicKey, slippage: number, pool?: PoolWithPrice): Promise<BN[]>;
    getPumpSwapPool(mint: PublicKey): Promise<PublicKey>;
    getPrice(mint: PublicKey): Promise<number>;
    fetchGlobalConfigAccount(): Promise<{
        admin: PublicKey;
        lpFeeBasisPoints: BN;
        protocolFeeBasisPoints: BN;
        disableFlags: number;
        protocolFeeRecipients: PublicKey[];
        coinCreatorFeeBasisPoints: BN;
    }>;
}
export {};
