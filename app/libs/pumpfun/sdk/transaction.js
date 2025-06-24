"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transactionFromInstructions = transactionFromInstructions;
exports.getSignature = getSignature;
exports.sendAndConfirmTransaction = sendAndConfirmTransaction;
const web3_js_1 = require("@solana/web3.js");
const bytes_1 = require("@coral-xyz/anchor/dist/cjs/utils/bytes");
function transactionFromInstructions(payerKey, instructions, recentBlockhash, signers) {
    const transaction = new web3_js_1.VersionedTransaction(new web3_js_1.TransactionMessage({
        payerKey,
        instructions,
        recentBlockhash,
    }).compileToV0Message());
    transaction.sign(signers);
    return transaction;
}
function getSignature(transaction) {
    return bytes_1.bs58.encode(transaction.signatures[0]);
}
async function sendAndConfirmTransaction(connection, payerKey, instructions, signers) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const transaction = transactionFromInstructions(payerKey, instructions, blockhash, signers);
    await connection.sendTransaction(transaction);
    const signature = getSignature(transaction);
    const result = await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
    });
    return [transaction, result.value.err];
}
//# sourceMappingURL=transaction.js.map