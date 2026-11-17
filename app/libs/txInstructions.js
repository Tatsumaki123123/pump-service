"use strict";

/**
 * 交易指令拼装的小工具。
 *
 * 起因：Jupiter 的 /swap-instructions 会把中间币的 createIdempotent ATA 同时放进
 * setupInstructions 和 otherInstructions（多跳路由很常见），两条一模一样的指令
 * 拼进同一笔交易，运行时会直接判非法：
 *   invalid transaction: Transaction contains a duplicate instruction (1) that is not allowed
 * 而且这个错误在 simulateTransaction 阶段就出现，交易根本发不出去。
 */

const { ComputeBudgetProgram } = require("@solana/web3.js");

const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// 只对「重复执行没有副作用」的程序去重。
// compute budget 是覆盖式的，ATA createIdempotent 本身幂等，删重复不会改语义。
const DEDUPE_SAFE_PROGRAM_IDS = new Set([
  ComputeBudgetProgram.programId.toBase58(),
  ATA_PROGRAM_ID,
]);

function instructionKey(instruction) {
  return [
    instruction.programId.toBase58(),
    instruction.keys
      .map(
        (key) =>
          `${key.pubkey.toBase58()}:${key.isSigner ? 1 : 0}:${
            key.isWritable ? 1 : 0
          }`,
      )
      .join(","),
    instruction.data.toString("base64"),
  ].join("|");
}

/**
 * 去掉完全重复的指令。
 *
 * 为什么可以一律删：Solana 的交易清洗规则本身就不允许同一笔交易里出现两条
 * 完全相同的指令（程序 + 账户 + data 全等），遇到会直接报
 *   invalid transaction: Transaction contains a duplicate instruction (N)
 * 也就是说「保留重复」必然失败，删掉反而是唯一能发出去的版本。
 *
 * 仍然把重复分成两类记日志：
 *  - 幂等类（compute budget / ATA createIdempotent）：正常，静默处理
 *  - 其它程序：说明 Jupiter 给了意外的重复，值得看一眼
 *
 * @param {import("@solana/web3.js").TransactionInstruction[]} instructions
 * @param {(message: string) => void} [log] 日志回调
 * @param {string} [label] 日志前缀，便于定位是哪一笔
 * @returns {{instructions: import("@solana/web3.js").TransactionInstruction[], removed: number, unexpected: number}}
 */
function dedupeIdempotentInstructions(instructions, log, label = "") {
  const seen = new Set();
  const out = [];
  let removed = 0;
  let unexpected = 0;

  for (const instruction of instructions) {
    const programId = instruction.programId.toBase58();
    const key = instructionKey(instruction);

    if (seen.has(key)) {
      removed += 1;
      if (!DEDUPE_SAFE_PROGRAM_IDS.has(programId)) {
        unexpected += 1;
        if (log) {
          log(
            `[dedupe] ${label} 去掉重复的非幂等指令（程序 ${programId}），这条交易本来也发不出去`,
          );
        }
      }
      continue;
    }

    seen.add(key);
    out.push(instruction);
  }

  if (removed > 0 && log) {
    log(
      `[dedupe] ${label} 去掉 ${removed} 条重复指令（${instructions.length} -> ${out.length}）`,
    );
  }

  return { instructions: out, removed, unexpected };
}

module.exports = {
  ATA_PROGRAM_ID,
  DEDUPE_SAFE_PROGRAM_IDS,
  instructionKey,
  dedupeIdempotentInstructions,
};
