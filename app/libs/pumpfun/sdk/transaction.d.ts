import { Blockhash, Connection, PublicKey, Signer, TransactionError, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
export declare function transactionFromInstructions(payerKey: PublicKey, instructions: TransactionInstruction[], recentBlockhash: Blockhash, signers: Signer[]): VersionedTransaction;
export declare function getSignature(transaction: VersionedTransaction): string;
export declare function sendAndConfirmTransaction(connection: Connection, payerKey: PublicKey, instructions: TransactionInstruction[], signers: Signer[]): Promise<[VersionedTransaction, TransactionError | null]>;
