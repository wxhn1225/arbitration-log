export type MissionStartKind = "missionName" | "hostLoading";

export type MissionResult = {
  index: number;
  nodeId?: string; // e.g. SolNode64, CrewBattleNode523, ...
  missionName?: string; // e.g. 兰麦地亚 (海王星)
  startKind: MissionStartKind;
  startLine: number; // 1-based
  endLine?: number; // 1-based
  startTime?: number; // seconds, from log prefix
  endTime?: number;
  durationSec?: number;
  stateStartedTime?: number; // SS_STARTED timestamp
  stateEndingTime?: number; // SS_ENDING timestamp
  stateDurationSec?: number; // stateEndingTime - stateStartedTime
  spawnedAtEnd?: number; // Spawned N from last OnAgentCreated in segment
  firstOnAgentCreatedTime?: number;
  lastOnAgentCreatedTime?: number;
  onAgentCreatedSpanSec?: number; // last - first
  shieldDronePerMin?: number;
  shieldDroneCount: number; // OnAgentCreated /Npc/CorpusEliteShieldDroneAgent*
  status: "ok" | "incomplete";
  note?: string;
};

export type ParseResult = {
  missions: MissionResult[];
  warnings: string[];
};

const reTimePrefix = /^(\d+(?:\.\d+)?)\s+/;

const reStartMissionName =
  /Script \[Info\]: ThemedSquadOverlay\.lua: Mission name:\s*(.+?)\s*-\s*仲裁/;

const reHostLoading =
  /Script \[Info\]: ThemedSquadOverlay\.lua: Host loading .*"name":"([^"]+)_EliteAlert"/;

const reEnd =
  /Script \[Info\]: Background\.lua: EliteAlertMission at ([A-Za-z0-9_]+)\b/;

const reStateStarted =
  /GameRulesImpl - changing state from SS_WAITING_FOR_PLAYERS to SS_STARTED/;
const reStateEnding =
  /GameRulesImpl - changing state from SS_STARTED to SS_ENDING/;

const reAnyOnAgentCreated = /AI \[Info\]: OnAgentCreated\b/;
const reSpawned = /\bSpawned\s+(\d+)\b/;
const reShieldDrone =
  /AI \[Info\]: OnAgentCreated \/Npc\/CorpusEliteShieldDroneAgent\d*\b/;

function parseTime(line: string): number | undefined {
  const m = line.match(reTimePrefix);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

function pickTotalSec(m: Pick<MissionResult, "stateDurationSec" | "onAgentCreatedSpanSec" | "durationSec">) {
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
 * 解析“最近有效的 N 把仲裁”（默认 2 把），并排除时长 < 60s 的记录。
 * 为移动端优化：仅读取文件尾部并逐步扩大窗口。
 */
export async function parseRecentValidEeLogFromFile(
  file: File,
  options?: ParseRecentValidFromFileOptions
): Promise<ParseResult> {
  const count = options?.count ?? 2;
  const minDurationSec = options?.minDurationSec ?? 60;
  const initial = options?.initialTailBytes ?? 4 * 1024 * 1024; // 4MB
  // 不做人为上限：必要时可扩到整文件（大日志也能解析）
  const max = options?.maxTailBytes ?? file.size;

  let tail = Math.min(Math.max(256 * 1024, initial), Math.max(256 * 1024, max));
  while (true) {
    const text = await readTailText(file, tail);
    const parsed = parseRecentMissionsInText(text);
    const valid = parsed.missions.filter((m) => {
      const totalSec = pickTotalSec(m);
      return totalSec != null && totalSec >= minDurationSec;
    });

    const picked = valid.slice(Math.max(0, valid.length - count));

    const warnings = [...parsed.warnings];
    if (picked.length < count && tail < max) {
      tail = Math.min(max, tail * 2);
      continue;
    }
    if (picked.length < count) {
      warnings.push(`有效记录不足：仅找到 ${picked.length} 把（过滤阈值 ${minDurationSec}s）。`);
    }

    // 重新编号 index（展示用）
    const missions = picked.map((m, idx) => ({ ...m, index: idx + 1 }));
    return { missions, warnings };
  }
}

