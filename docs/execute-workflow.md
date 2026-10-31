# executeData / executeLine / executeToken / executeWallet 工作流程

本文基于当前代码整理这四个模型以及 `executeSwap`、`executeToken`、`autoSwap` 服务之间的调用关系，重点说明一次线路执行从启动、建钱包、检查代币、买卖到回收的完整链路。

Pump AMM 买卖需要代币与 WSOL 的报价池。若链上有 Pump AMM 池但没有 WSOL 报价池，未配置专用路由的普通钱包会改用 Jupiter 进行 SOL 买入或代币卖出，默认滑点为 1%（线路显式设置滑点时以线路配置为准）。配置了 Axiom、Padre、Ave、代理、OKX 等专用路由的钱包仍使用原路由；这些路由当前依赖 WSOL Pump AMM 池，缺少该池时会明确报错，不会静默改走 Jupiter。Jupiter 请求未设置平台手续费，但仍需支付所选交易池的费用、链上手续费以及现有批量发送配置的 tip。

`wallet.isJup=true` 选择 Jupiter 换币路由，买入仍通过现有 Bundle 平台发送。买入按实际批次并行获取 Jupiter 指令，再获取新的 blockhash；Jupiter 买入及非 WSOL 池的 Jupiter 卖出在生产环境也执行模拟，失败时返回程序错误和 logs。Jupiter 买入交易超长时可拆出 tip，但不会删除计算预算指令。包含 Jupiter 的买入批次构建或模拟失败时不会发送已构建的部分交易。

`Bundle accepted but not landed` 表示观察超时；买入超时补充 token、发送平台和区块高度，需按原 signature 对账，不能据此认定交易失败后重新买入。单笔模拟无法保证批量内前序交易造成价格变化后，后序交易仍满足滑点。

Jupiter 和 DFlow 的公共 `/quote` 入口默认发送 `excludeDexes=Manifest`，覆盖使用这两个 SDK 的买入、卖出及回退路径，不局限于非 WSOL 池。分别通过 `JUPITER_EXCLUDE_DEXES`、`DFLOW_EXCLUDE_DEXES` 覆盖排除列表，多个 DEX 用英文逗号分隔；显式设置空字符串则不传排除参数。排除后没有可用路径会返回报价错误，不会自动移除排除条件重试。DFlow 的排除条件会计入报价缓存键；修改环境变量需重启服务。

