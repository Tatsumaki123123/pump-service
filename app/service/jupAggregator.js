const { Service } = require("egg");
const {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  TransactionInstruction,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createInitializeAccountInstruction,
} = require("@solana/spl-token");

const bs58 = require("bs58");
const borsh = require("@coral-xyz/borsh");
const chalk = require("chalk");

const JUP_PROGRAM_V6 = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);

class JupAggregator extends Service {
  constructor(ctx) {
    super(ctx);

    this.subscriptionId = null;
  }

  async startMonitor() {
    const { ctx } = this;
    const addresses = ["8J5GUAf7hr3LTPHJSkwrKFDNJPtAXtLHhnNHq6XxTLrW"];
    try {
      const parseData = async (base64Data) => {
        const buffer = Buffer.from(base64Data, "base64");
        const discriminator = buffer.slice(0, 8);
        const buyDiscriminator = Buffer.from([
          103, 244, 82, 31, 44, 245, 119, 119,
        ]);
        const sellDiscriminator = Buffer.from([
          62, 47, 55, 10, 165, 3, 220, 42,
        ]);
        let type = "";
        if (discriminator.equals(buyDiscriminator)) {
          type = "buy";
        }
        if (discriminator.equals(sellDiscriminator)) {
          type = "sell";
        }
        const timestampSchema = borsh.u64();
        const timestamp = timestampSchema
          .decode(buffer.slice(8, 8 + 8))
          .toString();
        const offset1 = 120;
        const pool = buffer.slice(offset1, offset1 + 32);
        const offset2 = 152;
        const user = buffer.slice(offset2, offset2 + 32);
        const createdTime = parseInt(timestamp) * 1000;
        const userAddress = bs58.encode(user);
        const poolAddress = bs58.encode(pool);
        if (addresses.includes(userAddress)) {
          console.log(type, userAddress, poolAddress);
          console.log(new Date(createdTime));
          console.log(chalk.red(new Date().toString()));
        }
        return;
      };

      //   parseData(
      //     "Z/RSHyz1d3cvLlFoAAAAAGDotnSXAAAAAF7QsgAAAAAAAAAAAAAAAPuPdesqAAAALOsqcftRAACY9PLaXgAAAMYBg7AAAAAAFAAAAAAAAADAX1oAAAAAAAUAAAAAAAAA8JcWAAAAAACGYd2wAAAAAGaRCrEAAAAAI4XeQ9cX+asW3R2xVHIKrdhY9l2mQsPGpvlAgRGSOw50igiERM/OwQmwHxzP/+S8iH99oLBzT+P0TFGM+WmiwWBnThG69mxgKzgsnE/eL/ii2yf59kVQmy8NnydqPxqmlxpn8fIsm84U1Nz5mknYtkcfEfs5HVMkpcjl+EEcUR/Xqo+wYNgpG0xNR12v92LJa9wNrOs2wBLq0S7TqUhBYQHIIfOo8I/viNwxQkp2gK6MloFwTPHl9ciOJ5m3+YIhuUEt5aKtS+RMiB8bBMnKUzbmTUDlQGL897Z1gHYaETsFAAAAAAAAAPCXFgAAAAAA"
      //   );
      //   parseData(
      //     "Pi83CqUD3CrvKlFoAAAAANBI5GjjAQAAGIP1WgAAAADQSORo4wEAAAposrYrAAAAp8gfNWa/AADUHNHoJQAAAG6fz14AAAAAFAAAAAAAAAATizAAAAAAAAUAAAAAAAAAxSIMAAAAAABbFJ9eAAAAANHOhl4AAAAAWCOngP4Gv00Dt0wTp8Urzq+cPQErsL8ReHuqn3yXxvV0igiERM/OwQmwHxzP/+S8iH99oLBzT+P0TFGM+WmiwdoAnDUU8T23wpm7LrgOmkynIoAhGndV635XXBhkSrVTlxpn8fIsm84U1Nz5mknYtkcfEfs5HVMkpcjl+EEcUR/Xqo+wYNgpG0xNR12v92LJa9wNrOs2wBLq0S7TqUhBYQHIIfOo8I/viNwxQkp2gK6MloFwTPHl9ciOJ5m3+YIh4IGT3tZtkerXWkSSsPeFqXymloN5l407JgGuquq3llAFAAAAAAAAAMUiDAAAAAAA"
      //   );
      //   return;
      this.subscriptionId = connection.onLogs(
        JUP_PROGRAM_V6,
        async (log) => {
          try {
            const { logs } = log;
            const buyLog = logs.find(
              (item) =>
                item === "Program log: Instruction: Buy" ||
                item === "Program log: Instruction: Sell"
            );
            if (buyLog) {
              const logPrefix = "Program data: ";
              const dataLog = logs.find((item) => item.indexOf(logPrefix) > -1);
              if (dataLog) {
                const base64Data = dataLog.slice(logPrefix.length).trim();
                parseData(base64Data);
              }
            }
          } catch (error) {
            console.error("error", error);
          }
        },
        "processed"
      );

      console.log("pump monitor started");
    } catch (error) {}
  }

  async stopMonitorAMM() {
    if (this.subscriptionId !== null) {
      await this.connection.removeProgramAccountChangeListener(
        this.subscriptionId
      );
      this.subscriptionId = null;
      console.log("Believe monitor stopped");
    }
  }
}

module.exports = JupAggregator;
