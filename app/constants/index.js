const bs58 = require("bs58");

const { Keypair, Connection, PublicKey } = require("@solana/web3.js");

const { retrieveEnvVariable } = require("../utils/utils");

const constants = {};

const RPC_URL = retrieveEnvVariable("RPC_URL");
constants.RPC_URL = RPC_URL;
constants.JITO_RPC = retrieveEnvVariable("JITO_RPC");

constants.wsol = "So11111111111111111111111111111111111111112";
constants.WSOL_TOKEN_ACCOUNT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
constants.usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const WALLET_PRIVATE_KEY = retrieveEnvVariable("WALLET_PRIVATE_KEY");

constants.boss = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));

constants.connection = new Connection(RPC_URL, "confirmed");

constants.PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

module.exports = constants;
