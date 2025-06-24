"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpSwapPool = void 0;
exports.globalConfigPda = globalConfigPda;
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const IDL_1 = require("./IDL");
const pda_1 = require("./sdk/pda");
const util_1 = require("./sdk/util");
const PUMP_AMM_PROGRAM_ID = new web3_js_1.PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_TOKEN_ACCOUNT = new web3_js_1.PublicKey("So11111111111111111111111111111111111111112");
function globalConfigPda(programId = pda_1.PUMP_AMM_PROGRAM_ID_PUBKEY) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("global_config")], programId);
}
class PumpSwapPool {
    program;
    connection;
    globalConfig;
    constructor(provider) {
        this.program = new anchor_1.Program(IDL_1.IDL_SWAP, provider);
        this.connection = this.program.provider.connection;
        this.globalConfig = globalConfigPda(this.program.programId)[0];
    }
    async getPoolsWithBaseMint(mintAddress) {
        const response = await this.connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
            filters: [
                {
                    memcmp: {
                        offset: 43,
                        bytes: mintAddress.toBase58(),
                    },
                },
            ],
            commitment: "confirmed",
        });
        const mappedPools = response.map((pool) => {
            const data = Buffer.from(pool.account.data);
            const poolData = this.program.coder.accounts.decode("pool", data);
            return {
                address: pool.pubkey,
                is_native_base: false,
                poolData,
            };
        });
        return mappedPools;
    }
    async getPoolsWithQuoteMint(mintAddress) {
        const response = await this.connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
            filters: [
                {
                    memcmp: {
                        offset: 75,
                        bytes: mintAddress.toBase58(),
                    },
                },
            ],
            commitment: "confirmed",
        });
        const mappedPools = response.map((pool) => {
            const data = Buffer.from(pool.account.data);
            const poolData = this.program.coder.accounts.decode("pool", data);
            return {
                address: pool.pubkey,
                is_native_base: true,
                poolData,
            };
        });
        return mappedPools;
    }
    async getPoolsWithBaseMintQuoteWSOL(mintAddress) {
        const response = await this.connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
            filters: [
                { dataSize: 211 },
                {
                    memcmp: {
                        offset: 43,
                        bytes: mintAddress.toBase58(),
                    },
                },
                {
                    memcmp: {
                        offset: 75,
                        bytes: WSOL_TOKEN_ACCOUNT.toBase58(),
                    },
                },
            ],
        });
        const mappedPools = response.map((pool) => {
            const data = Buffer.from(pool.account.data);
            const poolData = this.program.coder.accounts.decode("pool", data);
            return {
                address: pool.pubkey,
                is_native_base: true,
                poolData,
            };
        });
        return mappedPools;
    }
    async getPriceAndLiquidity(pool) {
        const wsolAddress = pool.poolData.poolQuoteTokenAccount;
        const tokenAddress = pool.poolData.poolBaseTokenAccount;
        const [wsolBalance, tokenBalance] = await Promise.all([
            this.connection.getTokenAccountBalance(wsolAddress, "confirmed"),
            this.connection.getTokenAccountBalance(tokenAddress, "confirmed"),
        ]);
        const price = wsolBalance.value.uiAmount / tokenBalance.value.uiAmount;
        const globalConfig = await this.fetchGlobalConfigAccount();
        return {
            ...pool,
            price,
            globalConfig,
            reserves: {
                native: wsolBalance.value.amount,
                token: tokenBalance.value.amount,
            },
        };
    }
    async getPoolDataFromPoolId(poolId) {
        const accountInfo = await this.connection.getAccountInfo(poolId, "confirmed");
        if (!accountInfo?.data)
            return;
        const data = Buffer.from(accountInfo?.data);
        const poolData = this.program.coder.accounts.decode("pool", data);
        const pool = {
            address: poolId,
            is_native_base: false,
            poolData,
        };
        return pool;
    }
    async getPoolsWithPrices(mintAddress) {
        const [poolsWithBaseMint, poolsWithQuoteMint] = await Promise.all([this.getPoolsWithBaseMint(mintAddress), this.getPoolsWithQuoteMint(mintAddress)]);
        //const poolsWithBaseMinQuoteWSOL = await getPoolsWithBaseMintQuoteWSOL(mintAddress)
        const pools = [...poolsWithBaseMint, ...poolsWithQuoteMint];
        const results = await Promise.all(pools.map((pool) => this.getPriceAndLiquidity(pool)));
        const sortedByHighestLiquidity = results.sort((a, b) => Number(b.reserves.native) - Number(a.reserves.native));
        return sortedByHighestLiquidity;
    }
    async getBuyTokenAmount(solAmount, mint, slippage, pool) {
        let poolDetail = pool;
        if (solAmount == 0n) {
            return {
                maxQuote: new anchor_1.BN(0),
                baseAmountOut: new anchor_1.BN(0),
            };
        }
        if (!poolDetail) {
            const pool_detail = await this.getPoolsWithPrices(mint);
            if (pool_detail.length == 0) {
                throw new Error(`Unable to find pool ${mint.toBase58()}`);
            }
            poolDetail = pool_detail[0];
        }
        const quote = new anchor_1.BN(solAmount.toString());
        const baseReserve = new anchor_1.BN(poolDetail.reserves.token);
        const quoteReserve = new anchor_1.BN(poolDetail.reserves.native);
        const lpFeeBps = poolDetail.globalConfig.lpFeeBasisPoints;
        const protocolFeeBps = poolDetail.globalConfig.protocolFeeBasisPoints;
        if (quote.isZero()) {
            throw new Error("Invalid input: 'quote' cannot be zero.");
        }
        if (baseReserve.isZero() || quoteReserve.isZero()) {
            throw new Error("Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.");
        }
        if (lpFeeBps.isNeg() || protocolFeeBps.isNeg()) {
            throw new Error("Fee basis points cannot be negative.");
        }
        // -----------------------------------------------------
        // 2) Calculate total fee basis points and denominator
        // -----------------------------------------------------
        const totalFeeBps = lpFeeBps.add(protocolFeeBps);
        const denominator = new anchor_1.BN(10_000).add(totalFeeBps);
        // -----------------------------------------------------
        // 3) Calculate effective quote amount
        // -----------------------------------------------------
        const effectiveQuote = quote.mul(new anchor_1.BN(10_000)).div(denominator);
        // -----------------------------------------------------
        // 4) Calculate the base tokens received using effectiveQuote
        //    base_amount_out = floor(base_reserve * effectiveQuote / (quote_reserve + effectiveQuote))
        // -----------------------------------------------------
        const numerator = baseReserve.mul(effectiveQuote);
        const denominatorEffective = quoteReserve.add(effectiveQuote);
        if (denominatorEffective.isZero()) {
            throw new Error("Pool would be depleted; denominator is zero.");
        }
        const baseAmountOut = numerator.div(denominatorEffective);
        // -----------------------------------------------------
        // 5) Calculate maxQuote with slippage
        //    If slippage=1 => factor = (1 + 1/100) = 1.01
        // -----------------------------------------------------
        const precision = new anchor_1.BN(1_000_000_000); // For slippage calculations
        const slippageFactorFloat = (1 + slippage / 10000) * 1_000_000_000;
        const slippageFactor = new anchor_1.BN(Math.floor(slippageFactorFloat));
        // maxQuote = quote * slippageFactor / 1e9
        const maxQuote = quote.mul(slippageFactor).div(precision);
        return { maxQuote, baseAmountOut };
    }
    async getBuyTokenAmounts(solAmounts, mint, slippage, pool) {
        let poolDetail = pool;
        if (!poolDetail) {
            const pool_detail = await this.getPoolsWithPrices(mint);
            if (pool_detail.length == 0) {
                throw new Error(`Unable to find pool ${mint.toBase58()}`);
            }
            poolDetail = pool_detail[0];
        }
        let currentBaseReserve = new anchor_1.BN(poolDetail.reserves.token);
        let currentQuoteReserve = new anchor_1.BN(poolDetail.reserves.native);
        const results = [];
        for (const solAmount of solAmounts) {
            // Create temporary pool state for this iteration
            const tempPool = {
                ...poolDetail,
                reserves: {
                    token: currentBaseReserve.toString(),
                    native: currentQuoteReserve.toString(),
                },
            };
            // Calculate amounts using existing function
            const result = await this.getBuyTokenAmount(solAmount, mint, slippage, tempPool);
            results.push(result);
            // Update reserves for next iteration
            currentBaseReserve = currentBaseReserve.sub(result.baseAmountOut);
            currentQuoteReserve = currentQuoteReserve.add(new anchor_1.BN(solAmount.toString()));
        }
        return results;
    }
    async getSellTokenAmount(tokenAmount, mint, slippage, pool) {
        let poolDetail = pool;
        if (tokenAmount == 0n) {
            return new anchor_1.BN(0);
        }
        if (!poolDetail) {
            const pool_detail = await this.getPoolsWithPrices(mint);
            if (pool_detail.length == 0) {
                throw new Error(`Unable to find pool ${mint.toBase58()}`);
            }
            poolDetail = pool_detail[0];
        }
        const base = new anchor_1.BN(tokenAmount.toString());
        const baseReserve = new anchor_1.BN(poolDetail.reserves.token);
        const quoteReserve = new anchor_1.BN(poolDetail.reserves.native);
        const lpFeeBps = poolDetail.globalConfig.lpFeeBasisPoints;
        const protocolFeeBps = poolDetail.globalConfig.protocolFeeBasisPoints;
        if (base.isZero()) {
            throw new Error("Invalid input: 'base' (base_amount_in) cannot be zero.");
        }
        if (baseReserve.isZero() || quoteReserve.isZero()) {
            throw new Error("Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.");
        }
        if (lpFeeBps.isNeg() || protocolFeeBps.isNeg()) {
            throw new Error("Fee basis points cannot be negative.");
        }
        // -----------------------------------------
        // 2) Calculate the raw quote output (no fees)
        //    This matches a typical constant-product formula for selling base to get quote:
        //      quote_amount_out = floor( (quoteReserve * base) / (baseReserve + base) )
        // -----------------------------------------
        const quoteAmountOut = quoteReserve.mul(base).div(baseReserve.add(base)); // floor by BN.div
        // -----------------------------------------
        // 3) Calculate fees
        //    LP fee and protocol fee are both taken from 'quoteAmountOut'
        // -----------------------------------------
        const lpFee = (0, util_1.fee)(quoteAmountOut, lpFeeBps);
        const protocolFee = (0, util_1.fee)(quoteAmountOut, protocolFeeBps);
        // Subtract fees to get the actual user receive
        const finalQuote = quoteAmountOut.sub(lpFee).sub(protocolFee);
        if (finalQuote.isNeg()) {
            // Theoretically shouldn't happen unless fees exceed quoteAmountOut
            throw new Error("Fees exceed total output; final quote is negative.");
        }
        // -----------------------------------------
        // 4) Calculate minQuote with slippage
        //    - If slippage=1 => 1%, we allow receiving as low as 99% of finalQuote
        // -----------------------------------------
        const precision = new anchor_1.BN(1_000_000_000); // For safe integer math
        // (1 - slippage/100) => e.g. slippage=1 => factor= 0.99
        const slippageFactorFloat = (1 - slippage / 10000) * 1_000_000_000;
        const slippageFactor = new anchor_1.BN(Math.floor(slippageFactorFloat));
        // minQuote = finalQuote * (1 - slippage/100)
        const minQuote = finalQuote.mul(slippageFactor).div(precision);
        return minQuote;
    }
    async getSellTokenAmounts(tokenAmounts, mint, slippage, pool) {
        let poolDetail = pool;
        if (!poolDetail) {
            const pool_detail = await this.getPoolsWithPrices(mint);
            if (pool_detail.length == 0) {
                throw new Error(`Unable to find pool ${mint.toBase58()}`);
            }
            poolDetail = pool_detail[0];
        }
        let currentBaseReserve = new anchor_1.BN(poolDetail.reserves.token);
        let currentQuoteReserve = new anchor_1.BN(poolDetail.reserves.native);
        const results = [];
        for (const tokenAmount of tokenAmounts) {
            // Create temporary pool state for this iteration
            const tempPool = {
                ...poolDetail,
                reserves: {
                    token: currentBaseReserve.toString(),
                    native: currentQuoteReserve.toString(),
                },
            };
            const minQuote = await this.getSellTokenAmount(tokenAmount, mint, slippage, tempPool);
            results.push(minQuote);
            // Update reserves for next iteration
            currentBaseReserve = currentBaseReserve.add(new anchor_1.BN(tokenAmount.toString()));
            currentQuoteReserve = currentQuoteReserve.sub(minQuote);
        }
        return results;
    }
    async getPumpSwapPool(mint) {
        const pools = await this.getPoolsWithBaseMintQuoteWSOL(mint);
        console.log("Pools:", pools.map((pool) => pool.address.toBase58()));
        return pools[0].address;
    }
    async getPrice(mint) {
        const pools = await this.getPoolsWithPrices(mint);
        return pools[0].price;
    }
    fetchGlobalConfigAccount() {
        return this.program.account.globalConfig.fetch(this.globalConfig);
    }
}
exports.PumpSwapPool = PumpSwapPool;
//# sourceMappingURL=poolswap.js.map