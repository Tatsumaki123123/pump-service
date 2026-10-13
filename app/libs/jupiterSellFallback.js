const JupSDK = require("./jup");
const DFlowSDK = require("./dflow");

const jupiter = new JupSDK();
const dflow = new DFlowSDK();
const TEMPORARY_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

async function getJupiterSellInstructions(ctx, params) {
  try {
    return await jupiter.getSellInstructions(ctx, params);
  } catch (jupiterError) {
    if (!TEMPORARY_HTTP_STATUSES.has(jupiterError.status)) {
      throw jupiterError;
    }
    console.warn(`Jupiter sell route unavailable for ${params.tokenMint.toBase58()}: ${jupiterError.message}; trying DFlow`);
    try {
      return await dflow.getSellInstructions(ctx, params);
    } catch (dflowError) {
      throw new Error(`Jupiter and DFlow sell routes failed: ${jupiterError.message}; DFlow: ${dflowError.message}`, {
        cause: dflowError,
      });
    }
  }
}

module.exports = { getJupiterSellInstructions };
