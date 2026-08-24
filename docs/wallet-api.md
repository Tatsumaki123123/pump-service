# Wallet API

这三个接口用于查询 Axiom 交易钱包、获取执行钱包私钥，以及归集执行钱包中的 SOL。

另外提供批量查询 SOL 余额接口。

默认服务地址：

```text
http://localhost:8899
```

所有接口均使用 `POST`，请求头需要设置：

```http
Content-Type: application/json
```

## 0. 批量查询 SOL 余额

```http
POST /v1/execute/getWalletBalances
```

批量查询指定钱包地址的 SOL 余额。接口每 100 个地址使用一次 RPC 批量请求，超过 100 个地址会自动分批；重复地址只返回一次。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `wallets` | array | 是 | 钱包地址数组，也支持 `{ "address": "..." }` 对象数组 |

### 请求示例

```bash
curl -X POST http://localhost:8899/v1/execute/getWalletBalances \
  -H "Content-Type: application/json" \
  -d '{
    "wallets": [
      "钱包地址1",
      "钱包地址2"
    ]
  }'
```

### 返回示例

```json
{
  "code": 0,
  "data": {
    "total": 2,
    "totalBalanceLamports": 15000000,
    "totalBalance": 0.015,
    "totalSol": 0.015,
    "list": [
      {
        "address": "钱包地址1",
        "exists": true,
        "balanceLamports": 10000000,
        "balance": 0.01,
        "sol": 0.01
      },
      {
        "address": "钱包地址2",
        "exists": false,
        "balanceLamports": 0,
        "balance": 0,
        "sol": 0
      }
    ]
  }
}
```

## 1. 查询 Axiom 交易钱包

```http
POST /v1/execute/getAxiomWallets
```

查询 `ExecuteWallet` 表中的钱包，检查每个钱包最近 10 笔交易中是否有包含 Axiom program 的成功交易。接口不会继续分页查询更早的历史交易。

接口固定使用项目 `RPC_URL` 配置的 QuickNode RPC。每个钱包只查询最近 10 笔交易，RPC 请求默认限制为每秒 10 次，并允许多个请求并行返回；收到限流响应时会自动退避重试。可以通过环境变量调整：

```env
AXIOM_RPC_REQUESTS_PER_SECOND=10
AXIOM_WALLET_CONCURRENCY=10
AXIOM_RPC_RETRY_ATTEMPTS=5
```

QuickNode 的限制是每秒 50 次请求。如果 RPC 账号还有其他业务请求，建议保持 `AXIOM_RPC_REQUESTS_PER_SECOND=10` 或调低到 `5`。

Axiom program：

```text
FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `startTime` | string/number | 是 | 开始时间。支持 ISO 时间、Unix 秒时间戳或毫秒时间戳 |
| `endTime` | string/number | 是 | 结束时间。支持 ISO 时间、Unix 秒时间戳或毫秒时间戳 |
| `eid` | number | 否 | 只查询指定 `eid` 下的钱包 |

ISO 时间示例：

```text
2026-08-01T00:00:00+08:00
```

如果 `endTime` 只传日期，例如 `2026-08-24`，接口会按当天 `23:59:59.999 UTC` 处理。建议调用方明确传入带时区的完整 ISO 时间。

### 请求示例

```bash
curl -X POST http://localhost:8899/v1/execute/getAxiomWallets \
  -H "Content-Type: application/json" \
  -d '{
    "startTime": "2026-08-01T00:00:00+08:00",
    "endTime": "2026-08-24T23:59:59+08:00",
    "eid": 123
  }'
