const { PublicKey } = require("@solana/web3.js");

const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);

const GLOBAL_CONFIG = new PublicKey(
  "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"
);

const PUMP_AMM_FEE = new PublicKey(
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX"
); // 3
const PUMP_AMM_FEE_TOKEN_ACCOUNT = new PublicKey(
  "X5QPJcpph4mBAJDzc4hRziFftSbcygV59kRb2Fu6Je1"
);
const EVENT_AUTHORITY = new PublicKey(
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR"
);

module.exports = {
  RENT_SYSVAR,
  GLOBAL_CONFIG,
  PUMP_AMM_FEE,
  PUMP_AMM_FEE_TOKEN_ACCOUNT,
  EVENT_AUTHORITY,
};
