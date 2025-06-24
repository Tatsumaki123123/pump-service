import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
export declare class PumpAmmAdminSdk {
    private readonly program;
    private readonly globalConfig;
    constructor(connection: Connection, programId?: string);
    programId(): PublicKey;
    fetchGlobalConfigAccount(): Promise<{
        admin: PublicKey;
        lpFeeBasisPoints: BN;
        protocolFeeBasisPoints: BN;
        disableFlags: number;
        protocolFeeRecipients: PublicKey[];
    }>;
    createConfig(lpFeeBasisPoints: BN, protocolFeeBasisPoints: BN, protocolFeeRecipients: PublicKey[], admin: PublicKey): Promise<TransactionInstruction>;
    disable(disableCreatePool: boolean, disableDeposit: boolean, disableWithdraw: boolean, disableBuy: boolean, disableSell: boolean, admin: PublicKey): Promise<TransactionInstruction>;
    updateAdmin(admin: PublicKey, newAdmin: PublicKey): Promise<TransactionInstruction>;
    updateFeeConfig(lpFeeBasisPoints: BN, protocolFeeBasisPoints: BN, protocolFeeRecipients: PublicKey[], admin: PublicKey): Promise<TransactionInstruction>;
}
//# sourceMappingURL=pumpAmmAdmin.d.ts.map