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

接口使用 Jupiter V6 路由 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`，输出 mint 固定为 USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`，滑点设为 1%。钱包需要有 SOL 支付网络手续费及可能的账户创建费用。交易确认后返回 `lineId`、钱包地址、输入和输出 mint、比例、数量和 `signature`。接口会实际发起链上交易；请求超时后先按签名或链上余额检查状态，避免重复卖出。

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