DFlow 参数参考：[Get Quote](https://pond.dflow.net/resources/trading-api/imperative/quote)。DEX 名称需使用各服务支持的准确标签，可分别查看 Jupiter 的 `/swap/v1/program-id-to-label` 与 DFlow 的 `/venues`。

## 1. 一句话概览

`ExecuteLine` 定义“怎么执行”，`ExecuteData` 定义“当前哪一批执行实例”，`ExecuteWallet` 保存该批次实际使用的钱包，`ExecuteToken` 保存该批次处理过的代币任务。

```text
ExecuteLine(lineId)
       |
       | 1:N，通过 ExecuteData.line
       v
ExecuteData(eid, active, bossAddress, line)
       |
       | 1:N，通过 ExecuteWallet.eid / ExecuteToken.eid
       +--------------------+
       v                    v
ExecuteWallet          ExecuteToken
       |                    |
       | 钱包私钥、余额       | 代币、池子、AMM、买卖状态
       +----------+---------+
                  |
          executeSwap 负责编排
```

其中：

- `line` 是线路配置的业务编号，对应 `ExecuteLine.lineId`。
- `eid` 是一次执行批次的编号，也是钱包和代币的批次隔离键。
- 一条线路通常只有一个 `ExecuteData.active=true` 的当前批次；历史批次保留在库中用于查询和审计。

## 2. 四张模型分别负责什么

| 模型 | 关键字段 | 职责 | 主要被谁读写 |
| --- | --- | --- | --- |
| `ExecuteLine` | `lineId`、`walletConfig`、`slippage`、`firstWallet`、`needFirstWallet`、`sourceWeb`、`groupSort`、`withdrawAddress`、`autoSwap` | 线路级配置：钱包数量和每个钱包的充值/买入/卖出策略、统一滑点、代币来源、机器人地址、提现地址 | `executeSwap`、`executeToken`、`autoSwap`、控制器线路配置接口 |
| `ExecuteData` | `eid`、`line`、`active`、`bossAddress`、`privateKey`、`walletsExist`、`createTime` | 一次执行批次的 boss 钱包和生命周期状态 | `executeSwap` 创建/切换/查询；`axiomWallet` 按时间或 `eid` 反查批次 |
| `ExecuteWallet` | `address`、`privateKey`、`eid`、`isActive`、`createTime` | 批次下的执行钱包；`eid` 将钱包绑定到一个批次 | `executeSwap` 生成/替换/查询；`walletAdmin` 读取私钥和归集资金 |
| `ExecuteToken` | `tid`、`token`、`pool`、`amm`、`eid`、`line`、`status`、`buyStatus`、`buyStartTime` | 批次内的代币任务和买卖状态 | `executeSwap.checkToken/buyToken/sellToken`、代币列表接口、自动交易 |

模型定义位置：

- [`app/model/executeLine.js`](../app/model/executeLine.js)
- [`app/model/executeData.js`](../app/model/executeData.js)
- [`app/model/executeWallet.js`](../app/model/executeWallet.js)
- [`app/model/executeToken.js`](../app/model/executeToken.js)

## 3. 主流程：从线路到一轮交易

### 3.1 线路配置是起点

线路数据保存在 `ExecuteLine`。其中最重要的是：

- `walletConfig`：数组下标与执行钱包下标对应。每个元素至少包含 `transferAmount`，并可包含 `firstBuy`、`secondBuy`、`thirdBuy`、`multiBuy` 等阶段配置。
- `slippage`：可选的线路级滑点，小数比例（例如 `0.2` 表示 20%），配置后覆盖钱包、阶段和 `firstWallet` 的滑点；未配置时使用各交易服务默认值。
- `firstWallet` / `needFirstWallet`：可选的额外首个钱包。`position` 决定放在主钱包之前还是之后，`type` 决定它参与哪个买入阶段。
- `sourceWeb` 和 `groupSort`：决定代币列表从 Debot 还是 Ave 获取，以及筛选条件。
- `minFollowStates`：`checkToken` 时的最小关注地址数门槛。
- `lineBots`：检查某代币在线路机器人钱包中的持仓。
- `withdrawAddress`：`withdraw(line, amount)` 的提现目标。

线路可以通过 `POST /v1/execute/updateLineData` 更新。带 `data` 时，控制器把字符串 JSON 合并到原线路；不带 `data` 时返回脱敏后的线路配置（会去掉 `firstWallet.privateKey`）。

### 3.2 启动或切换 `ExecuteData`

入口：`POST /v1/execute/start`，参数 `{ "line": lineId }`。

调用链：

```text
controller.executeSwap.start
  -> service.executeSwap.start(line)
      -> getExecuteData(line)
      -> generateNewBoss(...) 或 generateBoss(...)
```

`getExecuteData(line)` 只查 `active=true` 且 `line` 相同的记录。

#### 首次启动：没有当前批次

`generateNewBoss(line)`：

1. 检查活动和待切换记录的唯一索引。支持 MongoDB 4.4 standalone，不需要副本集或多文档事务。
2. 创建一个待充值的 Solana boss 和 `ExecuteData`：
   - `eid` 从 MongoDB `ExecuteSequence` 全局原子序列分配；
   - 保存 boss 公钥和 Base58 私钥；
   - `active=false`、`bossStatus=awaiting_funds`、`createTime=当前时间`、`line=line`；
   - `walletsExist` 使用模型默认值 `false`。
3. 密钥存入 MongoDB 并继续写出 `keypair.json`。接口返回待充值错误，包含新地址；可通过 `/v1/execute/getBoss` 查询 `active=false` 的待充值记录，响应不包含私钥。
4. 向该地址充值后，后台对账任务确认 finalized 余额达到门槛后激活，也可再次调用 `start` 恢复。默认激活门槛为 10000 lamports（0.00001 SOL），可用 `BOSS_ACTIVATION_MIN_LAMPORTS` 配置为正整数；实际首次充值还须满足链上账户租金等要求。

`eid` 是跨线路唯一的批次编号，不再由 `line` 计算。MongoDB 中以 BSON Int64（Extended JSON 显示为 `$numberLong`）保存，分配前会用现有最大 `eid` 对齐序列，之后通过 MongoDB 原子 `$inc` 递增，因此首次部署不需要手工回填序列值。Mongoose getter 保持业务对象和 JSON 接口中的 `eid` 为安全范围内的数字。

#### 后续启动：已有当前批次

`start(line)` 首先恢复待确认 boss；没有待确认记录时读取当前批次活动 `ExecuteWallet`，检查这些钱包的 finalized SOL 余额：

- 只要有一个钱包余额大于 0，直接抛出 `Wallet has balance`，防止未回收资金时换批次。
- 所有钱包余额为 0 时进入统一的 `bossLifecycle` 创建流程。

`start`、`generateBoss`、`generateNewBoss` 共用的处理顺序：

1. 获取线路资金锁，检查活动记录和待切换记录的唯一索引。
2. 若存在 pending/awaiting_funds boss，先恢复它；未确认时不新建目标地址，不重复签署另一笔转账。
3. 旧 boss 余额必须足够支付转账手续费，并使目标余额达到激活门槛；否则报错，不激活空钱包。
4. 保存新 boss：新 `eid`、`active=false`、`bossStatus=pending`。广播前持久化已签名交易、signature、blockhash、有效高度，进程中断后仍能重播同一笔交易。
5. 转账等待 finalized，单次等待 20 秒。转账异常后立即对账，仍未确认时保留 pending。`app/schedule/bossRecovery.js` 在进程启动后及每 10 秒调度恢复，下一次请求也可继续恢复。
6. 交易 finalized 后，从不早于交易 slot 的 finalized 状态读取目标余额；低于门槛不激活。
7. 使用单文档条件更新先退役旧 boss，再激活已到账的新 boss。新目标保留 `bossPending=true` 直到激活，唯一索引防止创建第二个待切换目标。每步检查资金锁；中间宕机允许暂时无活动记录，重试从 pending 恢复。
8. 返回成功前，再确认活动记录是目标 boss，且 finalized 余额仍达到门槛。保存激活余额、slot 和时间供排查。

同一线路的 boss 切换、钱包充值、回收、提现和换钱包共用 MongoDB 资金锁，锁会续期。存在 pending 时需先调用 `start` 对账。数据库分别限制每条线路最多一条 `active=true` 和一条 `bossPending=true`。关键记录使用 `w:1, j:true`，日志持久化后才继续。支持 MongoDB 4.4 standalone；存量重复活动记录或待切换标记会导致索引失败，应先人工核对处理。

已 finalized 的失败交易或确认过期且目标 finalized 余额为 0 的交易可标为 `failed`，保留密钥和签名后重新尝试。交易历史查不到或查询失败时，读取不早于本次 finalized 链头的目标余额：达到门槛即可激活保存的目标，兼容缺少过期高度的旧记录；余额大于 0 但不足门槛时保留 pending。不能因为历史缺失和余额为 0 就提前丢弃尚未过期的交易。

后台任务使用相同线路资金锁，只恢复保存的目标和交易，可重播原始签名交易，不创建新 boss、不签署新转账。没有交易签名的 `pending` 创建记录仍需显式 `start` 执行首次转账；`awaiting_funds` 记录可在充值确认后自动激活。单次任务未结束时避免在同一进程重复扫描，某条线路恢复失败会记录 `Boss reconciliation failed: line=...` 并继续处理其他线路。激活日志 `Boss activated` 包含线路、地址、余额和 slot。10 秒是调度间隔，实际恢复时间还取决于链上 finalized、资金锁、RPC 和数据库可用性。

`getBoss` 响应增加 `active`、`bossStatus`、`ready`、`minimumBalanceLamports` 和 `pending`（地址、eid、状态、签名），可观察当前活动记录和待恢复目标。

部署期间先停止旧版本的资金任务再更新所有实例。上线前需在 MongoDB 4.4 standalone 和测试链环境验证：余额不足、首次充值、转账后和退役后宕机、RPC 超时、历史缺失、并发切换及同一签名重播。本次改动不执行真实转账或数据库迁移。

这个流程保证成功响应前完成资金和活动记录检查；后续业务充值/提现或外部持钥人的操作仍可能消耗余额。已确认链上转账与 MongoDB 不能组成分布式原子事务，中间故障通过保存的状态恢复。

因此，`line` 表示批次归属线路，`eid` 表示全局唯一批次；线路切批次后，后续钱包和代币应绑定新 `eid`。

### 3.3 生成或补充 `ExecuteWallet`

入口：`POST /v1/execute/generateWallets`，参数 `{ "line": lineId }`。

调用 `executeSwap.generateWallets(line)`：

1. 读取当前活动 `ExecuteData`，用其 boss 私钥加载 boss keypair。
2. 读取 `ExecuteLine.walletConfig`，每个配置的 `transferAmount` 是该钱包本轮需要从 boss 获得的 SOL 数量。
3. 根据 `ExecuteData.walletsExist` 分两条路径：

**首次生成：**

- 按 `walletConfig` 长度生成同样数量的 keypair。
- 写入 `ExecuteWallet`，每条记录至少有 `address`、`privateKey`、`eid`。
- 记录会批量插入，私钥也会被写入根目录 `keypair.json`。
- 从 boss 向新钱包转入对应的 `transferAmount`。

**批次已有钱包：**

- 读取当前 `eid` 下 `isActive=true` 的钱包。
- 只挑选链上余额为 0 的钱包，并按数组下标取对应 `walletConfig[index].transferAmount` 进行补款。
- 没有可补款的钱包时抛出 `no wallet to transfer`。

转账完成后，更新当前 `ExecuteData.walletsExist=true`。后续 `getWallets(line)` 默认只返回当前 `eid` 且 `isActive=true` 的钱包；`getWallets(line, true)` 会返回当前批次的全部钱包，结束回收时使用后者。

### 3.4 获取待选代币：`executeToken.getTokenList`

入口：`POST /v1/executetoken/tokenList`，参数 `{ "line": lineId }`。

默认列表路径是：

1. 读取线路的当前活动 `ExecuteData` 和 `ExecuteLine`。
2. 根据 `sourceWeb` 调用：
   - `debot` -> `ctx.service.debot.getList(lineData.groupSort)`；
   - `ave` -> `ctx.service.ave.getList(lineData.groupSort)`。
3. 查询该 `eid` 下已经处于 `buy` 或 `sell` 的 `ExecuteToken`。
4. 查询该线路被标记为 `ReserveToken.type=bad` 的代币。
5. 从来源列表中排除上述两类代币，返回可选列表。

AVE 普通列表会在每个代币条目中返回交易对另一侧的 `token1_address`、`token1_symbol` 和 `token1_logo_url`。这些字段保留 AVE 原始值（图标可为相对路径）；目标代币位于交易对的 token1 侧时，字段取 token0 侧。其他来源未提供交易对元数据时不返回这些字段。

`POST /v1/executetoken/tokenList` 传入非 `default` 的 `listType` 时，会直接查询 `ReserveToken`，不会走上述来源网站列表逻辑。

当前 `executeToken.initTokenList(line)` 方法为空，因此 `POST /v1/executetoken/initTokenList` 目前没有实际初始化动作。

### 3.5 检查代币并创建 `ExecuteToken`

入口：`POST /v1/execute/checkToken`，请求体需要 `tokenData` 和 `eid`。自动交易也会直接调用同一个 service 方法。

`checkToken(tokenData, eid, forceCheck)` 的处理顺序：

1. 校验 token 是否为合法 Solana 地址。
2. 如果同一 `eid`、同一 token 已经是 `sell`，先把它改回 `buy`，允许重新执行。
3. 通过 `eid` 找到 `ExecuteData`，再通过 `ExecuteData.line` 找到线路配置。
4. 非 `forceCheck` 时检查当前线路机器人钱包合计持仓是否超过 1000。
5. 补齐代币元数据，优先级为：
   - 调用方提供的 `symbol` / `pool` / `amm`；
   - Ave 的 `getTokenInfo`（detail 接口使用 `mint-solana`）；
   - 现有 `ExecuteToken` 中的池子和 AMM；
   - Pump AMM 池扫描；
   - Raydium CPMM 池查询；
   - Pump.fun 池查询。
6. 找不到池子/AMM 或 symbol 时失败。
7. 查询 Ave 的关注聚合状态。如果 `line.minFollowStates > 0` 且关注数未达标：
   - 在 `ReserveToken` 写入或更新一条 `type=bad`；
   - 抛出“没有关注地址”。
8. 查询当前 `eid` 下同 token 的 `pending` 或 `buy` 记录：
   - 没有则创建新的 `ExecuteToken`，初始 `status=pending`；
   - 有则复用原来的 `tid`，避免重复创建。
9. 返回代币信息，并附带该 token 历史 `status=end` 的次数 `buyTimes`。

`ExecuteToken` 的状态在主流程中通常是：

```text
pending --买入成功--> buy --全部卖出--> sell
   ^                    |
   +---重新检查（若原状态 sell，会先回到 buy）
```

### 3.6 买入：从 `ExecuteToken` 选择钱包并路由到 AMM

入口：`POST /v1/execute/buyToken`，参数包括 `tid`、`type`，也可以附带 `walletAddress`。

控制器按请求形态分流：

- 带 `walletAddress`：只买指定钱包；
- `type` 是数组：依次执行多个阶段；
- 其他情况：执行一个阶段。

批量买入 `buyToken(tid, type)`：

1. 读取 `ExecuteToken`，要求记录存在且未处于 `end`。
2. 根据 `tokenInfo.line` 读取当前线路的钱包。
3. `getWalletsWithLineFirstWallet` 把三部分合并成交易钱包列表：
   - 当前 `eid` 的 `ExecuteWallet`；
   - 按数组下标合并的 `walletConfig[index]`；
   - 当 `needFirstWallet=true` 时插入 `firstWallet`。
4. `type` 可以是 `first`、`second`、`third`、`multi` 或 `all`：
   - 单阶段只选择该阶段 `enable=true` 的钱包；
   - `all` 按 `first -> multi -> second -> third` 的顺序逐阶段执行。
5. 根据 `ExecuteToken.amm` 路由到对应服务：
   - `raydiumcpmm` -> `raydiumCpmm.batchBuyToken`；
   - `raydiumlaunchlab` -> `raydiumLaunch.batchBuyToken`；
   - `pumpfunamm` -> `pumpAMM.batchBuyToken`；
   - `pump` -> `pumpfun.batchBuyToken`。
6. 包含 `firstWallet` 且 `isBundle=false` 时，会拆成独立钱包交易，并按 slot/延迟安排在主 bundle 前后执行。
7. 调用成功后更新：`status=buy`、`buyStatus=当前阶段`、`buyStartTime=当前时间`。

### 3.7 卖出：分阶段卖出或全部卖出

入口：`POST /v1/execute/sellToken`，参数包括 `tid`、`type`、可选 `percent`。

1. 读取 `ExecuteToken` 和线路钱包。
2. `getWalletsWithSellConfig` 根据阶段配置和 `percent` 计算卖出钱包及 `sellRatio`。
3. 同样根据 `amm` 路由到四类 AMM 服务的 `batchSellToken`。
4. 当 `type=all` 时，将 `ExecuteToken.status` 更新为 `sell`；分阶段卖出不会立即改为 `sell`。

随后可以调用 `POST /v1/execute/closeAllAccounts` 关闭各钱包的 token account，释放剩余资产。`isFirst=true` 时控制器只操作线路配置里的 `firstWallet`，否则操作当前批次的 `ExecuteWallet`。

### 3.8 结束一轮：回收钱包余额和提现

入口：`POST /v1/execute/end`，参数 `{ "line": lineId, "force": boolean }`。

`end` 当前只调用 `recycleSol(line, force)`：

1. 查询当前 `eid` 的全部钱包（包括 `isActive=false` 的历史替换钱包）。
2. 逐个关闭 token accounts。
3. 将每个钱包剩余 SOL 全部转回当前 `ExecuteData.bossAddress`。

这一步不会把当前 `ExecuteData.active` 改为 `false`，也不会自动创建新批次。下一次调用 `/v1/execute/start` 时，只有在钱包余额已经清空的前提下才会执行 `generateBoss` 完成批次切换。

如需从 boss 转到线路提现地址，可调用 `POST /v1/execute/withdraw`：

- 传 `amount` 时转固定数量；
- 不传时调用 `transferAllSol` 转出 boss 的全部 SOL；
- 目标来自 `ExecuteLine.withdrawAddress`。

## 4. `nextWallet`：替换一批执行钱包

入口：`POST /v1/execute/nextWallet`。

该方法针对当前活动钱包逐个执行：

1. 生成新 keypair，并创建新的 `ExecuteWallet`，绑定当前 `eid`。
2. 从旧钱包转出约 `0.01 SOL` 给新钱包。
3. 将新地址设为 `isActive=true`，旧地址设为 `isActive=false`。

切换前会检查活动钱包的 SPL Token 和 Token-2022 账户；任一账户的原始余额大于 `100` 时会报错。请求体可传 `force: true` 跳过持仓检查并强制切换。

同一条 line 的钱包轮换会通过分布式锁串行执行；轮换进行中再次请求会返回错误，不会重复创建钱包。新钱包会先以非活动状态创建，完成转账后再切换活动状态。

替换后，普通交易只使用新钱包；`getWallets(line, true)` 仍可查到旧钱包，便于后续余额回收或审计。

## 5. 自动交易 `autoSwap`

自动服务位于 [`app/service/autoSwap.js`](../app/service/autoSwap.js)，设计上的循环为：

```text
检查线路开关和钱包余额
        |
        +-- 余额不足 --> recycleSol
        |                 -> generateNewBoss
        |                 -> generateWallets
        |                 -> 重新 start
        |
        +-- 余额足够 --> 随机选择 tokenList
                          -> checkToken
                          -> buy first
                          -> 等待机器人入场（最多约 60 秒）
                          -> sell multi（有入场时）
                          -> 再等待机器人入场
                          -> sell all
                          -> closeAllAccounts
                          -> 重新 start
```

自动循环使用的关键数据仍然是同一套四模型：

- 从 `ExecuteLine` 读取 `autoSwap`、线路和钱包配置；
- 从 `ExecuteData` 取得当前 `eid`；
- 通过 `ExecuteToken` 记录每次 token 检查和交易状态；
- 通过 `ExecuteWallet` 查询余额和 token 持仓。

## 6. 主要接口入口

| 接口 | 作用 | 主要落点 |
| --- | --- | --- |
| `POST /v1/execute/start` | 启动线路或切换 boss 批次 | `executeSwap.start` |
| `POST /v1/execute/generateWallets` | 按线路配置生成/补款执行钱包 | `executeSwap.generateWallets` |
| `POST /v1/executetoken/tokenList` | 获取线路可选代币 | `executeToken.getTokenList` |
| `POST /v1/execute/checkToken` | 校验代币并创建/复用 `ExecuteToken` | `executeSwap.checkToken` |
| `POST /v1/execute/buyToken` | 按阶段或指定钱包买入 | `executeSwap.buyToken*` |
| `POST /v1/execute/sellToken` | 按阶段、比例或全部卖出 | `executeSwap.sellToken*` |
| `POST /v1/execute/closeAllAccounts` | 关闭 token accounts | `executeSwap.closeAllAccounts` |
| `POST /v1/execute/end` | 回收当前批次钱包 SOL 到 boss | `executeSwap.end/recycleSol` |
| `POST /v1/execute/nextWallet` | 替换当前活动钱包 | `executeSwap.nextWallet` |
| `POST /v1/execute/withdraw` | 从 boss 提现到线路地址 | `executeSwap.withdraw` |
| `POST /v1/execute/autoSwap` | 查询/更新线路自动交易开关 | `ExecuteLine.autoSwap` |

路由定义见 [`app/router.js`](../app/router.js)，控制器入口见 [`app/controller/executeSwap.js`](../app/controller/executeSwap.js) 和 [`app/controller/executeToken.js`](../app/controller/executeToken.js)。

## 7. 当前代码的注意点

以下是阅读当前实现时需要特别注意的地方：

1. **自动交易开关不会真正启动服务。** `POST /v1/execute/autoSwap` 只更新 `ExecuteLine.autoSwap`；启用分支中的 `ctx.service.autoSwap.start(line)` 当前被注释掉了。
2. **`autoSwap.start` 先初始化批次。** 启动时先获取当前 `ExecuteData`，恢复 pending boss，并在新活动批次尚无钱包时生成钱包，然后执行余额检查。首次 boss 未充值时会返回待充值提示。
3. **钱包和配置依赖数组下标匹配。** `walletConfig[index]` 与数据库查询结果的 `ExecuteWallet[index]` 被直接配对，但查询没有显式排序。钱包数量变化或替换后，建议增加稳定排序/序号字段，否则可能把错误的交易配置配给钱包。
4. **`nextWallet` 创建时使用了 `active:false`，模型字段实际叫 `isActive`。** 后续代码会再把新地址更新成 `isActive=true`，但字段命名不一致，且新记录没有补充 `createTime` 等批次元数据。
5. **私钥以明文 Base58 保存。** `ExecuteData`、`ExecuteWallet`、根目录 `keypair.json` 都直接保存私钥；生产环境至少应限制数据库和文件权限，并考虑加密存储和密钥轮换。
6. **`initTokenList` 目前是空实现。** 调用初始化接口不会生成或同步 `ExecuteToken`。
7. **`end` 不负责切换批次。** 它只回收资产；批次状态切换要等下一次 `/start`，且 `/start` 会先检查钱包余额是否已清零。
8. **`status=end` 更像历史兼容状态。** 当前 `sellToken(type="all")` 实际写入的是 `status=sell`，代码只在统计 `buyTimes` 时查询 `status=end`，主流程中没有看到把代币更新为 `end` 的路径。

## 8. 推荐的人工操作顺序

如果不使用自动服务，一轮线路执行可以按下面顺序调用：

```text
1. 确认 ExecuteLine 配置
2. /v1/execute/start
3. /v1/execute/generateWallets
4. /v1/executetoken/tokenList（可选）
5. /v1/execute/checkToken
6. /v1/execute/buyToken
7. /v1/execute/sellToken（可多阶段）
8. /v1/execute/closeAllAccounts
9. /v1/execute/end
10. /v1/execute/withdraw（可选）
11. 下一轮再次 /v1/execute/start，触发新 eid
```

排查问题时，优先用 `line` 找当前活动 `ExecuteData`，再用 `eid` 关联 `ExecuteWallet` 和 `ExecuteToken`。不要只按钱包地址或 token 地址排查，因为同一个地址可能跨线路或跨批次出现。
