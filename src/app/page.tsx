"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MissionResult, ParseResult, TickingPoint } from "../parser";
import { parseRecentValidEeLogFromFile } from "../parser";
import { useVirtualizer } from "@tanstack/react-virtual";

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
  totalSec: number;
  activeSec: number;
};

// ---- 共享：检测无效时段 ----
const INACTIVE_THRESH = 3;

function detectInactiveIntervals(
  series: TickingPoint[],
  phaseBoundaryTimes?: number[],
): Array<{ start: number; end: number }> {
  if (series.length < 2) return [];
  const intervals: Array<{ start: number; end: number }> = [];

  // 1) MT=0 连续 ≥ INACTIVE_THRESH 秒（或开局首段 MT=0）
  let runStart = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i]!.v === 0) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0) {
        const s = series[runStart]!.t;
        const e = series[i]!.t;
        if (runStart === 0 || e - s >= INACTIVE_THRESH) intervals.push({ start: s, end: e });
        runStart = -1;
      }
    }
  }
  if (runStart >= 0) {
    const s = series[runStart]!.t;
    const e = series[series.length - 1]!.t;
    if (runStart === 0 || e - s >= INACTIVE_THRESH) intervals.push({ start: s, end: e });
  }

  // 2) 采样点间隔 ≥ INACTIVE_THRESH 秒，满足以下任一条件标为无效：
  //    - 开局第一段（i===0）
  //    - 边界任一侧 MT=0（轮次切换后无人刷新）
  //    - 间隔超长（≥20s），极可能是轮次间隙（战斗中很少 20s 无生成）
  for (let i = 0; i < series.length - 1; i++) {
    const s = series[i]!.t;
    const e = series[i + 1]!.t;
    const gap = e - s;
    if (gap >= INACTIVE_THRESH) {
      const vBefore = series[i]!.v;
      const vAfter = series[i + 1]!.v;
      if (i === 0 || vBefore === 0 || vAfter === 0 || gap >= 20) {
        intervals.push({ start: s, end: e });
      }
    }
  }

  // 3) 轮次边界时间戳标记的采样空白（MT 两端都 >0 但确实是轮次间）
  if (phaseBoundaryTimes && phaseBoundaryTimes.length > 0) {
    for (const bt of phaseBoundaryTimes) {
      for (let i = 0; i < series.length - 1; i++) {
        if (series[i]!.t <= bt && series[i + 1]!.t > bt) {
          const gap = series[i + 1]!.t - series[i]!.t;
          if (gap >= INACTIVE_THRESH) {
            intervals.push({ start: series[i]!.t, end: series[i + 1]!.t });
          }
          break;
        }
      }
    }
  }

  // 按 start 排序并合并重叠区间
  intervals.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

function satColor(ratio: number): string {
  const r = ratio < 0.5 ? Math.round(ratio * 2 * 255) : 255;
  const g = ratio < 0.5 ? 255 : Math.round((1 - (ratio - 0.5) * 2) * 255);
  return `rgb(${r},${g},40)`;
}

function buildSatData(series: TickingPoint[], hostSec?: number, selectedSec?: number, phaseBoundaryTimes?: number[]): SatData | null {
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

  const gaps = detectInactiveIntervals(src, phaseBoundaryTimes);
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
    totalSec: totalAll,
    activeSec: activeAll,
  };
}

// ---- 无人机真空期分析 ---------------------------------------------------------

type DroneGapBucket = { lo: number; hi: number | null; totalPct: number; activePct: number };
type DroneGapData = {
  maxGap: number;
  buckets: DroneGapBucket[];
  gt2TotalPct: number;
  gt2ActivePct: number;
  totalSec: number;
  activeSec: number;
};

