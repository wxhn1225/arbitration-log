"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MissionResult, ParseResult, TickingPoint } from "../parser";
import { parseRecentValidEeLogFromFile } from "../parser";

type Theme = "b" | "c" | "e";
const THEME_LABELS: Record<Theme, string> = { b: "深海蓝", c: "暖雾暗", e: "暖奶油" };
const THEME_STORAGE_KEY = "arb-theme";

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
const EXTRA_PER_ROUND_PROB = 0.1;
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

function gradeCssClass(grade: string): string {
  if (grade === "S") return "gradeS";
  if (grade === "A+") return "gradeAPlus";
  if (grade === "A") return "gradeA";
  if (grade === "A-") return "gradeAMinus";
  return "gradeF";
}

// ---- 饱和度分析 -------------------------------------------------------------

type SatBucket = { lo: number; hi: number | null; totalPct: number; activePct: number };
type SatData = {
  maxV: number;
  buckets: SatBucket[];
  gte15TotalPct: number;
  gte15ActivePct: number;
};

function satColor(ratio: number): string {
  const r = ratio < 0.5 ? Math.round(ratio * 2 * 255) : 255;
  const g = ratio < 0.5 ? 255 : Math.round((1 - (ratio - 0.5) * 2) * 255);
  return `rgb(${r},${g},40)`;
}

function buildSatData(series: TickingPoint[], hostSec?: number, selectedSec?: number): SatData | null {
  // 按选中时间裁剪：只保留时间窗口内的数据
  let src = series;
  if (hostSec != null && selectedSec != null && selectedSec < hostSec && selectedSec > 0) {
    const trimStart = hostSec - selectedSec;
    src = series.filter((p) => p.t >= trimStart);
  }
  if (src.length < 2) return null;
  const maxV = Math.max(...src.map((p) => p.v), 1);
  const STEP = 5;
  const numBuckets = Math.max(1, Math.ceil((maxV + 1) / STEP));
  const totalDurs = new Array(numBuckets).fill(0) as number[];
  const activeDurs = new Array(numBuckets).fill(0) as number[];
  let totalAll = 0, activeAll = 0;

  const GAP_THRESH = 3;
  const gaps: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let i = 0; i < src.length; i++) {
    if (src[i]!.v === 0) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0) {
        const s = src[runStart]!.t;
        const e = src[i]!.t;
        if (runStart === 0 || e - s >= GAP_THRESH) gaps.push({ start: s, end: e });
        runStart = -1;
      }
    }
  }
  if (runStart >= 0) {
    const s = src[runStart]!.t;
    const e = src[src.length - 1]!.t;
    if (runStart === 0 || e - s >= GAP_THRESH) gaps.push({ start: s, end: e });
  }

  let gi = 0;
  let gte15Total = 0, gte15Active = 0;
  for (let i = 0; i < src.length - 1; i++) {
    const dt = src[i + 1]!.t - src[i]!.t;
    if (dt <= 0 || dt > 10) continue;
    const v = src[i]!.v;
    const t = src[i]!.t;
    const idx = Math.min(Math.floor(v / STEP), numBuckets - 1);
    totalDurs[idx]! += dt;
    totalAll += dt;
    if (v >= 15) gte15Total += dt;
    while (gi < gaps.length && gaps[gi]!.end <= t) gi++;
    const inGap = gi < gaps.length && t >= gaps[gi]!.start && t < gaps[gi]!.end;
    if (!inGap) {
      activeDurs[idx]! += dt;
      activeAll += dt;
      if (v >= 15) gte15Active += dt;
    }
  }
  if (totalAll <= 0) return null;

  const buckets: SatBucket[] = [];
  for (let i = 0; i < numBuckets; i++) {
    const lo = i * STEP;
    const hi = i < numBuckets - 1 ? lo + STEP - 1 : null;
    buckets.push({
      lo,
      hi,
      totalPct: totalDurs[i]! / totalAll,
      activePct: activeAll > 0 ? activeDurs[i]! / activeAll : 0,
    });
  }
  return {
    maxV,
    buckets,
    gte15TotalPct: totalAll > 0 ? (gte15Total / totalAll) * 100 : 0,
    gte15ActivePct: activeAll > 0 ? (gte15Active / activeAll) * 100 : 0,
  };
}

// ---- 无人机空窗期分析 ---------------------------------------------------------

type DroneGapBucket = { lo: number; hi: number | null; totalPct: number; activePct: number };
type DroneGapData = {
  maxGap: number;
  buckets: DroneGapBucket[];
  gt6TotalPct: number;
  gt6ActivePct: number;
};

