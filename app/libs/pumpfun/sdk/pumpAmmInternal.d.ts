import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BuyBaseInputResult, BuyQuoteInputResult, DepositBaseResult, DepositQuoteResult, SellBaseInputResult, SellQuoteInputResult, WithdrawResult } from "../types/sdk";
export declare class PumpAmmInternalSdk {
    private readonly connection;
    private readonly program;
    private readonly globalConfig;
    constructor(connection: Connection, programId?: string);
    programId(): PublicKey;
    globalConfigKey(): PublicKey;
    poolKey(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): [PublicKey, number];
    lpMintKey(pool: PublicKey): [PublicKey, number];
    fetchGlobalConfigAccount(): Promise<{
        admin: PublicKey;
        lpFeeBasisPoints: BN;
        protocolFeeBasisPoints: BN;
        disableFlags: number;
        protocolFeeRecipients: PublicKey[];
    }>;
    fetchPool(pool: PublicKey): Promise<{
        poolBump: number;
        index: number;
        creator: PublicKey;
        baseMint: PublicKey;
        quoteMint: PublicKey;
        lpMint: PublicKey;
        poolBaseTokenAccount: PublicKey;
        poolQuoteTokenAccount: PublicKey;
        lpSupply: BN;
    }>;
    createPoolInstructionsInternal(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, baseIn: BN, quoteIn: BN, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    depositInstructionsInternal(pool: PublicKey, lpToken: BN, maxBase: BN, maxQuote: BN, user: PublicKey, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined, userPoolTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    private withWsolAccounts;
    private withWsolAccount;
    private accountExists;
    depositBaseInputInternal(pool: PublicKey, base: BN, slippage: number): Promise<DepositBaseResult>;
    depositQuoteInputInternal(pool: PublicKey, quote: BN, slippage: number): Promise<DepositQuoteResult>;
    withdrawInstructionsInternal(pool: PublicKey, lpTokenAmountIn: BN, minBaseAmountOut: BN, minQuoteAmountOut: BN, user: PublicKey, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined, userPoolTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    withdrawInputsInternal(pool: PublicKey, lpAmount: BN, slippage: number): Promise<WithdrawResult>;
    getPoolBaseAndQuoteAmounts(pool: PublicKey): Promise<{
        fetchedPool: {
            poolBump: number;
            index: number;
            creator: PublicKey;
            baseMint: PublicKey;
            quoteMint: PublicKey;
            lpMint: PublicKey;
            poolBaseTokenAccount: PublicKey;
            poolQuoteTokenAccount: PublicKey;
            lpSupply: BN;
        };
        poolBaseAmount: BN;
        poolQuoteAmount: BN;
    }>;
    private liquidityAccounts;
    buyInstructionsInternal(pool: PublicKey, baseOut: BN, maxQuoteIn: BN, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    buyInstructionsInternalNoPool(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, baseOut: BN, maxQuoteIn: BN, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    buyBaseInput(pool: PublicKey, base: BN, slippage: number, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    buyQuoteInput(pool: PublicKey, quote: BN, slippage: number, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    buyAutocompleteQuoteFromBase(pool: PublicKey, base: BN, slippage: number): Promise<BN>;
    buyAutocompleteBaseFromQuote(pool: PublicKey, quote: BN, slippage: number): Promise<BN>;
    buyBaseInputInternal(pool: PublicKey, base: BN, slippage: number): Promise<BuyBaseInputResult>;
    buyQuoteInputInternal(pool: PublicKey, quote: BN, slippage: number): Promise<BuyQuoteInputResult>;
    buyQuoteInputInternalNoPool(quote: BN, slippage: number, poolBaseAmount: BN, poolQuoteAmount: BN): Promise<BuyQuoteInputResult>;
    sellInstructionsInternal(pool: PublicKey, baseAmountIn: BN, minQuoteAmountOut: BN, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    sellInstructionsInternalNoPool(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, baseAmountIn: BN, minQuoteAmountOut: BN, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    sellBaseInput(pool: PublicKey, base: BN, slippage: number, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    sellQuoteInput(pool: PublicKey, quote: BN, slippage: number, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    sellAutocompleteQuoteFromBase(pool: PublicKey, base: BN, slippage: number): Promise<BN>;
    sellAutocompleteBaseFromQuote(pool: PublicKey, quote: BN, slippage: number): Promise<BN>;
    sellBaseInputInternal(pool: PublicKey, base: BN, slippage: number): Promise<SellBaseInputResult>;
    sellBaseInputInternalNoPool(base: BN, slippage: number, poolBaseAmount: BN, poolQuoteAmount: BN): Promise<SellBaseInputResult>;
    sellQuoteInputInternal(pool: PublicKey, quote: BN, slippage: number): Promise<SellQuoteInputResult>;
    extendAccount(account: PublicKey, user: PublicKey): Promise<TransactionInstruction>;
    private swapAccounts;
    private getMintTokenPrograms;
}
//# sourceMappingURL=pumpAmmInternal.d.ts.map