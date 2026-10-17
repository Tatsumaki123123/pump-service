const { strict: assert } = require("node:assert");
const { PublicKey, TransactionInstruction } = require("@solana/web3.js");
const OKXRouterSDK = require("../../../app/libs/okxRouterV2");

describe("OKX sell instructions", () => {
  it("keeps the raw token amount and wallet address in the route request", async () => {
    const sdk = new OKXRouterSDK();
    const tokenMint = new PublicKey("So11111111111111111111111111111111111111112");
    const user = new PublicKey("11111111111111111111111111111111");
    let request;
    sdk.getRouterInstruction = async (_ctx, params) => {
      request = params;
      return {
        data: {
          data: [{
            instructionLists: [{
              programId: user.toBase58(),
              accounts: [],
              data: "AQ==",
            }],
          }],
        },
      };
    };

    const instructions = await sdk.getSellInstructions({}, {
      user,
      tokenMint,
      tokenAmount: "9938157711335",
      slippage: 0.01,
    });

    assert.equal(request.fromTokenAddress, tokenMint.toBase58());
    assert.equal(request.toTokenAddress, "11111111111111111111111111111111");
    assert.equal(request.amount, "9938157711335");
    assert.equal(request.userWalletAddress, user.toBase58());
    assert.equal(request.slippage, 0.01);
    assert.equal(instructions.length, 1);
    assert(instructions[0] instanceof TransactionInstruction);
    assert.deepEqual(instructions[0].data, Buffer.from([1]));
  });
});
