# `1-2 MING` 线路配置说明

本文基于当前项目代码，说明这份 `ExecuteLine` 配置的字段含义、实际交易行为，以及配置中容易产生误解的地方。

相关代码：

- 线路模型：[`app/model/executeLine.js`](../app/model/executeLine.js)
- 交易编排：[`app/service/executeSwap.js`](../app/service/executeSwap.js)
- Ave 筛选：[`app/service/ave.js`](../app/service/ave.js)
- Pump AMM：[`app/service/pumpAMM.js`](../app/service/pumpAMM.js)
- Raydium CPMM：[`app/service/raydiumCpmm.js`](../app/service/raydiumCpmm.js)
- 总流程说明：[`docs/execute-workflow.md`](./execute-workflow.md)

## 1. 配置概览

这条线路的配置意图是：

1. 从 Ave 获取 `stonk_out_new` 分类中最近两天的代币。
2. 生成两个执行钱包，每个钱包充值 4 SOL。
3. 两个钱包都执行 `firstBuy`，分别买入 1.85 SOL 和 2.95 SOL。
4. 买入优先使用 DFlow，并追加 Trogan 代理提示指令。
5. 第二个钱包额外支持 `firstSell` 全量卖出。
6. 用 Ave 关注数和线路机器人持仓过滤代币。

## 2. `walletConfig`

`walletConfig` 有两个元素，因此正常批次会生成两个 `ExecuteWallet`。配置和实际行为如下：

| 钱包 | 充值金额 | `firstBuy` 买入额 | 买入路由 | `firstSell` |
| --- | ---: | ---: | --- | --- |
| `walletConfig[0]` | 4 SOL | 1.85 SOL | DFlow + Trogan | 未配置 |
| `walletConfig[1]` | 4 SOL | 2.95 SOL | DFlow + Trogan | 100% |

### 2.1 `transferAmount`

执行 `/v1/execute/generateWallets` 时，boss 会按照 `transferAmount` 给每个钱包转 SOL。本配置会给两个钱包各转 4 SOL。

充值金额不等于买入金额，还需要覆盖交易费、代理提示费、账户租金和后续操作。

### 2.2 `limit`、`price`、`fee`

| 字段 | 值 | 作用 |
| --- | ---: | --- |
| `limit` | `200000` | 非 DFlow/Jupiter/OKX 路由时，通常作为 Compute Unit Limit |
| `price` | `0` | 非 DFlow 路由时通常作为 Compute Unit Price；DFlow 请求也会收到该值 |
| `fee` | `0.00001` SOL | 多钱包交易中的附加费用/提示费，具体由实际 AMM service 分支决定 |

由于两个钱包都设置了 `isDflow=true`，支持 DFlow 的 AMM 会优先使用 DFlow 返回的交易指令，不能仅凭 `limit`、`price`、`fee` 判断最终链上费用。

### 2.3 `firstBuy`

```json
{
  "enable": true,
  "isDflow": true,
  "isTragon": true,
  "buyAmount": 1.85
}
```

- `enable=true`：钱包参加 `first` 买入阶段。
- `buyAmount`：买入使用的 SOL 数量，不是 token 数量。
- `isDflow=true`：在支持该标志的 AMM service 中使用 DFlow 买入指令。
- `isTragon=true`：追加 Trogan 代理提示指令。

项目同时兼容 `isTrogan` 和 `isTragon` 两种拼写。建议新配置统一使用规范拼写 `isTrogan`，但当前的 `isTragon` 会被识别。

执行：

```http
POST /v1/execute/buyToken
```

请求示例：

```json
{
  "tid": 1234567890,
  "type": "first"
}
```

其中 `tid` 使用 `/v1/execute/checkToken` 返回的真实 `ExecuteToken.tid`。执行后两个主钱包分别买入 1.85 SOL 和 2.95 SOL。

### 2.4 `firstSell`

只有第二个钱包有：

```json
{
  "enable": true,
  "sellRatio": 1
}
```

`sellRatio` 的换算规则：

