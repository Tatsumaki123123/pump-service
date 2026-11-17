"use strict";

/**
 * 「内盘非 WSOL 池子默认走 Jupiter」自检。
 *
 * 不联网、不签名、不花钱，只验证三件容易回归的事：
 *  1. pool.js 导出了按计价单位列池子的能力（没有 WSOL 池时不再直接抛错）；
 *  2. checkToken 对内盘/外盘的非 WSOL 池都会落 useJup 标记；
 *  3. pumpfun 内盘的买卖两侧都接住了 useJup，且滑点从 bps 正确转成 Jupiter 要的 0~1 小数。
 *
 * 用法：node scripts/pumpfun-jup-route-check.js
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { PublicKey } = require("@solana/web3.js");
const { NATIVE_MINT } = require("@solana/spl-token");

const JupSDK = require("../app/libs/jup");
const pool = require("../app/libs/pool");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const JUP_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ROUTE_DISCRIMINATOR = Buffer.from([187, 100, 250, 204, 49, 196, 175, 20]);
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------------------------------------------------------------- 静态接线

check("pool.js 导出 getPumpPoolsWithQuoteInfo", () => {
  assert.strictEqual(typeof pool.getPumpPoolsWithQuoteInfo, "function");
});

check("ExecuteToken 有 useJup / quoteMint 字段", () => {
  const model = read("app/model/executeToken.js");
  assert.ok(/useJup:\s*\{\s*type:\s*Boolean/.test(model), "缺少 useJup 字段");
  assert.ok(/quoteMint:\s*\{\s*type:\s*String/.test(model), "缺少 quoteMint 字段");
});

check("checkToken 内外盘都会落 useJup 路由", () => {
  const src = read("app/service/executeSwap.js");
  assert.ok(
    /amm === PUMP_FUN_NAME\)\s*\{[\s\S]*?useJup: true/.test(src),
    "内盘分支没有打 useJup 标记",
  );
  assert.ok(
    /amm === PUMP_AMM_NAME && pool\)[\s\S]*?useJup: true/.test(src),
    "外盘分支没有打 useJup 标记",
  );
  // 落库字段必须一起写，否则 pumpfun 侧读不到
  assert.ok(/useJup:\s*Boolean\(routeInfo && routeInfo\.useJup\)/.test(src));
});

check("pumpfun 买卖两侧都读取 useJup 并接 Jupiter", () => {
  const src = read("app/service/pumpfun.js");
  const buyBlock = src.slice(src.indexOf("async batchBuyToken"), src.indexOf("async batchSellToken"));
  const sellBlock = src.slice(src.indexOf("async batchSellToken"));
  assert.ok(buyBlock.includes("getJupRouteInfo"), "买入没有读取路由标记");
  assert.ok(buyBlock.includes("jupSwap.getBuyInstructions"), "买入没有走 Jupiter");
  assert.ok(sellBlock.includes("getJupRouteInfo"), "卖出没有读取路由标记");
  assert.ok(sellBlock.includes("jupSwap.getSellInstructions"), "卖出没有走 Jupiter");
  // Jupiter 返回的 lookup table 必须真的用上，否则大路由编译会超限
  assert.ok(
    /lookupTables: walletLookupTables/.test(buyBlock),
    "买入编译交易时没有带 lookup table",
  );
  assert.ok(
    /lookupTables: walletLookupTables/.test(sellBlock),
    "卖出编译交易时没有带 lookup table",
  );
  // 体积兜底必须挂在两侧
  assert.ok(/compileTxWithSizeFallback/.test(buyBlock), "买入没有体积兜底");
  assert.ok(/compileTxWithSizeFallback/.test(sellBlock), "卖出没有体积兜底");
});

// ---------------------------------------------------------------- 行为校验

function makeCtx(calls) {
  return {
    curl: async (uri, options) => {
      calls.push({ uri: String(uri), options });
      const url = String(uri);
      if (url.includes("/swap/v1/quote")) {
        return {
          status: 200,
          data: JSON.stringify({
            inputMint: NATIVE_MINT.toBase58(),
            outputMint: USDC,
            inAmount: "1",
            outAmount: "1",
            routePlan: [],
          }),
        };
      }
      if (url.includes("/swap/v1/swap-instructions")) {
        return {
          status: 200,
          data: JSON.stringify({
            tokenLedgerInstruction: null,
            computeBudgetInstructions: [],
            setupInstructions: [],
            otherInstructions: [],
            swapInstruction: {
              programId: JUP_PROGRAM,
              accounts: [
                {
                  pubkey: NATIVE_MINT.toBase58(),
                  isSigner: false,
                  isWritable: false,
                },
              ],
              data: ROUTE_DISCRIMINATOR.toString("base64"),
            },
            cleanupInstruction: null,
            addressLookupTableAddresses: [],
          }),
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };
}

check("Jupiter 买入：SOL 金额与滑点单位正确", async () => {
  const calls = [];
  const sdk = new JupSDK();
  const user = new PublicKey(NATIVE_MINT);
  const tokenMint = new PublicKey(USDC);

  const result = await sdk.getBuyInstructions(makeCtx(calls), {
    user,
    tokenMint,
    buyAmount: 0.5, // SOL
    slippage: 0.25, // 0~1 小数，对应 2500 bps
    connection: null,
  });

  const quoteCall = calls.find((item) => item.uri.includes("/swap/v1/quote"));
  assert.ok(quoteCall, "没有请求 quote");
  const quoteUrl = new URL(quoteCall.uri);
  assert.strictEqual(quoteUrl.searchParams.get("inputMint"), NATIVE_MINT.toBase58());
  assert.strictEqual(quoteUrl.searchParams.get("outputMint"), USDC);
  assert.strictEqual(quoteUrl.searchParams.get("amount"), "500000000");
  assert.strictEqual(quoteUrl.searchParams.get("slippageBps"), "2500");

  assert.strictEqual(result.instructions.length, 1);
  assert.strictEqual(result.instructions[0].programId.toBase58(), JUP_PROGRAM);
  assert.deepStrictEqual(result.lookupTableAccounts, []);
});

check("pumpfun 滑点 bps -> 小数转换", () => {
  const src = read("app/service/pumpfun.js");
  // 内盘统一用 bps，Jupiter 要小数，必须显式除 10000
  assert.ok(
    /function getWalletSlippageFraction\(wallet\) \{\s*return Number\(getWalletSlippageBasisPoints\(wallet\)\) \/ 10000;/.test(
      src,
    ),
  );
  // 买卖两侧都必须用这个转换，不能把 bps 直接丢给 Jupiter
  const jupCalls = src.match(/slippage: getWalletSlippageFraction\(wallet\)/g) || [];
  assert.ok(jupCalls.length >= 2, `买卖两侧应各有一处换算，实际 ${jupCalls.length}`);
  assert.ok(
    !/slippage: Number\(slippageBasisPoints\) \/ 10000,\s*connection,\s*excludeDexes/.test(
      src,
    ),
    "有一侧还在手工换算，容易漏",
  );
});

check("非 WSOL 时不加载曲线账户，避免无曲线 token 直接抛错", () => {
  const src = read("app/service/pumpfun.js");
  assert.ok(
    /const allAxiomWallets =\s*!jupRoute\.useJup && wallets\.every\(\(wallet\) => wallet\.isAxiom\);/.test(
      src,
    ),
    "走 Jupiter 时仍在预计算 Axiom 曲线",
  );
});

// ---------------------------------------------------------------- 曲线 quote 解码

const {
  decodeCurve,
  ZERO_PUBKEY,
  WSOL: WSOL_MINT,
  QUOTE_MINT_OFFSET,
  QUOTE_MINT_END,
} = require("../app/libs/pumpCurve");

const EXOTIC_QUOTE = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb";
const SAMPLE_MINT = "DrJPPRpJJopB8zG4fM7wUWYFmUJxjV4hdKHTzDQNpump";

function makeCurveBuffer(quoteMint, size = 166) {
  const buf = Buffer.alloc(size);
  buf.writeBigUInt64LE(1039945747935021n, 8); // virtualTokenReserves
  buf.writeBigUInt64LE(24460093n, 16); // virtualQuoteReserves
  buf.writeBigUInt64LE(760045747935021n, 24); // realTokenReserves
  buf.writeBigUInt64LE(754794n, 32); // realQuoteReserves
  buf.writeBigUInt64LE(1000000000000000n, 40); // tokenTotalSupply
  buf[48] = 0; // complete
  if (size >= 81) new PublicKey(SAMPLE_MINT).toBuffer().copy(buf, 49);
  if (size >= QUOTE_MINT_END) new PublicKey(quoteMint).toBuffer().copy(buf, QUOTE_MINT_OFFSET);
  return buf;
}

check("曲线 quote_mint 解码：非 SOL 计价（6063 那种币）", () => {
  const q = decodeCurve(makeCurveBuffer(EXOTIC_QUOTE));
  assert.strictEqual(q.layout, "v2");
  assert.strictEqual(q.isSolQuote, false);
  assert.strictEqual(q.quoteMint, EXOTIC_QUOTE);
  assert.strictEqual(q.virtualQuoteReserves, 24460093n);
  assert.strictEqual(q.creator, SAMPLE_MINT);
});

check("曲线 quote_mint 解码：全零与 WSOL 都算 SOL 曲线", () => {
  assert.strictEqual(decodeCurve(makeCurveBuffer(ZERO_PUBKEY)).isSolQuote, true);
  assert.strictEqual(decodeCurve(makeCurveBuffer(WSOL_MINT)).isSolQuote, true);
});

check("老布局（81 字节）曲线不越界且视为 SOL", () => {
  const q = decodeCurve(makeCurveBuffer(ZERO_PUBKEY, 81));
  assert.strictEqual(q.layout, "legacy");
  assert.strictEqual(q.size, 81);
  assert.strictEqual(q.isSolQuote, true);
  assert.strictEqual(q.quoteMint, "");
});

check("checkToken 内盘以曲线 quote_mint 为权威判据", () => {
  const src = read("app/service/executeSwap.js");
  assert.ok(
    /getCurveQuote\(connection, token\)/.test(src),
    "checkToken 内盘没有读曲线 quote_mint",
  );
  assert.ok(/curveQuote && !curveQuote\.isSolQuote/.test(src));
});

check("pumpfun 兜底：DB 没有标记时读曲线再判一次", () => {
  const src = read("app/service/pumpfun.js");
  const block = src.slice(
    src.indexOf("async getJupRouteInfo"),
    src.indexOf("async batchBuyToken"),
  );
  assert.ok(block.includes("getCurveQuote"), "getJupRouteInfo 没有兜底读曲线");
  assert.ok(
    block.includes("useJup: true"),
    "兜底命中后没有回填 useJup",
  );
});

// ---------------------------------------------------------------- 重复指令去重

const {
  TransactionInstruction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const { dedupeIdempotentInstructions } = require("../app/libs/txInstructions");

const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function makeIx(programId, data, writable = true) {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: NATIVE_MINT, isSigner: false, isWritable: writable }],
    data,
  });
}

check("去重：重复的 setComputeUnitLimit 被去掉", () => {
  const limit = makeIx(ComputeBudgetProgram.programId, Buffer.from([2, 0, 64, 66, 15, 0]));
  const swap = makeIx(new PublicKey(JUP_PROGRAM), Buffer.from([1, 2, 3]));
  const result = dedupeIdempotentInstructions([limit, limit, swap]);
  assert.strictEqual(result.removed, 1);
  assert.strictEqual(result.instructions.length, 2);
  assert.strictEqual(result.instructions[1], swap);
});

check("去重：重复的幂等 ATA 创建被去掉（Jupiter 多跳的典型场景）", () => {
  const createAta = makeIx(ATA_PROGRAM, Buffer.from([1]));
  const swap = makeIx(new PublicKey(JUP_PROGRAM), Buffer.from([1, 2, 3]));
  const result = dedupeIdempotentInstructions([createAta, swap, createAta]);
  assert.strictEqual(result.removed, 1);
  assert.deepStrictEqual(
    result.instructions.map((ix) => ix.programId.toBase58()),
    [ATA_PROGRAM.toBase58(), JUP_PROGRAM],
  );
});

check("去重：数值不同的 compute budget 指令都保留", () => {
  const a = makeIx(ComputeBudgetProgram.programId, Buffer.from([2, 0, 64, 66, 15, 0]));
  const b = makeIx(ComputeBudgetProgram.programId, Buffer.from([2, 0, 200, 0, 0, 0]));
  const result = dedupeIdempotentInstructions([a, b]);
  assert.strictEqual(result.removed, 0);
  assert.strictEqual(result.instructions.length, 2);
});

check("去重：重复的非幂等指令同样去掉（运行时本来就不允许）", () => {
  const transfer = makeIx(
    new PublicKey("11111111111111111111111111111111"),
    Buffer.from([2, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0]),
  );
  const result = dedupeIdempotentInstructions([transfer, transfer]);
  assert.strictEqual(result.removed, 1);
  assert.strictEqual(result.unexpected, 1);
  assert.strictEqual(result.instructions.length, 1);
});

check("jup 分支不再自己追加 ComputeUnitLimit，且编译前统一去重", () => {
  const src = read("app/service/pumpfun.js");
  const buyBlock = src.slice(
    src.indexOf("async batchBuyToken"),
    src.indexOf("async batchSellToken"),
  );
  assert.ok(
    !/jupData\.instructions[\s\S]{0,40}setComputeUnitLimit/.test(buyBlock),
    "jup 买入仍在追加 SetComputeUnitLimit",
  );
  assert.ok(/dedupeIxs\(volumeIxs, `buy \$\{token\}`\)/.test(buyBlock), "买入没有去重");
  assert.ok(
    /dedupeIxs\(volumeIxs, `sell \$\{token\}`\)/.test(src),
    "卖出没有去重",
  );
});

// ---------------------------------------------------------------- 交易体积兜底

const {
  compileWithSizeFallback,
  MAX_TRANSACTION_BYTES,
} = require("../app/libs/txInstructions");
const { SystemProgram } = require("@solana/web3.js");
const BLOCKHASH = ZERO_PUBKEY;

function sizeOf(instructions, maxBytes = 100000) {
  return compileWithSizeFallback({
    payerKey: NATIVE_MINT,
    recentBlockhash: BLOCKHASH,
    instructions,
    maxBytes,
  }).size;
}

check("编译兜底：小交易原样通过，不动指令", () => {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    makeIx(new PublicKey(JUP_PROGRAM), Buffer.from([9, 9, 9])),
  ];
  const result = compileWithSizeFallback({
    payerKey: NATIVE_MINT,
    recentBlockhash: BLOCKHASH,
    instructions,
  });
  assert.strictEqual(result.dropped.length, 0);
  assert.strictEqual(result.tipDropped, false);
  assert.ok(result.size <= MAX_TRANSACTION_BYTES);
});

check("编译兜底：超限先去掉自己加的 compute budget", () => {
  const cb = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
  const tip = makeIx(SystemProgram.programId, Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]));
  const swap = makeIx(new PublicKey(JUP_PROGRAM), Buffer.from([9, 9, 9]));
  const base = sizeOf([cb, tip, swap]);

  const result = compileWithSizeFallback({
    payerKey: NATIVE_MINT,
    recentBlockhash: BLOCKHASH,
    instructions: [cb, tip, swap],
    tipInstruction: tip,
    maxBytes: base - 1,
  });
  assert.ok(result.size <= base - 1, `仍然超限: ${result.size}`);
  assert.ok(result.dropped.includes("computeBudget"), "没有优先砍 compute budget");
  assert.strictEqual(result.tipDropped, false);
});

check("编译兜底：还超就把 tip 摘出来交给调用方单独发", () => {
  const cb = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
  const tip = makeIx(SystemProgram.programId, Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]));
  const swap = makeIx(new PublicKey(JUP_PROGRAM), Buffer.from([9, 9, 9]));
  const base = sizeOf([cb, tip, swap]);

  const result = compileWithSizeFallback({
    payerKey: NATIVE_MINT,
    recentBlockhash: BLOCKHASH,
    instructions: [cb, tip, swap],
    tipInstruction: tip,
    maxBytes: base - 60,
  });
  assert.ok(result.tipDropped, "没有把 tip 摘出来");
  assert.ok(result.size <= base - 60);
});

check("编译兜底：怎么都装不下就抛错并带上体积明细", () => {
  const swap = makeIx(new PublicKey(JUP_PROGRAM), Buffer.from([9, 9, 9]));
  assert.throws(
    () =>
      compileWithSizeFallback({
        payerKey: NATIVE_MINT,
        recentBlockhash: BLOCKHASH,
        instructions: [swap],
        maxBytes: 40,
      }),
    /Transaction too large/,
  );
});

// ---------------------------------------------------------------- vote 账户定位

const { findVoteAccounts, VOTE_PROGRAM_ID } = require("../app/libs/txInstructions");
const { TransactionMessage, VersionedTransaction } = require("@solana/web3.js");

check("vote 账户定位：认出交易里被带上的 vote 账户", async () => {
  // 暗池拿 vote 账户当反 bundle 标记，路由命中就会进到我们的交易里
  const voteAccount = new PublicKey(
    "J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv",
  );
  const swapIx = new TransactionInstruction({
    programId: new PublicKey(JUP_PROGRAM),
    keys: [{ pubkey: voteAccount, isSigner: false, isWritable: true }],
    data: Buffer.from([1, 2, 3]),
  });
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: NATIVE_MINT,
      recentBlockhash: BLOCKHASH,
      instructions: [swapIx],
    }).compileToV0Message(),
  );

  const fakeConnection = {
    getMultipleAccountsInfo: async (keys) =>
      keys.map((key) => ({
        owner:
          key.toBase58() === voteAccount.toBase58()
            ? new PublicKey(VOTE_PROGRAM_ID)
            : SystemProgram.programId,
      })),
    getAddressLookupTable: async () => ({ value: null }),
  };

  const found = await findVoteAccounts(fakeConnection, [tx]);
  assert.deepStrictEqual(found, [voteAccount.toBase58()]);
});

check("vote 账户定位：没有 vote 账户时返回空数组", async () => {
  const swap = makeIx(new PublicKey(JUP_PROGRAM), Buffer.from([9, 9, 9]));
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: NATIVE_MINT,
      recentBlockhash: BLOCKHASH,
      instructions: [swap],
    }).compileToV0Message(),
  );
  const fakeConnection = {
    getMultipleAccountsInfo: async (keys) =>
      keys.map(() => ({ owner: SystemProgram.programId })),
    getAddressLookupTable: async () => ({ value: null }),
  };
  const found = await findVoteAccounts(fakeConnection, [tx]);
  assert.deepStrictEqual(found, []);
});

check("bundle 因 vote 账户被拒时会降级逐笔发送", () => {
  const src = read("app/service/pumpfun.js");
  const buyBlock = src.slice(
    src.indexOf("async batchBuyToken"),
    src.indexOf("async batchSellToken"),
  );
  assert.ok(/vote account/i.test(buyBlock), "买入没有识别 vote 账户报错");
  assert.ok(buyBlock.includes("findVoteAccounts"), "买入没有定位 vote 账户");
  assert.ok(buyBlock.includes("no bundle"), "买入没有降级发送");
  assert.ok(/vote account/i.test(src.slice(src.indexOf("async batchSellToken"))));
});

// ---------------------------------------------------------------- 排除标记池后重建

check("jup 支持按调用覆盖 excludeDexes 并回传路由标签", () => {
  const src = read("app/libs/jup.js");
  assert.ok(/excludeDexes:\s*excludeDexes/.test(src) || /const excludeDexes =/.test(src));
  assert.ok(/async getQuote\(ctx, input, output, amount, slippage, options = \{\}\)/.test(src));
  assert.ok(/return \{ \.\.\.result, routeLabels: routeLabelsOf\(quoteResponse\) \}/.test(src));
});

check("命中 vote 标记时先尝试排除暗池重建", () => {
  const src = read("app/service/pumpfun.js");
  assert.ok(
    /async rebuildJupWithoutVoteMarkers\(/.test(src),
    "没有排除重建逻辑",
  );
  assert.ok(
    /!\/\^pump\/i\.test\(label\)/.test(src),
    "排除时应保留 Pump.fun 这一跳",
  );
  assert.ok(
    /attempt < 3; attempt \+= 1/.test(src),
    "重建没有收敛上限，可能反复报价",
  );
  assert.ok(src.includes("已无可排除的 DEX"), "排不出结果时没有明确结论");
  // 买卖都通过 prepareJupInstructions 走同一套探测 + 重建
  const prepareBlock = src.slice(
    src.indexOf("async prepareJupInstructions"),
    src.indexOf("async rebuildJupWithoutVoteMarkers"),
  );
  assert.ok(
    prepareBlock.includes("this.rebuildJupWithoutVoteMarkers"),
    "prepareJupInstructions 没有接排除重建",
  );
  assert.ok(prepareBlock.includes("[jup] ${label} route"), "没有打印路由标签");
  const callSites = src.match(/prepareJupInstructions\(ctx, \{/g) || [];
  assert.ok(callSites.length >= 2, `买卖两侧应都调用，实际 ${callSites.length}`);
});

check("PUMP_REQUIRE_BUNDLE 可禁止降级逐笔发送", () => {
  const src = read("app/service/pumpfun.js");
  assert.ok(/PUMP_REQUIRE_BUNDLE/.test(src), "没有 REQUIRED_BUNDLE 开关");
  assert.ok(
    /PUMP_REQUIRE_BUNDLE=true 时不允许降级逐笔发送/.test(src),
    "开关没有拦截降级",
  );
});

check("缓存只复用排除项，不能跳过探测", () => {
  const src = read("app/service/pumpfun.js");
  const buyBlock = src.slice(
    src.indexOf("async batchBuyToken"),
    src.indexOf("async batchSellToken"),
  );
  // 曾经的 bug：缓存命中就跳过探针，结果拿到一条带标记的新路由直接发出去
  assert.ok(
    !/if \(cachedExclude === undefined\)/.test(buyBlock),
    "缓存命中时又跳过了探测",
  );
  assert.ok(
    /每笔都要探测/.test(src),
    "没有说明为什么每笔都要探测",
  );
  // 缓存里的排除项把路由排没了要能退回默认路由
  assert.ok(
    /用缓存排除 \$\{cachedExclude\} 取价失败/.test(src),
    "缓存排除导致无路由时没有回退",
  );
});





// ---------------------------------------------------------------- 执行

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}\n       ${error.message}`);
    }
  }
  console.log(
    failed === 0
      ? `\n全部通过 (${checks.length} 项)`
      : `\n${failed}/${checks.length} 项失败`,
  );
  process.exit(failed === 0 ? 0 : 1);
})();
