const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const {
  Program,
  AnchorProvider,
  Idl,
  BN,
  BorshInstructionCoder,
} = require("@coral-xyz/anchor");
const { connection } = require("../constants");

const PROGRAM_ID = new PublicKey(
  "6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma"
);
const IDL = require("../IDL/okxRouterV2-idl.json");

const coder = new BorshInstructionCoder(DexSolanaIDL);

function createSellInstruction(args) {
  const {
    user,
    tokenMint,
    amount_in,
    expect_amount_out,
    min_return,
    amounts,
    order_id,
  } = args;
  const routes = args.routes.map((routeArray) =>
    routeArray.map((route) => ({
      dexes: route.dexes.map((dex) => ({ PumpfunammSell: {} })),
      weights: Buffer.from(route.weights),
    }))
  );

  const instructionData = coder.encode("swap", {
    data: {
      amount_in: new BN(amount_in),
      expect_amount_out: new BN(expect_amount_out),
      min_return: new BN(min_return),
      amounts: amounts.map((amount) => new BN(amount)),
      routes,
    },
    order_id: new BN(order_id),
  });

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // payer
      { pubkey: sourceTokenAccount, isSigner: false, isWritable: true }, // source_token_account
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true }, // destination_token_account
      { pubkey: SOURCE_MINT, isSigner: false, isWritable: false }, // source_mint
      { pubkey: DESTINATION_MINT, isSigner: false, isWritable: false }, // destination_mint
    ],
    data: instructionData,
  });
}