function buildDroneGapData(
  times: number[],
  tickingSeries: TickingPoint[] | undefined,
  hostSec?: number,
  selectedSec?: number,
  phaseBoundaryTimes?: number[],
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

  // 变步长分桶边界：0-2 每0.5s, 2-4 每1s, 4-10 每2s, 10-30(10-15/15-20/20-30), 30-50 每10s，最后一桶固定 50+
  const edges: number[] = [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 15, 20, 30, 40, 50, 60];
  const numBuckets = edges.length - 1;

  const totalDurs = new Array(numBuckets).fill(0) as number[];
  const activeDurs = new Array(numBuckets).fill(0) as number[];
  let totalAll = 0, activeAll = 0;
  let gt2Total = 0, gt2Active = 0;

  const gapIntervals = tickingSeries ? detectInactiveIntervals(tickingSeries, phaseBoundaryTimes) : [];

  // maxGap 只取有效时段内的最大间隔（排除无效时段）
  let maxGap = 0;

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
    if (g > 2) gt2Total += g;
    const midT = src[i]! + g / 2;
    if (!isInGap(midT)) {
      activeDurs[idx]! += g;
      activeAll += g;
      if (g > 2) gt2Active += g;
      if (g > maxGap) maxGap = g;
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
    gt2TotalPct: totalAll > 0 ? (gt2Total / totalAll) * 100 : 0,
    gt2ActivePct: activeAll > 0 ? (gt2Active / activeAll) * 100 : 0,
    totalSec: totalAll,
    activeSec: activeAll,
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

// ---- 事件时间线 ----------------------------------------------------------------

type EventKind = "ticking" | "drone" | "phase";
type TimelineEvent = {
  t: number;
  kind: EventKind;
  value?: number;
  phaseIdx?: number;
  phaseKind?: "wave" | "round";
};

function buildEventTimeline(m: MissionResult): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (m.tickingSeries) {
    for (const p of m.tickingSeries) {
      events.push({ t: p.t, kind: "ticking", value: p.v });
    }
  }
  if (m.droneSpawnTimes) {
    for (let i = 0; i < m.droneSpawnTimes.length; i++) {
      events.push({
        t: m.droneSpawnTimes[i]!,
        kind: "drone",
        value: m.droneBurstSizes?.[i],
      });
    }
  }
  if (m.phaseBoundaryTimes) {
    const phaseKind = m.phases?.[0]?.kind;
    for (let i = 0; i < m.phaseBoundaryTimes.length; i++) {
      events.push({
        t: m.phaseBoundaryTimes[i]!,
        kind: "phase",
        phaseIdx: i + 1,
        phaseKind,
      });
    }
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

const KIND_LABELS: Record<EventKind, string> = {
  ticking: "存活敌人",
  drone: "无人机生成",
  phase: "波次",
};

type EventFilter = "all" | EventKind;
const FILTER_OPTIONS: { key: EventFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "ticking", label: "存活敌人" },
  { key: "drone", label: "无人机生成" },
  { key: "phase", label: "波次" },
];

function TimelineChart({
  allEvents,
  selectedRange,
  onRangeChange,
  playFromTime,
  speed,
  onSkipReady,
}: {
  allEvents: TimelineEvent[];
  selectedRange: [number, number] | null;
  onRangeChange: (r: [number, number] | null) => void;
  playFromTime: { t: number; seq: number } | null;
  speed: number;
  onSkipReady: (skipFn: (() => void) | null) => void;
}) {
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const animRef          = useRef<number>(0);
  const redrawRef        = useRef<((r: [number, number] | null) => void) | null>(null);
  const startScrollRef   = useRef<((sec: number) => void) | null>(null);
  const skipRef          = useRef<(() => void) | null>(null);
  const selectedRangeRef = useRef(selectedRange);
  const speedRef         = useRef(speed);

  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { selectedRangeRef.current = selectedRange; }, [selectedRange]);
  useEffect(() => { redrawRef.current?.(selectedRangeRef.current); }, [selectedRange]);
  useEffect(() => {
    if (playFromTime != null && startScrollRef.current) startScrollRef.current(playFromTime.t);
  }, [playFromTime]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelAnimationFrame(animRef.current);
    const cv = canvas;

    const W = cv.offsetWidth, H = cv.offsetHeight;
    if (W === 0 || H === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctxRaw = cv.getContext("2d");
    if (!ctxRaw) return;
    const c = ctxRaw;
    c.scale(dpr, dpr);

    const ticking = allEvents.filter((e) => e.kind === "ticking");
    const drones  = allEvents.filter((e) => e.kind === "drone");
    const phases  = allEvents.filter((e) => e.kind === "phase");
    if (ticking.length === 0 && drones.length === 0) return;

    const maxT  = Math.max(...allEvents.map((e) => e.t), 1);
    const maxV  = Math.max(...ticking.map((e) => e.value ?? 0), 1);
    const maxDC = Math.max(...drones.map((e) => e.value ?? 1), 1);

    const PAD = { top: 10, right: 12, bottom: 24, left: 42 };
    const cW = W - PAD.left - PAD.right;
    const cH = H - PAD.top - PAD.bottom;
    const aH = Math.floor(cH * 0.62);
    const aTop = PAD.top, aBot = PAD.top + aH;
    const divY = aBot + 1, dTop = divY + 2, dBot = PAD.top + cH;
    const dH = cH - aH - 3;

    const isDark = !!document.documentElement.getAttribute("data-theme");
    const labelC  = isDark ? "rgb(190,190,190)" : "rgb(30,24,16)";
    const gridC   = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.10)";
    const divC    = isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.14)";
    const lineC   = isDark ? "rgb(55,210,85)" : "rgb(0,125,42)";
    const phaseC  = isDark ? "rgba(255,200,50,0.85)" : "rgba(130,80,0,0.92)";
    const bandC   = isDark ? "rgba(255,255,255,0.026)" : "rgba(0,0,0,0.028)";
    const selFill = isDark ? "rgba(255,255,255,0.09)" : "rgba(60,80,220,0.09)";
    const selBord = isDark ? "rgba(255,255,255,0.38)" : "rgba(60,80,220,0.55)";
    const aFillT  = isDark ? "rgba(55,210,85,0.28)" : "rgba(0,140,50,0.23)";
    const aFillB  = isDark ? "rgba(55,210,85,0.02)" : "rgba(0,140,50,0.02)";
    const sFillT  = isDark ? "rgba(65,168,255,0.78)" : "rgba(10,62,192,0.68)";
    const sFillB  = isDark ? "rgba(65,168,255,0.10)" : "rgba(10,62,192,0.08)";
    const droneC  = isDark ? "rgb(65,168,255)" : "rgb(10,62,192)";

    const windowDur   = Math.min(maxT * 0.22, 120);
    const totalScroll = Math.max(0, maxT - windowDur);
    const BASE_MS     = Math.max(6000, totalScroll * 25);

    const waveBounds = [0, ...phases.map((p) => p.t), maxT];

    const step = Math.max(1, Math.floor(ticking.length / 600));
    const sampled: TimelineEvent[] = ticking.filter((_, i) => i % step === 0);
    const lastPt = ticking[ticking.length - 1];
    if (lastPt && sampled[sampled.length - 1] !== lastPt) sampled.push(lastPt);

    function yA(v: number) { return aTop + (1 - v / maxV) * aH; }
    function yD(n: number) { return dBot - (n / maxDC) * dH * 0.82; }

    const xOfFull = (t: number) => PAD.left + (t / maxT) * cW;
    const fullPts = sampled.map((e) => ({ x: xOfFull(e.t), y: yA(e.value ?? 0) }));

    function catmullSegments(pts: { x: number; y: number }[]) {
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)]!;
        const p1 = pts[i]!;
        const p2 = pts[i + 1]!;
        const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
        c.bezierCurveTo(
          p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
          p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
          p2.x, p2.y,
        );
      }
    }

    function fmtTime(sec: number) {
      const s = Math.round(sec);
      const mm = Math.floor(s / 60), ss = s % 60;
      return mm > 0 ? `${mm}:${String(ss).padStart(2, "0")}` : `${s}s`;
    }

    function drawScene(
      xOf: (t: number) => number,
      tA: number, tB: number,
      pts: { x: number; y: number }[],
      xTicks: number[],
      range: [number, number] | null,
    ) {
      c.clearRect(0, 0, W, H);

      c.fillStyle = labelC; c.font = "bold 12px sans-serif";
      c.textAlign = "right"; c.textBaseline = "middle";
      c.fillText(String(maxV), PAD.left - 4, aTop);
      c.fillText("0", PAD.left - 4, aBot);
      c.fillStyle = isDark ? "rgba(65,168,255,0.7)" : "rgba(10,62,192,0.7)";
      c.font = "bold 10px sans-serif";
      c.fillText("生成", PAD.left - 4, (dTop + dBot) / 2);

      c.fillStyle = labelC; c.font = "bold 12px sans-serif";
      c.textAlign = "center"; c.textBaseline = "top";
      for (const t of xTicks) c.fillText(fmtTime(t), xOf(t), dBot + 4);

      c.save();
      c.beginPath(); c.rect(PAD.left, 0, cW, H); c.clip();

      for (let i = 1; i < waveBounds.length - 1; i += 2) {
        const lo = waveBounds[i]!, hi = waveBounds[i + 1]!;
        if (hi <= tA || lo >= tB) continue;
        const x1 = Math.max(PAD.left, xOf(Math.max(lo, tA)));
        const x2 = Math.min(PAD.left + cW, xOf(Math.min(hi, tB)));
        if (x2 > x1) { c.fillStyle = bandC; c.fillRect(x1, aTop, x2 - x1, cH); }
      }

      c.strokeStyle = gridC; c.lineWidth = 0.5;
      for (let i = 0; i <= 4; i++) {
        const y = aTop + (i / 4) * aH;
        c.beginPath(); c.moveTo(PAD.left, y); c.lineTo(PAD.left + cW, y); c.stroke();
      }

      c.strokeStyle = divC; c.lineWidth = 1;
      c.beginPath(); c.moveTo(PAD.left, divY); c.lineTo(PAD.left + cW, divY); c.stroke();

      if (range) {
        const x1 = Math.max(PAD.left, xOfFull(range[0]));
        const x2 = Math.min(PAD.left + cW, xOfFull(range[1]));
        if (x2 > x1) {
          c.fillStyle = selFill; c.fillRect(x1, aTop, x2 - x1, cH);
          c.strokeStyle = selBord; c.lineWidth = 1; c.strokeRect(x1, aTop, x2 - x1, cH);
        }
      }

      c.font = "bold 9px sans-serif"; c.textAlign = "center"; c.textBaseline = "top";
      for (const p of phases) {
        if (p.t < tA - 2 || p.t > tB + 2) continue;
        const x = xOf(p.t);
        c.setLineDash([3, 3]); c.strokeStyle = phaseC; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x, aTop); c.lineTo(x, dBot); c.stroke();
        c.setLineDash([]);
        c.fillStyle = phaseC;
        c.fillText(`第${p.phaseIdx ?? ""}波`, x, aTop + 2);
      }

      if (pts.length >= 2) {
        const grad = c.createLinearGradient(0, aTop, 0, aBot);
        grad.addColorStop(0, aFillT); grad.addColorStop(1, aFillB);
        c.beginPath(); c.moveTo(pts[0]!.x, aBot); c.lineTo(pts[0]!.x, pts[0]!.y);
        catmullSegments(pts);
        c.lineTo(pts[pts.length - 1]!.x, aBot); c.closePath();
        c.fillStyle = grad; c.fill();

        c.beginPath(); c.moveTo(pts[0]!.x, pts[0]!.y);
        catmullSegments(pts);
        c.strokeStyle = lineC; c.lineWidth = 1.8; c.stroke();
      }

      c.strokeStyle = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";
      c.lineWidth = 0.5;
      c.beginPath(); c.moveTo(PAD.left, dBot); c.lineTo(PAD.left + cW, dBot); c.stroke();

      c.font = "bold 8px sans-serif"; c.textAlign = "center"; c.textBaseline = "bottom";
      for (const d of drones) {
        if (d.t < tA || d.t > tB) continue;
        const x = xOf(d.t), cnt = d.value ?? 1, yt = yD(cnt);
        const sg = c.createLinearGradient(0, yt, 0, dBot);
        sg.addColorStop(0, sFillT); sg.addColorStop(1, sFillB);
        c.fillStyle = sg; c.fillRect(x - 1.5, yt, 3, dBot - yt);
        if (cnt > 1) { c.fillStyle = droneC; c.fillText(`\u00d7${cnt}`, x, yt - 1); }
      }

      c.restore();
    }

    function drawScrollFrame(wStart: number) {
      const xOf = (t: number) => PAD.left + ((t - wStart) / windowDur) * cW;
      const xTicks = Array.from({ length: 6 }, (_, i) => wStart + (i / 5) * windowDur);
      const marg = windowDur * 0.06;
      const visPts = sampled
        .filter((e) => e.t >= wStart - marg && e.t <= wStart + windowDur + marg)
        .map((e) => ({ x: xOf(e.t), y: yA(e.value ?? 0) }));
      drawScene(xOf, wStart, wStart + windowDur, visPts, xTicks, null);
    }

    function drawFull(range: [number, number] | null) {
      const xTicks = Array.from({ length: 7 }, (_, i) => (i / 6) * maxT);
      drawScene(xOfFull, 0, maxT, fullPts, xTicks, range);
    }

    let animMode: "scroll" | "full" = "scroll";
    let isDragging = false;
    let dragStartT = 0;
    let dragMoved  = false;

    redrawRef.current = (r) => { if (animMode === "full") drawFull(r); };

    function clientXToTime(clientX: number) {
      const rect = cv.getBoundingClientRect();
      return Math.max(0, Math.min(maxT, ((clientX - rect.left - PAD.left) / cW) * maxT));
    }

    function startScrollFrom(startSec: number) {
      cancelAnimationFrame(animRef.current);
      animMode = "scroll";
      onRangeChange(null);
      const scrollFrom = Math.max(0, Math.min(startSec, totalScroll));
      const remainScroll = totalScroll - scrollFrom;
      const baseRemainMs = Math.max(2000, remainScroll * 25);
      let prevNow = performance.now();
      let progress = 0;
      function anim(now: number) {
        const dt = now - prevNow; prevNow = now;
        progress += dt * speedRef.current / baseRemainMs;
        if (progress >= 1) { progress = 1; }
        drawScrollFrame(scrollFrom + progress * remainScroll);
        if (progress < 1) { animRef.current = requestAnimationFrame(anim); }
        else { animMode = "full"; redrawRef.current = (r) => drawFull(r); drawFull(selectedRangeRef.current); onSkipReady(null); }
      }
      animRef.current = requestAnimationFrame(anim);
      onSkipReady(() => skipToFull());
    }
    startScrollRef.current = startScrollFrom;

    function skipToFull() {
      cancelAnimationFrame(animRef.current);
      animMode = "full";
      redrawRef.current = (r) => drawFull(r);
      drawFull(selectedRangeRef.current);
      onRangeChange(null);
      onSkipReady(null);
    }

    function onMouseDown(e: MouseEvent) {
      if (animMode === "scroll") {
        skipToFull();
        return;
      }
      isDragging = true; dragMoved = false; dragStartT = clientXToTime(e.clientX);
    }
    function onMouseMove(e: MouseEvent) {
      if (!isDragging || animMode !== "full") return;
      dragMoved = true;
      drawFull([Math.min(dragStartT, clientXToTime(e.clientX)), Math.max(dragStartT, clientXToTime(e.clientX))]);
    }
    function onMouseUp(e: MouseEvent) {
      if (!isDragging || animMode !== "full") return;
      isDragging = false;
      if (!dragMoved) {
        const clickT = clientXToTime(e.clientX);
        startScrollFrom(clickT);
        return;
      }
      const lo = Math.min(dragStartT, clientXToTime(e.clientX));
      const hi = Math.max(dragStartT, clientXToTime(e.clientX));
      if (hi - lo < maxT * 0.005) { onRangeChange(null); drawFull(null); }
      else { onRangeChange([lo, hi]); drawFull([lo, hi]); }
    }

    cv.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    startScrollFrom(0);

    return () => {
      cancelAnimationFrame(animRef.current);
      cv.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [allEvents, onRangeChange]);

  return <canvas ref={canvasRef} className="detailChart" style={{ cursor: "crosshair" }} />;
}

