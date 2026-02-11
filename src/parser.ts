export type MissionStartKind = "missionName" | "missionVote" | "hostLoading";

export type MissionResult = {
  index: number;
  nodeId?: string; // e.g. SolNode64, CrewBattleNode523, ...
  missionName?: string; // e.g. 兰麦地亚 (海王星)
  missionKind?: "defense" | "interception" | "unknown";
  startKind: MissionStartKind;
  startLine: number; // 1-based
  endLine?: number; // 1-based
  startTime?: number; // seconds, from log prefix
  endTime?: number;
  durationSec?: number;
  stateStartedTime?: number; // SS_STARTED timestamp
  stateEndingTime?: number; // SS_ENDING timestamp
  stateDurationSec?: number; // stateEndingTime - stateStartedTime
  eomTime?: number; // EndOfMatch/Extraction (mission complete UI) timestamp
  eomDurationSec?: number; // eomTime - stateStartedTime
  lastClientJoinTime?: number; // 最后一个“中途加入”的客机开始计时时间
  lastClientDurationSec?: number; // 结束参考时间 - lastClientJoinTime
  spawnedAtEnd?: number; // Spawned N from last OnAgentCreated in segment
  firstOnAgentCreatedTime?: number;
  lastOnAgentCreatedTime?: number;
  onAgentCreatedSpanSec?: number; // last - first
  shieldDronePerMin?: number;
  shieldDroneCount: number; // OnAgentCreated /Npc/CorpusEliteShieldDroneAgent*
  waveCount?: number; // defense only
  roundCount?: number; // defense/interception
  phases?: Array<{
    kind: "wave" | "round";
    index: number; // 1-based
    shieldDroneCount: number;
  }>;
  status: "ok" | "incomplete";
  note?: string;
};

export type ParseResult = {
  missions: MissionResult[];
  warnings: string[];
  validTotal?: number; // 日志内总共识别到多少把“有效仲裁”
};

// 有些日志行会在时间戳前带 "!"（例如 "!4631.303"），需要兼容
const reTimePrefix = /^!?(\d+(?:\.\d+)?)\s+/;

const reStartMissionName =
  /Script \[Info\]: ThemedSquadOverlay\.lua: Mission name:\s*(.+?)\s*-\s*仲裁/;

// 某些日志没有 Mission name 行，但会有投票/选任务行（仍含 “- 仲裁” 与 NodeId）
// e.g. ThemedSquadOverlay.lua: ShowMissionVote Casta (谷神星) - 仲裁 - 等级 ... (SolNode149_EliteAlert) -1
const reStartMissionVote =
  /Script \[Info\]: ThemedSquadOverlay\.lua: ShowMissionVote\s+(.+?)\s*-\s*仲裁/;
const reVoteNodeId = /\(([A-Za-z0-9_]+)_EliteAlert\)/;

const reHostLoading =
  /Script \[Info\]: ThemedSquadOverlay\.lua: Host loading .*"name":"([^"]+)_EliteAlert"/;

const reEnd =
  /Script \[Info\]: Background\.lua: EliteAlertMission at ([A-Za-z0-9_]+)\b/;

const reStateStarted =
  /GameRulesImpl - changing state from SS_WAITING_FOR_PLAYERS to SS_STARTED/;
const reStateEnding =
  /GameRulesImpl - changing state from SS_STARTED to SS_ENDING/;

// 任务结算 UI 出现的时间（通常更接近玩家看到的“结算用时”）
const reEomInit = /Script \[Info\]: EndOfMatch\.lua: Initialize\b/;
const reAllExtracting = /Script \[Info\]: ExtractionTimer\.lua: EOM: All players extracting\b/;
const reClientJoinInProgressNode =
  /Script \[Info\]: ThemedSquadOverlay\.lua: LoadLevelMsg received\. Client joining mission in-progress:\s*\{"name":"([^"]+)_EliteAlert"\}/;
const reSendLoadLevelNode =
  /Net \[Info\]: Sending LOAD_LEVEL to (.+?)\s+\[mission=\{"name":"([^"]+)_EliteAlert"\}\]/;
const reCreatePlayerForClient =
  /Game \[Info\]: CreatePlayerForClient\. id=(\d+), user name=(.+)$/;

const reAnyOnAgentCreated = /AI \[Info\]: OnAgentCreated\b/;
const reSpawned = /\bSpawned\s+(\d+)\b/;
const reShieldDrone =
  /AI \[Info\]: OnAgentCreated \/Npc\/CorpusEliteShieldDroneAgent\d*\b/;

const reDefenseWave = /Script \[Info\]: WaveDefend\.lua: Defense wave:\s*(\d+)\b/;
const reInterceptionNewRound =
  /Script \[Info\]: HudRedux\.lua: Queuing new transmission: InterNewRoundLotusTransmission\b/;
// 某些拦截日志没有 InterNewRoundLotusTransmission，但每轮结算会走 DefenseReward
const reDefenseRewardTransitionOut =
  /Script \[Info\]: DefenseReward\.lua: DefenseReward::TransitionOut\b/;

