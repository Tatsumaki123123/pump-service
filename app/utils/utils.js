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

module.exports = { retrieveEnvVariable, sleep, retry, retryAsync };
