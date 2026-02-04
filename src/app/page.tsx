"use client";

import React, { useMemo, useRef, useState } from "react";
import type { MissionResult, ParseResult } from "../parser";
import { parseEeLog } from "../parser";

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

  const m = useMemo<MissionResult | null>(() => {
    return parse?.missions?.[0] ?? null;
  }, [parse]);

  const metrics = useMemo(() => {
    const enemySpawned = m?.spawnedAtEnd ?? undefined;
    const drones = m?.shieldDroneCount ?? undefined;
    const totalSec =
      m?.onAgentCreatedSpanSec != null && m.onAgentCreatedSpanSec > 0
        ? m.onAgentCreatedSpanSec
        : m?.durationSec != null && m.durationSec > 0
          ? m.durationSec
          : undefined;
    const dronesPerMin =
      drones != null && totalSec != null && totalSec > 0
        ? drones / (totalSec / 60)
        : undefined;

    return { enemySpawned, drones, totalSec, dronesPerMin };
  }, [m]);

  const handleFile = async (file: File) => {
    setError(null);
    setParse(null);
    try {
      const text = await file.text();
      const res = parseEeLog(text); // 默认 latest
      setParse(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取或解析失败");
    }
  };

  return (
    <div className="wrap">
      <div className="bgfx" />
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
        <div className="topbar">
          <div className="actions">
            <span className="hint">仅限主机的 ee.log</span>
            {error ? <span className="err">解析失败</span> : null}
            {m?.status === "incomplete" ? <span className="warnTag">incomplete</span> : null}
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
    </div>
  );
}