function parseTime(line: string): number | undefined {
  const m = line.match(reTimePrefix);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

function pickTotalSec(
  m: Pick<MissionResult, "eomDurationSec" | "stateDurationSec" | "onAgentCreatedSpanSec" | "durationSec">
) {
  const z = m.eomDurationSec;
  if (z != null && Number.isFinite(z) && z > 0) return z;
  const a = m.stateDurationSec;
  if (a != null && Number.isFinite(a) && a > 0) return a;
  const b = m.onAgentCreatedSpanSec;
  if (b != null && Number.isFinite(b) && b > 0) return b;
  const c = m.durationSec;
  if (c != null && Number.isFinite(c) && c > 0) return c;
  return undefined;
}

const calcPerMin = (count: number, spanSec?: number): number | undefined => {
  if (spanSec == null) return undefined;
  if (!Number.isFinite(spanSec) || spanSec <= 0) return undefined;
  const perMin = count / (spanSec / 60);
  return Number.isFinite(perMin) ? perMin : undefined;
};

function parseAllEeLog(text: string): ParseResult {
  const warnings: string[] = [];
  const missions: MissionResult[] = [];

  const lines = text.split(/\r?\n/);

  let current:
    | (Omit<MissionResult, "index" | "shieldDroneCount" | "status"> & {
        startLine0: number; // 0-based
        startTime?: number;
        nodeId?: string;
        missionName?: string;
        startKind: MissionStartKind;
      })
    | null = null;

  // 聚合统计用（在 current 存在时实时更新）
  let curShieldDroneCount = 0;
  let curLastSpawned: number | undefined = undefined;
  let curLastOnAgentLine0: number | undefined = undefined;
  let curFirstOnAgentLine0: number | undefined = undefined;
  let curFirstOnAgentTime: number | undefined = undefined;
  let curLastOnAgentTime: number | undefined = undefined;

  const flushIncomplete = (reason: string) => {
    if (!current) return;
    const spanSec =
      curFirstOnAgentTime != null && curLastOnAgentTime != null
        ? curLastOnAgentTime - curFirstOnAgentTime
        : undefined;
    missions.push({
      index: missions.length + 1,
      nodeId: current.nodeId,
      missionName: current.missionName,
      startKind: current.startKind,
      startLine: current.startLine0 + 1,
      startTime: current.startTime,
      shieldDroneCount: curShieldDroneCount,
      spawnedAtEnd: curLastSpawned,
      firstOnAgentCreatedTime: curFirstOnAgentTime,
      lastOnAgentCreatedTime: curLastOnAgentTime,
      onAgentCreatedSpanSec: spanSec != null && Number.isFinite(spanSec) ? spanSec : undefined,
      shieldDronePerMin: calcPerMin(curShieldDroneCount, spanSec),
      status: "incomplete",
      note: reason,
    });
    current = null;
    curShieldDroneCount = 0;
    curLastSpawned = undefined;
    curLastOnAgentLine0 = undefined;
    curFirstOnAgentLine0 = undefined;
    curFirstOnAgentTime = undefined;
    curLastOnAgentTime = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // 任务开始标记（两种）
    const mName = line.match(reStartMissionName);
    const mHost = line.match(reHostLoading);

    if (!current) {
      if (mName) {
        current = {
          startLine0: i,
          startLine: i + 1,
          startTime: parseTime(line),
          startKind: "missionName",
          missionName: mName[1]?.trim() || undefined,
        } as any;
        continue;
      }
      if (mHost) {
        current = {
          startLine0: i,
          startLine: i + 1,
          startTime: parseTime(line),
          startKind: "hostLoading",
          nodeId: mHost[1],
        } as any;
        continue;
      }
    } else {
      // current 存在时，补齐信息（nodeId / missionName）
      if (!current.missionName && mName) {
        current.missionName = mName[1]?.trim() || undefined;
      }
      if (!current.nodeId && mHost) {
        current.nodeId = mHost[1];
      }

      // 在一个任务未结束前又出现“任务开始”，通常意味着日志缺失/断段
      if (mName || mHost) {
        // 只有当新开始行不是当前开始行本身时才判定为冲突
        if (i !== current.startLine0) {
          flushIncomplete(
            `在第 ${i + 1} 行遇到新的任务开始标记，但上一个任务尚未匹配到结束标记`
          );
          // 重新以当前行作为新的开始
          i -= 1; // 回退一行，让外层逻辑重新处理这一行
        }
        continue;
      }

      // 区间内统计：无人机数量
      if (reShieldDrone.test(line)) {
        curShieldDroneCount++;
      }

      // 区间内统计：最后一条 OnAgentCreated 的 Spawned
      if (reAnyOnAgentCreated.test(line)) {
        const t = parseTime(line);
        if (curFirstOnAgentLine0 == null) {
          curFirstOnAgentLine0 = i;
          if (t != null) curFirstOnAgentTime = t;
        }
        curLastOnAgentLine0 = i;
        if (t != null) curLastOnAgentTime = t;
        const sm = line.match(reSpawned);
        if (sm) {
          const n = Number(sm[1]);
          if (Number.isFinite(n)) curLastSpawned = n;
        }
      }

      // 任务结束标记（必须 SolNode 一致）
      const mEnd = line.match(reEnd);
      if (mEnd && current.nodeId && mEnd[1] === current.nodeId) {
        const endTime = parseTime(line);
        const dur =
          current.startTime != null && endTime != null ? endTime - current.startTime : undefined;
        const spanSec =
          curFirstOnAgentTime != null && curLastOnAgentTime != null
            ? curLastOnAgentTime - curFirstOnAgentTime
            : undefined;

        missions.push({
          index: missions.length + 1,
          nodeId: current.nodeId,
          missionName: current.missionName,
          startKind: current.startKind,
          startLine: current.startLine0 + 1,
          endLine: i + 1,
          startTime: current.startTime,
          endTime,
          durationSec: dur != null && Number.isFinite(dur) ? dur : undefined,
          spawnedAtEnd: curLastSpawned,
          firstOnAgentCreatedTime: curFirstOnAgentTime,
          lastOnAgentCreatedTime: curLastOnAgentTime,
          onAgentCreatedSpanSec: spanSec != null && Number.isFinite(spanSec) ? spanSec : undefined,
          shieldDronePerMin: calcPerMin(curShieldDroneCount, spanSec),
          shieldDroneCount: curShieldDroneCount,
          status: "ok",
          note:
            curLastOnAgentLine0 != null
              ? `最后一条 OnAgentCreated 位于第 ${curLastOnAgentLine0 + 1} 行`
              : "区间内未找到 OnAgentCreated",
        });

        current = null;
        curShieldDroneCount = 0;
        curLastSpawned = undefined;
        curLastOnAgentLine0 = undefined;
        curFirstOnAgentLine0 = undefined;
        curFirstOnAgentTime = undefined;
        curLastOnAgentTime = undefined;
      }
    }
  }

  // 文件结束仍未闭合
  if (current) {
    flushIncomplete("文件结束仍未匹配到任务结束标记（可能缺失结束行或未抓到 SolNode）");
  }

  if (missions.length === 0) {
    warnings.push("未在日志中找到任何仲裁任务开始标记。");
  } else {
    const incomplete = missions.filter((m) => m.status !== "ok").length;
    if (incomplete > 0) warnings.push(`有 ${incomplete} 个任务未能完整匹配到结束标记。`);
  }

  return { missions, warnings };
}

function parseLatestEeLog(text: string): ParseResult {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);

  // 从末尾往前找最近的“任务开始”标记（必须带“仲裁”）：
  // Script [Info]: ThemedSquadOverlay.lua: Mission name: <任意> - 仲裁
  // 下一行应为节点：
  // Script [Info]: ThemedSquadOverlay.lua: Host loading {"name":"SolNodeXX_EliteAlert"} with MissionInfo:
  let startIdx: number | null = null;
  let startKind: MissionStartKind | null = null;
  let nodeId: string | undefined = undefined;
  let missionName: string | undefined = undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const mName = line.match(reStartMissionName);
    if (mName) {
      startIdx = i;
      startKind = "missionName";
      missionName = mName[1]?.trim() || undefined;
      break;
    }
  }

  if (startIdx == null || startKind == null) {
    return { missions: [], warnings: ["未在日志中找到任何仲裁任务开始标记。"] };
  }

  // 开始标记下一行应为 Host loading（节点）
  const nextLine = lines[startIdx + 1] ?? "";
  const nextHost = nextLine.match(reHostLoading);
  if (nextHost) {
    nodeId = nextHost[1];
  } else {
    // 兼容极少数情况下节点行不是紧贴下一行（但仍然只以 Mission name 行作为开始）
    let found: string | undefined = undefined;
    for (let j = startIdx + 1; j < Math.min(lines.length, startIdx + 15); j++) {
      const l = lines[j] ?? "";
      const m = l.match(reHostLoading);
      if (m) {
        found = m[1];
        break;
      }
    }
    if (found) {
      nodeId = found;
      warnings.push("开始标记后的下一行未匹配到节点，已在后续行中补抓 SolNode。");
    } else {
      warnings.push("开始标记后的下一行未匹配到节点（SolNode），结束标记将无法严格匹配。");
    }
  }

  const startLine0 = startIdx;
  const startTime = parseTime(lines[startIdx] ?? "");

  let endIdx: number | undefined = undefined;
  let endTime: number | undefined = undefined;

  // 向下扫描，拿到“最后一条”匹配 SolNode 的结束标记（同一个任务期间可能会出现多次）
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // 补齐 missionName / nodeId（如果开始行缺失其中之一）
    if (!missionName) {
      const mName = line.match(reStartMissionName);
      if (mName) missionName = mName[1]?.trim() || undefined;
    }
    // nodeId 理论上来自开始标记下一行；这里不再“随便补抓”，避免误配

    const mEnd = line.match(reEnd);
    if (mEnd && nodeId && mEnd[1] === nodeId) {
      endIdx = i;
      endTime = parseTime(line);
      // 不 break，继续找同 SolNode 的更靠后的结束标记
    }
  }

  const endLimit0 = endIdx ?? lines.length - 1;

  // 在 [startIdx, endLimit0] 区间内做统计
  let shieldDroneCount = 0;
  let lastSpawned: number | undefined = undefined;
  let lastOnAgentLine0: number | undefined = undefined;
  let firstOnAgentTime: number | undefined = undefined;
  let lastOnAgentTime: number | undefined = undefined;
  let firstOnAgentLine0: number | undefined = undefined;

  for (let i = startIdx + 1; i <= endLimit0; i++) {
    const line = lines[i] ?? "";

    if (!missionName) {
      const mName = line.match(reStartMissionName);
      if (mName) missionName = mName[1]?.trim() || undefined;
    }
    if (!nodeId) {
      const mHost = line.match(reHostLoading);
      if (mHost) nodeId = mHost[1];
    }

    if (reShieldDrone.test(line)) {
      shieldDroneCount++;
    }

    if (reAnyOnAgentCreated.test(line)) {
      lastOnAgentLine0 = i;
      const t = parseTime(line);
      if (firstOnAgentLine0 == null) {
        firstOnAgentLine0 = i;
        if (t != null) firstOnAgentTime = t;
      }
      if (t != null) lastOnAgentTime = t;

      const sm = line.match(reSpawned);
      if (sm) {
        const n = Number(sm[1]);
        if (Number.isFinite(n)) lastSpawned = n;
      }
    }
  }

  const durationSec =
    startTime != null && endTime != null ? endTime - startTime : undefined;
  const spanSec =
    firstOnAgentTime != null && lastOnAgentTime != null
      ? lastOnAgentTime - firstOnAgentTime
      : undefined;
  const effectiveSpanSec =
    spanSec != null && Number.isFinite(spanSec) && spanSec > 0
      ? spanSec
      : durationSec != null && Number.isFinite(durationSec) && durationSec > 0
        ? durationSec
        : undefined;

  const mission: MissionResult = {
    index: 1,
    nodeId,
    missionName,
    startKind,
    startLine: startLine0 + 1,
    endLine: endIdx != null ? endIdx + 1 : undefined,
    startTime,
    endTime,
    durationSec: durationSec != null && Number.isFinite(durationSec) ? durationSec : undefined,
    spawnedAtEnd: lastSpawned,
    firstOnAgentCreatedTime: firstOnAgentTime,
    lastOnAgentCreatedTime: lastOnAgentTime,
    onAgentCreatedSpanSec: spanSec != null && Number.isFinite(spanSec) ? spanSec : undefined,
    shieldDronePerMin: calcPerMin(shieldDroneCount, effectiveSpanSec),
    shieldDroneCount,
    status: endIdx != null ? "ok" : "incomplete",
    note:
      endIdx != null
        ? lastOnAgentLine0 != null
          ? `最后一条 OnAgentCreated 位于第 ${lastOnAgentLine0 + 1} 行`
          : "区间内未找到 OnAgentCreated"
        : "未在开始标记之后匹配到任务结束标记（或未获取到 SolNode）",
  };

  if (mission.status !== "ok") {
    warnings.push("最新一次仲裁任务未能完整匹配到结束标记。");
  }

  return { missions: [mission], warnings };
}

