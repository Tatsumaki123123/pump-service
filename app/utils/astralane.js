const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require("@solana/web3.js");
const chalk = require("chalk");

const apiKey =
  "tatsuxtpC9u4mOOm5YdYN8iwYtspJa71YVmfZmH9PXu86DIqjY84tjsBJbbDtuXT";
const url = `http://ny.gateway.astralane.io/iris?api-key=${apiKey}`;

const tipAccounts = [
  "astrazznxsGUhWShqgNtAdfrzP2G83DzcWVJDxwV9bF",
  "astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm",
  "astra9xWY93QyfG6yM8zwsKsRodscjQ2uU2HKNL5prk",
  "astraRVUuTHjpwEVvNBeQEgwYx9w9CFyfxjYoobCZhL",
];

const tipAmount = 0.0001 * LAMPORTS_PER_SOL;
const connectionForAstra = new Connection(url, "confirmed");
function getRandomAccount() {
  const randomIndex = Math.floor(Math.random() * tipAccounts.length);
  return tipAccounts[randomIndex];
}
async function sendAstralaneTransaction(owner, ixs, blockhash) {
  console.log(chalk.green("sendAstralaneTransaction---"));
  const tipAccount = getRandomAccount();
  const recipientPublicKey = new PublicKey(tipAccount);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: recipientPublicKey,
      lamports: tipAmount,
    })
  );
  transaction.add(...ixs);

  transaction.recentBlockhash = blockhash;
  transaction.feePayer = owner.publicKey;
  transaction.sign(owner);

  try {
    const signature = await connectionForAstra.sendRawTransaction(
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

module.exports = { sendAstralaneTransaction, connectionForAstra };
