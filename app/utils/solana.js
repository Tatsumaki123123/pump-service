const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const { getAssociatedTokenAddressSync } = require("@solana/spl-token");

async function getSPLBalance(
  connection,
  tokenMint,
  owner,
  allowOffCurve = false
) {
  try {
    let ata = getAssociatedTokenAddressSync(tokenMint, owner, allowOffCurve);
    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return balance.value.uiAmount || 0;
  } catch (e) {}
  return 0;
}

module.exports = { getSPLBalance };