- `0 < sellRatio <= 1`：直接按比例，例如 `0.5` 表示 50%；
- `1 < sellRatio <= 100`：按百分数转换，例如 `50` 表示 50%。

因此，显式执行 `type="first"` 时，只有第二个主钱包参加首卖，并卖出 100%：

```json
{
  "tid": 1234567890,
  "type": "first",
  "percent": 100
}
```

如果执行 `type="all"`，代码会把当前两个主钱包都加入卖出列表，并按 100% 卖出，不受只有第二个钱包配置 `firstSell` 的限制。

分阶段卖出不会立即把 `ExecuteToken.status` 改为 `sell`；只有 `type="all"` 成功后才会更新该状态。

## 3. `isDflow` 与 `isTragon` 的关系

这两个字段不是全局线路开关，而是合并到每个交易钱包上的路由标志：

```text
isDflow=true    -> 选择 DFlow 交易指令（由具体 AMM service 支持情况决定）
isTragon=true   -> 在交易指令中追加 Trogan 代理提示
```

因此当前钱包的意图是：

```text
DFlow swap + Trogan proxy tip
```

实际交易底层服务仍由 `ExecuteToken.amm` 决定：

- Raydium CPMM、Raydium Launch、Pump AMM 会读取 `isDflow`；
- Pump.fun 的买入实现不会根据 `isDflow` 切换到 DFlow；
- 多个 AMM service 都会读取 `isTrogan/isTragon` 来追加 Trogan 指令。

## 4. `firstWallet` 和 `needFirstWallet`

配置中的外部首钱包为：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `address` | `Hx26...VJXbNWY` | 外部指定钱包地址 |
| `buyAmount` | `0.12` SOL | 首钱包买入金额 |
| `position` | `before` | 启用时放在主钱包之前 |
| `type` | `firstBuy` | 参加 first 买入阶段 |
| `isAve` | `false` | 不走 Ave 专用代理买入分支 |
| `isBundle` | `true` | 启用时作为 bundle 钱包处理 |
| `needFirstWallet` | `false` | 当前实际生效的开关 |

### 当前真实行为

由于 `needFirstWallet=false`，当前普通买卖流程不会把 `firstWallet` 加入交易列表。因此现在实际参与交易的只有两个 `walletConfig` 对应的 `ExecuteWallet`。

### 启用时的要求

如果以后改为 `needFirstWallet=true`：

1. `firstWallet` 会在 `firstBuy` 阶段插入两个主钱包之前；
2. `position="before"` 会让它排在主钱包前面；
3. `isBundle=true` 会使它按 bundle 钱包处理；
4. 数据库中的 `firstWallet` 必须有可用的 `privateKey`。

当前 JSON 没有提供 `privateKey`。如果数据库原记录也没有私钥，启用该钱包时构造 keypair 会失败。更新线路时，控制器只会在原记录存在私钥的情况下自动保留旧私钥。

## 5. Ave `groupSort`

因为 `sourceWeb="ave"`，获取候选代币时会调用：

```text
ctx.service.ave.getList(lineData.groupSort)
```

当前真正传给 Ave 的条件如下：

| 字段 | 值 | 实际含义 |
| --- | --- | --- |
| `category` | `stonk_out_new` | 代币分类 |
| `sort_field` | `created_at` | 按创建时间排序 |
| `sort_order` | `desc` | 最新优先 |
| `mcp_min` | `10000` | 市值下限 |
| `mcp_max` | `1000000` | 市值上限 |
| `create_day` | `2` | 最早回溯 2 天 |
| `create_day_end` | `0` | 截止当前时间 |
| `holder_min` | 未配置，默认 `30` | 持有人数下限 |
| `page_no` | 未配置，默认 `1` | 页码 |
| `page_size` | 未配置，默认 `500` | 每页最多 500 条 |

等价描述：

> 从 Ave 的 `stonk_out_new` 分类中，按创建时间倒序筛选最近 2 天、市值 1 万到 100 万、持有人数至少 30 的 Solana 代币。

