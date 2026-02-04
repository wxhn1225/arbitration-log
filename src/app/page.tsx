"use client";

import React, { useMemo, useRef, useState } from "react";
import type { MissionResult, ParseResult } from "../parser";
import { parseEeLog } from "../parser";

function formatSeconds(v?: number): string {
  if (v == null) return "-";
  return v.toFixed(3);
}

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

function StatusPill({ m }: { m: MissionResult }) {
  return (
    <span className="pill" title={m.note ?? ""}>
      {m.status === "ok" ? "OK" : "未闭合"}
    </span>
  );
}

export default function Page() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => {
    const missions = parse?.missions ?? [];
    const ok = missions.filter((m) => m.status === "ok").length;
    const incomplete = missions.length - ok;
    const last = [...missions].reverse().find((m) => m.status === "ok");
    return { total: missions.length, ok, incomplete, last };
  }, [parse]);

  const handleFile = async (file: File) => {
    setError(null);
    setParse(null);
    setFileName(file.name);
    setFileSize(file.size);
    try {
      const text = await file.text();
      const res = parseEeLog(text);
      setParse(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取或解析失败");
    }
  };

  return (
    <div className="wrap">
      <div className="title">
        <h1>Warframe 仲裁 ee.log 分析</h1>
        <div className="sub">只分析最后一次仲裁 · 纯前端解析 · 不上传到服务器</div>
      </div>

      <div className="grid">
        <div className="panel">
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
            <div>
              把 <code>ee.log</code> 拖到这里，或用下面按钮选择文件。
            </div>

            <div className="row">
              <label className="btn" htmlFor="file">
                选择文件
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

            <div className="meta">
              <div>
                <strong>开始标记</strong>：<code>Mission name: ... - 仲裁</code> 或{" "}
                <code>Host loading {"{...}"} name:"SolNodeXX_EliteAlert"</code>
              </div>
              <div>
                <strong>结束标记</strong>：<code>EliteAlertMission at SolNodeXX</code>（必须与开始的
                SolNodeXX 相同）
              </div>
              <div>
                <strong>统计</strong>：区间内最后一条 <code>OnAgentCreated</code> 的 <code>Spawned N</code>；
                区间内 <code>OnAgentCreated /Npc/CorpusEliteShieldDroneAgent</code> 的条数（无人机数量）
                ；以及区间内第一/最后条 <code>OnAgentCreated</code> 的时间差与每分钟无人机生成
              </div>
            </div>

            <div className="status">
              <div>
                <strong>文件</strong>：{fileName ?? "-"}{" "}
                {fileSize != null ? <span>({(fileSize / 1024 / 1024).toFixed(2)} MB)</span> : null}
              </div>
              <div>
                <strong>任务</strong>：{summary.total}（OK {summary.ok} / 未闭合 {summary.incomplete}）
              </div>
              {summary.last?.spawnedAtEnd != null ? (
                <div>
                  <strong>最后一个 OK 任务 Spawned</strong>：{summary.last.spawnedAtEnd}
                </div>
              ) : null}
              {summary.last?.shieldDronePerMin != null ? (
                <div>
                  <strong>最后一个 OK 任务 无人机/分钟</strong>：{formatPerMin(summary.last.shieldDronePerMin)}
                </div>
              ) : null}
              {error ? (
                <div className="bad">
                  <strong>错误</strong>：{error}
                </div>
              ) : null}
            </div>

            {parse?.warnings?.length ? (
              <div className="warn">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>提示</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {parse.warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        <div className="panel">
          <div style={{ marginBottom: 10, color: "rgba(255,255,255,0.82)", fontSize: 13 }}>
            解析结果
          </div>

          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>状态</th>
                <th>SolNode</th>
                <th>任务名</th>
                <th>行范围</th>
                <th>耗时</th>
                <th>OnAgent 时长</th>
                <th>无人机/分钟</th>
                <th>Spawned(最后)</th>
                <th>无人机数</th>
              </tr>
            </thead>
            <tbody>
              {(parse?.missions ?? []).map((m) => (
                <tr key={m.index}>
                  <td>{m.index}</td>
                  <td>
                    <StatusPill m={m} />
                  </td>
                  <td>{m.nodeId ?? "-"}</td>
                  <td>{m.missionName ?? "-"}</td>
                  <td>
                    {m.startLine}
                    {m.endLine ? ` ~ ${m.endLine}` : ""}
                    <div style={{ marginTop: 4, color: "rgba(255,255,255,0.62)", fontSize: 12 }}>
                      t={formatSeconds(m.startTime)} → t={formatSeconds(m.endTime)}
                    </div>
                  </td>
                  <td>{formatDuration(m.durationSec)}</td>
                  <td>
                    {formatDuration(m.onAgentCreatedSpanSec)}
                    <div style={{ marginTop: 4, color: "rgba(255,255,255,0.62)", fontSize: 12 }}>
                      t={formatSeconds(m.firstOnAgentCreatedTime)} → t={formatSeconds(m.lastOnAgentCreatedTime)}
                    </div>
                  </td>
                  <td>{formatPerMin(m.shieldDronePerMin)}</td>
                  <td>{m.spawnedAtEnd ?? "-"}</td>
                  <td>{m.shieldDroneCount}</td>
                </tr>
              ))}

              {(parse?.missions?.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={10} style={{ color: "rgba(255,255,255,0.65)" }}>
                    还没有结果：请先上传一个 <code>ee.log</code>。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

