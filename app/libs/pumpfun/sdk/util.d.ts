import BN from "bn.js";
import { Connection } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { PumpAmm } from "../types/pump_amm";
export declare function ceilDiv(a: BN, b: BN): BN;
export declare function fee(amount: BN, basisPoints: BN): BN;
export declare function getPumpAmmProgram(connection: Connection, programId?: string): Program<PumpAmm>;
