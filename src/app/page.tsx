"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MissionResult, ParseResult } from "../parser";
import { parseRecentValidEeLogFromFile } from "../parser";

type NodeMeta = {
  nodeId: string;
  nodeName?: string;
  systemName?: string;
  missionType?: string;
  faction?: string;
};

type RegionInfo = {
  name?: string;
  systemName?: string;
  missionName?: string;
  factionName?: string;
};

function t(dict: Record<string, string> | null, key?: string): string | undefined {
  if (!key) return undefined;
  const v = dict?.[key];
  if (typeof v === "string" && v.trim()) return v;
  return key;
}

function formatDuration(v?: number): string {
  if (v == null) return "-";
  const s = Math.max(0, Math.floor(v)); // 只显示整数部分（不四舍五入）
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return `${h}h ${rm}m ${rs}s`;
}

function formatPerMin(v?: number): string {
  if (v == null) return "-";
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(2);
}

function formatNumber(v?: number, digits = 3): string {
  if (v == null) return "-";
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}

function formatSignedPercent(v?: number): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

type BuffState = {
  blueBox: boolean; // ×2
  abundant: boolean; // ×1.18
  yellowBox: boolean; // ×2
  blessing: boolean; // ×1.25
};
type TimeMode = "host" | "lastClient" | "manual";
type ManualHms = { h: string; m: string; s: string };

const BASE_DROP = 0.06;
const EXTRA_PER_ROUND_PROB = 0.07;
const EXTRA_PER_ROUND_AMOUNT = 3;

function buffMultiplier(b: BuffState): number {
  let m = 1;
  if (b.blueBox) m *= 2;
  if (b.abundant) m *= 1.18;
  if (b.yellowBox) m *= 2;
  if (b.blessing) m *= 1.25;
  return m;
}

function gradeFor(perHour?: number): string {
  if (perHour == null || !Number.isFinite(perHour)) return "-";
  if (perHour >= 800) return "S";
  if (perHour >= 700) return "A+";
  if (perHour >= 600) return "A";
  if (perHour >= 500) return "A-";
  return "F";
}