### 当前不会生效的字段

在当前 `app/service/ave.js#getList` 中，以下字段不会进入 Ave 请求：

- `wallet_count`
- `address`
- `favId`
- `groupId`
- `duration`

特别是 `address` 只有在 `category="user"` 时才会被 `getUserList` 使用。本配置的 category 是 `stonk_out_new`，所以这里的 address 当前被忽略。

## 6. `minFollowStates`

`minFollowStates=3` 会在 `checkToken` 阶段查询 Ave 关注聚合状态：

```text
followStates.all <= 3  -> 拒绝，并写入 ReserveToken(type="bad")
followStates.all > 3   -> 通过关注数检查
```

注意这里是 `<=`，所以刚好等于 3 也会被拒绝，实际需要大于 3。

## 7. `lineBots`

`lineBots` 用于：

1. `checkToken` 时统计机器人对目标 token 的总持仓；
2. 查询线路机器人 token 余额。

当前列表有 14 条记录，但下面的地址重复了两次：

```text
3dEAxujbehwRQEQCszHgK6Qd6BcNxYoH91bwxajo4hsR
```

当前实现不会对 `lineBots` 去重，而是逐条查询并累加，所以该地址的持仓会被统计两次，可能更早触发：

```text
Bot has to many token
```

建议删除其中一条重复的 `3dEx` 记录。

## 8. `autoStep`

当前配置只有：

```json
{
  "method": "buy",
  "type": "first",
  "sleep": 1
}
```

从配置命名看，它表示执行一次 `first` 买入，然后等待 1 个时间单位。

但当前项目没有发现消费 `ExecuteLine.autoStep` 的执行器：

- `/v1/execute/autoSwap` 只读写 `autoSwap` 开关；
- `autoSwap.js` 使用硬编码的 `check -> buy first -> wait -> sell multi -> sell all -> close` 流程；
- `autoStep` 目前只会被线路配置读写接口保存和返回。

因此，当前 `autoStep` 不会自动触发买入，也不会改变 `autoSwap` 的执行顺序。

## 9. 当前代码下的实际执行时序

```text
ExecuteLine(lineName=1-2 MING)
        |
        | sourceWeb=ave，按 groupSort 拉取候选
        v
checkToken(token, eid)
        |
        +-- 机器人持仓总量 > 1000       -> 拒绝
        +-- Ave followStates.all <= 3   -> 拒绝并标记 bad
        +-- 其他 eid 正在买入该 token   -> 拒绝
        v
ExecuteToken(status=pending)
        |
        | buyToken(type=first)
        v
钱包 0: DFlow 买入 1.85 SOL + Trogan 指令
钱包 1: DFlow 买入 2.95 SOL + Trogan 指令
        |
        v
ExecuteToken(status=buy)
        |
        +-- sellToken(type=first) -> 仅钱包 1 按 100% 卖出
        |
        +-- sellToken(type=all)   -> 钱包 0、钱包 1 都按 100% 卖出
        v
ExecuteToken(status=sell，仅 all 会更新)
```

## 10. 上线前检查清单

- `ExecuteLine.lineId` 已配置，接口使用的是 `lineId`，不是 `lineName`。
- boss 余额足够给两个钱包各充值 4 SOL。
- 两个钱包的 4 SOL 足够覆盖买入额、租金和交易附加费用。
- DFlow 接口配置可用，并确认 `price=0` 符合当前 DFlow 服务预期。
- 确认是否需要 `isTragon=true`，它会追加代理提示指令和额外费用。
- 确认 `minFollowStates=3` 的真实门槛是 `followStates.all > 3`。
- 删除重复的 `3dEx` line bot 地址。
- 不使用外部首钱包时保持 `needFirstWallet=false`。
- 启用 `firstWallet` 前，确认数据库中存在匹配的 `privateKey`。
- 不要把 `autoStep` 当成当前已经生效的自动调度配置。
- 保证数据库钱包查询顺序与 `walletConfig` 下标关联不会错配。
