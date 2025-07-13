const {
  Raydium,
  getCpmmPdaPoolId,
  CurveCalculator,
  TxVersion,
  CREATE_CPMM_POOL_PROGRAM,
  DEV_CREATE_CPMM_POOL_PROGRAM,
  AMM_V4,
  AMM_STABLE,
  DEVNET_PROGRAM_ID,
  API_URLS,
  ALL_PROGRAM_ID,
  addComputeBudget,
  swapBaseInAutoAccount,
  ApiSwapV1Out,
  getATAAddress,
} = require("@raydium-io/raydium-sdk-v2");
const { LAMPORTS_PER_SOL, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");
const {
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_CONFIG_ID,
} = require("../constants/raydium");
const { NATIVE_MINT } = require("@solana/spl-token");

const axios = require("axios");

const { testWallet, connection } = require("../constants");
const { getSPLBalanceAmount } = require("./solana");

const VALID_CPMM_PROGRAM_ID = new Set([CREATE_CPMM_POOL_PROGRAM.toBase58()]);

const isValidCpmm = (id) => VALID_CPMM_PROGRAM_ID.has(id);
const VALID_AMM_PROGRAM_ID = new Set([
  AMM_V4.toBase58(),
  AMM_STABLE.toBase58(),
]);
const isValidAmm = (id) => VALID_AMM_PROGRAM_ID.has(id);

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
    amount,
    slippage = 0.01,
    computeBudgetConfig,
  } = params;
  console.log(params);
  const raydium = await initSdk();
  raydium.setOwner(user);
  const inputAmount = new BN(amount);
  const txVersion = TxVersion.V0;
  const inputMint = type === "buy" ? NATIVE_MINT : tokenMint;

  let poolInfo;
  let poolKeys;
  let rpcData;
  // const poolId = await getRaydiumCpmmPoolId(tokenMint);
  const poolData = await raydium.api.fetchPoolByMints({
    mint1: tokenMint,
    mint2: NATIVE_MINT,
  });
  // const data = await raydium.api.fetchPoolById({ ids: poolId });
  // console.log(data);
  poolInfo = poolData.data[0];
  if (!poolInfo) {
    throw new Error("Cannot find pool info");
  }
  const poolId = poolInfo.id;
  if (isValidCpmm(poolInfo.programId)) {
    const baseIn = inputMint.toBase58() === poolInfo.mintA.address;
    rpcData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);

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
      computeBudgetConfig: computeBudgetConfig,
      txVersion: TxVersion.V0,
    });

    return builder.allInstructions;
  } else if (isValidAmm(poolInfo.programId)) {
    poolKeys = await raydium.liquidity.getAmmPoolKeys(poolId);
    rpcData = await raydium.liquidity.getRpcPoolInfo(poolId);
    const [baseReserve, quoteReserve, status] = [
      rpcData.baseReserve,
      rpcData.quoteReserve,
      rpcData.status.toNumber(),
    ];
    const baseIn = inputMint === poolInfo.mintA.address;
    const [mintIn, mintOut] = baseIn
      ? [poolInfo.mintA, poolInfo.mintB]
      : [poolInfo.mintB, poolInfo.mintA];

    const out = raydium.liquidity.computeAmountOut({
      poolInfo: {
        ...poolInfo,
        baseReserve,
        quoteReserve,
        status,
        version: 4,
      },
      amountIn: amount,
      mintIn: mintIn.address,
      mintOut: mintOut.address,
      slippage: slippage,
    });

    const { execute, builder } = await raydium.liquidity.swap({
      poolInfo,
      poolKeys,
      amountIn: amount,
      amountOut: out.minAmountOut,
      fixedSide: "in",
      inputMint: mintIn.address,
      txVersion,
      computeBudgetConfig,
    });
    return builder.allInstructions;
  } else throw new Error("target pool is not CPMM pool");
}

module.exports = { initSdk, getRaydiumCpmmPoolId, getSwapInstructions };
