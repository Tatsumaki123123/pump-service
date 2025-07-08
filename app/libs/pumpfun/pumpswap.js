"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpSwapSDK = void 0;
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const spl_token_1 = require("@solana/spl-token");
const index_1 = require("./IDL/index");
const util_1 = require("./util");
const poolswap_1 = require("./poolswap");
const pda_1 = require("./sdk/pda");
// Define static public keys
const TOKEN_PROGRAM_ID = new web3_js_1.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WSOL_TOKEN_ACCOUNT = new web3_js_1.PublicKey("So11111111111111111111111111111111111111112");
const feeRecipient = new web3_js_1.PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
class PumpSwapSDK {
    program;
    connection;
    pumpSwapPool;
    constructor(provider) {
        this.program = new anchor_1.Program(index_1.IDL_SWAP, provider);
        this.connection = this.program.provider.connection;
        this.pumpSwapPool = new poolswap_1.PumpSwapPool(provider);
    }
    poolKey(index, creator, baseMint, quoteMint) {
        return (0, pda_1.poolPda)(index, creator, baseMint, quoteMint, this.program.programId);
    }
    async swapAccounts(pool, baseMint, quoteMint, user, globalConfig, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount) {
        // const [baseTokenProgram, quoteTokenProgram] = await this.getMintTokenPrograms(baseMint, quoteMint);
        const baseTokenProgram = TOKEN_PROGRAM_ID;
        const quoteTokenProgram = TOKEN_PROGRAM_ID;
        if (userBaseTokenAccount === undefined) {
            userBaseTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(baseMint, user, true, baseTokenProgram);
        }
        if (userQuoteTokenAccount === undefined) {
            userQuoteTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(quoteMint, user, true, quoteTokenProgram);
        }
        return {
            pool,
            globalConfig: globalConfig,
            user,
            baseMint,
            quoteMint,
            userBaseTokenAccount,
            userQuoteTokenAccount,
            poolBaseTokenAccount: (0, spl_token_1.getAssociatedTokenAddressSync)(baseMint, pool, true, baseTokenProgram),
            poolQuoteTokenAccount: (0, spl_token_1.getAssociatedTokenAddressSync)(quoteMint, pool, true, quoteTokenProgram),
            protocolFeeRecipient,
            baseTokenProgram,
            quoteTokenProgram,
        };
    }
    async getMintTokenPrograms(baseMint, quoteMint) {
        const baseMintAccountInfo = await this.connection.getAccountInfo(baseMint);
        if (baseMintAccountInfo === null) {
            throw new Error(`baseMint=${baseMint} not found`);
        }
        const quoteMintAccountInfo = await this.connection.getAccountInfo(quoteMint);
        if (quoteMintAccountInfo === null) {
            throw new Error(`quoteMint=${quoteMint} not found`);
        }
        return [baseMintAccountInfo.owner, quoteMintAccountInfo.owner];
    }
    async createBuyInstruction(poolId, user, mint, amount, solAmount, commitment = util_1.DEFAULT_COMMITMENT) {
        // Compute associated token account addresses
        const userBaseTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(mint, user);
        const userQuoteTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(WSOL_TOKEN_ACCOUNT, user);
        const { index, creator, baseMint, quoteMint } = await this.program.account.pool.fetch(poolId, "confirmed");
        const [pool] = this.poolKey(index, creator, baseMint, quoteMint);
        const globalConfig = (0, poolswap_1.globalConfigPda)(this.program.programId)[0];
        const swapAccounts = await this.swapAccounts(pool, mint, WSOL_TOKEN_ACCOUNT, user, globalConfig, feeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
        // Pack the instruction data: discriminator (8 bytes) + base_amount_in (8 bytes) + min_quote_amount_out (8 bytes)
        const associatedUser = await (0, spl_token_1.getAssociatedTokenAddress)(mint, user, false);
        const transaction = new web3_js_1.Transaction();
        try {
            await (0, spl_token_1.getAccount)(this.connection, associatedUser, commitment);
        }
        catch (e) {
            transaction.add((0, spl_token_1.createAssociatedTokenAccountInstruction)(user, associatedUser, user, mint));
        }
        try {
            await (0, spl_token_1.getAccount)(this.connection, userQuoteTokenAccount, commitment);
        }
        catch (e) {
            transaction.add((0, spl_token_1.createAssociatedTokenAccountInstruction)(user, userQuoteTokenAccount, user, spl_token_1.NATIVE_MINT));
        }
        transaction.add(web3_js_1.SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: userQuoteTokenAccount,
            lamports: solAmount,
        }));
        transaction.add((0, spl_token_1.createSyncNativeInstruction)(userQuoteTokenAccount));
        // sync wrapped SOL balance
        transaction.add(await this.program.methods.buy(new anchor_1.BN(amount.toString()), new anchor_1.BN(solAmount.toString())).accountsPartial(swapAccounts).instruction());
        transaction.add((0, spl_token_1.createCloseAccountInstruction)(userQuoteTokenAccount, user, user));
        return transaction;
    }
    async createSellInstruction(poolId, user, mint, baseAmountIn, // Use bigint for u64
    minQuoteAmountOut, closeTokenAccount = false, commitment = util_1.DEFAULT_COMMITMENT) {
        // Compute associated token account addresses
        const userBaseTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(mint, user);
        const userQuoteTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(WSOL_TOKEN_ACCOUNT, user);
        const { index, creator, baseMint, quoteMint } = await this.program.account.pool.fetch(poolId);
        const [pool] = this.poolKey(index, creator, baseMint, quoteMint);
        const globalConfig = (0, poolswap_1.globalConfigPda)(this.program.programId)[0];
        const swapAccounts = await this.swapAccounts(pool, mint, WSOL_TOKEN_ACCOUNT, user, globalConfig, feeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
        const transaction = new web3_js_1.Transaction();
        try {
            await (0, spl_token_1.getAccount)(this.connection, userQuoteTokenAccount, commitment);
        }
        catch (e) {
            transaction.add((0, spl_token_1.createAssociatedTokenAccountInstruction)(user, userQuoteTokenAccount, user, spl_token_1.NATIVE_MINT));
        }
        transaction.add(await this.program.methods.sell(new anchor_1.BN(baseAmountIn.toString()), new anchor_1.BN(minQuoteAmountOut.toString())).accountsPartial(swapAccounts).instruction());
        if (closeTokenAccount) {
            transaction.add((0, spl_token_1.createCloseAccountInstruction)(userQuoteTokenAccount, user, user));
        }
        // Create the transaction instruction
        return transaction;
    }
}
exports.PumpSwapSDK = PumpSwapSDK;
