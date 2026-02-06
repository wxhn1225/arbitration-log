## arbitration-log

这是一个部署在 GitHub Pages 的静态网页，用于在浏览器本地解析 `ee.log / EE.log`，提取仲裁记录并计算关键指标。

日志不会上传到服务器；解析完全在你的浏览器本地进行。

---

## 使用方式

1. 打开网页
2. 拖拽或选择你的 `ee.log / EE.log`
3. 页面会展示“最近有效 2 把”的结果，并可进入“查看详细”查看每波/每轮明细

### ee.log 路径（Windows）

`%LOCALAPPDATA%\Warframe`

---

## 网页展示哪些数据

每一把仲裁展示：

- 无人机生成：`/Npc/CorpusEliteShieldDroneAgent` 生成次数
- 敌人生成：区间内最后一条 `AI [Info]: OnAgentCreated ... Spawned N` 的 `N`
- 无人机生成/分钟：`无人机生成 / (总时间秒/60)`
- 总时间：按“总时间优先级”选取（见下文）

并展示用于生息期望/评级的字段：

- 波数（防御）
- 轮次（防御/拦截）
- 期望生息（总）
- 1h 期望生息
- 评级（按“满状态 1h 期望生息”）

---

## 仲裁任务如何被定位（开始/结束与统计区间）

解析器会在日志中定位仲裁的“开始候选段”，并且只有在该候选段后续确实进入 `SS_STARTED` 才会被当作有效任务统计（用于处理“倒计时出现但没进图”的情况）。

### 1) 开始标记（两种）

优先匹配下面任意一种即可视为“开始候选”：

1. `Script [Info]: ThemedSquadOverlay.lua: Mission name: <任意> - 仲裁`
2. `Script [Info]: ThemedSquadOverlay.lua: ShowMissionVote <任意> - 仲裁 ... (<NodeId>_EliteAlert)`

`NodeId` 获取规则：

- `Mission name`：默认取下一行 `Host loading {"name":"<NodeId>_EliteAlert"}`；若下一行不匹配，最多向后扫描 15 行补抓
- `ShowMissionVote`：直接从括号 `(SolNode149_EliteAlert)` 中提取 `<NodeId>`

### 2) 结束标记（NodeId 一致优先）

- 优先：`Script [Info]: Background.lua: EliteAlertMission at <NodeId> ...`
  - 同一把任务可能出现多次，取同 `NodeId` 的最后一次
- 若缺失 `EliteAlertMission at`：使用 `SS_ENDING` 作为结束点

### 3) 统计窗口收敛（避免误计数）

- **收敛规则（本项目最终规则）**：
  - **只在 SS_STARTED 之后开始计入**：开始计入无人机生成、敌人生成、波次/轮次等“生成统计”。
  - **SS_ENDING 之后不再计入生成统计**：避免其他任务的 `OnAgentCreated ... Spawned` 覆盖最终统计。

- **日志原始行（可直接搜索）**：
  - SS_STARTED（任务开始）：
    - `Net [Info]: GameRulesImpl - changing state from SS_WAITING_FOR_PLAYERS to SS_STARTED`
  - SS_ENDING（任务结束/结算流程开始）：
    - `Net [Info]: GameRulesImpl - changing state from SS_STARTED to SS_ENDING`

> 时间戳格式：行首通常是 `242.687`，任务失败时会带 `!` 前缀例如 `!4631.303`；本项目解析时间戳时会同时兼容这两种格式。

---

## 总时间（Total Time）如何计算

总时间使用统一的 `totalSec` 口径，优先级如下（越靠前优先级越高）：

### 1) 结算 UI（EOM）优先：游戏内“结算用时”

- **公式**：`eomDurationSec = eomTime - stateStartedTime`
- **eomTime 的日志标记**（取 SS_STARTED 之后、SS_ENDING 之前出现的最后一次时间戳）：
  - `Script [Info]: EndOfMatch.lua: Initialize`
  - `Script [Info]: ExtractionTimer.lua: EOM: All players extracting`

### 2) 状态机时长（SS_STARTED → SS_ENDING）

- **公式**：`stateDurationSec = stateEndingTime - stateStartedTime`
- **stateStartedTime 的日志标记**：
  - `Net [Info]: GameRulesImpl - changing state from SS_WAITING_FOR_PLAYERS to SS_STARTED`
- **stateEndingTime 的日志标记**：
  - `Net [Info]: GameRulesImpl - changing state from SS_STARTED to SS_ENDING`

---

## 无人机生成（Drones Generated）

在统计窗口内，计数以下行的出现次数：

`AI [Info]: OnAgentCreated /Npc/CorpusEliteShieldDroneAgent...`

---

## 敌人生成（Enemies Spawned）

在统计窗口内，找到最后一条 `AI [Info]: OnAgentCreated ... Spawned N`，取其中的 `N` 作为“敌人生成”。

说明：

- 这个 `Spawned` 仅包含敌对派系的单位
- 它不包含无人机、友军单位在内的生成累计

---

## 波次 / 轮次统计与“查看详细”

页面的“查看详细”会展示每波/每轮的：

- 无人机生成数
- 该波/轮的无人机期望生息（按当前倍率）

### 防御（Defense）

- 波次标记：`Script [Info]: WaveDefend.lua: Defense wave: <N>`
- 波数：`<N>` 最大值
- 轮次：每 3 波 1 轮：`ceil(wave/3)`

### 拦截（Interception）

使用播报作为轮次结束：

`Script [Info]: HudRedux.lua: Queuing new transmission: InterNewRoundLotusTransmission`

实现要点：

- 对播报前出现的无人机，归入第 1 轮
- finalize 时裁掉尾部空桶

---

## 生息期望与评级

### 1) 无人机掉落期望

- 初始掉率：6%
- BUFF 开关（默认全开；关闭则不计入）：
  - 资源掉落几率加成：×2
  - 富足巡回者：×1.18
  - 资源数量加成：×2
  - 资源掉落几率祝福：×1.25

无人机掉落期望：

`E_drones = 无人机生成 × 0.06 × (倍率乘积)`

### 2) 轮次奖励期望

- 每轮固定给 1
- 7% 概率额外给 3

每轮期望：`1 + 0.07×3 = 1.21`

轮次期望：

`E_rounds = 轮次 × 1.21`

### 3) 总期望与 1h 期望

- `E_total = E_drones + E_rounds`
- `E_1h = E_total × (3600 / totalSec)`

### 4) 评级

按“满 BUFF ”下的 `E_1h` 评级：

- S：1h ≥ 800
- A+：1h ≥ 700
- A：1h ≥ 600
- A-：1h ≥ 500
- F：1h ＜ 500

---



