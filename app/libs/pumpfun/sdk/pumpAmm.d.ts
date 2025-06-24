import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { DepositBaseAndLpTokenFromQuoteResult, DepositQuoteAndLpTokenFromBaseResult, Direction, WithdrawAutocompleteResult } from "../types/sdk";
export declare class PumpAmmSdk {
    private readonly pumpAmmInternalSdk;
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
    createPoolInstructions(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, baseIn: BN, quoteIn: BN, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    createAutocompleteInitialPoolPrice(initialBase: BN, initialQuote: BN): Promise<BN>;
    depositInstructions(pool: PublicKey, lpToken: BN, slippage: number, user: PublicKey, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined, userPoolTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    depositAutocompleteQuoteAndLpTokenFromBase(pool: PublicKey, base: BN, slippage: number): Promise<DepositQuoteAndLpTokenFromBaseResult>;
    depositAutocompleteBaseAndLpTokenFromQuote(pool: PublicKey, quote: BN, slippage: number): Promise<DepositBaseAndLpTokenFromQuoteResult>;
    withdrawInstructions(pool: PublicKey, lpToken: BN, slippage: number, user: PublicKey, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined, userPoolTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    withdrawAutoCompleteBaseAndQuoteFromLpToken(pool: PublicKey, lpAmount: BN, slippage: number): Promise<WithdrawAutocompleteResult>;
    swapBaseInstructions(pool: PublicKey, base: BN, slippage: number, direction: Direction, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    swapQuoteInstructions(pool: PublicKey, quote: BN, slippage: number, direction: Direction, user: PublicKey, protocolFeeRecipient?: PublicKey | undefined, userBaseTokenAccount?: PublicKey | undefined, userQuoteTokenAccount?: PublicKey | undefined): Promise<TransactionInstruction[]>;
    swapAutocompleteQuoteFromBase(pool: PublicKey, base: BN, slippage: number, direction: Direction): Promise<BN>;
    swapAutocompleteBaseFromQuote(pool: PublicKey, quote: BN, slippage: number, direction: Direction): Promise<BN>;
    extendAccount(account: PublicKey, user: PublicKey): Promise<TransactionInstruction>;
}
//# sourceMappingURL=pumpAmm.d.ts.map