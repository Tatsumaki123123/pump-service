# 旧地址维护与复用开发文档（第一阶段）

## 1. 目标与范围

第一阶段提供一批可维护的旧执行地址。可以预生成地址、查看/筛选/排序、批量删除未使用地址；`generateWallets` 可选择使用这批地址。旧地址被分配到执行批次后标记为使用中，boss 成功回收后标记为已结束。已结束地址不再分配给新批次，但当前批次仍可按零余额补款规则重新启用。

本阶段不做逐笔交易历史、自动挑选策略、钱包余额看板、地址导入、后台管理页面或链上历史索引。现有不传 `isOld` 或 `isOld=false` 的新建钱包行为保持不变。

## 2. 当前代码约束

- `ExecuteWallet` 保存执行钱包地址、私钥和 `eid`，`address` 当前有唯一索引。
- `generateWallets(line)` 首次按 `ExecuteLine.walletConfig` 创建 keypair，再按每项 `transferAmount` 从 boss 转 SOL。
- `getWallets(line)` 按当前 `eid` 查询 `ExecuteWallet`，买卖逻辑依赖查询结果顺序与 `walletConfig` 下标一致。
- `recycleSol` 在结束时将本批次钱包 SOL 转回 boss。只有所有必要转账都确认成功，才可将旧地址维护记录标为已结束。

## 3. 数据模型

### 3.1 新增 `ExecuteWalletAddress` 地址维护表

一条记录代表一个可供一次性复用的地址。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `address` | String, unique | 公钥地址 |
| `privateKey` | String | 对应私钥，沿用现有 keypair 格式和密钥读取方式 |
| `status` | String | `unused` 未使用、`in_use` 使用中、`ended` 已结束 |
| `createTime` | Date | 创建时间，用于列表排序 |
| `useEid` | BigInt, optional | 当前/最近关联的执行批次 |
| `useLine` | Number, optional | 当前/最近关联的线路 |
| `useTime` | Date, optional | 最近分配时间 |
| `endTime` | Date, optional | 回收成功并结束的时间 |

索引：`address` 唯一；`status, createTime` 组合索引。首次使用按 `unused -> in_use -> ended` 流转；当前批次对零余额地址重新充值成功后，允许 `ended -> in_use`，同时清除 `endTime`。`ended` 不再转回 `unused`。

### 3.2 `ExecuteWallet` 关联

扩展 `ExecuteWallet`，增加 `walletAddressId`（指向 `ExecuteWalletAddress` 的 `_id`），或使用稳定的地址维护记录 ID。旧钱包模式创建当前 `eid` 的 `ExecuteWallet` 批次记录，并关联地址维护记录；地址、公钥和私钥从维护表读取。保持现有 `ExecuteWallet.address` 唯一约束，因为每个维护地址只允许分配和使用一次。

新地址模式继续按旧逻辑创建 `ExecuteWallet`，可不填 `walletAddressId`。所有钱包读取路径仍按 `eid` 和 `walletIndex` 顺序工作，不能让维护表查询顺序改变 `walletConfig` 的下标映射。

## 4. 接口设计

沿用现有 `/v1/execute` POST JSON 风格。具体路由命名可按 controller 现有命名调整。

### 4.1 生成未使用地址

`POST /v1/execute/walletAddress/generate`

请求：

```json
{ "num": 20 }
```

行为：校验 `num` 为正整数且不超过配置上限；生成 `num` 个 keypair；写入地址维护表，状态为 `unused`。响应只返回数量和公钥地址，不返回私钥。失败时不能留下部分成功却报告全失败的模糊结果；返回成功/失败数量或采用事务/补偿清理。

### 4.2 获取地址列表

`POST /v1/execute/walletAddress/list`

请求字段：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `status` | String | `unused,in_use` | 可传单个或多个状态；允许显式查询 `ended` |
| `lineId` | Number | 无 | 按 `useLine` 关联线路筛选；尚未分配到线路的未使用地址不会匹配 |
| `sortBy` | String | `createTime` | 第一阶段只开放创建时间排序 |
| `sortOrder` | String | `desc` | `desc` 或 `asc` |
| `page` | Number | `1` | 页码 |
| `pageSize` | Number | `50` | 每页数量，需设最大值 |

