const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require("@solana/web3.js");
const { connection } = require("../constants");

const token = "e0f6af3d4f8d4e87ae3923f025029a7a";
const url = `http://de1.0slot.trade?api-key=${token}`;

const tipAccounts = [
  "Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3",
  "FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe",
  "ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13",
  "6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK",
  "Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr",
];

const tipAmount = 0.001 * LAMPORTS_PER_SOL;

const connectionForSend = new Connection(url, "confirmed");

function getRandomAccount() {
  const randomIndex = Math.floor(Math.random() * tipAccounts.length);
  return new PublicKey(tipAccounts[randomIndex]);
}

async function send0slotTransaction(owner, ixs) {
  const tipAccount = getRandomAccount();

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: tipAccount,
      lamports: tipAmount,
    })
  );
  transaction.add(...ixs);

  transaction.recentBlockhash = (
    await connection.getLatestBlockhash("processed")
  ).blockhash;
  transaction.feePayer = owner.publicKey;
  transaction.sign(owner);

  try {
    const signature = await connectionForSend.sendRawTransaction(
      transaction.serialize(),
      {
        preflightCommitment: "confirmed",
      }
    );
    console.log("Transaction signature:", signature); // Print the transaction signature if successful.
  } catch (error) {
    console.error("Error:", error); // Print any errors that occur during the transaction process.
  }
}

module.exports = { getRandomAccount, send0slotTransaction };
