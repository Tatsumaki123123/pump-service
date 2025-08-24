const { Buffer } = require("buffer");
const BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);

const int1 = 495000002;
const int2 = 104577564603;

const buffer = Buffer.alloc(17);

buffer.writeUInt32LE(0x8119c000, 0);
buffer.writeUInt8((int1 >>> 24) & 0xff, 4);

buffer.writeBigInt64LE(BigInt(int2), 8);
buffer.writeUInt8(0x00, 16);

const hexString = "00c019811d000000009a1b782f15000000";
console.log(hexString);
console.log(buffer.toString("hex"));
