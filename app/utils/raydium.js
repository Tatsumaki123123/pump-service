const {
  Raydium,
  getCpmmPdaPoolId,
  CurveCalculator,
  TxVersion,
} = require("@raydium-io/raydium-sdk-v2");
const { LAMPORTS_PER_SOL } = require("@solana/web3.js");
const BN = require("bn.js");
const {
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_CONFIG_ID,
} = require("../constants/raydium");
const { NATIVE_MINT } = require("@solana/spl-token");

const { testWallet, connection } = require("../constants");
const { getSPLBalanceAmount } = require("./solana");

let raydium;
const initSdk = async (params) => {
  if (raydium) return raydium;

  raydium = await Raydium.load({
    owner: testWallet,
    connection,
  });
  return raydium;
};

async function getRaydiumCpmmPoolId(tokenMint) {
  const poolId = await getCpmmPdaPoolId(
    RAYDIUM_CPMM_PROGRAM_ID,
    RAYDIUM_CPMM_CONFIG_ID,
    NATIVE_MINT,
    tokenMint
  );
  return poolId.publicKey;
}

async function getSwapInstructions(params) {
  const {
    tokenMint,
    user,
    type = "buy",
    inputAmount,
    slippage = 0.01,
    computeBudgetConfig,
  } = params;
  const raydium = await initSdk();
  const poolId = await getRaydiumCpmmPoolId(tokenMint);
  const data = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  const poolInfo = data.poolInfo;
  const poolKeys = data.poolKeys;
  const rpcData = data.rpcData;

  const baseIn = type === "buy" ? true : false;

  const swapResult = CurveCalculator.swap(
    inputAmount,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    rpcData.configInfo.tradeFeeRate
  );

  raydium.setOwner(user);
  const { execute, builder } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    inputAmount,
    swapResult,
    slippage,
    baseIn,
    computeBudgetConfig: computeBudgetConfig,
    txVersion: TxVersion.V0,
  });

  return builder.allInstructions;
}

module.exports = { initSdk, getRaydiumCpmmPoolId, getSwapInstructions };
