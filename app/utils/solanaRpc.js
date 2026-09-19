"use strict";

/**
 * The current RPC can return transaction version 1, while the 1.x web3.js
 * response schema only accepts `legacy` and version 0. Use the connection's
 * raw JSON-RPC methods so newer transaction versions are not rejected by the
 * client-side superstruct validator.
 */
function assertRpcResponse(response, methodName) {
  if (response?.error) {
    const error = new Error(
      response.error.message || `Solana RPC ${methodName} failed`,
    );
    error.code = response.error.code;
    error.data = response.error.data;
    throw error;
  }
  return response?.result ?? null;
}

async function getParsedTransactions(connection, signatures, config = {}) {
  if (!signatures || signatures.length === 0) return [];

  const rpcConfig = {
    ...config,
    encoding: "jsonParsed",
  };
  const batch = signatures.map((signature) => ({
    methodName: "getTransaction",
    args: [signature, rpcConfig],
  }));

  if (typeof connection._rpcBatchRequest !== "function") {
    if (typeof connection._rpcRequest === "function") {
      const responses = await Promise.all(
        batch.map(({ args }) => connection._rpcRequest("getTransaction", args)),
      );
      return responses.map((response) =>
        assertRpcResponse(response, "getParsedTransactions"),
      );
    }
    // Keep compatibility with alternate Connection implementations.
    return connection.getParsedTransactions(signatures, config);
  }

  const responses = await connection._rpcBatchRequest(batch);
  return responses.map((response) =>
    assertRpcResponse(response, "getParsedTransactions"),
  );
}

async function getTransaction(connection, signature, config = {}) {
  const rpcConfig = { ...config };

  if (typeof connection._rpcRequest !== "function") {
    return connection.getTransaction(signature, config);
  }

  const response = await connection._rpcRequest("getTransaction", [
    signature,
    rpcConfig,
  ]);
  return assertRpcResponse(response, "getTransaction");
}

module.exports = {
  getParsedTransactions,
  getTransaction,
};
