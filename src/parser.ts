// ---- 导出类型 ---------------------------------------------------------------

export type MissionResult = {
  index: number;
  nodeId?: string;
  spawnedAtEnd?: number;          // 最后一条 OnAgentCreated 的 Spawned 编号（敌人总数参考）
  shieldDroneCount: number;       // 无人机生成数量
  eomDurationSec?: number;        // 主机总时间：eomTime - stateStartedTime
  lastClientDurationSec?: number; // 客机总时间：eomTime - lastClientJoinTime
  waveCount?: number;             // 波数（防御/镜像防御）
  roundCount?: number;            // 轮数（所有任务类型）
  phases?: Array<{
    kind: "wave" | "round";
    index: number; // 1-based
    shieldDroneCount: number;
  }>;
  status: "ok" | "incomplete";
};

export type ParseResult = {
  missions: MissionResult[];
  warnings: string[];
  validTotal?: number;
  readComplete?: boolean;
  readProgress01?: number;
  readStopReason?: string;
};

export type ParseRecentValidFromFileOptions = {
  count?: number;
  minDurationSec?: number;
  chunkBytes?: number;
};

// ---- 正则 -------------------------------------------------------------------

// 有些日志行在时间戳前带 "!"（例如 "!4631.303"），需要兼容
const reTimePrefix = /^!?(\d+(?:\.\d+)?)\s+/;

// 任务开始标记
const reStartMissionName =
  /Script \[Info\]: ThemedSquadOverlay\.lua: Mission name:\s*(.+?)\s*-\s*仲裁/;
const reStartMissionVote =
  /Script \[Info\]: ThemedSquadOverlay\.lua: ShowMissionVote\s+(.+?)\s*-\s*仲裁/;
const reVoteNodeId = /\(([A-Za-z0-9_]+)_EliteAlert\)/;

// Host loading 行（提取 NodeId）
const reHostLoading =
  /Script \[Info\]: ThemedSquadOverlay\.lua: Host loading .*"name":"([^"]+)_EliteAlert"/;

// 任务结束标记
const reEnd =
  /Script \[Info\]: Background\.lua: EliteAlertMission at ([A-Za-z0-9_]+)\b/;

// 游戏状态机
const reStateStarted =
  /GameRulesImpl - changing state from SS_WAITING_FOR_PLAYERS to SS_STARTED/;
const reStateEnding =
  /GameRulesImpl - changing state from SS_STARTED to SS_ENDING/;

// 结算 UI（EOM）——取 SS_STARTED 之后、SS_ENDING 之前最后一次出现的时间戳
const reEomInit = /Script \[Info\]: EndOfMatch\.lua: Initialize\b/;
const reAllExtracting = /Script \[Info\]: ExtractionTimer\.lua: EOM: All players extracting\b/;

// 客机进图标记
const reClientJoinInProgressNode =
  /Script \[Info\]: ThemedSquadOverlay\.lua: LoadLevelMsg received\. Client joining mission in-progress:\s*\{"name":"([^"]+)_EliteAlert"\}/;
const reSendLoadLevelNode =
  /Net \[Info\]: Sending LOAD_LEVEL to (.+?)\s+\[mission=\{"name":"([^"]+)_EliteAlert"\}\]/;
const reCreatePlayerForClient =
  /Game \[Info\]: CreatePlayerForClient\. id=(\d+), user name=(.+)$/;

// 敌人/无人机生成
const reAnyOnAgentCreated = /AI \[Info\]: OnAgentCreated\b/;
const reSpawned = /\bSpawned\s+(\d+)\b/;
const reShieldDrone =
  /AI \[Info\]: OnAgentCreated \/Npc\/CorpusEliteShieldDroneAgent\d*\b/;

// 防御波次 / 拦截轮次 标记
const reDefenseWave = /Script \[Info\]: WaveDefend\.lua: Defense wave:\s*(\d+)\b/;
const reInterceptionNewRound =
  /Script \[Info\]: HudRedux\.lua: Queuing new transmission: InterNewRoundLotusTransmission\b/;
const reDefenseRewardTransitionOut =
  /Script \[Info\]: DefenseReward\.lua: DefenseReward::TransitionOut\b/;

