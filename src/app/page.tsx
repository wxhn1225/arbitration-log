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

type BuffState = {
  blueBox: boolean; // ×2
  abundant: boolean; // ×1.18
  yellowBox: boolean; // ×2
  blessing: boolean; // ×1.25
};

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
  const runRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regions, setRegions] = useState<Record<string, RegionInfo> | null>(null);
  const [dictZh, setDictZh] = useState<Record<string, string> | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [copyingIdx, setCopyingIdx] = useState<number | null>(null);
  const [copyResult, setCopyResult] = useState<{ idx: number; ok: boolean } | null>(
    null
  );
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
    const totalSec =
      m?.eomDurationSec != null && m.eomDurationSec > 0
        ? m.eomDurationSec
        : m?.stateDurationSec != null && m.stateDurationSec > 0
        ? m.stateDurationSec
        : m?.onAgentCreatedSpanSec != null && m.onAgentCreatedSpanSec > 0
          ? m.onAgentCreatedSpanSec
          : m?.durationSec != null && m.durationSec > 0
            ? m.durationSec
            : undefined;
    const dronesPerMin =
      drones != null && totalSec != null && totalSec > 0
        ? drones / (totalSec / 60)
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
    const expectedPerHour =
      expectedTotal != null && totalSec != null && totalSec > 0
        ? (expectedTotal * 3600) / totalSec
        : undefined;

    // 满状态评级（不受勾选影响）
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
    const fullExpectedPerHour =
      fullExpectedTotal != null && totalSec != null && totalSec > 0
        ? (fullExpectedTotal * 3600) / totalSec
        : undefined;

    return {
      enemySpawned,
      drones,
      totalSec,
      dronesPerMin,
      waveCount,
      roundCount,
      expectedFromDrones,
      expectedFromRounds,
      expectedTotal,
      expectedPerHour,
      fullExpectedPerHour,
      grade: gradeFor(fullExpectedPerHour),
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

  useEffect(() => {
    if (!copyResult) return;
    const t = window.setTimeout(() => setCopyResult(null), 1400);
    return () => window.clearTimeout(t);
  }, [copyResult]);

  const copyRunImage = async (idx: number) => {
    const el = runRefs.current[idx];
    if (!el) return;

    setCopyingIdx(idx);
    try {
      const detailsEls = Array.from(el.querySelectorAll("details")) as HTMLDetailsElement[];
      const openStates = detailsEls.map((d) => d.open);
      detailsEls.forEach((d) => {
        d.open = false;
      });
      el.classList.add("shotMode");

      try {
        // 等字体就绪，避免截图字形抖动（浏览器不支持则忽略）
        const fontsReady = (document as unknown as { fonts?: { ready?: Promise<void> } })
          .fonts?.ready;
        if (fontsReady) await fontsReady.catch(() => {});

        const { default: html2canvas } = await import("html2canvas");
        const canvas = await html2canvas(el, {
          backgroundColor: null,
          scale: 2,
          useCORS: true,
          logging: false,
        });

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error("toBlob failed"));
          }, "image/png");
        });

        const fileName = `arbitration-log-${idx + 1}.png`;
        const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem })
          .ClipboardItem;
        const canWrite =
          typeof ClipboardItemCtor !== "undefined" &&
          typeof navigator !== "undefined" &&
          !!navigator.clipboard &&
          typeof (navigator.clipboard as unknown as { write?: unknown }).write === "function";

        if (canWrite) {
          await (navigator.clipboard as unknown as { write: (items: ClipboardItem[]) => Promise<void> }).write([
            new ClipboardItemCtor({ [blob.type]: blob }),
          ]);
        } else {
          // 兼容：不支持写剪贴板图片时，直接下载 PNG
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1200);
        }

        setCopyResult({ idx, ok: true });
      } finally {
        el.classList.remove("shotMode");
        const detailsEls2 = Array.from(el.querySelectorAll("details")) as HTMLDetailsElement[];
        detailsEls2.forEach((d, i) => {
          d.open = openStates[i] ?? false;
        });
      }
    } catch {
      setCopyResult({ idx, ok: false });
    } finally {
      setCopyingIdx((v) => (v === idx ? null : v));
    }
  };

  const handleFile = async (file: File) => {
    setError(null);
    setParse(null);
    setProgress(0);
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
          <span>ee.log 路径：%LOCALAPPDATA%\Warframe</span>
          <span>仅显示最近有效 2 把（时长 &lt; 1 分钟自动排除）</span>
        </div>

        <div className="topbar">
          <div className="actions">
            <span className="hint">仅限主机的 ee.log</span>
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
              const phaseLabel =
                m.missionKind === "defense"
                  ? "波次"
                  : m.missionKind === "interception"
                    ? "轮次"
                    : "阶段";
              return (
                <div
                  key={idx}
                  className="runBlock"
                  ref={(node) => {
                    runRefs.current[idx] = node;
                  }}
                >
                  <div className="runHeader">
                    <div className="runTitle">最近有效第 {idx + 1} 把</div>
                    <div className="runRight">
                      <div className="runSub">{nodeInfoLine(m) || "-"}</div>
                      <button
                        type="button"
                        className="btn copyBtn"
                        data-hide-in-shot="1"
                        disabled={copyingIdx === idx}
                        onClick={() => void copyRunImage(idx)}
                        title="复制该把分析图片"
                      >
                        {copyingIdx === idx
                          ? "复制中…"
                          : copyResult?.idx === idx
                            ? copyResult.ok
                              ? "已复制"
                              : "复制失败"
                            : "复制图片"}
                      </button>
                    </div>
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
                      <div className="metricValue">{formatPerMin(metrics.dronesPerMin)}</div>
                    </div>
                    <div className="metric metricD">
                      <div className="metricLabel">总时间</div>
                      <div className="metricValue">{formatDuration(metrics.totalSec)}</div>
                    </div>
                  </div>

                  <div className="metricsSmall">
                    <div className="mini">
                      <div className="miniLabel">波数</div>
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
                    <div className="mini">
                      <div className="miniLabel">1h 期望</div>
                      <div className="miniValue">{formatNumber(metrics.expectedPerHour, 1)}</div>
                    </div>
                    <div className="mini">
                      <div className="miniLabel">评级</div>
                      <div className="miniValue">{metrics.grade}</div>
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