function DetailOverlay({
  m,
  runIdx,
  nodeInfo,
  onClose,
}: {
  m: MissionResult;
  runIdx: number;
  nodeInfo: string;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const [chartRange, setChartRange] = useState<[number, number] | null>(null);
  const [speed, setSpeed] = useState(1);
  const [playTrigger, setPlayTrigger] = useState<{ t: number; seq: number } | null>(null);
  const [skipFn, setSkipFn] = useState<(() => void) | null>(null);
  const allEvents = useMemo(() => buildEventTimeline(m), [m]);
  const events = useMemo(() => {
    let evts = filter === "all" ? allEvents : allEvents.filter((e) => e.kind === filter);
    if (chartRange) evts = evts.filter((e) => e.t >= chartRange[0] && e.t <= chartRange[1]);
    return evts;
  }, [allEvents, filter, chartRange]);
  const handlePlayFrom = (t: number) => setPlayTrigger({ t, seq: Date.now() });

  const bodyRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const counts = useMemo(() => {
    const c: Record<EventKind, number> = { ticking: 0, drone: 0, phase: 0 };
    for (const e of allEvents) c[e.kind]++;
    return c;
  }, [allEvents]);

  return (
    <div
      className="detailOverlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="detailPanel">
        <div className="detailHeader">
          <span className="detailTitle">Run #{runIdx + 1} — {nodeInfo}</span>
          <span className="detailTotalCount">{events.length.toLocaleString()} 条</span>
          <button className="detailClose" onClick={onClose} title="关闭 (Esc)">✕</button>
        </div>
        <div className="chartControlsWrap">
          <TimelineChart
            allEvents={allEvents}
            selectedRange={chartRange}
            onRangeChange={setChartRange}
            playFromTime={playTrigger}
            speed={speed}
            onSkipReady={(fn) => setSkipFn(() => fn)}
          />
          <div className="speedControls">
            {[0.5, 1, 2, 3].map((s) => (
              <button
                key={s}
                className={`speedBtn${speed === s ? " active" : ""}`}
                onClick={() => setSpeed(s)}
              >{s}×</button>
            ))}
            {skipFn && (
              <button className="speedBtn speedBtnSkip" onClick={skipFn}>跳过 ⏭</button>
            )}
          </div>
        </div>
        <div className="detailFilters">
          {FILTER_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              className={`detailFilter detailFilter-${key}${filter === key ? " active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
              {key !== "all" && <span className="detailFilterCount">{counts[key as EventKind]}</span>}
            </button>
          ))}
          {chartRange && (
            <div className="chartRangeTag">
              <span>{chartRange[0].toFixed(1)}s – {chartRange[1].toFixed(1)}s</span>
              <button className="chartRangeClear" onClick={() => setChartRange(null)} title="清除时间筛选">✕</button>
            </div>
          )}
        </div>
        <div className="detailTableHead">
          <span className="dtTime">时间 (s)</span>
          <span className="dtKind">类型</span>
          <span className="dtVal">数值</span>
        </div>
        <div className="detailBody" ref={bodyRef}>
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const ev = events[vRow.index]!;
              const valText =
                ev.kind === "ticking"
                  ? String(ev.value ?? "-")
                  : ev.kind === "drone"
                    ? `×${ev.value ?? 1}`
                    : `第 ${ev.phaseIdx} 波`;
              return (
                <div
                  key={vRow.index}
                  className={`dtRow dtRow-${ev.kind}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    transform: `translateY(${vRow.start}px)`,
                    height: `${vRow.size}px`,
                    width: "100%",
                  }}
                >
                  <span className="dtTime dtTimeLink" onClick={() => handlePlayFrom(ev.t)} title="从此处播放">{ev.t.toFixed(2)}</span>
                  <span className="dtKind">{KIND_LABELS[ev.kind]}</span>
                  <span className="dtVal">{valText}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Page -------------------------------------------------------------------

export default function Page() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastFileRef = useRef<File | null>(null);
  const runRefs = useRef<Array<HTMLDivElement | null>>([]);
  const captureRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [copyingIdx, setCopyingIdx] = useState<number | null>(null);
  const [satPctMode, setSatPctMode] = useState<"total" | "active">("active");
  const [detailState, setDetailState] = useState<{ m: MissionResult; idx: number } | null>(null);

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
      // 等待一帧让 React 重渲染（下拉框 → 纯文字）
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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
    <>
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
                      ? buildSatData(m.tickingSeries, metrics.hostTotalSec, selectedSec, m.phaseBoundaryTimes) : null;
                    const dg = m.droneSpawnTimes && m.droneSpawnTimes.length >= 2
                      ? buildDroneGapData(m.droneSpawnTimes, m.tickingSeries, metrics.hostTotalSec, selectedSec, m.phaseBoundaryTimes) : null;
                    const bd = buildDroneBurstDistrib(m.droneBurstSizes);
                    if (!sd && !dg && !bd) return null;
                    return (
                      <div className="satDual">
                        <div className="satModeRow">
                          {copyingIdx === idx
                            ? <span className="satModeText">{satPctMode === "total" ? "总时间" : "有效时间"}</span>
                            : <select
                                className="satSelect"
                                value={satPctMode}
                                onChange={(e) => setSatPctMode(e.target.value as "total" | "active")}
                              >
                                <option value="total">总时间</option>
                                <option value="active">有效时间</option>
                              </select>
                          }
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
                                      const baseSec = satPctMode === "total" ? sd.totalSec : sd.activeSec;
                                      const barW = Math.max(pct > 0 ? 2 : 0, pct * 100);
                                      const sec = pct * baseSec;
                                      return (
                                        <div className="satRow" key={i}>
                                          <span className="satLabel">{label}</span>
                                          <div className="satTrack">
                                            <div className="satFill" style={{ width: `${barW}%`, backgroundColor: satColor(ratio) }} />
                                          </div>
                                          <span className="satPct">{(pct * 100).toFixed(1)}% <span className="satSub">{sec.toFixed(1)}s</span></span>
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
                                          <span className="satPct">{(r.pct * 100).toFixed(1)}% <span className="satSub">{r.count}次</span></span>
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
                          {/* 右：无人机真空期 */}
                          {dg && (
                            <div className="satDistrib">
                              <div className="satTitleRow">
                                <span className="satTitle">无人机真空期</span>
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
                                  const baseSec = satPctMode === "total" ? dg.totalSec : dg.activeSec;
                                  const barW = Math.max(pct > 0 ? 2 : 0, pct * 100);
                                  const sec = pct * baseSec;
                                  return (
                                    <div className="satRow" key={i}>
                                      <span className="satLabel">{label}</span>
                                      <div className="satTrack">
                                        <div className="satFill" style={{ width: `${barW}%`, backgroundColor: satColor(ratio) }} />
                                      </div>
                                      <span className="satPct">{(pct * 100).toFixed(1)}% <span className="satSub">{sec.toFixed(1)}s</span></span>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="satFooter">
                                &gt;2s：{(satPctMode === "total" ? dg.gt2TotalPct : dg.gt2ActivePct).toFixed(1)}%
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

                  <div className="detailBtnRow" {...{ "data-html2canvas-ignore": "true" }}>
                    <button
                      className="detailBtn"
                      onClick={() => setDetailState({ m, idx })}
                    >
                      查看时间线
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>

    {detailState && (
      <DetailOverlay
        m={detailState.m}
        runIdx={detailState.idx}
        nodeInfo={nodeInfoLine(detailState.m)}
        onClose={() => setDetailState(null)}
      />
    )}
    </>
  );
}
