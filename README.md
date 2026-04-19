# arbitration-log

GitHub Pages 静态网页，在浏览器本地解析 Warframe 的 `EE.log`，提取仲裁记录并计算关键指标。

日志不会上传到服务器，解析完全在本地进行。

**仅限主机的 EE.log**

---

## 使用方式

1. 打开网页
2. 拖拽或点击上传 `EE.log`（支持 2GB+ 大文件）
3. 页面默认展示最近有效 2 次仲裁，可自行调整次数

### EE.log 路径（Windows）

```
%LOCALAPPDATA%\Warframe
```

---

## 展示指标

每次仲裁展示：

| 指标 | 说明 |
|------|------|
| 无人机生成 | `CorpusEliteShieldDroneAgent` 生成次数 |
| 敌人生成 | 区间内最后一条 `OnAgentCreated` 的 `Spawned N` |
| 无人机/分钟 | 无人机生成 ÷ (总时间秒 / 60) |
| 总时间 | 见下文 |
| 波次 / 轮次 | 见下文 |
| 期望生息（总）/ 生息/h / 生息/min | 见下文 |
| 评级 | 按满状态 1h 期望生息 |
| 敌人饱和度 | 存活敌人分布（总时间占比 + 有效时间占比） |

---

## 任务定位：开始与结束标记

### 开始标记（两种，任意一种命中即可）

```
Script [Info]: ThemedSquadOverlay.lua: Mission name: <任意> - 仲裁
Script [Info]: ThemedSquadOverlay.lua: ShowMissionVote <任意> - 仲裁 ... (<NodeId>_EliteAlert)
```

`NodeId` 获取：
- `Mission name` 行：从后续最多 15 行内的 `Host loading {"name":"<NodeId>_EliteAlert"}` 提取
- `ShowMissionVote` 行：直接从括号内提取 `<NodeId>`

### 结束标记

```
Script [Info]: Background.lua: EliteAlertMission at <NodeId> (...)
```

NodeId 必须与开始处获取的一致；同一把任务可能多次出现，取**最后一次**。

若缺失 `EliteAlertMission at`，则以 `SS_ENDING` 作为结束点。

### 统计区间

- 起点：`SS_STARTED`（`GameRulesImpl - changing state from SS_WAITING_FOR_PLAYERS to SS_STARTED`）
- 终点：`SS_ENDING`（`GameRulesImpl - changing state from SS_STARTED to SS_ENDING`）

开始标记后若未进入 `SS_STARTED`（如倒计时出现但未进图），不计入统计。`SS_ENDING` 后不再计入生成统计，避免回飞船阶段的 `Spawned 0` 污染数据。

---

## 总时间

**公式**：`eomDurationSec = eomTime − stateStartedTime`

`eomTime` 取 SS_STARTED 之后、SS_ENDING 之前，以下日志最后一次出现的时间戳：

```
Script [Info]: EndOfMatch.lua: Initialize
Script [Info]: ExtractionTimer.lua: EOM: All players extracting
```

页面提供三种时间口径可切换：

| 口径 | 说明 |
|------|------|
| 主机时间 | `eomDurationSec`（默认） |
| 最后客机时间 | `eomTime − lastClientJoinTime`（最后加入队友的视角） |
| 自定义时间 | 手动输入 |

> 时间戳格式：行首通常为 `242.687`，任务失败时带 `!` 前缀（如 `!4631.303`），两种均兼容。

---

## 波次 / 轮次统计

### 防御（Defense）

- **波次标记**：`Script [Info]: WaveDefend.lua: Defense wave: <N>`
- **波次数**：最后见到的 `<N>`
- **轮次数**：`⌈波次 / 3⌉`（每 3 波 1 轮）

### 拦截（Interception）

- **轮次边界（优先）**：
  ```
  Script [Info]: HudRedux.lua: Queuing new transmission: InterNewRoundLotusTransmission
  ```
- **轮次边界（兜底）**（当上述标记缺失时）：
  ```
  Script [Info]: DefenseReward.lua: DefenseReward::TransitionOut
  ```
- **轮次数**：边界标记出现次数

### 镜像防御（Mirror Defense）

适用地图（通过 `levelOverride` 识别）：
- `LastWish/LastWishDefense`（Citrine · 火星）
- `EntratiLab/EntratiLabMirrorDefense`（墓垒 · 火卫二）

- **波次标记**：`Script [Info]: LoopDefend.lua: Loop Defense wave: <N>`
- **轮次边界**：`DefenseReward::TransitionOut`（每轮 2 波）
- **特殊处理**：LoopDefend.lua 的内部计数器 buffer 长度为 29，超过后计数器归零（如 29→1）。解析器检测到归零时将 offset 累加，跳过归零标记，确保波次编号正确累计。

---

## 敌人饱和度

解析器在统计区间内逐秒采集 `MonitoredTicking` 值（每条 `OnAgentCreated` 行中的 `MonitoredTicking N`），按 5 一档分桶（0–4、5–9、10–14、…），展示两套时间占比：

| 占比 | 说明 |
|------|------|
| 总时间占比 | 每档的持续时间 ÷ 总采样时间（含 MT=0 时段） |
| 有效时间占比 | 每档的持续时间 ÷ 有效采样时间（排除开局间隙和轮次间隙中 MT=0 的时段） |

**"有效时间"** 的定义：排除两类间隙中 MT=0 的连续段——

1. **开局间隙**：任务开始到 `MonitoredTicking` 首次不为 0
2. **轮次间隙**：持续 ≥3 秒的连续 MT=0 段（轮次结束到敌人重新刷出）

战斗中短暂的 MT=0（<3 秒）仍计入有效时间。

---

## 生息期望与评级

### 无人机掉落期望

初始掉率 6%，状态栏 4 个倍率开关（默认全开）：

| 开关 | 倍率 |
|------|------|
| 资源掉落几率加成 | ×2 |
| 富足巡回者 | ×1.18 |
| 资源数量加成 | ×2 |
| 资源掉落几率祝福 | ×1.25 |

```
E_drones = 无人机生成 × 0.06 × (已开启倍率乘积)
```

### 轮次奖励期望

每轮固定 1 个生息，另有概率额外奖励：

```
每轮期望 = 1 + 额外概率 × 额外数量
E_rounds = 轮次 × 每轮期望
```

### 总期望与 1h 期望

```
E_total = E_drones + E_rounds
E_1h    = E_total × (3600 / 总时间秒)
```

### 评级

按**满状态**（4 个倍率全开）下的 `E_1h` 评级：

| 评级 | 条件 |
|------|------|
| S | 1h ≥ 800 |
| A+ | 1h ≥ 700 |
| A | 1h ≥ 600 |
| A- | 1h ≥ 500 |
| F | 1h < 500 |

---

## 节点信息

日志提供 `NodeId`（如 `SolNode64`），节点名/星球/任务类型/派系从以下文件解析：

- `warframe-public-export-plus/ExportRegions.json`：`NodeId → name / systemName / missionName / factionName`（语言 key）
- `warframe-public-export-plus/dict.zh.json`：语言 key → 中文

构建时通过 `scripts/prepare-warframe-data.mjs` 将上述文件复制到 `public/`，运行时由页面直接 fetch。

---

## 大文件支持

使用 `File.slice().arrayBuffer()` 按 4MB 块流式读取，逐行解析。内存占用接近常量，不随日志大小增长，支持 2GB+ 日志文件。

---

## 技术栈

- Next.js（App Router，静态导出）
- TypeScript
- 部署：GitHub Pages + GitHub Actions