function buildDroneGapData(
  times: number[],
  tickingSeries: TickingPoint[] | undefined,
  hostSec?: number,
  selectedSec?: number,
): DroneGapData | null {
  if (times.length < 2) return null;

  // 按选中时间裁剪
  let src = times;
  if (hostSec != null && selectedSec != null && selectedSec < hostSec && selectedSec > 0) {
    const trimStart = hostSec - selectedSec;
    src = times.filter((t) => t >= trimStart);
  }
  if (src.length < 2) return null;

  // 计算事件间的间隔（parser 已将连续无人机行合并为单次事件）
  const gaps: number[] = [];
  for (let i = 0; i < src.length - 1; i++) {
    gaps.push(src[i + 1]! - src[i]!);
  }

  const maxGap = Math.max(...gaps);

  // 变步长分桶边界：0-6 每2s, 6-20 每5s, 20-110 每10s（与左栏等高）
  const minCeil = 110;
  const ceil10 = Math.max(minCeil, Math.ceil(maxGap / 10) * 10);
  const edges: number[] = [0, 2, 4, 6, 10, 15, 20];
  for (let v = 30; v <= ceil10; v += 10) edges.push(v);
  if (edges[edges.length - 1]! <= maxGap) edges.push(edges[edges.length - 1]! + 10);
  const numBuckets = edges.length - 1;

  const totalDurs = new Array(numBuckets).fill(0) as number[];
  const activeDurs = new Array(numBuckets).fill(0) as number[];
  let totalAll = 0, activeAll = 0;
  let gt6Total = 0, gt6Active = 0;

  // 识别间隙区间（复用敌人饱和度的逻辑：开局 + 轮次间隙中 MT=0 ≥3s）
  const GAP_THRESH = 3;
  const gapIntervals: Array<{ start: number; end: number }> = [];
  if (tickingSeries && tickingSeries.length >= 2) {
    let runStart = -1;
    for (let i = 0; i < tickingSeries.length; i++) {
      if (tickingSeries[i]!.v === 0) {
        if (runStart < 0) runStart = i;
      } else {
        if (runStart >= 0) {
          const s = tickingSeries[runStart]!.t;
          const e = tickingSeries[i]!.t;
          if (runStart === 0 || e - s >= GAP_THRESH) gapIntervals.push({ start: s, end: e });
          runStart = -1;
        }
      }
    }
    if (runStart >= 0) {
      const s = tickingSeries[runStart]!.t;
      const e = tickingSeries[tickingSeries.length - 1]!.t;
      if (runStart === 0 || e - s >= GAP_THRESH) gapIntervals.push({ start: s, end: e });
    }
  }

  function isInGap(t: number): boolean {
    for (const g of gapIntervals) {
      if (t >= g.start && t < g.end) return true;
    }
    return false;
  }

  function bucketIdx(g: number): number {
    for (let b = 0; b < numBuckets; b++) {
      if (g < edges[b + 1]!) return b;
    }
    return numBuckets - 1;
  }

  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i]!;
    const idx = bucketIdx(g);
    totalDurs[idx]! += g;
    totalAll += g;
    if (g > 6) gt6Total += g;
    const midT = src[i]! + g / 2;
    if (!isInGap(midT)) {
      activeDurs[idx]! += g;
      activeAll += g;
      if (g > 6) gt6Active += g;
    }
  }
  if (totalAll <= 0) return null;

  const buckets: DroneGapBucket[] = [];
  for (let i = 0; i < numBuckets; i++) {
    const lo = edges[i]!;
    const hi = i < numBuckets - 1 ? edges[i + 1]! : null;
    buckets.push({
      lo,
      hi,
      totalPct: totalDurs[i]! / totalAll,
      activePct: activeAll > 0 ? activeDurs[i]! / activeAll : 0,
    });
  }
  return {
    maxGap: Math.round(maxGap),
    buckets,
    gt6TotalPct: totalAll > 0 ? (gt6Total / totalAll) * 100 : 0,
    gt6ActivePct: activeAll > 0 ? (gt6Active / activeAll) * 100 : 0,
  };
}

// ---- 无人机连续生成数量分布 -----------------------------------------------------

type DroneBurstDistrib = {
  maxBurst: number;
  rows: Array<{ size: number; count: number; pct: number }>;
};

