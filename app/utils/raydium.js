const {
  Raydium,
  getCpmmPdaPoolId,
  CurveCalculator,
} = require("@raydium-io/raydium-sdk-v2");
const { LAMPORTS_PER_SOL } = require("@solana/web3.js");
const BN = require("bn.js");
const {
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_CONFIG_ID,
} = require("../constants/raydium");
const { NATIVE_MINT } = require("@solana/spl-token");

const { testWallet, connection } = require("../constants");

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
    tokenMint,
    NATIVE_MINT
  );
  return poolId.publicKey;
}

async function getSwapInstructions(params) {
  const { tokenMint, type = "buy", amount, slippage = 0.01 } = params;
  const raydium = await initSdk();
  const poolId = await getRaydiumCpmmPoolId(tokenMint);
  const inputAmount = new BN(amount * LAMPORTS_PER_SOL);
  const data = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  const poolInfo = data.poolInfo;
  const poolKeys = data.poolKeys;
  const rpcData = data.rpcData;
  console.log(poolInfo);

  const baseIn = type === "buy" ? false : true;

  const swapResult = CurveCalculator.swap(
    inputAmount,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    rpcData.configInfo.tradeFeeRate
  );

  const { execute, builder } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    inputAmount,
    swapResult,
    slippage,
    baseIn,
  });

  return builder.allInstructions;
}

module.exports = { initSdk, getRaydiumCpmmPoolId, getSwapInstructions };
