import { PublicKey } from "@solana/web3.js";
export declare const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export declare const PUMP_AMM_PROGRAM_ID_PUBKEY: PublicKey;
export declare const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export declare const PUMP_PROGRAM_ID_PUBKEY: PublicKey;
export declare const CANONICAL_POOL_INDEX = 0;
export declare function globalConfigPda(programId?: PublicKey): [PublicKey, number];
export declare function poolPda(index: number, owner: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, programId?: PublicKey): [PublicKey, number];
export declare function lpMintPda(pool: PublicKey, programId?: PublicKey): [PublicKey, number];
export declare function lpMintAta(lpMint: PublicKey, owner: PublicKey): PublicKey;
export declare function pumpPoolAuthorityPda(mint: PublicKey, pumpProgramId?: PublicKey): [PublicKey, number];
export declare function canonicalPumpPoolPda(mint: PublicKey, programId?: PublicKey, pumpProgramId?: PublicKey): [PublicKey, number];
export declare function pumpAmmEventAuthorityPda(programId?: PublicKey): [PublicKey, number];
//# sourceMappingURL=pda.d.ts.map