function encodeSwapInstruction(
  instructionDiscriminator,
  baseAmountOut,
  maxQuoteAmountIn
) {
  const buffer = Buffer.alloc(1 + 8 + 8); // 1字节方法标识 + 8字节u64 + 8字节u64

  // 写入方法标识符
  buffer.writeUInt8(instructionDiscriminator, 0);
  // buffer.writeUInt8(20, 1);

  // 以小端格式写入u64值
  buffer.writeBigUInt64LE(BigInt(maxQuoteAmountIn) - 2n, 1);
  buffer.writeBigUInt64LE(BigInt(parseInt(baseAmountOut * 0.835)), 9);

  return buffer.toString("hex");
}

const data1 = {
  baseAmountOut: 4839994708220,
  maxQuoteAmountIn: 1980000002,
};
const data2 = {
  baseAmountOut: 23662545239,
  maxQuoteAmountIn: "9900002",
};

console.log("0000670476000000003ca3cfd1ad030000");
console.log(
  encodeSwapInstruction(0, data1.baseAmountOut, data1.maxQuoteAmountIn)
);
console.log("00e00f9700000000000b7ecd7104000000");
console.log(
  encodeSwapInstruction(0, data2.baseAmountOut, data2.maxQuoteAmountIn)
);

function hexToU64LE(hex) {
  // 移除可能存在的 0x 前缀
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;

  // 确保长度为 16 字符（8 字节）
  const paddedHex = cleanHex.padStart(16, "0");

  // 转换为 Buffer 并读取为小端序 BigInt
  const buffer = Buffer.from(paddedHex, "hex");
  return buffer.readBigUInt64LE();
}

console.log("-------------------------");
console.log(hexToU64LE("0067047600000000"));
console.log(hexToU64LE("0267047600000000"));

console.log(hexToU64LE("e00f970000000000"));
console.log(hexToU64LE("e20f970000000000"));

console.log("-------------------------");
console.log(hexToU64LE("3ca3cfd1ad030000"));
console.log(hexToU64LE("a3913dddbd030000"));

console.log(hexToU64LE("0b7ecd7104000000"));
console.log(hexToU64LE("df6d516804000000"));