export function parseEeLog(
  text: string,
  opts?: { mode?: "latest" | "all" }
): ParseResult {
  const mode = opts?.mode ?? "latest";
  return mode === "all" ? parseAllEeLog(text) : parseLatestEeLog(text);
}

async function readTailText(file: File, tailBytes: number): Promise<string> {
  const start = Math.max(0, file.size - tailBytes);
  // 用 slice + text() 避免一次性读取整文件
  return await file.slice(start).text();
}

export type ParseLatestFromFileOptions = {
  initialTailBytes?: number;
  maxTailBytes?: number;
};

export type ParseRecentValidFromFileOptions = ParseLatestFromFileOptions & {
  count?: number; // 最近有效几把
  minDurationSec?: number; // 小于该时长视为无效（默认 60s）
  chunkBytes?: number; // 流式读取块大小
};

function parseRecentMissionsInText(text: string): ParseResult {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);

  const startIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (reStartMissionName.test(line)) startIdxs.push(i);
  }

  if (startIdxs.length === 0) {
    return { missions: [], warnings: ["未在日志中找到任何仲裁任务开始标记。"] };
  }

  const missions: MissionResult[] = [];

  for (let s = 0; s < startIdxs.length; s++) {
    const startIdx = startIdxs[s]!;
    const boundary = s + 1 < startIdxs.length ? startIdxs[s + 1]! - 1 : lines.length - 1;
    const startLine = lines[startIdx] ?? "";
    const mName = startLine.match(reStartMissionName);
    const missionName = mName?.[1]?.trim() || undefined;

    // 节点：优先下一行，否则向后最多 15 行（且不跨越下一次开始标记）
    let nodeId: string | undefined = undefined;
    const nextLine = lines[startIdx + 1] ?? "";
    const nextHost = nextLine.match(reHostLoading);
    if (nextHost) {
      nodeId = nextHost[1];
    } else {
      for (let j = startIdx + 1; j <= Math.min(boundary, startIdx + 15); j++) {
        const l = lines[j] ?? "";
        const m = l.match(reHostLoading);
        if (m) {
          nodeId = m[1];
          break;
        }
      }
    }

    const startTime = parseTime(startLine);

    // 在本次边界内选择“最后一条”结束标记（避免早期初始化的同名打印）
    let endIdx: number | undefined = undefined;
    let endTime: number | undefined = undefined;
    if (nodeId) {
      for (let i = startIdx + 1; i <= boundary; i++) {
        const line = lines[i] ?? "";
        const mEnd = line.match(reEnd);
        if (mEnd && mEnd[1] === nodeId) {
          endIdx = i;
          endTime = parseTime(line);
        }
      }
    }

    const endLimit0 = endIdx ?? boundary;

    // 区间统计
    let shieldDroneCount = 0;
    let lastSpawned: number | undefined = undefined;
    let firstOnAgentTime: number | undefined = undefined;
    let lastOnAgentTime: number | undefined = undefined;
    let stateStartedTime: number | undefined = undefined;
    let stateEndingTime: number | undefined = undefined;

    for (let i = startIdx + 1; i <= endLimit0; i++) {
      const line = lines[i] ?? "";

      if (reShieldDrone.test(line)) shieldDroneCount++;

      if (reAnyOnAgentCreated.test(line)) {
        const t = parseTime(line);
        if (t != null) {
          if (firstOnAgentTime == null) firstOnAgentTime = t;
          lastOnAgentTime = t;
        }
        const sm = line.match(reSpawned);
        if (sm) {
          const n = Number(sm[1]);
          if (Number.isFinite(n)) lastSpawned = n;
        }
      }

      if (stateStartedTime == null && reStateStarted.test(line)) {
        const t = parseTime(line);
        if (t != null) stateStartedTime = t;
      }
      // 结束态可能打印多次：取最后一次更稳
      if (reStateEnding.test(line)) {
        const t = parseTime(line);
        if (t != null) stateEndingTime = t;
      }
    }

    const durationSec =
      startTime != null && endTime != null ? endTime - startTime : undefined;
    const onAgentSpanSec =
      firstOnAgentTime != null && lastOnAgentTime != null
        ? lastOnAgentTime - firstOnAgentTime
        : undefined;
    const stateDurationSec =
      stateStartedTime != null && stateEndingTime != null
        ? stateEndingTime - stateStartedTime
        : undefined;

    const totalSec = pickTotalSec({
      stateDurationSec,
      onAgentCreatedSpanSec: onAgentSpanSec,
      durationSec,
    });

    missions.push({
      index: missions.length + 1,
      nodeId,
      missionName,
      startKind: "missionName",
      startLine: startIdx + 1,
      endLine: endIdx != null ? endIdx + 1 : undefined,
      startTime,
      endTime,
      durationSec: durationSec != null && Number.isFinite(durationSec) ? durationSec : undefined,
      stateStartedTime,
      stateEndingTime,
      stateDurationSec:
        stateDurationSec != null && Number.isFinite(stateDurationSec) ? stateDurationSec : undefined,
      spawnedAtEnd: lastSpawned,
      firstOnAgentCreatedTime: firstOnAgentTime,
      lastOnAgentCreatedTime: lastOnAgentTime,
      onAgentCreatedSpanSec:
        onAgentSpanSec != null && Number.isFinite(onAgentSpanSec) ? onAgentSpanSec : undefined,
      shieldDronePerMin: calcPerMin(shieldDroneCount, totalSec),
      shieldDroneCount,
      status: endIdx != null ? "ok" : "incomplete",
      note: totalSec != null ? `totalSec=${totalSec.toFixed(3)}` : undefined,
    });
  }

  return { missions, warnings };
}

