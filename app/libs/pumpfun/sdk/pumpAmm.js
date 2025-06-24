"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpAmmSdk = void 0;
const deposit_1 = require("./deposit");
const pumpAmmInternal_1 = require("./pumpAmmInternal");
const pda_1 = require("./pda");
class PumpAmmSdk {
    pumpAmmInternalSdk;
    constructor(connection, programId = pda_1.PUMP_AMM_PROGRAM_ID) {
        this.pumpAmmInternalSdk = new pumpAmmInternal_1.PumpAmmInternalSdk(connection, programId);
    }
    programId() {
        return this.pumpAmmInternalSdk.programId();
    }
    globalConfigKey() {
        return this.pumpAmmInternalSdk.globalConfigKey();
    }
    poolKey(index, creator, baseMint, quoteMint) {
        return this.pumpAmmInternalSdk.poolKey(index, creator, baseMint, quoteMint);
    }
    lpMintKey(pool) {
        return this.pumpAmmInternalSdk.lpMintKey(pool);
    }
    fetchGlobalConfigAccount() {
        return this.pumpAmmInternalSdk.fetchGlobalConfigAccount();
    }
    fetchPool(pool) {
        return this.pumpAmmInternalSdk.fetchPool(pool);
    }
    async createPoolInstructions(index, creator, baseMint, quoteMint, baseIn, quoteIn, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        return this.pumpAmmInternalSdk.createPoolInstructionsInternal(index, creator, baseMint, quoteMint, baseIn, quoteIn, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async createAutocompleteInitialPoolPrice(initialBase, initialQuote) {
        return initialQuote.div(initialBase);
    }
    async depositInstructions(pool, lpToken, slippage, user, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined, userPoolTokenAccount = undefined) {
        const { fetchedPool, poolBaseAmount, poolQuoteAmount } = await this.pumpAmmInternalSdk.getPoolBaseAndQuoteAmounts(pool);
        const { maxBase, maxQuote } = (0, deposit_1.depositLpToken)(lpToken, slippage, poolBaseAmount, poolQuoteAmount, fetchedPool.lpSupply);
        return this.pumpAmmInternalSdk.depositInstructionsInternal(pool, lpToken, maxBase, maxQuote, user, userBaseTokenAccount, userQuoteTokenAccount, userPoolTokenAccount);
    }
    async depositAutocompleteQuoteAndLpTokenFromBase(pool, base, slippage) {
        const { quote, lpToken } = await this.pumpAmmInternalSdk.depositBaseInputInternal(pool, base, slippage);
        return {
            quote,
            lpToken,
        };
    }
    async depositAutocompleteBaseAndLpTokenFromQuote(pool, quote, slippage) {
        const { base, lpToken } = await this.pumpAmmInternalSdk.depositQuoteInputInternal(pool, quote, slippage);
        return {
            base,
            lpToken,
        };
    }
    async withdrawInstructions(pool, lpToken, slippage, user, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined, userPoolTokenAccount = undefined) {
        const { minBase, minQuote } = await this.pumpAmmInternalSdk.withdrawInputsInternal(pool, lpToken, slippage);
        return this.pumpAmmInternalSdk.withdrawInstructionsInternal(pool, lpToken, minBase, minQuote, user, userBaseTokenAccount, userQuoteTokenAccount, userPoolTokenAccount);
    }
    async withdrawAutoCompleteBaseAndQuoteFromLpToken(pool, lpAmount, slippage) {
        const { base, quote } = await this.pumpAmmInternalSdk.withdrawInputsInternal(pool, lpAmount, slippage);
        return {
            base,
            quote,
        };
    }
    async swapBaseInstructions(pool, base, slippage, direction, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        if (direction == "quoteToBase") {
            return await this.pumpAmmInternalSdk.buyBaseInput(pool, base, slippage, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
        }
        return await this.pumpAmmInternalSdk.sellBaseInput(pool, base, slippage, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async swapQuoteInstructions(pool, quote, slippage, direction, user, protocolFeeRecipient = undefined, userBaseTokenAccount = undefined, userQuoteTokenAccount = undefined) {
        if (direction == "quoteToBase") {
            return await this.pumpAmmInternalSdk.buyQuoteInput(pool, quote, slippage, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
        }
        return await this.pumpAmmInternalSdk.sellQuoteInput(pool, quote, slippage, user, protocolFeeRecipient, userBaseTokenAccount, userQuoteTokenAccount);
    }
    async swapAutocompleteQuoteFromBase(pool, base, slippage, direction) {
        if (direction == "quoteToBase") {
            return await this.pumpAmmInternalSdk.buyAutocompleteQuoteFromBase(pool, base, slippage);
        }
        return await this.pumpAmmInternalSdk.sellAutocompleteQuoteFromBase(pool, base, slippage);
    }
    async swapAutocompleteBaseFromQuote(pool, quote, slippage, direction) {
        if (direction == "quoteToBase") {
            return await this.pumpAmmInternalSdk.buyAutocompleteBaseFromQuote(pool, quote, slippage);
        }
        return await this.pumpAmmInternalSdk.sellAutocompleteBaseFromQuote(pool, quote, slippage);
    }
    async extendAccount(account, user) {
        return this.pumpAmmInternalSdk.extendAccount(account, user);
    }
}
exports.PumpAmmSdk = PumpAmmSdk;
//# sourceMappingURL=pumpAmm.js.map