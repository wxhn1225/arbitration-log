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
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
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
    setFileName(file.name);
    setFileSize(file.size);
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
      <div className="panel">
      <div className="title">
        <h1>arbitration-log</h1>
        <div className="sub">latest run only</div>
      </div>

      <div className="panelInner">
        <div>
          <div
            className={`drop ${isDragOver ? "dragover" : ""}`}
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
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.86)" }}>
              拖拽 <code>ee.log</code> 到这里，或选择文件
            </div>

            <div className="row">
              <label className="btn" htmlFor="file">
                上传日志
              </label>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setParse(null);
                  setFileName(null);
                  setFileSize(null);
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

            <div className="accentLine" />

            <div className="status">
              <div>
                <strong>文件</strong>：{fileName ?? "-"}{" "}
                {fileSize != null ? <span>({(fileSize / 1024 / 1024).toFixed(2)} MB)</span> : null}
              </div>
              {m?.status === "incomplete" ? (
                <div className="bad">
                  <strong>提示</strong>：未完整匹配到结束标记（结果可能不完整）
                </div>
              ) : null}
              {error ? (
                <div className="bad">
                  <strong>错误</strong>：{error}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="metrics">
          <div className="metric">
            <div className="metricLabel">无人机</div>
            <div className="metricValue">
              {metrics.drones ?? "-"}
              <small>count</small>
            </div>
            <div className="metricHint">区间内 `CorpusEliteShieldDroneAgent` 的创建次数</div>
          </div>
          <div className="metric">
            <div className="metricLabel">敌人生成</div>
            <div className="metricValue">
              {metrics.enemySpawned ?? "-"}
              <small>spawned</small>
            </div>
            <div className="metricHint">区间内最后一条 `OnAgentCreated` 的 Spawned</div>
          </div>
          <div className="metric">
            <div className="metricLabel">无人机 / 分钟</div>
            <div className="metricValue">
              {formatPerMin(metrics.dronesPerMin)}
              <small>/min</small>
            </div>
            <div className="metricHint">无人机数 ÷ 总时间（分钟）</div>
          </div>
          <div className="metric">
            <div className="metricLabel">总时间</div>
            <div className="metricValue">
              {formatDuration(metrics.totalSec)}
              <small>time</small>
            </div>
            <div className="metricHint">优先 OnAgentCreated 首尾时间差，否则用任务开始/结束时间差</div>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}

