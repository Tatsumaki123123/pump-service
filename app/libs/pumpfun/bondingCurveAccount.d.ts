import { GlobalAccount } from "./globalAccount";
import { PublicKey } from "@solana/web3.js";
export declare class BondingCurveAccount {
    discriminator: bigint;
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
    realTokenReserves: bigint;
    realSolReserves: bigint;
    tokenTotalSupply: bigint;
    complete: boolean;
    creator: PublicKey;
    constructor(discriminator: bigint, virtualTokenReserves: bigint, virtualSolReserves: bigint, realTokenReserves: bigint, realSolReserves: bigint, tokenTotalSupply: bigint, complete: boolean, creator: PublicKey);
    getBuyPrice(amount: bigint): bigint;
    getSellPrice(amount: bigint, feeBasisPoints: bigint): bigint;
    getMarketCapSOL(): bigint;
    getFinalMarketCapSOL(feeBasisPoints: bigint): bigint;
    getBuyOutPrice(amount: bigint, feeBasisPoints: bigint): bigint;
    static fromBuffer(buffer: Buffer): BondingCurveAccount;
    static fromGlobalAccount(g: GlobalAccount): BondingCurveAccount;
    getBuyPrices(amounts: bigint[]): bigint[];
    getSellPrices(amounts: bigint[], feeBasisPoints: bigint): bigint[];
}
