const { Program } = require("@coral-xyz/anchor");
const { Connection, LAMPORTS_PER_SOL, PublicKey } = require("@solana/web3.js");

const BN = require("bn.js");
const struct = require("buffer-layout");
const { keccak_256 } = require("js-sha3");

const IDL = require("../IDL/pumpswap-idl.json");
const {
  connection,
  PUMP_AMM_PROGRAM_ID,
  WSOL_TOKEN_ACCOUNT,
} = require("../constants");

const program = new Program(IDL, { connection });

async function calculateBuyAmount() {
  // 获取 pump_amm 池数据
  const poolInfo = await connection.getAccountInfo(PUMP_AMM_PROGRAM_ID);
  if (!poolInfo) throw new Error("Pool info not found");

  // 解析 Pool 账户
  const idl = parseIdl(IDL);
  const poolData = idl.accounts.find((acc) => acc.name === "Pool");
  const poolState = poolData.type.fields.reduce((acc, field) => {
    // 假设使用 Borsh 序列化解析（需具体实现）
    // 这里需要从 poolInfo.data 解码 pool_bump, base_mint, quote_mint, pool_base_token_account, pool_quote_token_account 等
    return acc;
  });

  const baseTokenVault = new PublicKey(poolState.pool_base_token_account);
  const quoteTokenVault = new PublicKey(poolState.pool_quote_token_account);

  // 获取储备量
  const baseDecimals = 6; // 假设代币 decimals 为 6
  const quoteDecimals = 9; // SOL decimals
  const baseTokenReserves = await getTokenBalance(
    connection,
    baseTokenVault,
    baseDecimals
  );
  const quoteTokenReserves = await getTokenBalance(
    connection,
    quoteTokenVault,
    quoteDecimals
  );

  // 假设费用
  const lpFeeBasisPoints = 100; // 1%
  const protocolFeeBasisPoints = 50; // 0.5%
  const totalFee = (lpFeeBasisPoints + protocolFeeBasisPoints) / 10000; // 1.5%

  // 计算 0.1 SOL 能买到的代币数量
  const solInput = 0.1; // 0.1 SOL
  const solInputLamports = solInput * 10 ** quoteDecimals;
  const effectiveSolInput = solInputLamports * (1 - totalFee);
  const tokensOut =
    baseTokenReserves *
    (effectiveSolInput / (quoteTokenReserves + effectiveSolInput));

  console.log(`0.1 SOL can buy approximately ${tokensOut.toFixed(6)} tokens`);

  // 计算代币对 SOL 的价格
  const priceOfTokenInSol = quoteTokenReserves / baseTokenReserves;

  // 获取 SOL/USDC 价格
  const solUsdcInfo = await connection.getAccountInfo(SOL_USDC_POOL_ID);
  if (!solUsdcInfo) throw new Error("SOL/USDC pool info not found");
  const solUsdcState = LIQUIDITY_STATE_LAYOUT_V4.decode(solUsdcInfo.data);
  const solBalance = await getTokenBalance(
    connection,
    solUsdcState.baseVault,
    9
  );
  const usdcBalance = await getTokenBalance(
    connection,
    solUsdcState.quoteVault,
    6
  );
  const priceOfSolInUsdc = usdcBalance / solBalance;

  // 计算代币对 USDC 的价格
  const priceOfTokenInUsdc = priceOfTokenInSol * priceOfSolInUsdc;
  console.log(
    `Price of 1 token in USDC: ${priceOfTokenInUsdc.toFixed(6)} USDC`
  );
}
module.exports = {
  calculateBuyAmount,
};
