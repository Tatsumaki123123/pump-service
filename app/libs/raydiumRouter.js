const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} = require("@solana/web3.js");
const {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  closeWSOLAtaIx,
  getOrCreateAssociatedTokenAccount,
  createCloseAccountInstruction,
} = require("@solana/spl-token");
const {
  API_URLS,
  ApiSwapV1Out,
  USDCMint,
  PoolKeys,
  getATAAddress,
  swapBaseInAutoAccount,
  ALL_PROGRAM_ID,
  printSimulate,
  addComputeBudget,
} = require("@raydium-io/raydium-sdk-v2");
const BN = require("bn.js");
class RaydiumRouterSDK {
  async getBuyInstructions(ctx, params) {
    const {
      user,
      tokenMint,
      buyAmount,
      slippage = 0.1,
      computeBudgetConfig,
    } = params;
    const inputMint = NATIVE_MINT.toBase58();
    const outputMint = tokenMint.toBase58();
    const amount = buyAmount * LAMPORTS_PER_SOL;
    const txVersion = "LEGACY";

    const { data: swapResponse } = await ctx.curl(
      `${
        API_URLS.SWAP_HOST
      }/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${
        slippage * 10000
      }&txVersion=${txVersion}`,
      {
        method: "get",
        dataType: "json",
      }
    );

    if (!swapResponse.success) {
      throw new Error(swapResponse.msg);
    }
    const res = await ctx.curl(
      API_URLS.BASE_HOST +
        API_URLS.POOL_KEY_BY_ID +
        `?ids=${swapResponse.data.routePlan.map((r) => r.poolId).join(",")}`,
      {
        method: "get",
        dataType: "json",
      }
    );

    // get input/output token account ata
    // please ensure your input token account has balance

    const wSolATA = getAssociatedTokenAddressSync(NATIVE_MINT, user, false);
    const tokenAta = getAssociatedTokenAddressSync(tokenMint, user, false);

    const createWSOLAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      wSolATA,
      user,
      NATIVE_MINT
    );

    const createTokenAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      tokenAta,
      user,
      tokenMint
    );
    const transferLamportsWSOLIx = SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: wSolATA,
      lamports: Math.trunc(buyAmount * (1 + slippage) * LAMPORTS_PER_SOL),
    });
    const syncNativeIx = createSyncNativeInstruction(wSolATA, TOKEN_PROGRAM_ID);

    const closeWSOLAtaIx = createCloseAccountInstruction(wSolATA, user, user);

    const ins = swapBaseInAutoAccount({
      programId: ALL_PROGRAM_ID.Router,
      wallet: user,
      amount: new BN(amount),
      inputAccount: wSolATA,
      outputAccount: tokenAta,
      routeInfo: swapResponse,
      poolKeys: res.data.data,
    });
    const { instructions } = addComputeBudget(computeBudgetConfig);

    const ixs = [
      ...instructions,
      createWSOLAtaIx,
      createTokenAtaIx,
      transferLamportsWSOLIx,
      syncNativeIx,
      ins,
      closeWSOLAtaIx,
    ];

    return ixs;
  }

  async getSellInstructions(ctx, params) {
    const { user, tokenMint, tokenAmount, slippage = 0.1 } = params;
  }
}

module.exports = RaydiumRouterSDK;