/**
 * 面向移动端的解析入口：只读取日志文件尾部并逐步扩大范围。
 * 默认仅为“最新一次仲裁”服务（parseEeLog 的 latest 模式）。
 */
export async function parseLatestEeLogFromFile(
  file: File,
  options?: ParseLatestFromFileOptions
): Promise<ParseResult> {
  const initial = options?.initialTailBytes ?? 4 * 1024 * 1024; // 4MB
  // 不做人为上限：必要时可扩到整文件（大日志也能解析）
  const max = options?.maxTailBytes ?? file.size;

  // 逐步扩大尾部窗口，直到能稳定解析出一条任务（并尽量拿到节点）
  let tail = Math.min(Math.max(256 * 1024, initial), Math.max(256 * 1024, max));
  while (true) {
    const text = await readTailText(file, tail);
    const res = parseEeLog(text, { mode: "latest" });
    const m = res.missions[0];

    const needMore =
      res.missions.length === 0 ||
      (m != null && (m.nodeId == null || (m.status === "incomplete" && tail < max)));

    if (!needMore) return res;
    if (tail >= max) return res;

    tail = Math.min(max, tail * 2);
  }
}

/**
 * 解析“最近有效的 N 次仲裁”（默认 2 次），并排除时长 < 60s 的记录。
 * 为移动端优化：仅读取文件尾部并逐步扩大窗口。
 */
