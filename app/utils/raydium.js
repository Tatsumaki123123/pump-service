const {
  Raydium,
  getCpmmPdaPoolId,
  CurveCalculator,
  TxVersion,
  CREATE_CPMM_POOL_PROGRAM,
  AMM_V4,
  AMM_STABLE,
  getPdaLaunchpadPoolId,
  LAUNCHPAD_PROGRAM,
  PlatformConfig,
} = require("@raydium-io/raydium-sdk-v2");
const { LAMPORTS_PER_SOL, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");
const {
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_CONFIG_ID,
} = require("../constants/raydium");
const { NATIVE_MINT } = require("@solana/spl-token");

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
    console.log("cpmm pool");
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
      txVersion,
    });

    return builder.allInstructions;
  } else if (isValidAmm(poolInfo.programId)) {
    console.log("liquidity pool");
    poolKeys = await raydium.liquidity.getAmmPoolKeys(poolId);
    rpcData = await raydium.liquidity.getRpcPoolInfo(poolId);
    const [baseReserve, quoteReserve, status] = [
      rpcData.baseReserve,
      rpcData.quoteReserve,
      rpcData.status.toNumber(),
    ];
    const baseIn = inputMint.toBase58() === poolInfo.mintA.address;
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
      amountIn: inputAmount,
      mintIn: mintIn.address,
      mintOut: mintOut.address,
      slippage: slippage,
    });

    const { execute, transaction, builder } = await raydium.liquidity.swap({
      poolInfo,
      poolKeys,
      amountIn: inputAmount,
      amountOut: out.minAmountOut,
      fixedSide: "in",
      inputMint: mintIn.address,
      txVersion,
      // computeBudgetConfig,
    });
    return builder.allInstructions;
  } else throw new Error("target pool is not CPMM pool");
}

async function getRaydiumLaunchSwapInstructions(params) {
  const {
    tokenMint,
    user,
    type = "buy",
    amount,
    slippage = 0.01,
    computeBudgetConfig,
  } = params;
  const raydium = await initSdk();
  raydium.setOwner(user);
  const mintA = tokenMint;
  const mintB = NATIVE_MINT;
  const programId = LAUNCHPAD_PROGRAM;
  const inAmount = new BN(amount);
  const txVersion = TxVersion.V0;

  const poolId = await getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintA, mintB)
    .publicKey;
  const poolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId });
  const data = await raydium.connection.getAccountInfo(poolInfo.platformId);
  const platformInfo = PlatformConfig.decode(data.data);
  if (!poolInfo) {
    throw new Error("Cannot find pool info");
  }

  const newSlippage = new BN(10000 * slippage);

  if (type === "buy") {
    const { transaction, extInfo, execute, builder } =
      await raydium.launchpad.buyToken({
        programId,
        mintA,
        slippage: newSlippage,
        configInfo: poolInfo.configInfo,
        platformFeeRate: platformInfo.feeRate,
        txVersion: txVersion.V0,
        buyAmount: inAmount,
        computeBudgetConfig,
      });
    return builder.allInstructions;
  } else if (type === "sell") {
    const { execute, transaction, builder } = await raydium.launchpad.sellToken(
      {
        programId,
        mintA,
        configInfo: poolInfo.configInfo,
        platformFeeRate: platformInfo.feeRate,
        txVersion: TxVersion.V0,
        sellAmount: inAmount,
      }
    );
    return builder.allInstructions;
  }
}

module.exports = {
  initSdk,
  getRaydiumCpmmPoolId,
  getSwapInstructions,
  getRaydiumLaunchSwapInstructions,
  isValidCpmm,
  isValidAmm,
};
