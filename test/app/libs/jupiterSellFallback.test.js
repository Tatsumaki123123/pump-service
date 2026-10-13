const { strict: assert } = require("node:assert");
const JupSDK = require("../../../app/libs/jup");
const DFlowSDK = require("../../../app/libs/dflow");
const { getJupiterSellInstructions } = require("../../../app/libs/jupiterSellFallback");

describe("Jupiter sell fallback", () => {
  const originalJupiter = JupSDK.prototype.getSellInstructions;
  const originalDflow = DFlowSDK.prototype.getSellInstructions;
  const params = {
    tokenMint: { toBase58: () => "mint" },
    tokenAmount: "9938157711335",
    slippage: 0.2,
  };

  afterEach(() => {
    JupSDK.prototype.getSellInstructions = originalJupiter;
    DFlowSDK.prototype.getSellInstructions = originalDflow;
  });

  it("uses DFlow with the same sell amount and slippage after Jupiter 503", async () => {
    const error = new Error("Jupiter quote failed with HTTP 503");
    error.status = 503;
    JupSDK.prototype.getSellInstructions = async () => { throw error; };
    DFlowSDK.prototype.getSellInstructions = async (_ctx, received) => {
      assert.equal(received, params);
      return { instructions: ["fallback"] };
    };

    assert.deepEqual(await getJupiterSellInstructions({}, params), {
      instructions: ["fallback"],
    });
  });

  it("does not change providers for a Jupiter quote validation error", async () => {
    const error = new Error("Cannot get Jupiter V2 quote: no route");
    JupSDK.prototype.getSellInstructions = async () => { throw error; };
    DFlowSDK.prototype.getSellInstructions = async () => {
      throw new Error("DFlow should not be called");
    };

    await assert.rejects(getJupiterSellInstructions({}, params), error);
  });
});
