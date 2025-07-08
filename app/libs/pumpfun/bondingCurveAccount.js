"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BondingCurveAccount = void 0;
const borsh_1 = require("@coral-xyz/borsh");
class BondingCurveAccount {
    discriminator;
    virtualTokenReserves;
    virtualSolReserves;
    realTokenReserves;
    realSolReserves;
    tokenTotalSupply;
    complete;
    creator;
    constructor(discriminator, virtualTokenReserves, virtualSolReserves, realTokenReserves, realSolReserves, tokenTotalSupply, complete, creator) {
        this.discriminator = discriminator;
        this.virtualTokenReserves = virtualTokenReserves;
        this.virtualSolReserves = virtualSolReserves;
        this.realTokenReserves = realTokenReserves;
        this.realSolReserves = realSolReserves;
        this.tokenTotalSupply = tokenTotalSupply;
        this.complete = complete;
        this.creator = creator;
    }
    getBuyPrice(amount) {
        if (this.complete) {
            throw new Error("Curve is complete");
        }
        if (amount <= 0n) {
            return 0n;
        }
        // Calculate the product of virtual reserves
        let n = this.virtualSolReserves * this.virtualTokenReserves;
        // Calculate the new virtual sol reserves after the purchase
        let i = this.virtualSolReserves + amount;
        // Calculate the new virtual token reserves after the purchase
        let r = n / i + 1n;
        // Calculate the amount of tokens to be purchased
        let s = this.virtualTokenReserves - r;
        // Return the minimum of the calculated tokens and real token reserves
        return s < this.realTokenReserves ? s : this.realTokenReserves;
    }
    getSellPrice(amount, feeBasisPoints) {
        if (this.complete) {
            throw new Error("Curve is complete");
        }
        if (amount <= 0n) {
            return 0n;
        }
        // Calculate the proportional amount of virtual sol reserves to be received
        let n = (amount * this.virtualSolReserves) / (this.virtualTokenReserves + amount);
        // Calculate the fee amount in the same units
        let a = (n * feeBasisPoints) / 10000n;
        // Return the net amount after deducting the fee
        return n - a;
    }
    getMarketCapSOL() {
        if (this.virtualTokenReserves === 0n) {
            return 0n;
        }
        return (this.tokenTotalSupply * this.virtualSolReserves) / this.virtualTokenReserves;
    }
    getFinalMarketCapSOL(feeBasisPoints) {
        let totalSellValue = this.getBuyOutPrice(this.realTokenReserves, feeBasisPoints);
        let totalVirtualValue = this.virtualSolReserves + totalSellValue;
        let totalVirtualTokens = this.virtualTokenReserves - this.realTokenReserves;
        if (totalVirtualTokens === 0n) {
            return 0n;
        }
        return (this.tokenTotalSupply * totalVirtualValue) / totalVirtualTokens;
    }
    getBuyOutPrice(amount, feeBasisPoints) {
        let solTokens = amount < this.realSolReserves ? this.realSolReserves : amount;
        let totalSellValue = (solTokens * this.virtualSolReserves) / (this.virtualTokenReserves - solTokens) + 1n;
        let fee = (totalSellValue * feeBasisPoints) / 10000n;
        return totalSellValue + fee;
    }
    static fromBuffer(buffer) {
        const structure = (0, borsh_1.struct)([
            (0, borsh_1.u64)("discriminator"),
            (0, borsh_1.u64)("virtualTokenReserves"),
            (0, borsh_1.u64)("virtualSolReserves"),
            (0, borsh_1.u64)("realTokenReserves"),
            (0, borsh_1.u64)("realSolReserves"),
            (0, borsh_1.u64)("tokenTotalSupply"),
            (0, borsh_1.bool)("complete"),
            (0, borsh_1.publicKey)("creator"),
        ]);
        let value = structure.decode(buffer);
        return new BondingCurveAccount(BigInt(value.discriminator), BigInt(value.virtualTokenReserves), BigInt(value.virtualSolReserves), BigInt(value.realTokenReserves), BigInt(value.realSolReserves), BigInt(value.tokenTotalSupply), value.complete, value.creator);
    }
    static fromGlobalAccount(g) {
        return new BondingCurveAccount(1n, g.initialVirtualTokenReserves, g.initialVirtualSolReserves, g.initialRealTokenReserves, g.initialVirtualSolReserves, g.tokenTotalSupply, false, g.authority);
    }
    getBuyPrices(amounts) {
        if (this.complete) {
            throw new Error("Curve is complete");
        }
        const results = [];
        let currentVirtualTokenReserves = this.virtualTokenReserves;
        let currentVirtualSolReserves = this.virtualSolReserves;
        let currentRealTokenReserves = this.realTokenReserves;
        for (let amount of amounts) {
            if (amount <= 0n) {
                results.push(0n);
                continue;
            }
            // Calculate the product of current virtual reserves
            let n = currentVirtualSolReserves * currentVirtualTokenReserves;
            // Calculate the new virtual sol reserves after the purchase
            let i = currentVirtualSolReserves + amount;
            // Calculate the new virtual token reserves after the purchase
            let r = n / i + 1n;
            // Calculate the amount of tokens to be purchased
            let s = currentVirtualTokenReserves - r;
            // Determine the minimum between calculated and available real tokens
            let buyAmount = s < currentRealTokenReserves ? s : currentRealTokenReserves;
            // Add result to the array
            results.push(buyAmount);
            // Update reserves for the next iteration
            currentVirtualSolReserves = i; // New SOL reserves after purchase
            currentVirtualTokenReserves = r; // New token reserves after purchase
            currentRealTokenReserves -= buyAmount; // Reduce real token reserves by the amount sold
        }
        return results;
    }
    getSellPrices(amounts, feeBasisPoints) {
        if (this.complete) {
            throw new Error("Curve is complete");
        }
        const results = [];
        let currentSolReserves = this.virtualSolReserves; // Start with current reserves
        let currentTokenReserves = this.virtualTokenReserves;
        for (let amount of amounts) {
            if (amount <= 0n) {
                results.push(0n);
            }
            else {
                // Calculate the proportional amount of virtual sol reserves to be received
                let n = (amount * currentSolReserves) / (currentTokenReserves + amount);
                // Calculate the fee amount in the same units
                let a = (n * feeBasisPoints) / 10000n;
                // Net amount after fee
                let netAmount = n - a;
                results.push(netAmount);
                // Update reserves for the next iteration
                currentSolReserves -= n; // Reduce SOL reserves by the amount sent
                currentTokenReserves += amount; // Increase token reserves by the amount received
            }
        }
        return results;
    }
}
exports.BondingCurveAccount = BondingCurveAccount;
