const { Message, MessageV0, PublicKey } = require("@solana/web3.js");
const { utils } = require("@coral-xyz/anchor");

class TransactionFormatter {
  formTransactionFromJson(data, time) {
    const rawTx = data["transaction"];
    const slot = data.slot;
    const version = rawTx.transaction.message.versioned ? 0 : "legacy";
    const meta = this.formMeta(rawTx.meta);
    const signatures = rawTx.transaction.signatures.map((s) =>
      utils.bytes.bs58.encode(s)
    );
    const message = this.formTxnMessage(rawTx.transaction.message);

    return {
      slot,
      version,
      blockTime: time,
      meta,
      transaction: {
        signatures,
        message,
      },
    };
  }

  formTxnMessage(message) {
    if (!message.versioned) {
      return new Message({
        header: {
          numRequiredSignatures: message.header.numRequiredSignatures,
          numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
          numReadonlyUnsignedAccounts:
            message.header.numReadonlyUnsignedAccounts,
        },
        recentBlockhash: utils.bytes.bs58.encode(
          Buffer.from(message.recentBlockhash, "base64")
        ),
        accountKeys: message.accountKeys?.map((d) => Buffer.from(d, "base64")),
        instructions: message.instructions.map(
          ({ data, programIdIndex, accounts }) => ({
            programIdIndex: programIdIndex,
            accounts: Array.from(accounts),
            data: utils.bytes.bs58.encode(Buffer.from(data || "", "base64")),
          })
        ),
      });
    } else {
      return new MessageV0({
        header: {
          numRequiredSignatures: message.header.numRequiredSignatures,
          numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
          numReadonlyUnsignedAccounts:
            message.header.numReadonlyUnsignedAccounts,
        },
        recentBlockhash: utils.bytes.bs58.encode(
          Buffer.from(message.recentBlockhash, "base64")
        ),
        staticAccountKeys: message.accountKeys.map(
          (k) => new PublicKey(Buffer.from(k, "base64"))
        ),
        compiledInstructions: message.instructions.map(
          ({ programIdIndex, accounts, data }) => ({
            programIdIndex: programIdIndex,
            accountKeyIndexes: Array.from(accounts),
            data: Uint8Array.from(Buffer.from(data || "", "base64")),
          })
        ),
        addressTableLookups:
          message.addressTableLookups?.map(
            ({ accountKey, writableIndexes, readonlyIndexes }) => ({
              writableIndexes: writableIndexes || [],
              readonlyIndexes: readonlyIndexes || [],
              accountKey: new PublicKey(Buffer.from(accountKey, "base64")),
            })
          ) || [],
      });
    }
  }

  formMeta(meta) {
    return {
      err: meta.errorInfo ? { err: meta.errorInfo } : null,
      fee: meta.fee,
      preBalances: meta.preBalances,
      postBalances: meta.postBalances,
      preTokenBalances: meta.preTokenBalances || [],
      postTokenBalances: meta.postTokenBalances || [],
      logMessages: meta.logMessages || [],
      loadedAddresses:
        meta.loadedWritableAddresses || meta.loadedReadonlyAddresses
          ? {
              writable:
                meta.loadedWritableAddresses?.map((address) => address) || [],
              readonly:
                meta.loadedReadonlyAddresses?.map((address) => address) || [],
            }
          : undefined,
      innerInstructions:
        meta.innerInstructions?.map((i) => ({
          index: i.index || 0,
          instructions: i.instructions.map((instruction) => ({
            programIdIndex: instruction.programIdIndex,
            accounts: Array.from(instruction.accounts),
            data: utils.bytes.bs58.encode(
              Buffer.from(instruction.data || "", "base64")
            ),
          })),
        })) || [],
    };
  }
}

module.exports = { TransactionFormatter };
