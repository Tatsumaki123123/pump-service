const { PublicKey } = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);

const GLOBAL_CONFIG = new PublicKey(
  "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"
);

// https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_RECIPIENT_ROTATION.md
const PUMP_AMM_FEE = new PublicKey(
  "2aSWZ3QXsNLVVBr1UB1HxSw7sqMRR2pv2qa5ohsTi5Gp",
);
const PUMP_AMM_MAYHEM_FEE = new PublicKey(
  "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS",
);
const RETIRED_PUMP_AMM_FEE_RECIPIENTS = new Set([
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
]);

const getPumpAmmFeeAta = (recipient) => getAssociatedTokenAddressSync(
  NATIVE_MINT, recipient, true, TOKEN_PROGRAM_ID,
);
const PUMP_AMM_FEE_TOKEN_ACCOUNT = getPumpAmmFeeAta(PUMP_AMM_FEE);

function getPumpAmmWsolProtocolFeeAccounts(isMayhem, envPrefix = "PUMP_AMM") {
  const recipientKey = `${envPrefix}_PROTOCOL_FEE_RECIPIENT`;
  const ataKey = `${recipientKey}_TOKEN_ACCOUNT`;
  // Mayhem uses a separate allowlist; do not apply an ordinary pool override.
  const configuredRecipient = !isMayhem && process.env[recipientKey];
  const ordinaryRecipient = configuredRecipient
    ? new PublicKey(configuredRecipient)
    : PUMP_AMM_FEE;
  const recipient = isMayhem ? PUMP_AMM_MAYHEM_FEE : ordinaryRecipient;
  if (RETIRED_PUMP_AMM_FEE_RECIPIENTS.has(recipient.toBase58())) {
    throw new Error(`${recipientKey} is retired; update or remove it`);
  }
  const tokenAccount = getPumpAmmFeeAta(recipient);
  if (!isMayhem && process.env[ataKey] && process.env[ataKey] !== tokenAccount.toBase58()) {
    throw new Error(`${ataKey} must match the WSOL ATA for ${recipientKey}; update or remove it`);
  }
  return { recipient, tokenAccount };
}
const EVENT_AUTHORITY = new PublicKey(
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR"
);

module.exports = {
  RENT_SYSVAR,
  GLOBAL_CONFIG,
  PUMP_AMM_FEE,
  PUMP_AMM_FEE_TOKEN_ACCOUNT,
  getPumpAmmWsolProtocolFeeAccounts,
  EVENT_AUTHORITY,
};
