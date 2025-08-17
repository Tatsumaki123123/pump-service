const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const TROGAN_PROGRAM_ID = new PublicKey(
  "troY36YiPGqMyAYCNbEqYCdN2tb91Zf7bHcQt7KUi61"
);

const TROGAN_FEES_VAULT = new PublicKey(
  "FEPUHsSPy47EQm33TvBSfACp1ZFen3EVNUjKVdm9HSDD"
);

const discriminator = new Uint8Array([212, 6, 30, 174, 147, 23, 236, 55]);
const createTroProxyInstruction = (payer, jipAcc, amount = 0.0001) => {
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
      //   pubkey: new PublicKey("jitodontfront111111111111111112959531111111"), // Account #3
      pubkey: jipAcc, // Account #3
      isWritable: false,
      isSigner: false,
    },
    {
      pubkey: SystemProgram.programId, // Account #4 (System Program)
      isWritable: false,
      isSigner: false,
    },
  ];
  const instructionData = Buffer.concat([
    Buffer.from(discriminator),
    Buffer.from(
      new Uint8Array(
        new BigUint64Array([BigInt(amount * LAMPORTS_PER_SOL)]).buffer
      )
    ),
  ]);

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
