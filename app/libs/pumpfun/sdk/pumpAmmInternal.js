"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpAmmInternalSdk = void 0;
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const pda_1 = require("./pda");
const spl_token_1 = require("@solana/spl-token");
const deposit_1 = require("./deposit");
const withdraw_1 = require("./withdraw");
const buy_1 = require("./buy");
const sell_1 = require("./sell");
const system_1 = require("@coral-xyz/anchor/dist/cjs/native/system");
const util_1 = require("./util");
class PumpAmmInternalSdk {
    connection;
    program;
    globalConfig;
    constructor(connection, programId = pda_1.PUMP_AMM_PROGRAM_ID) {
        this.connection = connection;
        this.program = (0, util_1.getPumpAmmProgram)(connection, programId);
        this.globalConfig = (0, pda_1.globalConfigPda)(this.program.programId)[0];
    }
    programId() {
        return this.program.programId;
    }
    globalConfigKey() {
        return this.globalConfig;
    }
    poolKey(index, creator, baseMint, quoteMint) {
        return (0, pda_1.poolPda)(index, creator, baseMint, quoteMint, this.program.programId);
    }
    lpMintKey(pool) {
        return (0, pda_1.lpMintPda)(pool, this.program.programId);
    }
    fetchGlobalConfigAccount() {
        return this.program.account.globalConfig.fetch(this.globalConfig);
    }
    fetchPool(pool) {
        return this.program.account.pool.fetch(pool);
    }
    async createPoolInstructionsInternal(index, creator, baseMint, quoteMint, baseIn, quoteIn, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const [baseTokenProgram, quoteTokenProgram] = await this.getMintTokenPrograms(baseMint, quoteMint);
        if (userBaseTokenAccount === undefined) {
            userBaseTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(baseMint, creator, true, baseTokenProgram);
        }
        if (userQuoteTokenAccount === undefined) {
            userQuoteTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(quoteMint, creator, true, quoteTokenProgram);
        }
        return await this.withWsolAccounts(creator, baseMint, userBaseTokenAccount, baseIn, quoteMint, userQuoteTokenAccount, quoteIn, async () => {
            const [pool] = (0, pda_1.poolPda)(index, creator, baseMint, quoteMint, this.program.programId);
            const instructions = [];
            const poolBaseTokenAccountPDA = (0, spl_token_1.getAssociatedTokenAddressSync)(baseMint, pool, true, baseTokenProgram);
            if (!(await this.accountExists(poolBaseTokenAccountPDA))) {
                instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(creator, poolBaseTokenAccountPDA, pool, baseMint, baseTokenProgram));
            }
            const poolQuoteTokenAccountPDA = (0, spl_token_1.getAssociatedTokenAddressSync)(quoteMint, pool, true, quoteTokenProgram);
            if (!(await this.accountExists(poolQuoteTokenAccountPDA))) {
                instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(creator, poolQuoteTokenAccountPDA, pool, quoteMint, quoteTokenProgram));
            }
            instructions.push(await this.program.methods
                .createPool(index, baseIn, quoteIn)
                .accountsPartial({
                globalConfig: this.globalConfig,
                baseMint,
                quoteMint,
                creator,
                userBaseTokenAccount,
                userQuoteTokenAccount,
                baseTokenProgram,
                quoteTokenProgram,
            })
                .instruction());
            return instructions;
        });
    }
    async depositInstructionsInternal(pool, lpToken, maxBase, maxQuote, user, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined, userPoolTokenAccount = undefined) {
        const poolData = await this.program.account.pool.fetch(pool);
        const { baseMint, quoteMint, lpMint } = poolData;
        const [baseTokenProgram, quoteTokenProgram] = await this.getMintTokenPrograms(baseMint, quoteMint);
        const liquidityAccounts = await this.liquidityAccounts(pool, poolData, baseTokenProgram, quoteTokenProgram, user, userBaseTokenAccount, userQuoteTokenAccount, userPoolTokenAccount);
        return await this.withWsolAccounts(user, baseMint, liquidityAccounts.userBaseTokenAccount, maxBase, quoteMint, liquidityAccounts.userQuoteTokenAccount, maxQuote, async () => {
            const instructions = [];
            if (!(await this.accountExists(liquidityAccounts.userPoolTokenAccount))) {
                instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(user, liquidityAccounts.userPoolTokenAccount, user, lpMint, spl_token_1.TOKEN_2022_PROGRAM_ID));
            }
            instructions.push(await this.program.methods.deposit(lpToken, maxBase, maxQuote).accountsPartial(liquidityAccounts).instruction());
            return instructions;
        });
    }
    async withWsolAccounts(user, baseMint, userBaseAta, baseAmount, quoteMint, userQuoteAta, quoteAmount, block) {
        return await this.withWsolAccount(user, baseMint, userBaseAta, baseAmount, () => this.withWsolAccount(user, quoteMint, userQuoteAta, quoteAmount, block));
    }
    async withWsolAccount(user, mint, ata, amount, block) {
        const instructions = [];
        let wsolAccountCreated = false;
        if (mint.equals(spl_token_1.NATIVE_MINT)) {
            if (!(await this.accountExists(ata))) {
                instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(user, ata, user, spl_token_1.NATIVE_MINT));
                wsolAccountCreated = true;
            }
            instructions.push(web3_js_1.SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: ata,
                lamports: BigInt(amount.toString()),
            }), (0, spl_token_1.createSyncNativeInstruction)(ata));
        }
        const blockInstructions = await block();
        instructions.push(...blockInstructions);
        if (wsolAccountCreated) {
            instructions.push((0, spl_token_1.createCloseAccountInstruction)(ata, user, user, undefined, spl_token_1.TOKEN_PROGRAM_ID));
        }
        return instructions;
    }
    async accountExists(account) {
        const accountInfo = await this.connection.getAccountInfo(account);
        return accountInfo !== null && !accountInfo.owner.equals(system_1.SYSTEM_PROGRAM_ID);
    }
    async depositBaseInputInternal(pool, base, slippage) {
        const { fetchedPool, poolBaseAmount, poolQuoteAmount } = await this.getPoolBaseAndQuoteAmounts(pool);
        const { token1, lpToken, maxToken0, maxToken1 } = (0, deposit_1.depositToken0Internal)(base, slippage, poolBaseAmount, poolQuoteAmount, fetchedPool.lpSupply);
        return {
            quote: token1,
            lpToken,
            maxBase: maxToken0,
            maxQuote: maxToken1,
        };
    }
    async depositQuoteInputInternal(pool, quote, slippage) {
        const { fetchedPool, poolBaseAmount, poolQuoteAmount } = await this.getPoolBaseAndQuoteAmounts(pool);
        const { token1, lpToken, maxToken0, maxToken1 } = (0, deposit_1.depositToken0Internal)(quote, slippage, poolQuoteAmount, poolBaseAmount, fetchedPool.lpSupply);
        return {
            base: token1,
            lpToken,
            maxBase: maxToken1,
            maxQuote: maxToken0,
        };
    }
    async withdrawInstructionsInternal(pool, lpTokenAmountIn, minBaseAmountOut, minQuoteAmountOut, user, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined, userPoolTokenAccount = undefined) {
        const poolData = await this.program.account.pool.fetch(pool);
        const { baseMint, quoteMint } = poolData;
        const [baseTokenProgram, quoteTokenProgram] = await this.getMintTokenPrograms(baseMint, quoteMint);
        const liquidityAccounts = await this.liquidityAccounts(pool, poolData, baseTokenProgram, quoteTokenProgram, user, userBaseTokenAccount, userQuoteTokenAccount, userPoolTokenAccount);
        const instructions = [];
        let baseWsolAtaCreated = false;
        if (!(await this.accountExists(liquidityAccounts.userBaseTokenAccount))) {
            instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(user, liquidityAccounts.userBaseTokenAccount, user, liquidityAccounts.baseMint, baseTokenProgram));
            if (baseMint.equals(spl_token_1.NATIVE_MINT)) {
                baseWsolAtaCreated = true;
            }
        }
        let quoteWsolAtaCreated = false;
        if (!(await this.accountExists(liquidityAccounts.userQuoteTokenAccount))) {
            instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(user, liquidityAccounts.userQuoteTokenAccount, user, liquidityAccounts.quoteMint, quoteTokenProgram));
            if (quoteMint.equals(spl_token_1.NATIVE_MINT)) {
                quoteWsolAtaCreated = true;
            }
        }
        instructions.push(await this.program.methods.withdraw(lpTokenAmountIn, minBaseAmountOut, minQuoteAmountOut).accountsPartial(liquidityAccounts).instruction());
        if (baseWsolAtaCreated) {
            instructions.push((0, spl_token_1.createCloseAccountInstruction)(liquidityAccounts.userBaseTokenAccount, user, user, undefined, spl_token_1.TOKEN_PROGRAM_ID));
        }
        if (quoteWsolAtaCreated) {
            instructions.push((0, spl_token_1.createCloseAccountInstruction)(liquidityAccounts.userQuoteTokenAccount, user, user, undefined, spl_token_1.TOKEN_PROGRAM_ID));
        }
        return instructions;
    }
    async withdrawInputsInternal(pool, lpAmount, slippage) {
        const { fetchedPool, poolBaseAmount, poolQuoteAmount } = await this.getPoolBaseAndQuoteAmounts(pool);
        return (0, withdraw_1.withdrawInternal)(lpAmount, slippage, poolBaseAmount, poolQuoteAmount, fetchedPool.lpSupply);
    }
    async getPoolBaseAndQuoteAmounts(pool) {
        const fetchedPool = await this.fetchPool(pool);
        const [baseTokenProgram, quoteTokenProgram] = await this.getMintTokenPrograms(fetchedPool.baseMint, fetchedPool.quoteMint);
        const poolBaseTokenAccount = await (0, spl_token_1.getAccount)(this.connection, fetchedPool.poolBaseTokenAccount, undefined, baseTokenProgram);
        const poolQuoteTokenAccount = await (0, spl_token_1.getAccount)(this.connection, fetchedPool.poolQuoteTokenAccount, undefined, quoteTokenProgram);
        const poolBaseAmount = new anchor_1.BN(poolBaseTokenAccount.amount.toString());
        const poolQuoteAmount = new anchor_1.BN(poolQuoteTokenAccount.amount.toString());
        return { fetchedPool, poolBaseAmount, poolQuoteAmount };
    }
    async liquidityAccounts(pool, { baseMint, quoteMint, lpMint, poolBaseTokenAccount, poolQuoteTokenAccount }, baseTokenProgram, quoteTokenProgram, user, userBaseTokenAccount, userQuoteTokenAccount, userPoolTokenAccount) {
        if (userBaseTokenAccount === undefined) {
            userBaseTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(baseMint, user, true, baseTokenProgram);
        }
        if (userQuoteTokenAccount === undefined) {
            userQuoteTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(quoteMint, user, true, quoteTokenProgram);
        }
        if (userPoolTokenAccount === undefined) {
            userPoolTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(lpMint, user, true, spl_token_1.TOKEN_2022_PROGRAM_ID);
        }
        return {
            pool,
            globalConfig: this.globalConfig,
            user,
            baseMint,
            quoteMint,
            lpMint,
            userBaseTokenAccount,
            userQuoteTokenAccount,
            userPoolTokenAccount,
            poolBaseTokenAccount,
            poolQuoteTokenAccount,
        };
    }
    async buyInstructionsInternal(pool, baseOut, maxQuoteIn, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const { index, creator, baseMint, quoteMint } = await this.program.account.pool.fetch(pool);
        return await this.buyInstructionsInternalNoPool(index, creator, baseMint, quoteMint, baseOut, maxQuoteIn, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async buyInstructionsInternalNoPool(index, creator, baseMint, quoteMint, baseOut, maxQuoteIn, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const [pool] = this.poolKey(index, creator, baseMint, quoteMint);
        const swapAccounts = await this.swapAccounts(pool, baseMint, quoteMint, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
        return this.withWsolAccount(user, quoteMint, swapAccounts.userQuoteTokenAccount, maxQuoteIn, async () => {
            const instructions = [];
            let baseWsolAtaCreated = false;
            if (!(await this.accountExists(swapAccounts.userBaseTokenAccount))) {
                instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(user, swapAccounts.userBaseTokenAccount, user, swapAccounts.baseMint, swapAccounts.baseTokenProgram));
                if (baseMint.equals(spl_token_1.NATIVE_MINT)) {
                    baseWsolAtaCreated = true;
                }
            }
            instructions.push(await this.program.methods.buy(baseOut, maxQuoteIn).accountsPartial(swapAccounts).instruction());
            if (baseWsolAtaCreated) {
                instructions.push((0, spl_token_1.createCloseAccountInstruction)(swapAccounts.userBaseTokenAccount, user, user, undefined, spl_token_1.TOKEN_PROGRAM_ID));
            }
            return instructions;
        });
    }
    async buyBaseInput(pool, base, slippage, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const { maxQuote } = await this.buyBaseInputInternal(pool, base, slippage);
        return this.buyInstructionsInternal(pool, base, maxQuote, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async buyQuoteInput(pool, quote, slippage, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const { base, maxQuote } = await this.buyQuoteInputInternal(pool, quote, slippage);
        return this.buyInstructionsInternal(pool, base, maxQuote, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async buyAutocompleteQuoteFromBase(pool, base, slippage) {
        const { uiQuote } = await this.buyBaseInputInternal(pool, base, slippage);
        return uiQuote;
    }
    async buyAutocompleteBaseFromQuote(pool, quote, slippage) {
        const { base } = await this.buyQuoteInputInternal(pool, quote, slippage);
        return base;
    }
    async buyBaseInputInternal(pool, base, slippage) {
        const { poolBaseAmount, poolQuoteAmount } = await this.getPoolBaseAndQuoteAmounts(pool);
        const globalConfig = await this.fetchGlobalConfigAccount();
        return (0, buy_1.buyBaseInputInternal)(base, slippage, poolBaseAmount, poolQuoteAmount, globalConfig.lpFeeBasisPoints, globalConfig.protocolFeeBasisPoints);
    }
    async buyQuoteInputInternal(pool, quote, slippage) {
        const { poolBaseAmount, poolQuoteAmount } = await this.getPoolBaseAndQuoteAmounts(pool);
        return this.buyQuoteInputInternalNoPool(quote, slippage, poolBaseAmount, poolQuoteAmount);
    }
    async buyQuoteInputInternalNoPool(quote, slippage, poolBaseAmount, poolQuoteAmount) {
        const globalConfig = await this.fetchGlobalConfigAccount();
        return (0, buy_1.buyQuoteInputInternal)(quote, slippage, poolBaseAmount, poolQuoteAmount, globalConfig.lpFeeBasisPoints, globalConfig.protocolFeeBasisPoints);
    }
    async sellInstructionsInternal(pool, baseAmountIn, minQuoteAmountOut, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const { index, creator, baseMint, quoteMint } = await this.program.account.pool.fetch(pool);
        return await this.sellInstructionsInternalNoPool(index, creator, baseMint, quoteMint, baseAmountIn, minQuoteAmountOut, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async sellInstructionsInternalNoPool(index, creator, baseMint, quoteMint, baseAmountIn, minQuoteAmountOut, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const [pool] = this.poolKey(index, creator, baseMint, quoteMint);
        const swapAccounts = await this.swapAccounts(pool, baseMint, quoteMint, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
        return this.withWsolAccount(user, baseMint, swapAccounts.userBaseTokenAccount, baseAmountIn, async () => {
            const instructions = [];
            let quoteWsolAtaCreated = false;
            if (!(await this.accountExists(swapAccounts.userQuoteTokenAccount))) {
                instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(user, swapAccounts.userQuoteTokenAccount, user, swapAccounts.quoteMint, swapAccounts.quoteTokenProgram));
                if (quoteMint.equals(spl_token_1.NATIVE_MINT)) {
                    quoteWsolAtaCreated = true;
                }
            }
            instructions.push(await this.program.methods.sell(baseAmountIn, minQuoteAmountOut).accountsPartial(swapAccounts).instruction());
            if (quoteWsolAtaCreated) {
                instructions.push((0, spl_token_1.createCloseAccountInstruction)(swapAccounts.userQuoteTokenAccount, user, user, undefined, spl_token_1.TOKEN_PROGRAM_ID));
            }
            return instructions;
        });
    }
    async sellBaseInput(pool, base, slippage, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const { minQuote } = await this.sellBaseInputInternal(pool, base, slippage);
        return this.sellInstructionsInternal(pool, base, minQuote, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async sellQuoteInput(pool, quote, slippage, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        const { base, minQuote } = await this.sellQuoteInputInternal(pool, quote, slippage);
        return this.sellInstructionsInternal(pool, base, minQuote, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async sellAutocompleteQuoteFromBase(pool, base, slippage) {
        const { uiQuote } = await this.sellBaseInputInternal(pool, base, slippage);
        return uiQuote;
    }
    async sellAutocompleteBaseFromQuote(pool, quote, slippage) {
        const { base } = await this.sellQuoteInputInternal(pool, quote, slippage);
        return base;
    }
    async sellBaseInputInternal(pool, base, slippage) {
        const { poolBaseAmount, poolQuoteAmount } = await this.getPoolBaseAndQuoteAmounts(pool);
        return this.sellBaseInputInternalNoPool(base, slippage, poolBaseAmount, poolQuoteAmount);
    }
    async sellBaseInputInternalNoPool(base, slippage, poolBaseAmount, poolQuoteAmount) {
        const globalConfig = await this.fetchGlobalConfigAccount();
        return (0, sell_1.sellBaseInputInternal)(base, slippage, poolBaseAmount, poolQuoteAmount, globalConfig.lpFeeBasisPoints, globalConfig.protocolFeeBasisPoints);
    }
    async sellQuoteInputInternal(pool, quote, slippage) {
        const { poolBaseAmount, poolQuoteAmount } = await this.getPoolBaseAndQuoteAmounts(pool);
        const globalConfig = await this.fetchGlobalConfigAccount();
        return (0, sell_1.sellQuoteInputInternal)(quote, slippage, poolBaseAmount, poolQuoteAmount, globalConfig.lpFeeBasisPoints, globalConfig.protocolFeeBasisPoints);
    }
    async extendAccount(account, user) {
        return this.program.methods
            .extendAccount()
            .accountsPartial({
            account,
            user,
        })
            .instruction();
    }
    async swapAccounts(pool, baseMint, quoteMint, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount) {
        if (protocolFeeRecipient === undefined) {
            const { protocolFeeRecipients } = await this.program.account.globalConfig.fetch(this.globalConfig);
            protocolFeeRecipient = protocolFeeRecipients[Math.floor(Math.random() * protocolFeeRecipients.length)];
        }
        const [baseTokenProgram, quoteTokenProgram] = await this.getMintTokenPrograms(baseMint, quoteMint);
        if (userBaseTokenAccount === undefined) {
            userBaseTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(baseMint, user, true, baseTokenProgram);
        }
        if (userQuoteTokenAccount === undefined) {
            userQuoteTokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(quoteMint, user, true, quoteTokenProgram);
        }
        return {
            pool,
            globalConfig: this.globalConfig,
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
}
exports.PumpAmmInternalSdk = PumpAmmInternalSdk;
//# sourceMappingURL=pumpAmmInternal.js.map