export default function Page() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regions, setRegions] = useState<Record<string, RegionInfo> | null>(null);
  const [dictZh, setDictZh] = useState<Record<string, string> | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [timeModeByIdx, setTimeModeByIdx] = useState<Record<number, TimeMode>>({});
  const [manualHmsByIdx, setManualHmsByIdx] = useState<Record<number, ManualHms>>({});
  const [actualEssenceByIdx, setActualEssenceByIdx] = useState<Record<number, string>>({});
  const [buffs, setBuffs] = useState<BuffState>({
    blueBox: true,
    abundant: true,
    yellowBox: true,
    blessing: true,
  });
  const mul = useMemo(() => buffMultiplier(buffs), [buffs]);

  const missions = useMemo<MissionResult[]>(() => parse?.missions ?? [], [parse]);

  const ensureWarframeData = async () => {
    if (regions && dictZh) return { regions, dictZh };
    try {
      const base = "./warframe-public-export-plus";
      const [r1, r2] = await Promise.all([
        fetch(`${base}/ExportRegions.json`),
        fetch(`${base}/dict.zh.json`),
      ]);
      const [j1, j2] = await Promise.all([
        r1.ok ? r1.json() : null,
        r2.ok ? r2.json() : null,
      ]);
      if (j1 && typeof j1 === "object") setRegions(j1 as Record<string, RegionInfo>);
      if (j2 && typeof j2 === "object") setDictZh(j2 as Record<string, string>);
      return {
        regions: (j1 && typeof j1 === "object" ? (j1 as Record<string, RegionInfo>) : null),
        dictZh: (j2 && typeof j2 === "object" ? (j2 as Record<string, string>) : null),
      };
    } catch {
      return null;
    }
  };

  const metricsFor = (m?: MissionResult | null) => {
    const enemySpawned = m?.spawnedAtEnd ?? undefined;
    const drones = m?.shieldDroneCount ?? undefined;
    const hostTotalSec =
      m?.eomDurationSec != null && m.eomDurationSec > 0
        ? m.eomDurationSec
        : m?.stateDurationSec != null && m.stateDurationSec > 0
        ? m.stateDurationSec
        : m?.onAgentCreatedSpanSec != null && m.onAgentCreatedSpanSec > 0
          ? m.onAgentCreatedSpanSec
          : m?.durationSec != null && m.durationSec > 0
            ? m.durationSec
            : undefined;
    const lastClientTotalSec =
      m?.lastClientDurationSec != null && m.lastClientDurationSec > 0
        ? m.lastClientDurationSec
        : undefined;

    const waveCount = m?.waveCount;
    const roundCount = m?.roundCount;

    const expectedFromDrones =
      drones != null ? drones * BASE_DROP * mul : undefined;
    const expectedFromRounds =
      roundCount != null
        ? roundCount * (1 + EXTRA_PER_ROUND_PROB * EXTRA_PER_ROUND_AMOUNT)
        : undefined;
    const expectedTotal =
      expectedFromDrones != null && expectedFromRounds != null
        ? expectedFromDrones + expectedFromRounds
        : expectedFromDrones != null
          ? expectedFromDrones
          : expectedFromRounds != null
            ? expectedFromRounds
            : undefined;

    // 满状态（用于评级）
    const fullMul = 2 * 1.18 * 2 * 1.25;
    const fullExpectedFromDrones =
      drones != null ? drones * BASE_DROP * fullMul : undefined;
    const fullExpectedFromRounds =
      roundCount != null
        ? roundCount * (1 + EXTRA_PER_ROUND_PROB * EXTRA_PER_ROUND_AMOUNT)
        : undefined;
    const fullExpectedTotal =
      fullExpectedFromDrones != null && fullExpectedFromRounds != null
        ? fullExpectedFromDrones + fullExpectedFromRounds
        : fullExpectedFromDrones != null
          ? fullExpectedFromDrones
          : fullExpectedFromRounds != null
            ? fullExpectedFromRounds
            : undefined;

    return {
      enemySpawned,
      drones,
      hostTotalSec,
      lastClientTotalSec,
      waveCount,
      roundCount,
      expectedFromDrones,
      expectedFromRounds,
      expectedTotal,
      fullExpectedTotal,
    };
  };

  const nodeInfoLine = (m: MissionResult) => {
    if (!m.nodeId) return "-";
    const info = regions?.[m.nodeId];
    const meta: NodeMeta | undefined = info
      ? {
          nodeId: m.nodeId,
          nodeName: t(dictZh, info.name),
          systemName: t(dictZh, info.systemName),
          missionType: t(dictZh, info.missionName),
          faction: t(dictZh, info.factionName),
        }
      : undefined;
    const parts = [meta?.nodeName, meta?.systemName, meta?.missionType, meta?.faction].filter(
      Boolean
    ) as string[];
    // 不展示 (SolNode94) 这类括号信息，只展示可读文本
    return parts.length ? parts.join(" · ") : m.nodeId;
  };

  const handleFile = async (file: File) => {
    setError(null);
    setParse(null);
    setProgress(0);
    setTimeModeByIdx({});
    setManualHmsByIdx({});
    setActualEssenceByIdx({});
    try {
      // 节点信息：按原生 ExportRegions + dict.zh.json 实时翻译（用于展示）
      // 加载失败不影响解析，只会影响节点信息展示
      if (!regions || !dictZh) await ensureWarframeData();
      const res = await parseRecentValidEeLogFromFile(
        file,
        {
          count: 2,
          minDurationSec: 60,
          chunkBytes: 4 * 1024 * 1024,
        },
        (p) => setProgress(p)
      );
      setParse(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取或解析失败");
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="wrap">
      <div
        className={`panel dropzone ${isDragOver ? "dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
      >
        <div className="statusBar">
          <div className="statusLeft">
            <span className="statusTitle">状态</span>
            <span className="statusHint">初始掉率：{Math.round(BASE_DROP * 100)}%</span>
          </div>
          <div className="statusToggles">
            <label className="toggle">
              <input
                type="checkbox"
                checked={buffs.blueBox}
                onChange={(e) => setBuffs((s) => ({ ...s, blueBox: e.target.checked }))}
              />
              <span>资源掉落几率加成 ×2</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={buffs.abundant}
                onChange={(e) => setBuffs((s) => ({ ...s, abundant: e.target.checked }))}
              />
              <span>富足巡回者 ×1.18</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={buffs.yellowBox}
                onChange={(e) => setBuffs((s) => ({ ...s, yellowBox: e.target.checked }))}
              />
              <span>资源数量加成 ×2</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={buffs.blessing}
                onChange={(e) => setBuffs((s) => ({ ...s, blessing: e.target.checked }))}
              />
              <span>资源掉落几率祝福 ×1.25</span>
            </label>
          </div>
        </div>

        <div className="helpLine">
          <span>EE.log 路径：%LOCALAPPDATA%\Warframe</span>
          <span>仅显示最近有效 2 把（时长 &lt; 1 分钟自动排除）</span>
        </div>

        <div className="topbar">
          <div className="actions">
            <span className="hint">仅限主机的 EE.log</span>
            {progress != null ? (
              <span className="warnTag">{Math.round(progress * 100)}%</span>
            ) : null}
            {error ? <span className="err">解析失败</span> : null}
            {missions.some((m) => m.status === "incomplete") ? (
              <span className="warnTag">incomplete</span>
            ) : null}
            <label className="btn primary" htmlFor="file">
              上传
            </label>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setError(null);
                setParse(null);
                setTimeModeByIdx({});
                setManualHmsByIdx({});
                setActualEssenceByIdx({});
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              清空
            </button>
            <input
              id="file"
              ref={fileRef}
              type="file"
              accept=".log,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </div>
        </div>

        <div className="runs">
          {missions.length === 0 ? (
            <div className="empty">暂无有效记录</div>
          ) : (
            missions.map((m, idx) => {
              const metrics = metricsFor(m);
              const timeMode = timeModeByIdx[idx] ?? "host";
              const manual = manualHmsByIdx[idx] ?? { h: "", m: "", s: "" };
              const mh = Number(manual.h);
              const mm = Number(manual.m);
              const ms = Number(manual.s);
              const manualSec =
                (Number.isFinite(mh) ? Math.max(0, mh) : 0) * 3600 +
                (Number.isFinite(mm) ? Math.max(0, mm) : 0) * 60 +
                (Number.isFinite(ms) ? Math.max(0, ms) : 0);
              const selectedSec =
                timeMode === "host"
                  ? metrics.hostTotalSec
                  : timeMode === "lastClient"
                    ? metrics.lastClientTotalSec ?? metrics.hostTotalSec
                    : manualSec > 0
                      ? manualSec
                      : metrics.hostTotalSec;
              const dronesPerMin =
                metrics.drones != null && selectedSec != null && selectedSec > 0
                  ? metrics.drones / (selectedSec / 60)
                  : undefined;
              const expectedPerHour =
                metrics.expectedTotal != null && selectedSec != null && selectedSec > 0
                  ? (metrics.expectedTotal * 3600) / selectedSec
                  : undefined;
              const expectedPerMin =
                metrics.expectedTotal != null && selectedSec != null && selectedSec > 0
                  ? (metrics.expectedTotal * 60) / selectedSec
                  : undefined;
              const fullExpectedPerHour =
                metrics.fullExpectedTotal != null && selectedSec != null && selectedSec > 0
                  ? (metrics.fullExpectedTotal * 3600) / selectedSec
                  : undefined;
              const grade = gradeFor(fullExpectedPerHour);
              const actualText = actualEssenceByIdx[idx] ?? "";
              const actualEssence = Number(actualText);
              const diffPct =
                Number.isFinite(actualEssence) &&
                metrics.expectedTotal != null &&
                metrics.expectedTotal > 0
                  ? ((actualEssence - metrics.expectedTotal) / metrics.expectedTotal) * 100
                  : undefined;
              const diffClass =
                diffPct != null ? (diffPct > 0 ? "diffPos" : diffPct < 0 ? "diffNeg" : "diffFlat") : "";
              const diffText = diffPct == null ? "-" : formatSignedPercent(diffPct);
              const phaseLabel =
                m.missionKind === "defense"
                  ? "波次"
                  : m.missionKind === "interception"
                    ? "轮次"
                    : "阶段";
              return (
                <div key={idx} className="runBlock">
                  <div className="runHeader">
                    <div className="runTitle" aria-label={`最近有效第 ${idx + 1} 把`}>
                      <span className="runIndex">{String(idx + 1).padStart(2, "0")}</span>
                    </div>
                    <div className="runSub">{nodeInfoLine(m) || "-"}</div>
                  </div>
                  <div className="metricsBig">
                    <div className="metric metricA">
                      <div className="metricLabel">无人机生成</div>
                      <div className="metricValue">{metrics.drones ?? "-"}</div>
                    </div>
                    <div className="metric metricB">
                      <div className="metricLabel">敌人生成</div>
                      <div className="metricValue">{metrics.enemySpawned ?? "-"}</div>
                    </div>
                    <div className="metric metricC">
                      <div className="metricLabel">无人机生成/分钟</div>
                      <div className="metricValue">{formatPerMin(dronesPerMin)}</div>
                    </div>
                    <div className="metric metricD">
                      <div className="metricLabel">总时间</div>
                      <div className="metricValue">{formatDuration(selectedSec)}</div>
                    </div>
                  </div>

                  <div className="timeModeBar">
                    <label className="modeItem">
                      <input
                        type="radio"
                        name={`time-mode-${idx}`}
                        checked={timeMode === "host"}
                        onChange={() => setTimeModeByIdx((s) => ({ ...s, [idx]: "host" }))}
                      />
                      <span>主机时间</span>
                    </label>
                    <label className="modeItem">
                      <input
                        type="radio"
                        name={`time-mode-${idx}`}
                        checked={timeMode === "lastClient"}
                        onChange={() => setTimeModeByIdx((s) => ({ ...s, [idx]: "lastClient" }))}
                        disabled={metrics.lastClientTotalSec == null}
                      />
                      <span>最后客机时间 {formatDuration(metrics.lastClientTotalSec)}</span>
                    </label>
                    <label className="modeItem">
                      <input
                        type="radio"
                        name={`time-mode-${idx}`}
                        checked={timeMode === "manual"}
                        onChange={() => setTimeModeByIdx((s) => ({ ...s, [idx]: "manual" }))}
                      />
                      <span>自定义时间</span>
                    </label>
                    {timeMode === "manual" ? (
                      <label className="modeInput modeInputHms">
                        <span>h</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="1"
                          value={manual.h}
                          onChange={(e) =>
                            setManualHmsByIdx((s) => ({ ...s, [idx]: { ...(s[idx] ?? { h: "", m: "", s: "" }), h: e.target.value } }))
                          }
                        />
                        <span>m</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="1"
                          value={manual.m}
                          onChange={(e) =>
                            setManualHmsByIdx((s) => ({ ...s, [idx]: { ...(s[idx] ?? { h: "", m: "", s: "" }), m: e.target.value } }))
                          }
                        />
                        <span>s</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="1"
                          value={manual.s}
                          onChange={(e) =>
                            setManualHmsByIdx((s) => ({ ...s, [idx]: { ...(s[idx] ?? { h: "", m: "", s: "" }), s: e.target.value } }))
                          }
                        />
                      </label>
                    ) : null}
                    <label className="modeInput">
                      <span>实际生息</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.1"
                        value={actualText}
                        onChange={(e) =>
                          setActualEssenceByIdx((s) => ({ ...s, [idx]: e.target.value }))
                        }
                      />
                    </label>
                  </div>

                  <div className="metricsSmall">
                    <div className="mini">
                      <div className="miniLabel">波次</div>
                      <div className="miniValue">{metrics.waveCount ?? "-"}</div>
                    </div>
                    <div className="mini">
                      <div className="miniLabel">轮次</div>
                      <div className="miniValue">{metrics.roundCount ?? "-"}</div>
                    </div>
                    <div className="mini">
                      <div className="miniLabel">期望生息</div>
                      <div className="miniValue">{formatNumber(metrics.expectedTotal, 3)}</div>
                    </div>
                    <div className="mini miniDual">
                      <div className="miniLabel">生息速率</div>
                      <div className="miniSub">h: {formatNumber(expectedPerHour, 1)}</div>
                      <div className="miniSub">min: {formatNumber(expectedPerMin, 2)}</div>
                    </div>
                    {actualText.trim() ? (
                      <div className="mini">
                        <div className="miniLabel">偏差</div>
                        <div className={`miniValue ${diffClass}`}>{diffText}</div>
                      </div>
                    ) : null}
                    <div className="mini">
                      <div className="miniLabel">评级</div>
                      <div className="miniValue">{grade}</div>
                    </div>
                  </div>

                  <details className="detail">
                    <summary>查看详细</summary>
                    <div className="detailInner">
                      <div className="detailMeta">
                        <div className="kv">
                          <div className="k">{phaseLabel}</div>
                          <div className="v">
                            {m.missionKind === "defense"
                              ? `${metrics.waveCount ?? "-"} 波 / ${metrics.roundCount ?? "-"} 轮（每 3 波 1 轮）`
                              : m.missionKind === "interception"
                                ? `${metrics.roundCount ?? "-"} 轮（每轮 = 1 轮次）`
                                : "-"}
                          </div>
                        </div>
                        <div className="kv">
                          <div className="k">轮次奖励期望</div>
                          <div className="v">
                            {metrics.roundCount != null
                              ? `${formatNumber(
                                  metrics.roundCount *
                                    (1 + EXTRA_PER_ROUND_PROB * EXTRA_PER_ROUND_AMOUNT),
                                  3
                                )}（保底 ${metrics.roundCount} + 额外期望 ${formatNumber(
                                  metrics.roundCount *
                                    (EXTRA_PER_ROUND_PROB * EXTRA_PER_ROUND_AMOUNT),
                                  3
                                )}）`
                              : "-"}
                          </div>
                        </div>
                        <div className="kv">
                          <div className="k">无人机掉落倍率</div>
                          <div className="v">× {formatNumber(mul, 2)}</div>
                        </div>
                      </div>

                      {Array.isArray(m.phases) && m.phases.length ? (
                        <div className="phaseTable">
                          <div className="phaseRow phaseHead">
                            <div className="c1">{phaseLabel}</div>
                            <div className="c2">无人机生成</div>
                            <div className="c3">无人机期望生息</div>
                          </div>
                          {m.phases.map((p) => {
                            const expected = p.shieldDroneCount * BASE_DROP * mul;
                            const label =
                              p.kind === "wave"
                                ? `第 ${p.index} 波（第 ${Math.ceil(p.index / 3)} 轮）`
                                : `第 ${p.index} 轮`;
                            return (
                              <div key={`${p.kind}-${p.index}`} className="phaseRow">
                                <div className="c1">{label}</div>
                                <div className="c2">{p.shieldDroneCount}</div>
                                <div className="c3">{formatNumber(expected, 3)}</div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="detailEmpty">该把日志段内未识别到 {phaseLabel} 标记</div>
                      )}
                    </div>
                  </details>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

