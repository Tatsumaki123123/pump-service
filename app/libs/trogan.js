const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const TROGAN_PROGRAM_ID = new PublicKey(
  "troyXT7Ty3s2rjJe4bqWaroUrS4Fjd8rbHHNHxcACF4"
);

const TROGAN_FEES_VAULT = new PublicKey(
  "9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco"
);

const TROGAN_TIP_VAULT = new PublicKey(
  "75amCPfPecHipzFeE7gsBi8rLptXCEQGewon7jePpwHP"
);

const TROGAN_JITODONTFRONT = new PublicKey(
  "jitodontfront111111111111111112959799111111"
);

const TROGAN_DISCRIMINATOR_HEX =
  process.env.TROGAN_DISCRIMINATOR_HEX || "4d4df51d1cf91bee";
const TROGAN_PARAM_LAMPORTS = BigInt(
  process.env.TROGAN_PARAM_LAMPORTS || "500000"
);

const JITO_BUNDLE_PROVIDERS = new Set(["quicknode", "jito", "helius", "helius_jito"]);

const createTroProxyInstruction = (payer, _jipAcc, amount = 0.0001) => {
  const bundleProvider = (process.env.BUNDLE_PROVIDER || "quicknode").toLowerCase();
  if (JITO_BUNDLE_PROVIDERS.has(bundleProvider)) {
    console.log(
      `Skip Trojan instruction for ${bundleProvider} bundle because jitonobundle/jitodontfront accounts are not permitted.`,
    );
    return null;
  }

  const accounts = [
    {
      pubkey: payer, // Account #1
      isWritable: true,
      isSigner: true,
    },
    {
      pubkey: TROGAN_FEES_VAULT, // Account #2
      isWritable: true,
      isSigner: false,
    },
    {
      pubkey: TROGAN_TIP_VAULT, // Account #3
      isWritable: true,
      isSigner: false,
    },
    {
      pubkey: TROGAN_JITODONTFRONT, // Account #4
      isWritable: false,
      isSigner: false,
    },
    {
      pubkey: SystemProgram.programId, // Account #5
      isWritable: false,
      isSigner: false,
    },
  ];
  const tipLamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
  const instructionData = Buffer.concat([
    Buffer.from(TROGAN_DISCRIMINATOR_HEX, "hex"),
    Buffer.from(new Uint8Array(new BigUint64Array([TROGAN_PARAM_LAMPORTS]).buffer)),
    Buffer.from(new Uint8Array(new BigUint64Array([tipLamports]).buffer)),
  ]);

  console.log("Trojan instruction", {
    programId: TROGAN_PROGRAM_ID.toBase58(),
    accounts: accounts.map((item) => item.pubkey.toBase58()),
    data: instructionData.toString("hex"),
  });

  const instruction = new TransactionInstruction({
    keys: accounts,
    programId: TROGAN_PROGRAM_ID,
    data: instructionData,
  });
  return instruction;
};

module.exports = {
  createTroProxyInstruction,
};