默认按创建时间倒序，默认不返回 `ended` 地址。传 `status=ended` 时可以查看已结束地址；支持 `unused`、`in_use` 和 `ended` 状态筛选。列表仅返回地址、状态、批次/线路关联和时间，不返回私钥。

按线路查询示例：

```json
{ "lineId": 1, "status": ["in_use", "ended"] }
```

### 4.3 查询地址 SOL 余额

`POST /v1/execute/walletAddress/balances`

```json
{ "addresses": ["地址1", "地址2"] }
```

`addresses` 必须为非空数组，地址必须是合法 Solana 公钥。复用现有批量余额服务，地址去重后每 100 个一批查询。不要求地址在维护表中存在。

响应沿用 `{ code: 0, data: { total, totalBalanceLamports, totalBalance, totalSol, list } }`。每项包含 `address`、`exists`、`balanceLamports`、`balance` 和 `sol`，其中 `balance` 和 `sol` 单位为 SOL。未创建的链上账户返回 `exists=false` 和余额 0；RPC 失败会报错。

### 4.4 批量删除地址

`POST /v1/execute/walletAddress/delete`

请求：

```json
{ "ids": ["id1", "id2"] }
```

只允许删除 `unused` 地址。`in_use` 和 `ended` 记录拒绝删除，以保留批次关联及历史可追溯性。响应提供删除数量和未删除 ID/原因。请求需限制最大批量数；重复 ID 按一个处理。

### 4.5 选择旧地址生成执行钱包

扩展 `POST /v1/execute/generateWallets`：

```json
{ "line": 1, "isOld": true }
```

`isOld` 缺省或为 `false` 时，完全沿用现有新建钱包流程。`isOld=true` 时从地址维护表中选择 `unused` 地址，数量必须等于 `walletConfig.length`，按 `walletConfig` 下标建立关联，并按每项 `transferAmount` 向地址转 SOL；全部分配成功后状态改为 `in_use`。

如果当前批次已经生成钱包（`walletsExist=true`），则沿用原来的补款规则：读取当前批次活动钱包，跳过余额大于 0 的钱包，只给余额为 0 的钱包转入对应 `transferAmount`。全部钱包都有余额时返回 `no wallet to transfer`。补款确认成功后，仅将本次补款且关联当前 `eid` 的维护地址恢复为 `in_use`，更新 `useTime` 并清除 `endTime`；本次跳过的钱包状态不变。不新建地址或重新分配地址。

本阶段不接受客户端传入私钥或自定义地址数组，新批次也不选取 `ended` 地址。

## 5. 旧地址生成流程

1. 加载活动 `ExecuteData`、线路 `walletConfig` 和 boss keypair，校验当前批次还没有钱包，避免重复生成或重复转账。
2. 查询 `unused` 地址，按 `createTime` 升序取足 `walletConfig.length` 条，确保先消耗较早生成的地址；不足时在转账前报错并说明需要数量/可用数量。
3. 原子地将选中地址从 `unused` 改为 `in_use`，写入 `useEid`、`useLine`、`useTime`。更新条件必须包含原状态 `unused`，避免并发请求重复认领。
4. 为每个地址创建当前批次 `ExecuteWallet` 记录，设置稳定的 `walletIndex`/`wid` 和 `walletAddressId`，使买卖阶段仍按配置下标取钱包。
5. 按 `walletConfig[index].transferAmount` 从 boss 向地址转账。只有完整流程确认成功后才将 `ExecuteData.walletsExist` 设为 `true`。
6. 任一步骤失败时，按链上结果处理：尚未提交任何转账且本批次关联可安全删除时，回滚关联并将记录恢复 `unused`；已提交或状态未知的转账不得释放地址，保持 `in_use` 并允许后续对账/人工处理，防止重复发款。

