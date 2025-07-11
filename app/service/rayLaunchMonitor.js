"use strict";
const { Service } = require("egg");
const { LAMPORTS_PER_SOL, PublicKey } = require("@solana/web3.js");

const bs58 = require("bs58");
const borsh = require("@coral-xyz/borsh");
const chalk = require("chalk");

const {
  default: Client,
  CommitmentLevel,
} = require("@triton-one/yellowstone-grpc");
const { SolanaParser } = require("@shyft-to/solana-transaction-parser");
const { TransactionFormatter } = require("../utils/transaction-formatter");
const { SolanaEventParser } = require("../utils/event-parser");
const { bnLayoutFormatter } = require("../utils/bn-layout-formatter");
const { rl_formatter } = require("../utils/rl-transaction-formatter");

const raydiumLaunchpadIdl = require("../IDL/raydium_launchpad.json");

const { connection, GRPC_ENDPOINT, GRPC_TOKEN } = require("../constants");
const {
  RAYDIUM_LAUNCHPAD_PROGRAM_ID,
  RAYDIUM_LAUNCHPAD_AUTHORITY_ID,
} = require("../constants/raydium");

const TXN_FORMATTER = new TransactionFormatter();

const RAYDIUM_LAUNCHPAD_IX_PARSER = new SolanaParser([]);
RAYDIUM_LAUNCHPAD_IX_PARSER.addParserFromIdl(
  RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58(),
  raydiumLaunchpadIdl
);

const RAYDIUM_LAUNCHPAD_EVENT_PARSER = new SolanaEventParser([], console);
RAYDIUM_LAUNCHPAD_EVENT_PARSER.addParserFromIdl(
  RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58(),
  raydiumLaunchpadIdl
);

const CREATE_EVENT_IX_DISCRIMINATOR = Buffer.from([
  151, 215, 226, 9, 118, 161, 115, 174,
]);
const CREATE_IX_DISCRIMINATOR = Buffer.from([
  175, 175, 109, 31, 13, 152, 155, 237,
]);

const FILTER_CONFIG = {
  programIds: [RAY_LAUNCHPAD_PROGRAM_ID],
  requiredAccounts: [RAY_LAUNCHPAD_PROGRAM_ID, RAY_LAUNCHPAD_AUTHORITY_ID],
  instructionDiscriminators: [CREATE_IX_DISCRIMINATOR],
};

class RayLaunchMonitor extends Service {
  async startMonitor() {
    await this.startGrpcMonitor();
  }

  async startGrpcMonitor() {
    console.log(chalk.green("\n --- ray launch pad startGrpcMonitor"));
    const yellowClient = new Client(GRPC_ENDPOINT, GRPC_TOKEN);
    const stream = await yellowClient.subscribe();
    const request = createSubscribeRequest();
    const handleStreamEvents = (stream) => {
      return new Promise((resolve, reject) => {
        stream.on("data", (data) => this.handleData(data));
        stream.on("error", (error) => {
          console.error("Stream error:", error);
          reject(error);
          stream.end();
        });
        stream.on("end", () => {
          console.log("Stream ended");
          resolve();
        });
        stream.on("close", () => {
          console.log("Stream closed");
          resolve();
        });
      });
    };
    try {
      await sendSubscribeRequest(stream, request);
      console.log(
        "Geyser connection established - watching new Pump.fun mints. \n"
      );
      await handleStreamEvents(stream);
    } catch (error) {
      console.error("Error in subscription process:", error);
      stream.end();
    }
  }

  async handleData(data) {
    const transaction = data.transaction?.transaction;
    const message = transaction?.transaction?.message;
    const logs = transaction?.meta?.logMessages;

    if (!transaction || !message || !logs) {
      return;
    }

    console.log("---handleData------------");
    const txn = TXN_FORMATTER.formTransactionFromJson(
      data.transaction,
      Date.now()
    );
    const parsedTxn = decodeRaydiumLaunchpad(txn);
    if (!parsedTxn) return;
    console.log(parsedTxn);

    const formatterRLTxn = rl_formatter(parsedTxn, txn);
    if (!formatterRLTxn) return;
  }
}

function createSubscribeRequest() {
  return {
    accounts: {},
    slots: {},
    transactions: {
      Raydium_Launchpad: {
        accountInclude: [],
        accountExclude: [],
        accountRequired: FILTER_CONFIG.requiredAccounts,
        instructionDiscriminators: FILTER_CONFIG.instructionDiscriminators,
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    commitment: COMMITMENT,
    accountsDataSlice: [],
    ping: undefined,
  };
}

function sendSubscribeRequest(stream, request) {
  return new Promise((resolve, reject) => {
    stream.write(request, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function decodeRaydiumLaunchpad(tx) {
  if (tx.meta?.err) return;

  try {
    const paredIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta.loadedAddresses
    );

    const raydiumLaunchpadIxs = paredIxs.filter(
      (ix) =>
        ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) ||
        ix.programId.equals(
          new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        )
    );

    const parsedInnerIxs =
      RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionWithInnerInstructions(tx);
    const raydium_launchpad_inner_ixs = parsedInnerIxs.filter(
      (ix) =>
        ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) ||
        ix.programId.equals(
          new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        )
    );

    const allInstructions = [
      ...raydiumLaunchpadIxs,
      ...raydium_launchpad_inner_ixs,
    ];

    if (allInstructions.length === 0) return;

    const decodeAndCleanUnknownFields = (instructions) => {
      return instructions
        .filter((ix) => ix.name !== "unknown")
        .map((ix) => {
          if (ix.args?.unknown) {
            const buffer = Buffer.from(ix.args.unknown, "base64");
            const schema = raydiumLaunchpadIdl.instructions.find(
              (instruction) => instruction.name === ix.name
            );

            if (!schema) {
              console.warn(`No schema found for instruction: ${ix.name}`);
            } else {
              console.log(`Schema for instruction ${ix.name}:`, schema);

              try {
                const someValue = buffer.readUInt32LE(0);
                console.log(`Manually decoded value: ${someValue}`);
                ix.args.decodedUnknown = { someValue };
              } catch (err) {
                console.error(`Failed to manually decode unknown field:`, err);
              }
            }

            delete ix.args.unknown;
          }

          if (ix.innerInstructions) {
            ix.innerInstructions = decodeAndCleanUnknownFields(
              ix.innerInstructions
            );
          }

          return ix;
        });
    };

    const cleanedInstructions =
      decodeAndCleanUnknownFields(raydiumLaunchpadIxs);
    const cleanedInnerInstructions = decodeAndCleanUnknownFields(
      raydium_launchpad_inner_ixs
    );

    const events = RAYDIUM_LAUNCHPAD_EVENT_PARSER.parseEvent(tx);

    const result =
      events.length > 0
        ? {
            instructions: cleanedInstructions,
            inner_ixs: cleanedInnerInstructions,
            events,
          }
        : {
            instructions: cleanedInstructions,
            inner_ixs: cleanedInnerInstructions,
          };

    bnLayoutFormatter(result);

    return result;
  } catch (err) {}
}

module.exports = RayLaunchMonitor;
