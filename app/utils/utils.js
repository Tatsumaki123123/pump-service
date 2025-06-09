function retrieveEnvVariable(variableName) {
  const variable = process.env[variableName] || "";
  if (!variable) {
    console.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
}

module.exports = { retrieveEnvVariable };
