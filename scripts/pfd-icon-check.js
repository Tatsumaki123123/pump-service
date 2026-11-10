"use strict";

/**
 * 图标解析自测（本地起一个 HTTP server 假扮 metadata 服务，不连外网）。
 * 用法：node scripts/pfd-icon-check.js
 */

const http = require("http");
const assert = require("assert");

const { IconResolver, fetchIconFromUri } = require("../app/libs/pfd/icon");

const updates = [];
// 模拟 Mongo 集合：updateMany 会把结果写回这些行，和线上「下次请求读到新值」一致
const docs = [];

function fakeApp() {
  return {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    model: {
      PfdToken: {
        updateMany: async (query, update) => {
          updates.push({ query, set: update.$set });
          let n = 0;
          for (const doc of docs) {
            if (doc.token !== query.token) continue;
            Object.assign(doc, update.$set);
            n += 1;
          }
          return { modifiedCount: n };
        },
      },
    },
  };
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/a.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "A", image: "https://cdn.test/a.png" }));
        return;
      }
      if (req.url === "/b.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "B" }));
        return;
      }
      res.writeHead(500);
      res.end("boom");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. 单条解析
  assert.strictEqual(await fetchIconFromUri(`${base}/a.json`), "https://cdn.test/a.png");
  assert.strictEqual(await fetchIconFromUri(`${base}/b.json`), "", "没有 image 字段应返回空");
  await assert.rejects(() => fetchIconFromUri(`${base}/missing.json`), /HTTP 500/);
  assert.strictEqual(await fetchIconFromUri("data:image/png;base64,xxx"), "", "非 http 直接跳过");
  console.log("✓ 单条解析：image 提取 / 无图 / 5xx / 非 http 都符合预期");

  // 2. 队列行为
  const resolver = new IconResolver(fakeApp(), { concurrency: 2, perCall: 3 });
  const rows = [
    { token: "mintA", uri: `${base}/a.json` },
    { token: "mintB", uri: `${base}/b.json` },
    { token: "mintD", uri: `${base}/missing.json` },
    { token: "mintC", uri: `${base}/a.json` },
    { token: "mintHas", uri: `${base}/a.json`, icon: "https://cdn.test/has.png" },
    { token: "mintRecent", uri: `${base}/a.json`, iconCheckedAt: new Date() },
  ];
  docs.push(...rows);

  const queued = resolver.enqueue(rows);
  assert.strictEqual(queued, 3, "perCall=3 时一轮只排 3 个");
  await new Promise((r) => setTimeout(r, 500));

  assert.strictEqual(updates.length, 3, "应写回 3 条");
  const byToken = new Map(updates.map((u) => [u.query.token, u.set]));
  assert.strictEqual(byToken.get("mintA").icon, "https://cdn.test/a.png");
  assert.strictEqual(byToken.get("mintB").icon, "", "没图的要写空串");
  assert.strictEqual(byToken.get("mintB").iconError, false, "metadata 里确实没图 = 不是错误");
  assert.strictEqual(byToken.get("mintD").iconError, true, "5xx 要标记为错误，1 小时后再试");
  assert.ok(byToken.get("mintB").iconCheckedAt instanceof Date, "失败也要记时间避免重试");
  console.log("✓ 队列：有图的写 URL，没图的写空串；网络失败与「确实没图」分开标记");

  // 3. 已有 icon / 近期解析过的不再排队（用打过点的 docs 再排一次）
  const before = updates.length;
  const again = resolver.enqueue(docs);
  assert.strictEqual(again, 1, "只剩 mintC 需要解析");
  await new Promise((r) => setTimeout(r, 300));
  const fresh = updates.slice(before);
  assert.deepStrictEqual(
    fresh.map((u) => u.query.token),
    ["mintC"],
    "已有图标 / 近期解析过的不应重复请求",
  );
  console.log("✓ 去重：已有图标、以及近期解析过的都不会重复请求");

  server.close();
  console.log("\n图标解析自测通过 ✅");
}

main().catch((error) => {
  console.error("\n图标解析自测失败 ❌");
  console.error(error);
  process.exit(1);
});
