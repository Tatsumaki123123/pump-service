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

module.exports = { retrieveEnvVariable, sleep };
