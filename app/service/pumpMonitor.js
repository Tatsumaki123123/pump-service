const { Service } = require("egg");

const bs58 = require("bs58");

const { connection } = require("../constants/index");

class PumpMonitor extends Service {
  constructor(ctx) {
    super(ctx);

    this.subscriptionId = null;
  }

  async startMonitor() {
    const { ctx } = this;
    const addresses = ["56S29mZ3wqvw8hATuUUFqKhGcSGYFASRRFNT38W8q7G3"];
    try {
      const parseData = async (base64Data) => {
        const buffer = Buffer.from(base64Data, "base64");
        const discriminator = buffer.slice(0, 8);
        const expectedDiscriminator = Buffer.from([
          103, 244, 82, 31, 44, 245, 119, 119,
        ]);
        if (!discriminator.equals(expectedDiscriminator)) {
          // throw new Error("Invalid discriminator");
          return;
        }
        let offset = 0;
        for (let index = 0; index < 24; index++) {
          offset += 8;
          const user = buffer.slice(offset, offset + 32);
          console.log(offset, bs58.encode(user));
        }

        return;
        const offset1 = 120;
        const pool = buffer.slice(offset1, offset1 + 32);
        const offset2 = 152;
        const user = buffer.slice(offset2, offset2 + 32);

        // 转换为 base58 格式
        const userAddress = bs58.encode(user);
        const poolAddress = bs58.encode(pool);
      };

      parseData(
        "Z/RSHyz1d3d9JlFoAAAAAFqpe0WcAQAAf9lVQgAAAAAAAAAAAAAAAGibo2stAAAAuP8Wg1SkAACa3YvpGQAAAP7ypkEAAAAAFAAAAAAAAAApnSEAAAAAAAUAAAAAAAAAS2cIAAAAAAAnkMhBAAAAAL1e2UEAAAAAktadZZkmJTVuQHQDmaXiwRacArgo+8ZctOWEeUzLLuh0igiERM/OwQmwHxzP/+S8iH99oLBzT+P0TFGM+Wmiwb6zerkWZGsQszQjzQh7D/YYq2UcTx6oerO1qbfmzV8Blxpn8fIsm84U1Nz5mknYtkcfEfs5HVMkpcjl+EEcUR/Xqo+wYNgpG0xNR12v92LJa9wNrOs2wBLq0S7TqUhBYQHIIfOo8I/viNwxQkp2gK6MloFwTPHl9ciOJ5m3+YIhLI2SDBb3ikG9W1AJtzp/w/a+50Cf2JNPYxLAHpoStngFAAAAAAAAAEtnCAAAAAAA"
      );
      return;
      this.subscriptionId = this.connection.onLogs(
        AMM_PROGRAM_ID,
        async (log) => {
          try {
            const { logs } = log;
            const buyLog = logs.find(
              (item) => item === "Program log: Instruction: Buy"
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
            console.error("believe error", error);
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

module.exports = PumpMonitor;
