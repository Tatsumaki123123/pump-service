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
    /compileToV0Message\(walletLookupTables\)/.test(buyBlock),
    "买入编译交易时没有带 lookup table",
  );
  assert.ok(
    /compileToV0Message\(walletLookupTables\)/.test(sellBlock),
    "卖出编译交易时没有带 lookup table",
  );
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
  assert.ok(/Number\(slippageBasisPoints\) \/ 10000/.test(src), "卖出没有换算滑点");
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