function buildDroneBurstDistrib(burstSizes: number[] | undefined): DroneBurstDistrib | null {
  if (!burstSizes || burstSizes.length === 0) return null;
  const maxBurst = Math.max(...burstSizes);
  if (maxBurst <= 0) return null;
  const counts = new Array(maxBurst).fill(0) as number[];
  for (const s of burstSizes) {
    if (s >= 1 && s <= maxBurst) counts[s - 1]!++;
  }
  const total = burstSizes.length;
  const rows = counts.map((c, i) => ({ size: i + 1, count: c, pct: total > 0 ? c / total : 0 }));
  return { maxBurst, rows };
}

export default function Page() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastFileRef = useRef<File | null>(null);
  const runRefs = useRef<Array<HTMLDivElement | null>>([]);
  const captureRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [copyingIdx, setCopyingIdx] = useState<number | null>(null);
  const [satPctMode, setSatPctMode] = useState<"total" | "active">("active");

  // ── theme ──
  const [theme, setThemeState] = useState<Theme>("e");
  const [showThemeMenu, setShowThemeMenu] = useState(false);

  // load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
    if (saved && (saved === "b" || saved === "c" || saved === "e")) {
      setThemeState(saved);
      if (saved === "e") {
        document.documentElement.removeAttribute("data-theme");
      } else {
        document.documentElement.setAttribute("data-theme", saved);
      }
    }
  }, []);

  const applyTheme = (t: Theme) => {
    setThemeState(t);
    setShowThemeMenu(false);
    localStorage.setItem(THEME_STORAGE_KEY, t);
    if (t === "e") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", t);
    }
  };
  const [isDragOver, setIsDragOver] = useState(false);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regions, setRegions] = useState<Record<string, RegionInfo> | null>(null);
  const [dictZh, setDictZh] = useState<Record<string, string> | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [showCount, setShowCount] = useState<number>(2);
  const [showCountInput, setShowCountInput] = useState<string>("2");
  const [displayCount, setDisplayCount] = useState<number>(2);
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
  const visibleMissions = useMemo(() => {
    if (displayCount <= 0) return [];
    if (missions.length <= displayCount) return missions;
    // 展示“最近”的 N 次：取末尾
    return missions.slice(Math.max(0, missions.length - displayCount));
  }, [missions, displayCount]);

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
      m?.eomDurationSec != null && m.eomDurationSec > 0 ? m.eomDurationSec : undefined;
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

    // 满状态（用于评分）
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

  const handleFile = async (
    file: File,
    countOverride?: number,
    opts?: { preserveExisting?: boolean }
  ) => {
    lastFileRef.current = file;
    setError(null);
    if (!opts?.preserveExisting) setParse(null);
    setProgress(0);
    setTimeModeByIdx({});
    setManualHmsByIdx({});
    setActualEssenceByIdx({});
    try {
      // 节点信息：按原生 ExportRegions + dict.zh.json 实时翻译（用于展示）
      // 加载失败不影响解析，只会影响节点信息展示
      if (!regions || !dictZh) await ensureWarframeData();
      const useCount = countOverride ?? showCount;
      const res = await parseRecentValidEeLogFromFile(
        file,
        {
          count: useCount,
          minDurationSec: 60,
          chunkBytes: 4 * 1024 * 1024,
        },
        (p) => setProgress(p)
      );
      setParse(res);
      setDisplayCount(useCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取或解析失败");
    } finally {
      setProgress(null);
    }
  };

  const captureRun = async (idx: number) => {
    const el = captureRefs.current[idx];
    if (!el) return;
    setCopyingIdx(idx);
    try {
      // wait for fonts to finish loading so text renders correctly
      await document.fonts.ready;
      const { default: html2canvas } = await import("html2canvas");
      // pick background color matching current theme
      const bgColor =
        theme === "b" ? "#0d1c30" : theme === "c" ? "#18140f" : "#fffefb";
      const canvas = await html2canvas(el, {
        backgroundColor: bgColor,
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
      });
      await new Promise<void>((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) {
            const url = URL.createObjectURL(blob);
            // try clipboard first, fall back to download
            navigator.clipboard
              .write([new ClipboardItem({ "image/png": blob })])
              .catch(() => {
                const a = document.createElement("a");
                a.href = url;
                a.download = `arbitration-${String(idx + 1).padStart(2, "0")}.png`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              })
              .finally(() => {
                setTimeout(() => URL.revokeObjectURL(url), 5000);
              });
          }
          resolve();
        }, "image/png");
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`截图失败：${msg}`);
    } finally {
      setTimeout(() => setCopyingIdx(null), 1600);
    }
  };

  return (
    <div className="wrap">
      <header className="siteHeader">
        <span className="siteTitle">arbitration-log</span>
        <div className="themeSwitch">
          <button
            className="themeSwitchBtn"
            onClick={() => setShowThemeMenu((v) => !v)}
          >
            <span className={`themeDot tp-${theme}`} />
            {THEME_LABELS[theme]}
            <span className="themeSwitchArrow">▾</span>
          </button>
          {showThemeMenu && (
            <>
              <div className="themeBackdrop" onClick={() => setShowThemeMenu(false)} />
              <div className="themeMenu">
                {(["b", "c", "e"] as Theme[]).map((t) => (
                  <button
                    key={t}
                    className={`themeOption${theme === t ? " active" : ""}`}
                    onClick={() => applyTheme(t)}
                  >
                    <span className={`themeDot tp-${t}`} />
                    {THEME_LABELS[t]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </header>
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
          <span>时长 &lt; 1 分钟自动排除</span>
        </div>

        <div className="topbar">
          <div className="actions">
            <span className="hint">仅限主机的 EE.log</span>
            {progress != null ? (
              <span className="warnTag">{Math.round(progress * 100)}%</span>
            ) : null}
            {error ? (
              <span className="err" title={error}>
                解析失败：{error}
              </span>
            ) : null}
            {parse?.readComplete === false ? (
              <span
                className="warnTag"
                title={`${parse.readStopReason ?? "读取未完成"}（已读取 ${Math.round(
                  (parse.readProgress01 ?? 0) * 100
                )}%）`}
              >
                未读完 {Math.round((parse.readProgress01 ?? 0) * 100)}%
              </span>
            ) : null}
            {visibleMissions.some((m) => m.status === "incomplete") ? (
              <span className="warnTag">incomplete</span>
            ) : null}
            <label className="btn primary" htmlFor="file">
              上传
            </label>
            <label className="countPick">
              <span>展示</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={showCountInput}
                onChange={(e) => setShowCountInput(e.target.value)}
              />
              <span>次</span>
              <span style={{ opacity: 0.72 }}>
                Max：{parse?.validTotal ?? "-"}次
              </span>
            </label>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                const max = parse?.validTotal;
                const n0 = Number(showCountInput);
                const n = Number.isFinite(n0) ? Math.max(1, Math.floor(n0)) : 2;
                const clamped = max != null ? Math.min(n, Math.max(1, max)) : n;
                setShowCount(clamped);
                setShowCountInput(String(clamped));
                        setDisplayCount(clamped);
                        // 立刻按新值展示：若当前结果不足再自动重解析补齐
                        if (clamped <= missions.length) {
                          setTimeModeByIdx({});
                          setManualHmsByIdx({});
                          setActualEssenceByIdx({});
                        } else if (lastFileRef.current) {
                          // 保留当前展示，后台重解析补齐到 clamped
                          void handleFile(lastFileRef.current, clamped, { preserveExisting: true });
                        }
              }}
              disabled={!lastFileRef.current || progress != null}
            >
              应用
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setError(null);
                setParse(null);
                setTimeModeByIdx({});
                setManualHmsByIdx({});
                setActualEssenceByIdx({});
                setShowCount(2);
                setShowCountInput("2");
                setDisplayCount(2);
                lastFileRef.current = null;
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
          {visibleMissions.length === 0 ? (
            <div className="empty">暂无有效记录</div>
          ) : (
            visibleMissions.map((m, idx) => {
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
                m.phases?.[0]?.kind === "wave"
                  ? "波次"
                  : m.phases?.[0]?.kind === "round"
                    ? "轮次"
                    : "阶段";
              return (
                <div
                  key={idx}
                  className="runBlock"
                  ref={(el) => { runRefs.current[idx] = el; }}
                >
                  <div
                    className="runCapture"
                    ref={(el) => { captureRefs.current[idx] = el; }}
                  >
                  <div className="runHeader">
                    <div className="runLeft">
                      <span className="runIndex">{String(idx + 1).padStart(2, "0")}</span>
                      <span className="runSub">{nodeInfoLine(m) || "-"}</span>
                    </div>
                    <div className={`gradeBadge ${gradeCssClass(grade)}`}>{grade}</div>
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
                      <div className="metricLabel">无人机/分钟</div>
                      <div className="metricValue">{formatPerMin(dronesPerMin)}</div>
                    </div>
                    <div className="metric metricD">
                      <div className="metricLabel">总时间</div>
                      <div className="metricValue">{formatDuration(selectedSec)}</div>
                    </div>
                  </div>

                  {(() => {
                    const sd = m.tickingSeries && m.tickingSeries.length > 0
                      ? buildSatData(m.tickingSeries, metrics.hostTotalSec, selectedSec) : null;
                    const dg = m.droneSpawnTimes && m.droneSpawnTimes.length >= 2
                      ? buildDroneGapData(m.droneSpawnTimes, m.tickingSeries, metrics.hostTotalSec, selectedSec) : null;
                    const bd = buildDroneBurstDistrib(m.droneBurstSizes);
                    if (!sd && !dg && !bd) return null;
                    return (
                      <div className="satDual">
                        {/* 共享下拉框 */}
                        <div className="satModeRow">
                          <select
                            className="satSelect"
                            value={satPctMode}
                            onChange={(e) => setSatPctMode(e.target.value as "total" | "active")}
                          >
                            <option value="total">总时间</option>
                            <option value="active">有效时间</option>
                          </select>
                        </div>
                        <div className="satDualGrid">
                          {/* 左：敌人饱和度 + 无人机连续生成 */}
                          {(sd || bd) && (
                            <div className="satLeftStack">
                              {sd && (
                                <div className="satDistrib">
                                  <div className="satTitleRow">
                                    <span className="satTitle">敌人饱和度</span>
                                    <span className="satMax">Max {sd.maxV}</span>
                                  </div>
                                  <div className="satHead">
                                    <span className="satHeadLabel">存活</span>
                                    <span className="satHeadSpacer" />
                                    <span className="satHeadLabel">占比</span>
                                  </div>
                                  <div className="satRows">
                                    {sd.buckets.map((b, i) => {
                                      const label = b.hi != null ? `${b.lo}–${b.hi}` : `${b.lo}+`;
                                      const ratio = sd.maxV > 0 ? (b.lo + (b.hi != null ? b.hi : b.lo)) / 2 / sd.maxV : 0;
                                      const pct = satPctMode === "total" ? b.totalPct : b.activePct;
                                      const barW = Math.max(pct > 0 ? 2 : 0, pct * 100);
                                      return (
                                        <div className="satRow" key={i}>
                                          <span className="satLabel">{label}</span>
                                          <div className="satTrack">
                                            <div className="satFill" style={{ width: `${barW}%`, backgroundColor: satColor(ratio) }} />
                                          </div>
                                          <span className="satPct">{(pct * 100).toFixed(1)}%</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  <div className="satFooter">
                                    ≥15 占比：{(satPctMode === "total" ? sd.gte15TotalPct : sd.gte15ActivePct).toFixed(1)}%
                                  </div>
                                </div>
                              )}
                              {bd && (
                                <div className="satDistrib">
                                  <div className="satTitleRow">
                                    <span className="satTitle">无人机连续生成</span>
                                    <span className="satMax">Max {bd.maxBurst}</span>
                                  </div>
                                  <div className="satHead">
                                    <span className="satHeadLabel">数量</span>
                                    <span className="satHeadSpacer" />
                                    <span className="satHeadLabel">占比</span>
                                  </div>
                                  <div className="satRows">
                                    {bd.rows.map((r) => {
                                      const barW = Math.max(r.pct > 0 ? 2 : 0, r.pct * 100);
                                      const ratio = bd.maxBurst > 1 ? (r.size - 1) / (bd.maxBurst - 1) : 0;
                                      return (
                                        <div className="satRow" key={r.size}>
                                          <span className="satLabel">{r.size}</span>
                                          <div className="satTrack">
                                            <div className="satFill" style={{ width: `${barW}%`, backgroundColor: satColor(ratio) }} />
                                          </div>
                                          <span className="satPct">{(r.pct * 100).toFixed(1)}%</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  <div className="satFooter">
                                    生成 {bd.rows.reduce((s, r) => s + r.count, 0)} 次
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {/* 右：无人机空窗期 */}
                          {dg && (
                            <div className="satDistrib">
                              <div className="satTitleRow">
                                <span className="satTitle">无人机空窗期</span>
                                <span className="satMax">Max {dg.maxGap}s</span>
                              </div>
                              <div className="satHead">
                                <span className="satHeadLabel">间隔(s)</span>
                                <span className="satHeadSpacer" />
                                <span className="satHeadLabel">占比</span>
                              </div>
                              <div className="satRows">
                                {dg.buckets.map((b, i) => {
                                  const label = b.hi != null ? `${b.lo}–${b.hi}` : `${b.lo}+`;
                                  const ratio = dg.maxGap > 0 ? (b.lo + (b.hi != null ? b.hi : b.lo)) / 2 / dg.maxGap : 0;
                                  const pct = satPctMode === "total" ? b.totalPct : b.activePct;
                                  const barW = Math.max(pct > 0 ? 2 : 0, pct * 100);
                                  return (
                                    <div className="satRow" key={i}>
                                      <span className="satLabel">{label}</span>
                                      <div className="satTrack">
                                        <div className="satFill" style={{ width: `${barW}%`, backgroundColor: satColor(ratio) }} />
                                      </div>
                                      <span className="satPct">{(pct * 100).toFixed(1)}%</span>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="satFooter">
                                &gt;6s：{(satPctMode === "total" ? dg.gt6TotalPct : dg.gt6ActivePct).toFixed(1)}%
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

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
                    <button
                      className={`screenshotBtn${copyingIdx === idx ? " copying" : ""}`}
                      style={{ marginLeft: "auto" }}
                      onClick={() => void captureRun(idx)}
                      disabled={copyingIdx === idx}
                      {...{ "data-html2canvas-ignore": "true" }}
                    >
                      {copyingIdx === idx ? "✓" : "截图"}
                    </button>
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
                  </div>

                  </div>{/* /runCapture */}

                  <details className="detail">
                    <summary>查看详细</summary>
                    <div className="detailInner">
                      <div className="detailMeta">
                        <div className="kv">
                          <div className="k">{phaseLabel}</div>
                          <div className="v">
                            {(() => {
                              const wpr =
                                metrics.waveCount != null &&
                                metrics.roundCount != null &&
                                metrics.roundCount > 0
                                  ? Math.round(metrics.waveCount / metrics.roundCount)
                                  : 3;
                              if (m.phases?.[0]?.kind === "wave") {
                                return `${metrics.waveCount ?? "-"} 波 / ${metrics.roundCount ?? "-"} 轮（每 ${wpr} 波 1 轮）`;
                              }
                              if (
                                m.phases?.[0]?.kind === "round" &&
                                metrics.waveCount != null &&
                                metrics.roundCount != null &&
                                metrics.waveCount > metrics.roundCount
                              ) {
                                return `${metrics.waveCount} 波 / ${metrics.roundCount} 轮（每 2 波 1 轮）`;
                              }
                              if (m.phases?.[0]?.kind === "round") {
                                return `${metrics.roundCount ?? "-"} 轮`;
                              }
                              return "-";
                            })()}
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
                            <div className="c2">无人机生成（总）</div>
                            <div className="c3">无人机期望生息（总）</div>
                          </div>
                          {(() => {
                            let cumDrones = 0;
                            let cumExpected = 0;
                            return m.phases.map((p) => {
                              cumDrones += p.shieldDroneCount;
                              const perExpected = p.shieldDroneCount * BASE_DROP * mul;
                              cumExpected += perExpected;
                              // 每轮波数：普通防御=3，镜像防御=2；用比值动态推算
                              const wavesPerRound =
                                metrics.waveCount != null &&
                                metrics.roundCount != null &&
                                metrics.roundCount > 0
                                  ? Math.round(metrics.waveCount / metrics.roundCount)
                                  : 3;
                              // 轮次模式下 waveCount > roundCount 表示镜像防御降级（无单波标记）
                              const isMirrorRoundMode =
                                p.kind === "round" &&
                                metrics.waveCount != null &&
                                metrics.roundCount != null &&
                                metrics.waveCount > metrics.roundCount;
                              const label =
                                p.kind === "wave"
                                  ? `第 ${p.index} 波（第 ${Math.ceil(p.index / wavesPerRound)} 轮）`
                                  : isMirrorRoundMode
                                    ? `第 ${p.index} 轮（第 ${p.index * 2 - 1}–${p.index * 2} 波）`
                                    : `第 ${p.index} 轮`;
                              return (
                                <div key={`${p.kind}-${p.index}`} className="phaseRow">
                                  <div className="c1">{label}</div>
                                  <div className="c2">
                                    {p.shieldDroneCount}
                                    <span className="phaseCum">（{cumDrones}）</span>
                                  </div>
                                  <div className="c3">
                                    {formatNumber(perExpected, 3)}
                                    <span className="phaseCum">（{formatNumber(cumExpected, 0)}）</span>
                                  </div>
                                </div>
                              );
                            });
                          })()}
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

