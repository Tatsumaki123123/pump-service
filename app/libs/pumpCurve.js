"use strict";

/**
 * pump.fun 内盘曲线账户解析（新版序列化布局）。
 *
 * 为什么需要它：`app/libs/pumpfun/bondingCurveAccount.js` 是旧版 SDK，
 * 只解前 81 字节，而且把 offset 16 的字段叫 virtualSolReserves。
 * 现在这个字段实际是 virtual_quote_reserves，账户尾部还多了一个 quote_mint。
 *
 * 结果是：**非 SOL 计价的曲线**（例如用另一个 pump 币或稳定币做计价）
 * 会被旧 SDK 当成 SOL 曲线，普通 buy 指令发出去必然失败：
 *   AnchorError: Unsupported quote mint (6063)
 *
 * 新版布局（结构体 158 字节 + 8 字节 discriminator = 166）：
 *   +8    virtual_token_reserves        u64
 *   +16   virtual_quote_reserves        u64   原 virtual_sol_reserves
 *   +24   real_token_reserves           u64
 *   +32   real_quote_reserves           u64   原 real_sol_reserves
 *   +40   token_total_supply            u64
 *   +48   complete                      bool
 *   +49   creator                       pubkey(32)
 *   +81   is_mayhem_mode                bool
 *   +82   is_cashback_coin              bool
 *   +83   quote_mint                    pubkey(32)  SOL 曲线这里是全零
 *   +115  creator_fee_bps               u64
 *   ...
 * 更早的曲线在物理上更短（不是补零），所以必须做长度守卫。
 *
 * 参考：@pump-fun/pump-sdk 4.x 的 BondingCurve 定义。
 */

const { PublicKey } = require("@solana/web3.js");

const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
const CURVE_SEED = Buffer.from("bonding-curve");

const WSOL = "So11111111111111111111111111111111111111112";
// Token-2022 的原生 mint，pump 把它和 SOL 同等对待
const TOKEN_2022_NATIVE = "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP";
// 全零 pubkey：SOL 曲线的 quote_mint 就是它
const ZERO_PUBKEY = PublicKey.default.toBase58();

// 完整的结构体长度（含 discriminator），用于判断尾部字段是否存在
const CURVE_ACCOUNT_SIZE = 166;
// quote_mint 字段首尾偏移（含 8 字节 discriminator）
const QUOTE_MINT_OFFSET = 83;
const QUOTE_MINT_END = QUOTE_MINT_OFFSET + 32;

function curvePda(mint) {
  const mintKey = mint instanceof PublicKey ? mint : new PublicKey(mint);
  return PublicKey.findProgramAddressSync(
    [CURVE_SEED, mintKey.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
}

/** SOL 曲线：quote_mint 是全零，老账户干脆没有这个字段 */
function isSolQuote(quoteMint) {
  if (!quoteMint) return true;
  return (
    quoteMint === ZERO_PUBKEY ||
    quoteMint === WSOL ||
    quoteMint === TOKEN_2022_NATIVE
  );
}

/**
 * 解析曲线账户数据。
 * @param {Buffer|Uint8Array} data 账户原始数据
 * @returns {null|object} 长度不足返回 null
 */
function decodeCurve(data) {
  if (!data || data.length < 49) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const hasQuoteField = buf.length >= QUOTE_MINT_END;
  const quoteMint = hasQuoteField
    ? new PublicKey(buf.subarray(QUOTE_MINT_OFFSET, QUOTE_MINT_END)).toBase58()
    : "";

  return {
    // 账户版本：166 = 新布局，81 = 只有储备和 creator
    size: buf.length,
    layout: buf.length >= CURVE_ACCOUNT_SIZE ? "v2" : "legacy",
    virtualTokenReserves: buf.readBigUInt64LE(8),
    // 旧版 SDK 把它叫 virtualSolReserves；只有 SOL 曲线才是 lamports
    virtualQuoteReserves: buf.readBigUInt64LE(16),
    realTokenReserves: buf.readBigUInt64LE(24),
    realQuoteReserves: buf.readBigUInt64LE(32),
    tokenTotalSupply: buf.readBigUInt64LE(40),
    complete: buf[48] !== 0,
    creator: new PublicKey(buf.subarray(49, 81)).toBase58(),
    isMayhemMode: buf.length > 81 ? buf[81] !== 0 : false,
    isCashbackCoin: buf.length > 82 ? buf[82] !== 0 : false,
    quoteMint,
    isSolQuote: isSolQuote(quoteMint),
  };
}

// 同一个 token 在 checkToken 和买卖两侧都要判一次，加个短缓存省 RPC。
// key = mint，value = { at, promise }
const quoteCache = new Map();
const QUOTE_CACHE_TTL_MS = 5 * 60 * 1000;
const QUOTE_CACHE_MAX = 5000;

function pruneQuoteCache() {
  if (quoteCache.size <= QUOTE_CACHE_MAX) return;
  let drop = quoteCache.size - QUOTE_CACHE_MAX;
  for (const key of quoteCache.keys()) {
    quoteCache.delete(key);
    if (--drop <= 0) break;
  }
}

/**
 * 读链上曲线账户并解析出计价单位。查不到曲线返回 null（不抛错）。
 * @param {import("@solana/web3.js").Connection} connection
 * @param {string} mint
 * @param {object} [options]
 * @param {number} [options.ttlMs] 缓存时间，0 表示不缓存
 * @param {string} [options.commitment]
 */
async function getCurveQuote(connection, mint, options = {}) {
  const ttlMs = options.ttlMs === undefined ? QUOTE_CACHE_TTL_MS : Number(options.ttlMs);
  const cacheable = ttlMs > 0;
  const cached = quoteCache.get(mint);
  if (cacheable && cached && Date.now() - cached.at < ttlMs) {
    return cached.promise;
  }

  const promise = (async () => {
    const info = await connection.getAccountInfo(
      curvePda(mint),
      options.commitment || "confirmed",
    );
    if (!info || !info.data) return null;
    return decodeCurve(info.data);
  })();

  if (!cacheable) return promise;
  quoteCache.set(mint, { at: Date.now(), promise });
  pruneQuoteCache();
  // 失败的不缓存，避免一次 RPC 抖动把 token 钉死在错误判断上
  promise.catch(() => {
    const current = quoteCache.get(mint);
    if (current && current.promise === promise) quoteCache.delete(mint);
  });
  return promise;
}

function clearCurveQuoteCache(mint) {
  if (mint) quoteCache.delete(mint);
  else quoteCache.clear();
}

module.exports = {
  PUMP_PROGRAM_ID,
  WSOL,
  ZERO_PUBKEY,
  CURVE_ACCOUNT_SIZE,
  QUOTE_MINT_OFFSET,
  QUOTE_MINT_END,
  curvePda,
  isSolQuote,
  decodeCurve,
  getCurveQuote,
  clearCurveQuoteCache,
};