// 镜像防御关卡标识：在 Host loading 块内的 levelOverride 行
// 已知地图：LastWishDefense（Citrine · 火星）、EntratiLabMirrorDefense（墓垒 · 火卫二）
const reLevelOverrideMirrorDefense =
  /levelOverride=\/Lotus\/Levels\/Proc\/(?:LastWish\/LastWishDefense|EntratiLab\/EntratiLabMirrorDefense)\b/;

// 镜像防御单波标记（与普通防御的 WaveDefend.lua 不同）
const reLoopDefenseWave = /Script \[Info\]: LoopDefend\.lua: Loop Defense wave:\s*(\d+)\b/;

// ---- 工具函数 ----------------------------------------------------------------

function parseTime(line: string): number | undefined {
  const m = line.match(reTimePrefix);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

// ---- 流式解析（主要入口）-----------------------------------------------------

/**
 * 流式读取 EE.log 文件，解析最近有效的 N 次仲裁任务。
 * - 以 4MB 块逐步读取，避免大文件 OOM
 * - 默认取最近 2 次有效任务，排除时长 < 60s 的记录
 */
export async function parseRecentValidEeLogFromFile(
  file: File,
  options?: ParseRecentValidFromFileOptions,
  onProgress?: (progress01: number) => void
): Promise<ParseResult> {
  const count = options?.count ?? 2;
  const minDurationSec = options?.minDurationSec ?? 60;
  const chunkBytes = options?.chunkBytes ?? 4 * 1024 * 1024;

  const decoder = new TextDecoder("utf-8");
  let carry = "";
  let offset = 0;
  let lineNo = 0;

  // ---- Run 内部状态（不导出）-------------------------------------------------
  type Run = {
    startLine: number;
    endLine?: number;
    nodeId?: string;
    needHostLines: number;

    // 状态机时间
    stateStartedTime?: number;
    stateStartedLine?: number;
    stateEndingTime?: number;
    stateEndingLine?: number;

    // 结算 UI 时间（主机总时间来源）
    eomTime?: number;
    eomLine?: number;

    // 客机进图时间
    lastClientJoinTime?: number;
    loadLevelSentFirstByPlayer: Record<string, number>;

    // 生成统计
    shieldDroneCount: number;
    lastSpawned?: number;

    // 波次/轮次（内部检测，不直接导出为任务类型）
    missionKind?: "defense" | "interception" | "mirrorDefense" | "unknown";
    phaseKind?: "wave" | "round";
    phases: number[];
    curPhaseIndex?: number;
    interCompletedRounds?: number;
    interHasTransmissionMarker?: boolean;
    pendingDronesBeforeFirstRoundMarker: number;
    waveCount?: number;
    roundCount?: number;
    // 镜像防御 LoopDefend 波次归零检测
    loopDefendLastWave?: number;   // 上次见到的波次编号
    loopDefendOffset?: number;     // 累计偏移（每次归零加上上次最大值）
  };

  let cur: Run | null = null;
  const valid: MissionResult[] = [];
  let validTotal = 0;
  const warnings: string[] = [];
  let readComplete = true;
  let readProgress01: number | undefined = undefined;
  let readStopReason: string | undefined = undefined;

  // ---- finalize：将 Run 转为 MissionResult ------------------------------------
  const finalize = () => {
    if (!cur) return;
    const run = cur;

    // 主机总时间：EOM UI 触发时间 - SS_STARTED 时间
    const eomDurationSec =
      run.stateStartedTime != null && run.eomTime != null
        ? run.eomTime - run.stateStartedTime
        : undefined;

    // 客机总时间：EOM UI 触发时间 - 最后客机进图时间
    const lastClientDurationSec =
      run.lastClientJoinTime != null && run.eomTime != null
        ? run.eomTime - run.lastClientJoinTime
        : undefined;

    // ---- 波次/轮次 finalise --------------------------------------------------
    if (run.missionKind === "defense") {
      const waveCount = run.waveCount ?? (run.phases.length ? run.phases.length : undefined);
      run.waveCount = waveCount;
      run.roundCount = waveCount != null ? Math.ceil(waveCount / 3) : run.roundCount;
      run.phaseKind = "wave";
      if (waveCount != null && run.phases.length > waveCount) run.phases.length = waveCount;
    } else if (run.missionKind === "mirrorDefense") {
      if (run.phaseKind === "wave") {
        // 有 LoopDefend 单波标记：waveCount 直接来自 LoopDefend 计数（归零假事件已在 feedLine 跳过）
        if ((run.interCompletedRounds ?? 0) > 0) {
          run.roundCount = run.interCompletedRounds;
          // waveCount 以 LoopDefend 为准；若未记录则退而用 phases 长度
          if (run.waveCount == null) {
            run.waveCount = run.phases.length > 0 ? run.phases.length : undefined;
          }
        } else {
          // 无 TransitionOut：用 LoopDefend 波次推算轮次
          const waveCount = run.waveCount ?? (run.phases.length > 0 ? run.phases.length : undefined);
          run.waveCount = waveCount;
          run.roundCount = waveCount != null ? Math.ceil(waveCount / 2) : undefined;
        }
        // 裁剪 phases，确保与 waveCount 一致
        if (run.waveCount != null && run.phases.length > run.waveCount) {
          run.phases.length = run.waveCount;
        }
      } else {
        // 无 LoopDefend 标记（旧日志）：按 TransitionOut 轮次统计，波数 = 轮数 × 2
        run.phaseKind = "round";
        const completed = run.interCompletedRounds ?? 0;
        if (completed > 0) {
          run.roundCount = completed;
        } else if (run.roundCount == null) {
          if (run.phases.length > 0) run.roundCount = run.phases.length;
          else if (run.pendingDronesBeforeFirstRoundMarker > 0) run.roundCount = 1;
        }
        run.waveCount = run.roundCount != null ? run.roundCount * 2 : undefined;
        if (run.roundCount != null && run.phases.length > run.roundCount) {
          run.phases.length = run.roundCount;
        }
      }
    } else if (run.missionKind === "interception") {
      run.phaseKind = "round";
      const completed = run.interCompletedRounds ?? 0;
      if (completed > 0) {
        run.roundCount = completed;
      } else if (run.roundCount == null) {
        if (run.phases.length > 0) run.roundCount = run.phases.length;
        else if (run.pendingDronesBeforeFirstRoundMarker > 0) run.roundCount = 1;
      }
      run.waveCount = run.roundCount;
      if (run.roundCount != null && run.phases.length > run.roundCount) {
        run.phases.length = run.roundCount;
      }
    }

    const m: MissionResult = {
      index: 0,
      nodeId: run.nodeId,
      spawnedAtEnd: run.lastSpawned,
      shieldDroneCount: run.shieldDroneCount,
      eomDurationSec:
        eomDurationSec != null && Number.isFinite(eomDurationSec) ? eomDurationSec : undefined,
      lastClientDurationSec:
        lastClientDurationSec != null && Number.isFinite(lastClientDurationSec)
          ? lastClientDurationSec
          : undefined,
      waveCount: run.waveCount,
      roundCount: run.roundCount,
      phases:
        run.phaseKind && run.phases.length
          ? run.phases.map((n, i) => ({ kind: run.phaseKind!, index: i + 1, shieldDroneCount: n }))
          : undefined,
      status: run.endLine != null ? "ok" : "incomplete",
    };

    const hasStarted = run.stateStartedLine != null;
    const hasSpawnSignals = run.shieldDroneCount > 0 || run.lastSpawned != null;
    const allowIncomplete = m.status === "incomplete" && hasStarted && hasSpawnSignals;
    const isValid =
      (eomDurationSec != null && eomDurationSec >= minDurationSec) || allowIncomplete;

    if (isValid) {
      validTotal++;
      valid.push(m);
      while (valid.length > count) valid.shift();
    }
    cur = null;
  };

  // ---- feedLine：逐行处理 ----------------------------------------------------
  const feedLine = (line: string) => {
    lineNo++;

    const mStartName = line.match(reStartMissionName);
    const mStartVote = line.match(reStartMissionVote);
    if (mStartName || mStartVote) {
      if (cur) {
        if (cur.stateStartedLine == null) {
          cur = null;
        } else {
          cur.endLine = cur.endLine ?? lineNo - 1;
          finalize();
        }
      }
      const voteNode = mStartVote ? line.match(reVoteNodeId) : null;
      cur = {
        startLine: lineNo,
        needHostLines: 15,
        shieldDroneCount: 0,
        missionKind: "unknown",
        phases: [],
        interCompletedRounds: 0,
        interHasTransmissionMarker: false,
        pendingDronesBeforeFirstRoundMarker: 0,
        loadLevelSentFirstByPlayer: {},
        loopDefendLastWave: 0,
        loopDefendOffset: 0,
      };
      if (voteNode?.[1]) cur.nodeId = voteNode[1];
      return;
    }

    if (!cur) return;

    // 状态机时间
    if (cur.stateStartedTime == null && reStateStarted.test(line)) {
      const t = parseTime(line);
      if (t != null) cur.stateStartedTime = t;
      cur.stateStartedLine = lineNo;
    }
    if (reStateEnding.test(line)) {
      if (cur.stateStartedLine != null) {
        const t = parseTime(line);
        if (t != null) cur.stateEndingTime = t;
        cur.stateEndingLine = lineNo;
        cur.endLine = lineNo;
      }
    }

    const afterEnding = cur.stateEndingLine != null && lineNo > cur.stateEndingLine;
    const afterStarted = cur.stateStartedLine != null && lineNo >= cur.stateStartedLine;

    // 补抓 NodeId
    if (!cur.nodeId && cur.needHostLines > 0) {
      const h = line.match(reHostLoading);
      if (h) cur.nodeId = h[1];
      cur.needHostLines--;
    }

    // 镜像防御检测（levelOverride 出现在 Host loading 块内，SS_STARTED 之前）
    if (cur.missionKind === "unknown" && reLevelOverrideMirrorDefense.test(line)) {
      cur.missionKind = "mirrorDefense";
    }

    // 任务结束标记（取最后一次）
    if (cur.nodeId) {
      const e = line.match(reEnd);
      if (e && e[1] === cur.nodeId) {
        cur.endLine = lineNo;
      }
    }

    if (afterEnding) return;

    // EOM 结算 UI 时间（SS_STARTED ~ SS_ENDING 之间最后一次）
    if (afterStarted && (reAllExtracting.test(line) || reEomInit.test(line))) {
      const t = parseTime(line);
      if (t != null) {
        cur.eomTime = t;
        cur.eomLine = lineNo;
      }
    }

    // 客机进图时间（取最后一次）
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
          const times = Object.values(cur.loadLevelSentFirstByPlayer);
          if (times.length > 0) cur.lastClientJoinTime = Math.max(...times);
        }
      }
      const cp = line.match(reCreatePlayerForClient);
      if (cp) {
        const pid = Number(cp[1]);
        if (Number.isFinite(pid) && pid > 0) {
          const t = parseTime(line);
          if (t != null) cur.lastClientJoinTime = t;
        }
      }
    }

    // 防御波次 / 镜像防御波次 / 拦截轮次 标记
    if (afterStarted) {
      // 镜像防御：单波标记（优先于 TransitionOut）
      if (cur.missionKind === "mirrorDefense") {
        const mlw = line.match(reLoopDefenseWave);
        if (mlw) {
          const w = Number(mlw[1]);
          if (Number.isFinite(w) && w > 0) {
            if ((cur.loopDefendLastWave ?? 0) > 0 && w < (cur.loopDefendLastWave ?? 0)) {
              // LoopDefend 脚本 buffer 循环归零（如 29→1）。
              // 归零时的 "wave 1" 是脚本内部计数器重置事件，不是真实波次生成。
              // 将 offset 设为 lastWave-1，使下一条真实标记（wave 2）= 正确的累计波次。
              cur.loopDefendOffset = (cur.loopDefendOffset ?? 0) + (cur.loopDefendLastWave ?? 0) - 1;
              cur.loopDefendLastWave = w;
              // 跳过此归零标记，不更新 phase
            } else {
              cur.loopDefendLastWave = w;
              const actualWave = (cur.loopDefendOffset ?? 0) + w;
              cur.phaseKind = "wave";
              cur.curPhaseIndex = actualWave;
              cur.waveCount = actualWave;
              while (cur.phases.length < actualWave) cur.phases.push(0);
            }
          }
        }
      }

      // 普通防御：单波标记
      if (cur.missionKind !== "mirrorDefense") {
        const mw = line.match(reDefenseWave);
        if (mw) {
          const w = Number(mw[1]);
          if (Number.isFinite(w) && w > 0) {
            cur.missionKind = "defense";
            cur.phaseKind = "wave";
            cur.curPhaseIndex = w;
            cur.waveCount = w;
            while (cur.phases.length < w) cur.phases.push(0);
          }
        }
      }

      // 拦截：轮次播报
      if (reInterceptionNewRound.test(line)) {
        cur.missionKind = "interception";
        cur.phaseKind = "round";
        cur.interHasTransmissionMarker = true;
        cur.interCompletedRounds = (cur.interCompletedRounds ?? 0) + 1;
        cur.roundCount = cur.interCompletedRounds;
        if (cur.interCompletedRounds === 1 && cur.pendingDronesBeforeFirstRoundMarker > 0) {
          if (cur.phases.length < 1) cur.phases.push(0);
          cur.phases[0] = (cur.phases[0] ?? 0) + cur.pendingDronesBeforeFirstRoundMarker;
          cur.pendingDronesBeforeFirstRoundMarker = 0;
        }
        cur.curPhaseIndex = cur.interCompletedRounds + 1;
      } else if (reDefenseRewardTransitionOut.test(line)) {
        if (cur.missionKind === "mirrorDefense") {
          // 镜像防御：TransitionOut 用于统计轮数（2 波 1 轮），不改变 phaseKind/curPhaseIndex
          cur.interCompletedRounds = (cur.interCompletedRounds ?? 0) + 1;
          cur.roundCount = cur.interCompletedRounds;
          // 若没有 LoopDefend 波次标记（旧日志），降级为轮次模式
          if (cur.phaseKind !== "wave") {
            cur.phaseKind = "round";
            if (cur.interCompletedRounds === 1 && cur.pendingDronesBeforeFirstRoundMarker > 0) {
              if (cur.phases.length < 1) cur.phases.push(0);
              cur.phases[0] = (cur.phases[0] ?? 0) + cur.pendingDronesBeforeFirstRoundMarker;
              cur.pendingDronesBeforeFirstRoundMarker = 0;
            }
            cur.curPhaseIndex = cur.interCompletedRounds + 1;
          }
        } else if (cur.missionKind !== "defense" && cur.interHasTransmissionMarker !== true) {
          // 拦截：TransitionOut 作为轮次边界（没有 Transmission marker 时）
          cur.missionKind = "interception";
          cur.phaseKind = "round";
          cur.interCompletedRounds = (cur.interCompletedRounds ?? 0) + 1;
          cur.roundCount = cur.interCompletedRounds;
          if (cur.interCompletedRounds === 1 && cur.pendingDronesBeforeFirstRoundMarker > 0) {
            if (cur.phases.length < 1) cur.phases.push(0);
            cur.phases[0] = (cur.phases[0] ?? 0) + cur.pendingDronesBeforeFirstRoundMarker;
            cur.pendingDronesBeforeFirstRoundMarker = 0;
          }
          cur.curPhaseIndex = cur.interCompletedRounds + 1;
        }
      }
    }

    // 无人机 & 敌人生成统计（SS_STARTED 之后才计入）
    if (afterStarted && reShieldDrone.test(line)) {
      cur.shieldDroneCount++;
      if (cur.phaseKind && cur.curPhaseIndex != null && cur.curPhaseIndex > 0) {
        const idx0 = cur.curPhaseIndex - 1;
        while (cur.phases.length <= idx0) cur.phases.push(0);
        cur.phases[idx0] = (cur.phases[idx0] ?? 0) + 1;
      } else if (cur.missionKind !== "defense" && cur.missionKind !== "mirrorDefense") {
        // 拦截：在第一个轮次边界前的无人机暂存
        cur.pendingDronesBeforeFirstRoundMarker++;
      }
    }

    if (afterStarted && reAnyOnAgentCreated.test(line)) {
      const sm = line.match(reSpawned);
      if (sm) {
        const n = Number(sm[1]);
        if (Number.isFinite(n)) cur.lastSpawned = n;
      }
    }
  };

  // ---- 流式读取主循环 ---------------------------------------------------------
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkBytes);
    let buf: ArrayBuffer;
    try {
      buf = await file.slice(offset, end).arrayBuffer();
    } catch (e) {
      readComplete = false;
      readProgress01 = file.size ? offset / file.size : 0;
      readStopReason = `读取失败：offset=${offset}, end=${end}（可能文件正在被占用/写入）`;
      warnings.push(`${readStopReason}。已返回当前已解析结果。`);
      break;
    }
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
  return {
    missions,
    warnings,
    validTotal,
    readComplete,
    readProgress01: readComplete ? 1 : readProgress01,
    readStopReason,
  };
}