首次生成保留批次和认领校验；批次已生成时按零余额规则补款，不能给有余额的钱包重复打款。首次生成中断但 `walletsExist=false` 且已存在执行钱包时，继续报错以避免盲目重复转账。

## 6. boss 回收与状态结束

在 `recycleSol(line)` 中，当前批次钱包全部回收成功后，找到 `walletAddressId` 非空的执行钱包，并把对应维护记录更新为：

```text
status = ended
endTime = now
```

只有全部旧地址都成功回收后才整体结束。任一钱包转账失败或结果未知，旧地址继续保持 `in_use`，以免被误当成可用地址。回收重试应能识别已成功的地址，避免重复发送或重复改状态。

新建模式钱包没有维护表关联，不受状态更新影响。旧地址变为 `ended` 后，默认列表和新批次地址选择都不再返回它；显式按 `status=ended` 查询仍可查阅。当前批次通过 `isOld=true` 对零余额地址重新补款成功后，该地址恢复 `in_use` 并重新出现在默认列表。

## 7. 安全与并发要求

- 维护表 API 和日志不返回/打印私钥。
- `num`、分页和批量删除均限制最大值，拒绝负数、非整数和超限输入。
- 地址认领使用带旧状态条件的原子更新；若认领数量不足，释放本请求已认领但尚未产生链上副作用的记录。
- 同一线路继续使用现有线路操作锁；原子地址认领还需防止不同线路并发选中同一地址。
- 转账提交结果未知时保留 `in_use`，不得自动重试转账或回滚地址状态。
- 私钥目前沿用现有系统的存储方式；后续应单独评估密钥加密和现有 `keypair.json` 导出行为。本阶段新生成地址的接口响应不得包含私钥。

## 8. 兼容与迁移

- 不迁移已有 `ExecuteWallet` 到地址维护表；维护表仅管理新预生成的旧地址。
- 新增字段为可选，已有执行钱包读取逻辑兼容无 `walletAddressId` 的记录。
- `generateWallets` 不传 `isOld` 与 `isOld=false` 保持旧行为；自动任务调用也继续走新钱包逻辑。
- 旧地址只分配给一个批次；同一批次可以重新补款启用，结束后保留维护记录，不物理删除。

## 9. 验收标准

- 传 `num=N` 成功创建 N 条 `unused` 地址记录，响应不含私钥。
- 列表默认创建时间倒序，能按三种状态筛选；默认结果不包含 `ended`；显式查询 `ended` 可见。
- 批量删除可删除未使用地址，遇到 `in_use`/`ended` 时拒绝该地址并返回原因。
- `isOld` 缺省/false 时现有新建和充值行为不变。
- `isOld=true` 时严格按 `walletConfig` 数量分配未使用地址，数量不足时不发生转账。
- 分配后维护记录为 `in_use`，`ExecuteWallet` 与地址维护记录关联，买卖服务仍按正确配置下标读取钱包。
- boss 回收全部成功后关联旧地址变为 `ended`；部分失败或结果未知时不结束。
- 当前批次已生成时，`isOld=true` 只给零余额钱包补款；全部有余额时报 `no wallet to transfer`。成功补款的关联地址从 `ended` 恢复 `in_use`，清除 `endTime`；跳过的钱包不改状态。
- 并发调用不会把同一旧地址分配给两个 `eid`，重复请求不会重复打款。

## 10. 实施顺序

1. 新增 `ExecuteWalletAddress` 模型、索引及 `ExecuteWallet.walletAddressId`。
2. 新增生成、列表、批量删除 controller/service 接口。
3. 改造 `generateWallets(line, isOld)`，实现原子认领、批次关联和配置金额转账。
4. 改造 `recycleSol`，仅在完整成功后将关联地址置为 `ended`。
5. 检查 `getWallets`、余额查询、买卖、替换钱包及回收路径对可选关联字段的兼容。
6. 验证默认旧行为、旧地址数量不足、并发分配、转账失败/未知、部分回收和重复请求。