export async function parseRecentValidEeLogFromFile(
  file: File,
  options?: ParseRecentValidFromFileOptions,
  onProgress?: (progress01: number) => void
): Promise<ParseResult> {
  const count = options?.count ?? 2;
  const minDurationSec = options?.minDurationSec ?? 60;
  const chunkBytes = options?.chunkBytes ?? 4 * 1024 * 1024; // 4MB

  // 流式逐块读取：避免 2GB+ 日志导致 OOM
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  let offset = 0;
  let lineNo = 0;

  type Run = {
    startKind: MissionStartKind;
    startLine: number;
    endLine?: number;
    startTime?: number;
    endTime?: number;
    missionName?: string;
    nodeId?: string;
    // start 后抓 node 的窗口
    needHostLines: number;

    // metrics
    shieldDroneCount: number;
    lastSpawned?: number;
    firstOnAgentTime?: number;
    lastOnAgentTime?: number;
    stateStartedTime?: number;
    stateEndingTime?: number;
    stateStartedLine?: number;
    stateEndingLine?: number;
    eomTime?: number;
    eomLine?: number;
    lastClientJoinTime?: number;
    loadLevelSentFirstByPlayer: Record<string, number>; // 同一客机重复发送只保留第一次
    lastSeenTime?: number; // 用于“未结束也可分析”的进行中时长估算
    lastSeenLine?: number;

    // phases (defense waves or interception rounds)
    missionKind?: "defense" | "interception" | "unknown";
    phaseKind?: "wave" | "round";
    phases: number[]; // index -> drones count (0-based)
    curPhaseIndex?: number; // 1-based
    // interception round markers count (end-of-round)
    interCompletedRounds?: number;
    interHasTransmissionMarker?: boolean; // InterNewRoundLotusTransmission 是否出现过（出现则不再用 TransitionOut 计数）
    pendingDronesBeforeFirstRoundMarker: number; // interception: drones before first marker -> round 1
    waveCount?: number;
    roundCount?: number;
  };

  let cur: Run | null = null;
  const valid: MissionResult[] = [];
  let validTotal = 0;
  const warnings: string[] = [];

  const finalize = () => {
    if (!cur) return;
    const run = cur;
    // 未结束时：用最后看到的时间当作“当前结束时间”，以便输出进行中统计
    const effectiveEndTime =
      run.endTime ?? run.eomTime ?? run.stateEndingTime ?? run.lastOnAgentTime ?? run.lastSeenTime;
    const durationSec =
      run.startTime != null && effectiveEndTime != null ? effectiveEndTime - run.startTime : undefined;
    const onAgentSpanSec =
      run.firstOnAgentTime != null && run.lastOnAgentTime != null
        ? run.lastOnAgentTime - run.firstOnAgentTime
        : undefined;
    // 进行中：若未进入 SS_ENDING，则用 lastSeenTime 估算已进行的 stateDurationSec
    const stateDurationSec =
      run.stateStartedTime != null && run.stateEndingTime != null
        ? run.stateEndingTime - run.stateStartedTime
        : run.stateStartedTime != null && run.lastSeenTime != null
          ? run.lastSeenTime - run.stateStartedTime
          : undefined;
    const eomDurationSec =
      run.stateStartedTime != null && run.eomTime != null ? run.eomTime - run.stateStartedTime : undefined;
    // 客机口径：优先用 EOM 时间（更贴近玩家看到的“结算用时”），避免被 EliteAlertMission/SS_ENDING 拉长
    const clientEndTime =
      run.eomTime ?? run.endTime ?? run.stateEndingTime ?? run.lastOnAgentTime ?? run.lastSeenTime;
    const lastClientDurationSec =
      run.lastClientJoinTime != null && clientEndTime != null
        ? clientEndTime - run.lastClientJoinTime
        : undefined;

    const totalSec = pickTotalSec({
      eomDurationSec: eomDurationSec != null && Number.isFinite(eomDurationSec) ? eomDurationSec : undefined,
      stateDurationSec,
      onAgentCreatedSpanSec: onAgentSpanSec,
      durationSec,
    });

    // phases: 补全防御/拦截的波次/轮次统计
    if (run.missionKind === "defense") {
      const waveCount =
        run.waveCount != null
          ? run.waveCount
          : run.phases.length
            ? run.phases.length
            : undefined;
      run.waveCount = waveCount;
      run.roundCount = waveCount != null ? Math.ceil(waveCount / 3) : run.roundCount;
      run.phaseKind = "wave";
      if (waveCount != null && run.phases.length > waveCount) run.phases.length = waveCount;
    } else if (run.missionKind === "interception") {
      run.phaseKind = "round";
      // roundCount 优先用“轮次结束播报”的次数（更符合实际：最后一轮不会出现 0）
      const completed = run.interCompletedRounds ?? 0;
      if (completed > 0) {
        run.roundCount = completed;
      } else if (run.roundCount == null) {
        // 没出现 round marker：兜底按已统计到的 phases 或 pending 判断
        if (run.phases.length > 0) run.roundCount = run.phases.length;
        else if (run.pendingDronesBeforeFirstRoundMarker > 0) run.roundCount = 1;
      }
      run.waveCount = run.roundCount;
      // 修剪掉“播报后进入下一轮”的尾部空桶
      if (run.roundCount != null && run.phases.length > run.roundCount) {
        run.phases.length = run.roundCount;
      }
    }

    const m: MissionResult = {
      index: 0,
      nodeId: run.nodeId,
      missionName: run.missionName,
      missionKind: run.missionKind ?? "unknown",
      startKind: run.startKind,
      startLine: run.startLine,
      endLine: run.endLine,
      startTime: run.startTime,
      endTime: run.endTime ?? effectiveEndTime,
      durationSec: durationSec != null && Number.isFinite(durationSec) ? durationSec : undefined,
      stateStartedTime: run.stateStartedTime,
      stateEndingTime: run.stateEndingTime,
      stateDurationSec:
        stateDurationSec != null && Number.isFinite(stateDurationSec) ? stateDurationSec : undefined,
      eomTime: run.eomTime,
      eomDurationSec:
        eomDurationSec != null && Number.isFinite(eomDurationSec) ? eomDurationSec : undefined,
      lastClientJoinTime: run.lastClientJoinTime,
      lastClientDurationSec:
        lastClientDurationSec != null && Number.isFinite(lastClientDurationSec)
          ? lastClientDurationSec
          : undefined,
      spawnedAtEnd: run.lastSpawned,
      firstOnAgentCreatedTime: run.firstOnAgentTime,
      lastOnAgentCreatedTime: run.lastOnAgentTime,
      onAgentCreatedSpanSec:
        onAgentSpanSec != null && Number.isFinite(onAgentSpanSec) ? onAgentSpanSec : undefined,
      shieldDronePerMin: calcPerMin(run.shieldDroneCount, totalSec),
      shieldDroneCount: run.shieldDroneCount,
      waveCount: run.waveCount,
      roundCount: run.roundCount,
      phases:
        run.phaseKind && run.phases.length
          ? run.phases
              .map((n, i) => ({
                kind: run.phaseKind!,
                index: i + 1,
                shieldDroneCount: n,
              }))
          : undefined,
      status: run.endLine != null ? "ok" : "incomplete",
    };

    const hasStarted = run.stateStartedLine != null;
    const hasSpawnSignals =
      run.shieldDroneCount > 0 || run.lastSpawned != null || run.firstOnAgentTime != null;
    // 规则：即使没有结束标记，只要已开始并且有生成信号，也认为“这是一个仲裁”，允许输出（进行中）
    const allowIncomplete = run.endLine == null && hasStarted && hasSpawnSignals;
    const isValid = (totalSec != null && totalSec >= minDurationSec) || allowIncomplete;
    if (isValid) {
      validTotal++;
      valid.push(m);
      while (valid.length > count) valid.shift();
    }
    cur = null;
  };

  const feedLine = (line: string) => {
    lineNo++;

    const mStartName = line.match(reStartMissionName);
    const mStartVote = line.match(reStartMissionVote);
    if (mStartName || mStartVote) {
      // 新开始出现：
      // - 若上一把还没真正进入 SS_STARTED（只是投票/倒计时），则丢弃上一把并直接替换为新的开始
      // - 若上一把已进入 SS_STARTED，则结算上一把再开始新的一把
      if (cur) {
        if (cur.stateStartedLine == null) {
          // 丢弃未开始的候选任务（避免 “开始标记、开始标记、结束标记” 把错误开始当真）
          cur = null;
        } else {
          cur.endLine = cur.endLine ?? lineNo - 1;
          finalize();
        }
      }
      const missionName =
        (mStartName?.[1] ?? mStartVote?.[1] ?? "")?.trim() || undefined;
      const voteNode = mStartVote ? line.match(reVoteNodeId) : null;
      cur = {
        startKind: mStartVote ? "missionVote" : "missionName",
        startLine: lineNo,
        startTime: parseTime(line),
        missionName,
        needHostLines: 15, // 期望下一行是 host loading，最多向后 15 行补抓
        shieldDroneCount: 0,
        missionKind: "unknown",
        phases: [],
        interCompletedRounds: 0,
        interHasTransmissionMarker: false,
        pendingDronesBeforeFirstRoundMarker: 0,
        loadLevelSentFirstByPlayer: {},
      };
      if (voteNode?.[1]) cur.nodeId = voteNode[1];
      return;
    }

    if (!cur) return;

    // 记录进行中“当前时间”（用于未结束也可分析）
    const seenT = parseTime(line);
    if (seenT != null) {
      cur.lastSeenTime = seenT;
      cur.lastSeenLine = lineNo;
    }

    // 先更新状态机时间（用于限定统计窗口）
    if (cur.stateStartedTime == null && reStateStarted.test(line)) {
      const t = parseTime(line);
      if (t != null) cur.stateStartedTime = t;
      cur.stateStartedLine = lineNo;
    }
    // 结束态可能打印多次：取最后一次更稳
    if (reStateEnding.test(line)) {
      // 只有真正进入过 SS_STARTED 的任务才允许用 SS_ENDING 作为结束点（避免 hub 的 ending 误判）
      if (cur.stateStartedLine != null) {
        const t = parseTime(line);
        if (t != null) cur.stateEndingTime = t;
        cur.stateEndingLine = lineNo;
        // 某些日志没有 EliteAlertMission at <NodeId>，用 SS_ENDING 作为结束点
        cur.endLine = lineNo;
        if (t != null) cur.endTime = t;
      }
    }

    const afterEnding = cur.stateEndingLine != null && lineNo > cur.stateEndingLine;

    // 关键：只有 SS_STARTED 之后才开始计入生成统计，避免“倒计时未进图”但开始标记已出现的误计数
    const afterStarted = cur.stateStartedLine != null && lineNo >= cur.stateStartedLine;

    // 补抓 nodeId（尽量靠近开始处）
    if (!cur.nodeId && cur.needHostLines > 0) {
      const h = line.match(reHostLoading);
      if (h) cur.nodeId = h[1];
      cur.needHostLines--;
    }

    // end marker（取最后一次）
    if (cur.nodeId) {
      const e = line.match(reEnd);
      if (e && e[1] === cur.nodeId) {
        cur.endLine = lineNo;
        cur.endTime = parseTime(line);
      }
    }

    // 若已进入 SS_ENDING：仍允许捕捉 end marker，但不再计入波次/轮次/生成统计
    if (afterEnding) return;

    // 结算 UI（更贴近玩家看到的“结算时间”）：记录 SS_STARTED 之后、SS_ENDING 之前出现的最后一次
    if (afterStarted && (reAllExtracting.test(line) || reEomInit.test(line))) {
      const t = parseTime(line);
      if (t != null) {
        cur.eomTime = t;
        cur.eomLine = lineNo;
      }
    }

    // “客机开始计时”标记：取最后一次
    // 1) 客机 in-progress 加入（有些日志会出现）
    // 2) 主机向客机发送 LOAD_LEVEL（更常见，19.log 的 Odin 也是靠这个）
    if (afterStarted) {
      const j = line.match(reClientJoinInProgressNode);
      if (j && cur.nodeId && j[1] === cur.nodeId) {
        const t = parseTime(line);
        if (t != null) cur.lastClientJoinTime = t;
      }
      const s = line.match(reSendLoadLevelNode);
      if (s && cur.nodeId && s[2] === cur.nodeId) {
        const t = parseTime(line);
        const player = s[1]?.trim();
        if (t != null && player) {
          if (cur.loadLevelSentFirstByPlayer[player] == null) {
            cur.loadLevelSentFirstByPlayer[player] = t;
          }
          // “最后客机”定义：按每个客机的首次 LOAD_LEVEL 时间，取其中最晚的一位
          const times = Object.values(cur.loadLevelSentFirstByPlayer);
          if (times.length > 0) cur.lastClientJoinTime = Math.max(...times);
        }
      }
      // 客机“真正进入任务”更接近的标记：CreatePlayerForClient(id>0)
      // id=0 通常是主机本人；id>0 视为客机连接
      const cp = line.match(reCreatePlayerForClient);
      if (cp) {
        const pid = Number(cp[1]);
        if (Number.isFinite(pid) && pid > 0) {
          const t = parseTime(line);
          if (t != null) cur.lastClientJoinTime = t;
        }
      }
    }

    // 识别“防御波次 / 拦截新轮次”标记（只在任务进行中）
    if (afterStarted) {
      const mw = line.match(reDefenseWave);
      if (mw) {
        const w = Number(mw[1]);
        if (Number.isFinite(w) && w > 0) {
          cur.missionKind = "defense";
          cur.phaseKind = "wave";
          cur.curPhaseIndex = w;
          cur.waveCount = Math.max(cur.waveCount ?? 0, w);
          // 确保数组长度 >= w
          while (cur.phases.length < w) cur.phases.push(0);
        }
      }

      // 拦截轮次边界：
      // 1) 优先使用 InterNewRoundLotusTransmission（若存在）
      // 2) 若不存在，使用 DefenseReward::TransitionOut（Ose 这类日志更稳定）
      if (reInterceptionNewRound.test(line)) {
        cur.missionKind = "interception";
        cur.phaseKind = "round";
        cur.interHasTransmissionMarker = true;
        cur.interCompletedRounds = (cur.interCompletedRounds ?? 0) + 1;
        cur.roundCount = cur.interCompletedRounds;
        // 第一次遇到播报：把此前累计的无人机归到第 1 轮
        if (cur.interCompletedRounds === 1 && cur.pendingDronesBeforeFirstRoundMarker > 0) {
          if (cur.phases.length < 1) cur.phases.push(0);
          cur.phases[0] = (cur.phases[0] ?? 0) + cur.pendingDronesBeforeFirstRoundMarker;
          cur.pendingDronesBeforeFirstRoundMarker = 0;
        }
        // 播报之后进入下一轮（active round = completed + 1）
        cur.curPhaseIndex = cur.interCompletedRounds + 1;
      } else if (reDefenseRewardTransitionOut.test(line)) {
        // 注意：Defense 和 Interception 都可能出现该行
        // - 若 node-map 已判定为 defense，则不应把它当作拦截轮次边界
        // - 若 node-map 判定为 interception 或仍未知，则可用作拦截轮次边界（仅当没有 transmission marker）
        const allowAsInterception =
          cur.missionKind !== "defense" && cur.interHasTransmissionMarker !== true;
        if (allowAsInterception) {
          cur.missionKind = "interception";
          cur.phaseKind = "round";
          cur.interCompletedRounds = (cur.interCompletedRounds ?? 0) + 1;
          cur.roundCount = cur.interCompletedRounds;
          // 第一次遇到边界：把此前累计的无人机归到第 1 轮
          if (cur.interCompletedRounds === 1 && cur.pendingDronesBeforeFirstRoundMarker > 0) {
            if (cur.phases.length < 1) cur.phases.push(0);
            cur.phases[0] = (cur.phases[0] ?? 0) + cur.pendingDronesBeforeFirstRoundMarker;
            cur.pendingDronesBeforeFirstRoundMarker = 0;
          }
          // 结算后进入下一轮（active round = completed + 1）
          cur.curPhaseIndex = cur.interCompletedRounds + 1;
        }
      }
    }

    if (afterStarted && reShieldDrone.test(line)) {
      cur.shieldDroneCount++;
      // 分波/轮统计
      if (cur.phaseKind && cur.curPhaseIndex != null && cur.curPhaseIndex > 0) {
        const idx0 = cur.curPhaseIndex - 1;
        while (cur.phases.length <= idx0) cur.phases.push(0);
        cur.phases[idx0] = (cur.phases[idx0] ?? 0) + 1;
      } else if (cur.missionKind !== "defense") {
        // 拦截：尚未遇到轮次边界播报 -> 先暂存（归到第 1 轮）
        cur.pendingDronesBeforeFirstRoundMarker++;
      }
    }

    if (afterStarted && reAnyOnAgentCreated.test(line)) {
      const t = parseTime(line);
      if (t != null) {
        if (cur.firstOnAgentTime == null) cur.firstOnAgentTime = t;
        cur.lastOnAgentTime = t;
      }
      const sm = line.match(reSpawned);
      if (sm) {
        const n = Number(sm[1]);
        if (Number.isFinite(n)) cur.lastSpawned = n;
      }
    }
  };

  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkBytes);
    const buf = await file.slice(offset, end).arrayBuffer();
    const text = decoder.decode(buf, { stream: true });
    const combined = carry + text;
    const parts = combined.split(/\r?\n/);
    carry = parts.pop() ?? "";
    for (const line of parts) feedLine(line);
    offset = end;
    if (onProgress) onProgress(file.size ? offset / file.size : 1);
  }

  const tail = carry + decoder.decode();
  if (tail.trim()) feedLine(tail);
  finalize();

  const missions = valid.map((m, idx) => ({ ...m, index: idx + 1 }));
  if (missions.length < count) {
    warnings.push(`有效记录不足：仅找到 ${missions.length} 次（过滤阈值 ${minDurationSec}s）。`);
  }
  return { missions, warnings, validTotal };
}

