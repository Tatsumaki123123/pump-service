"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANONICAL_POOL_INDEX = exports.PUMP_PROGRAM_ID_PUBKEY = exports.PUMP_PROGRAM_ID = exports.PUMP_AMM_PROGRAM_ID_PUBKEY = exports.PUMP_AMM_PROGRAM_ID = void 0;
exports.globalConfigPda = globalConfigPda;
exports.poolPda = poolPda;
exports.lpMintPda = lpMintPda;
exports.lpMintAta = lpMintAta;
exports.pumpPoolAuthorityPda = pumpPoolAuthorityPda;
exports.canonicalPumpPoolPda = canonicalPumpPoolPda;
exports.pumpAmmEventAuthorityPda = pumpAmmEventAuthorityPda;
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const spl_token_1 = require("@solana/spl-token");
exports.PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
exports.PUMP_AMM_PROGRAM_ID_PUBKEY = new web3_js_1.PublicKey(exports.PUMP_AMM_PROGRAM_ID);
exports.PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
exports.PUMP_PROGRAM_ID_PUBKEY = new web3_js_1.PublicKey(exports.PUMP_PROGRAM_ID);
exports.CANONICAL_POOL_INDEX = 0;
function globalConfigPda(programId = exports.PUMP_AMM_PROGRAM_ID_PUBKEY) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("global_config")], programId);
}
function poolPda(index, owner, baseMint, quoteMint, programId = exports.PUMP_AMM_PROGRAM_ID_PUBKEY) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("pool"), new anchor_1.BN(index).toArrayLike(Buffer, "le", 2), owner.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()], programId);
}
function lpMintPda(pool, programId = exports.PUMP_AMM_PROGRAM_ID_PUBKEY) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), pool.toBuffer()], programId);
}
function lpMintAta(lpMint, owner) {
    return (0, spl_token_1.getAssociatedTokenAddressSync)(lpMint, owner, true, spl_token_1.TOKEN_2022_PROGRAM_ID);
}
function pumpPoolAuthorityPda(mint, pumpProgramId = exports.PUMP_PROGRAM_ID_PUBKEY) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], pumpProgramId);
}
function canonicalPumpPoolPda(mint, programId = exports.PUMP_AMM_PROGRAM_ID_PUBKEY, pumpProgramId = exports.PUMP_PROGRAM_ID_PUBKEY) {
    const [pumpPoolAuthority] = pumpPoolAuthorityPda(mint, pumpProgramId);
    return poolPda(exports.CANONICAL_POOL_INDEX, pumpPoolAuthority, mint, spl_token_1.NATIVE_MINT, programId);
}
function pumpAmmEventAuthorityPda(programId = exports.PUMP_AMM_PROGRAM_ID_PUBKEY) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], programId);
}
//# sourceMappingURL=pda.js.map