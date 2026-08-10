const { isObject } = require("lodash");

const BN = require("bn.js");
const { PublicKey } = require("@solana/web3.js");

function retrieveEnvVariable(variableName) {
  const variable = process.env[variableName] || "";
  if (!variable) {
    console.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
}

function sleep(s) {
  return new Promise((resolve) => setTimeout(resolve, s * 1000));
}

function splitIntoBundles(items, maxSize = 5) {
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }
  if (!Number.isInteger(maxSize) || maxSize < 2) {
    throw new RangeError("maxSize must be an integer greater than 1");
  }

  const bundles = [];
  let index = 0;
  while (index < items.length) {
    const remaining = items.length - index;
    let size = Math.min(maxSize, remaining);
    if (remaining - size === 1) {
      size -= 1;
    }
    bundles.push(items.slice(index, index + size));
    index += size;
  }
  return bundles;
}

function retry(func, maxAttempts = 3) {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      attempts++;
      return func();
    } catch (error) {
      if (attempts === maxAttempts) {
        throw error;
      }
      console.log(`Attempt ${attempts} failed: ${error.message}`);
    }
  }
}

async function retryAsync(func, maxAttempts = 3, onError = false) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await func();
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxAttempts) {
        onError && (await onError());
        console.error(lastError);
        return false;
      }
    }
  }
}

function bnLayoutFormatter(obj) {
  const newObj = {};
  for (const key in obj) {
    if (obj[key]?.constructor?.name === "PublicKey") {
      newObj[key] = obj[key].toBase58();
    } else if (obj[key]?.constructor?.name === "BN") {
      newObj[key] = Number(obj[key].toString());
    } else if (obj[key]?.constructor?.name === "BigInt") {
      newObj[key] = Number(obj[key].toString());
    } else if (obj[key]?.constructor?.name === "Buffer") {
      newObj[key] = obj[key].toString("base64");
    } else if (isObject(obj[key])) {
      newObj[key] = { ...obj[key] };
      bnLayoutFormatter(newObj[key]);
    } else {
      newObj[key] = obj[key];
    }
  }
  return newObj;
}

function reverseBnLayoutFormatter(obj, options = {}) {
  const newObj = {};
  for (const key in obj) {
    try {
      if (typeof obj[key] === "string") {
        newObj[key] = new PublicKey(obj[key]);
      } else if (typeof obj[key] === "number" || typeof obj[key] === "string") {
        newObj[key] = new BN(obj[key].toString());
      } else if (isObject(obj[key])) {
        newObj[key] = { ...obj[key] };
        reverseBnLayoutFormatter(newObj[key]);
      } else {
        newObj[key] = obj[key];
      }
    } catch (error) {
      console.warn(`Failed to convert ${key}: ${error.message}`);
      newObj[key] = obj[key];
    }
  }
  return newObj;
}

module.exports = {
  retrieveEnvVariable,
  sleep,
  splitIntoBundles,
  retry,
  retryAsync,
  bnLayoutFormatter,
  reverseBnLayoutFormatter,
};
