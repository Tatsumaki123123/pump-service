"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ceilDiv = ceilDiv;
exports.fee = fee;
exports.getPumpAmmProgram = getPumpAmmProgram;
const bn_js_1 = __importDefault(require("bn.js"));
const anchor_1 = require("@coral-xyz/anchor");
const pumpswap_json_1 = __importDefault(require("../IDL/pumpswap.json"));
const pda_1 = require("./pda");
function ceilDiv(a, b) {
    if (b.isZero()) {
        throw new Error("Cannot divide by zero.");
    }
    return a.add(b.subn(1)).div(b);
}
function fee(amount, basisPoints) {
    return ceilDiv(amount.mul(basisPoints), new bn_js_1.default(10_000));
}
function getPumpAmmProgram(connection, programId = pda_1.PUMP_AMM_PROGRAM_ID) {
    const pumpAmmIdlAddressOverride = { ...pumpswap_json_1.default };
    pumpAmmIdlAddressOverride.address = programId;
    return new anchor_1.Program(pumpAmmIdlAddressOverride, new anchor_1.AnchorProvider(connection, null, {}));
}
