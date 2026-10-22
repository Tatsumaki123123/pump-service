# Fomo 钱包与卖出接口

服务地址默认 `http://localhost:8899`。接口均为 `POST`，请求头为 `Content-Type: application/json`，成功响应格式为 `{ "code": 0, "data": ... }`。除获取代币余额外，接口都需要 `lineId`；导入、修改和删除接口还需要 `key`，查询钱包信息与兑换接口不需要。`lineId` 对应 `ExecuteLine.lineId`，必须是已存在的正整数线路编号；`key` 为 `AppData.key` 中的钱包访问密钥，与导出私钥接口使用同一密码。导入接口会将 Base58 私钥存入独立的 `FomoWallet` 集合，响应不会返回私钥。

## 导入钱包

`POST /v1/execute/fomo/importWallet`

```json
{
  "lineId": 1,
  "privateKey": "Base58 编码的 Solana 钱包私钥",
  "key": "钱包访问密钥"
}
```

返回 `{ "lineId": 1, "address": "钱包地址" }`。同一线路下重复导入同一地址会报错；同一地址可关联多条线路。请通过 HTTPS 提交私钥，避免在请求日志中记录请求体。

## 查询钱包信息

`POST /v1/execute/fomo/getWallets`

```json
{
  "lineId": 1,
  "address": "可选的钱包地址"
}
```

不传 `address` 时查询指定 `lineId` 下的所有 fomo 钱包。返回 `total` 和 `list`；每项只包含 `lineId`、`address`、`sol`、`usdc`。`usdc` 是避免精度损失的十进制字符串。余额来自当前 RPC 的 confirmed 状态。

## 获取代币余额

`POST /v1/execute/fomo/getTokenBalance`

```json
{
  "address": "钱包地址",
  "token": "代币 mint 地址"
}
```

按 mint 汇总该地址持有的所有代币账户余额，支持 SPL Token 和 Token 2022。返回 `address`、`token`、`amountRaw`、`decimals`、`amount`；`amountRaw` 和 `amount` 均为字符串。没有该代币账户时返回零余额。此接口无需 `lineId`，查询的是链上地址余额，不要求钱包已导入 Fomo。卖出接口仍只读取关联代币账户，因此这里的总余额可能大于可直接卖出的余额。

## 修改钱包

`POST /v1/execute/fomo/updateWallet`

```json
{
  "lineId": 1,
  "address": "当前钱包地址",
  "newPrivateKey": "新钱包的 Base58 私钥",
  "key": "钱包访问密钥"
}
```

使用 `lineId` 和当前 `address` 定位钱包，用 `newPrivateKey` 推导新地址并替换私钥。返回 `{ "lineId": 1, "address": "新钱包地址" }`。若当前钱包不存在，或新地址已在同一线路导入，则报错。修改只更新数据库记录，不会转移旧地址上的资产。

## 删除钱包

`POST /v1/execute/fomo/deleteWallet`

```json
{
  "lineId": 1,
  "address": "要删除的钱包地址",
  "key": "钱包访问密钥"
}
```

删除指定线路下的钱包记录和保存的私钥，返回 `{ "lineId": 1, "address": "已删除的钱包地址" }`。其他线路中的相同地址不受影响。删除不会转移或销毁链上资产；请事先保管好私钥。

## 卖出代币为 USDC

`POST /v1/execute/fomo/sellToken`

```json
{
  "lineId": 1,
  "address": "已导入的 fomo 钱包地址",
  "token": "待卖出的代币 mint 地址",
  "sellRatio": 1
}
```

卖出接口使用 `lineId` 和 `address` 定位钱包。`sellRatio` 可省略，默认 `1`，取值为 `0 < sellRatio <= 1`，最多 9 位小数。卖出数量按该钱包**关联代币账户**的原始整数余额向下取整。小于一个最小代币单位时报错。若代币仅存于其他非关联账户，需先归集到关联代币账户。

接口优先使用 Jupiter V6 路由，路由构建失败时尝试 DFlow；输出 mint 固定为 USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`。首轮滑点默认 5%，明确的链上失败或交易过期后，最多重报价两次，滑点依次提高到 10%、15%。可通过 `FOMO_BASE_SLIPPAGE_BPS`、`FOMO_MAX_SLIPPAGE_BPS` 调整，单位为基点。每次重试都会重新读取余额；交易状态不明确时不会提交第二笔交易。

交易会使用优先费，并可通过 `FOMO_MAX_PRIORITY_FEE_LAMPORTS` 调整其上限（默认 500,000 lamports）；DFlow 路由的计算单元价格可通过 `FOMO_COMPUTE_UNIT_PRICE_MICROLAMPORTS` 调整（默认 50,000 micro-lamports/CU）。交易会先向主 RPC 和配置的辅助 RPC 广播同一签名，并每 1.5 秒重播，直到确认或区块哈希过期。最多等待 90 秒确认；超时且状态仍未知时会返回错误和签名，不会自动发起第二笔交易。可选设置 `FOMO_SEND_RPC_URLS` 为逗号分隔的同一 Solana 集群 RPC URL，以并行传播和确认。钱包仍需有 SOL 支付网络手续费及可能的账户创建费用。

成功响应包含 `routeProvider`（`jupiter` 或 `dflow`）和 `attempts`。接口发起的是链上交易，无法保证缺少流动性、代币限制卖出、钱包 SOL 不足等外部条件下必然成交；未确认状态不会被当作成功返回。

## 将 USDC 兑换为 SOL

`POST /v1/execute/fomo/swapUsdcToSol`

```json
{
  "lineId": 1,
  "address": "已导入的 fomo 钱包地址",
  "sellRatio": 1
}
```

`sellRatio` 可省略，默认 `1`，按该钱包 USDC 关联代币账户余额的比例兑换；取值为 `0 < sellRatio <= 1`，最多 9 位小数。接口通过 Jupiter V6 将 USDC 兑换为原生 SOL，滑点为 1%，确认成功后返回 `lineId`、`address`、USDC 输入数量、`outputMint`（SOL 的原生 mint）及交易 `signature`。钱包仍需预留少量 SOL 支付交易手续费。此接口不需要 `key`。
