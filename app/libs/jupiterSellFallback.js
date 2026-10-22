const JupSDK = require("./jup");
const DFlowSDK = require("./dflow");

const jupiter = new JupSDK();
const dflow = new DFlowSDK();
const TEMPORARY_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

async function getJupiterSellInstructions(ctx, params, options = {}) {
  const {
    fallbackOnAnyError = false,
    preferDFlow = false,
    includeProvider = false,
  } = options;
  const providers = preferDFlow
    ? [["dflow", dflow], ["jupiter", jupiter]]
    : [["jupiter", jupiter], ["dflow", dflow]];
  const errors = [];

  for (let index = 0; index < providers.length; index++) {
    const [providerName, provider] = providers[index];
    try {
      const result = await provider.getSellInstructions(ctx, params);
      return includeProvider ? { ...result, routeProvider: providerName } : result;
    } catch (error) {
      errors.push({ providerName, error });
      const canFallback = fallbackOnAnyError || TEMPORARY_HTTP_STATUSES.has(error.status);
      if (index === providers.length - 1 || !canFallback) {
        break;
      }
      console.warn(
        `${providerName} sell route unavailable for ${params.tokenMint.toBase58()}: ${error.message}; trying ${providers[index + 1][0]}`,
      );
    }
  }

  if (errors.length === 1) throw errors[0].error;
  const message = errors
    .map(({ providerName, error }) => `${providerName}: ${error.message}`)
    .join("; ");
  const combinedError = new Error(`Jupiter and DFlow sell routes failed: ${message}`, {
    cause: errors[errors.length - 1].error,
  });
  if (fallbackOnAnyError) combinedError.retryable = true;
  throw combinedError;
}

async function getJupiterSellTransaction(ctx, params, options = {}) {
  const {
    fallbackOnAnyError = false,
    preferDFlow = false,
  } = options;
  const providers = preferDFlow
    ? [["dflow", () => dflow.getSellInstructions(ctx, params)], ["jupiter", () => jupiter.getSellTransaction(ctx, params)]]
    : [["jupiter", () => jupiter.getSellTransaction(ctx, params)], ["dflow", () => dflow.getSellInstructions(ctx, params)]];
  const errors = [];

  for (let index = 0; index < providers.length; index++) {
    const [providerName, getRoute] = providers[index];
    try {
      const result = await getRoute();
      return { ...result, routeProvider: providerName };
    } catch (error) {
      errors.push({ providerName, error });
      const canFallback = fallbackOnAnyError || TEMPORARY_HTTP_STATUSES.has(error.status);
      if (index === providers.length - 1 || !canFallback) break;
      console.warn(
        `${providerName} sell route unavailable for ${params.tokenMint.toBase58()}: ${error.message}; trying ${providers[index + 1][0]}`,
      );
    }
  }

  if (errors.length === 1) throw errors[0].error;
  const message = errors
    .map(({ providerName, error }) => `${providerName}: ${error.message}`)
    .join("; ");
  const combinedError = new Error(`Jupiter and DFlow sell routes failed: ${message}`, {
    cause: errors[errors.length - 1].error,
  });
  if (fallbackOnAnyError) combinedError.retryable = true;
  throw combinedError;
}

module.exports = { getJupiterSellInstructions, getJupiterSellTransaction };
