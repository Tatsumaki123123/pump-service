const bs58 = require("bs58");

require("dotenv/config");

const { Keypair, Connection, PublicKey } = require("@solana/web3.js");

const { retrieveEnvVariable } = require("../utils/utils");

const constants = {};

const RPC_URL = retrieveEnvVariable("RPC_URL");
constants.RPC_URL = RPC_URL;
const WSS_RPC_URL = retrieveEnvVariable("WSS_RPC_URL");
constants.WSS_RPC_URL = WSS_RPC_URL;
constants.JITO_RPC = retrieveEnvVariable("JITO_RPC");

constants.wsol = "So11111111111111111111111111111111111111112";
constants.WSOL_TOKEN_ACCOUNT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
constants.usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

constants.connection = new Connection(RPC_URL, {
  wsEndpoint: WSS_RPC_URL,
  commitment: "confirmed",
});

constants.PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

constants.BLOCK_RAZOR_1 = new PublicKey(
  "7ZKL8BAPfKKa6FNmds48QKFnckrcj4mkppRnsBAR2xVH"
);

const PRIVATE_KEY =
  "2rCKuqBiskXu8KPHiv9joWziemRfZiDMkzSyHzoWAphJ4MtfqbSsm5qdNoCcxZbFpu4xML5JFjH21qmZpbTnwnDQ";

constants.testWallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

constants.GRPC_ENDPOINT = "https://grpc-fra-1.erpc.global";
// constants.GRPC_ENDPOINT = "https://grpc-ny-1.erpc.global";
constants.GRPC_TOKEN = "e8782e9b-dc7c-4bd4-b931-012e4f8f0dde";

module.exports = constants;
