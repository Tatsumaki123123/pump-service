const { NATIVE_MINT } = require("@solana/spl-token");
const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} = require("@solana/web3.js");

const BASE_URL = "https://lite-api.jup.ag";

class JupSDK {
  async getBuyInstructions(ctx, params) {
    const { user, tokenMint, buyAmount, slippage } = params;
    const amount = buyAmount * LAMPORTS_PER_SOL;
    const quoteResponse = await this.getQuote(
      ctx,
      NATIVE_MINT.toBase58(),
      tokenMint.toBase58(),
      amount,
      slippage
    );
    return await this.getSwapInstructions(ctx, user, quoteResponse);
  }

  async getSellInstructions(ctx, params) {
    const { user, tokenMint, tokenAmount, slippage } = params;
    const amount = tokenAmount;
    const quoteResponse = await this.getQuote(
      ctx,
      tokenMint.toBase58(),
      NATIVE_MINT.toBase58(),
      amount,
      slippage
    );
    return await this.getSwapInstructions(ctx, user, quoteResponse);
  }

  async getSwapInstructions(ctx, user, quoteResponse) {
    const uri = `${BASE_URL}/swap/v1/swap-instructions`;
    const res = await ctx.curl(uri, {
      dataType: "json",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        quoteResponse,
        userPublicKey: user,
      },
    });
    const instructions = res.data;
    const {
      tokenLedgerInstruction,
      computeBudgetInstructions,
      setupInstructions,
      swapInstruction,
      cleanupInstruction,
    } = instructions;
    const allInstructions = [
      ...computeBudgetInstructions,
      ...setupInstructions,
      swapInstruction,
      cleanupInstruction,
    ];
    return allInstructions.map((instruction) => {
      return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((key) => ({
          pubkey: new PublicKey(key.pubkey),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, "base64"),
      });
    });
  }

  async getQuote(ctx, input, output, amount, slippage) {
    const slippageBps = slippage * 10000;
    const uri = `${BASE_URL}/swap/v1/quote?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
    const res = await ctx.curl(uri, {
      dataType: "json",
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });
    return res.data;
  }
}

module.exports = JupSDK;