```

### 返回示例

```json
{
  "code": 0,
  "data": {
    "startTime": "2026-07-31T16:00:00.000Z",
    "endTime": "2026-08-24T15:59:59.000Z",
    "total": 1,
    "list": [
      {
        "address": "钱包地址",
        "eid": 123,
        "isActive": true,
        "tradeCount": 4,
        "firstTradeTime": "2026-08-02T03:12:00.000Z",
        "lastTradeTime": "2026-08-20T08:15:00.000Z",
        "lastSignature": "交易签名"
      }
    ]
  }
}
```

只有最近 10 笔交易中满足以下条件的交易会计入结果：

- 交易成功；
- 钱包地址是交易 signer；
- 顶层指令或内部指令调用了 Axiom program。

## 2. 获取钱包私钥

```http
POST /v1/execute/getWalletPrivateKey
```

根据地址查询 `ExecuteWallet` 表中的钱包私钥。地址必须已经存在于 `ExecuteWallet` 表中。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `address` | string | 是 | 执行钱包地址 |
| `key` | string | 是 | 访问密钥，默认值为 `basketball` |

访问密钥保存在 `AppData.key` 字段中。修改密钥示例：

```js
db.appdatas.updateOne(
  {},
  { $set: { key: "新的访问密钥" } }
)
```

### 请求示例

```bash
curl -X POST http://localhost:8899/v1/execute/getWalletPrivateKey \
  -H "Content-Type: application/json" \
  -d '{
    "address": "钱包地址",
    "key": "basketball"
  }'
```

### 返回示例

```json
{
  "code": 0,
  "data": {
    "address": "钱包地址",
    "privateKey": "Base58 编码的私钥"
  }
}
```

私钥接口属于高敏感接口。不要把响应写入日志、前端页面、聊天记录或公开监控系统；生产环境应立即将默认密钥修改为随机高强度密钥，并限制接口访问来源。

## 3. 归集钱包 SOL 余额

```http
POST /v1/execute/transferWalletBalance
```

把 `wallets` 中每个执行钱包的可用 SOL 余额转入 `AppData.receiveAddress` 配置的收款地址。接口会从 `ExecuteWallet` 表读取对应私钥，并按顺序逐个执行转账。

配置收款地址示例：

```js
db.appdatas.updateOne(
  {},
  { $set: { receiveAddress: "收款地址" } },
  { upsert: true }
)
```

接口会根据当前交易计算实际手续费，转账金额为：

```text
钱包当前余额 - 当前交易手续费
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `wallets` | array | 是 | 钱包地址数组，不能是空数组 |

`wallets` 支持两种格式：

```json
[
  "钱包地址1",
  "钱包地址2"
]
```

或：

```json
[
  { "address": "钱包地址1" },
  { "address": "钱包地址2" }
]
```

### 请求示例

```bash
curl -X POST http://localhost:8899/v1/execute/transferWalletBalance \
  -H "Content-Type: application/json" \
  -d '{
    "wallets": [
      "钱包地址1",
      "钱包地址2"
    ]
  }'
```

### 返回示例

```json
{
  "code": 0,
  "data": {
    "receiveAddress": "收款地址",
    "total": 2,
    "success": 1,
    "skipped": 1,
    "failed": 0,
    "list": [
      {
        "address": "钱包地址1",
        "status": "success",
        "balanceLamports": 10000000,
        "feeLamports": 5000,
        "transferLamports": 9995000,
        "signature": "交易签名"
      },
      {
        "address": "钱包地址2",
        "status": "skipped",
        "balanceLamports": 1000,
        "feeLamports": 5000,
        "transferLamports": 0,
        "message": "Balance is not enough to cover the transaction fee"
      }
    ]
  }
}
```

单个钱包状态说明：

| 状态 | 说明 |
| --- | --- |
| `success` | 转账成功，返回 `signature` |
| `skipped` | 余额不足以支付手续费，或源钱包就是收款地址 |
| `failed` | 读取私钥、RPC、发送或确认交易失败 |
| `not_found` | 地址不在 `ExecuteWallet` 表中 |

该接口会实际转移链上资产，调用前请确认 `AppData.receiveAddress` 和钱包数组无误。按当前接口设计，余额归集接口不额外校验 `key`。

## 错误返回

参数或业务校验失败时，接口通常返回：

```json
{
  "status": 200,
  "message": "Invalid key"
}
```

常见错误包括：

- `startTime is required` / `endTime is required`；
- `startTime is invalid` / `endTime is invalid`；
- `Invalid key`；
- `Wallet not found`；
- `AppData.receiveAddress is not configured`；
- `wallets must be a non-empty array`。
