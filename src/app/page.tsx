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

function formatDuration(v?: number): string {
  if (v == null) return "-";
  const s = Math.max(0, v);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  if (m < 60) return `${m}m ${rs.toFixed(0)}s`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return `${h}h ${rm}m`;
}

function formatPerMin(v?: number): string {
  if (v == null) return "-";
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(2);
}

export default function Page() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodeMap, setNodeMap] = useState<Record<string, NodeMeta> | null>(null);

  const missions = useMemo<MissionResult[]>(() => parse?.missions ?? [], [parse]);

  useEffect(() => {
    // 轻量：只加载一次节点映射（由 build 时脚本生成到 public/）
    let cancelled = false;
    fetch("./node-map.zh.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled) return;
        if (json && typeof json === "object") setNodeMap(json as Record<string, NodeMeta>);
      })
      .catch(() => {
        // 忽略：无映射时仅展示 nodeId
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const metricsFor = (m?: MissionResult | null) => {
    const enemySpawned = m?.spawnedAtEnd ?? undefined;
    const drones = m?.shieldDroneCount ?? undefined;
    const totalSec =
      m?.stateDurationSec != null && m.stateDurationSec > 0
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
    return { enemySpawned, drones, totalSec, dronesPerMin };
  };

  const nodeInfoLine = (m: MissionResult) => {
    const meta = m.nodeId ? nodeMap?.[m.nodeId] : undefined;
    const parts = [
      meta?.nodeName,
      meta?.systemName,
      meta?.missionType,
      meta?.faction,
    ].filter(Boolean) as string[];
    // 不展示 (SolNode94) 这类括号信息，只展示可读文本
    return parts.join(" · ");
  };

  const handleFile = async (file: File) => {
    setError(null);
    setParse(null);
    try {
      const res = await parseRecentValidEeLogFromFile(file, { count: 2, minDurationSec: 60 });
      setParse(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取或解析失败");
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
        <div className="helpLine">
          <span>ee.log 路径：%LOCALAPPDATA%\\Warframe</span>
          <span>仅显示最近有效 2 把（时长 &lt; 1 分钟自动排除）</span>
        </div>

        <div className="topbar">
          <div className="actions">
            <span className="hint">仅限主机的 ee.log</span>
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
              return (
                <div key={idx} className="runBlock">
                  <div className="runHeader">
                    <div className="runTitle">最近有效第 {idx + 1} 把</div>
                    <div className="runSub">
                      {nodeInfoLine(m) || "-"}
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
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

