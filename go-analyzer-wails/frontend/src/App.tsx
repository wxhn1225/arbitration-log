import { useState, useEffect } from 'react';
import { GetDefaultPath, SelectLogDirectory, SelectLogFile, AnalyzeLog } from '../wailsjs/go/main/App';

interface NodeInfo {
  NodeID: string;
  NodeName: string;
  SystemName: string;
  MissionType: string;
  Faction: string;
}

interface MissionResult {
  Index: number;
  NodeID?: string;
  MissionName?: string;
  StartLine: number;
  EndLine?: number;
  StartTime?: number;
  EndTime?: number;
  DurationSec?: number;
  StateDurationSec?: number;
  OnAgentCreatedSpanSec?: number;
  SpawnedAtEnd?: number;
  ShieldDroneCount: number;
  ShieldDronePerMin?: number;
  Status: string;
  Note?: string;
  NodeInfo?: NodeInfo;
}

interface ParseResult {
  Missions: MissionResult[];
  Warnings: string[];
}

function App() {
  const [logPath, setLogPath] = useState('');
  const [recentCount, setRecentCount] = useState(2);
  const [minDuration, setMinDuration] = useState(60);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    GetDefaultPath().then(setLogPath);
  }, []);

  const handleSelectDirectory = async () => {
    try {
      const dir = await SelectLogDirectory();
      if (dir) {
        setLogPath(dir);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSelectFile = async () => {
    try {
      const file = await SelectLogFile();
      if (file) {
        setLogPath(file);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleAnalyze = async () => {
    if (!logPath.trim()) {
      setError('请输入日志路径');
      return;
    }

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const data = await AnalyzeLog({
        logPath,
        recentCount,
        minDuration,
      });
      setResult(data);
    } catch (err: any) {
      setError(err.message || '分析失败');
    } finally {
      setLoading(false);
    }
  };

  const getTotalTime = (mission: MissionResult) => {
    if (mission.StateDurationSec && mission.StateDurationSec > 0) {
      return mission.StateDurationSec;
    }
    if (mission.OnAgentCreatedSpanSec && mission.OnAgentCreatedSpanSec > 0) {
      return mission.OnAgentCreatedSpanSec;
    }
    if (mission.DurationSec && mission.DurationSec > 0) {
      return mission.DurationSec;
    }
    return 0;
  };

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-purple-600 via-purple-700 to-indigo-800">
      {/* Header */}
      <div className="bg-white/10 backdrop-blur-sm border-b border-white/20 px-6 py-4">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <span className="text-4xl">⚔️</span>
          Warframe 仲裁日志分析器
        </h1>
        <p className="text-purple-100 mt-1 text-sm">本地分析 ee.log 文件，获取仲裁任务详细数据</p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* 配置面板 */}
          <div className="bg-white rounded-2xl shadow-2xl p-6">
            <div className="space-y-4">
              {/* 日志路径 */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  日志文件路径
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={logPath}
                    onChange={(e) => setLogPath(e.target.value)}
                    placeholder="选择目录或文件，例如: C:\Users\YourName\AppData\Local\Warframe"
                    className="flex-1 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring focus:ring-purple-200 focus:ring-opacity-50 transition"
                  />
                  <button
                    onClick={handleSelectDirectory}
                    className="px-6 py-3 bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium rounded-lg transition whitespace-nowrap"
                    title="选择目录（自动查找 ee.log）"
                  >
                    📁 目录
                  </button>
                  <button
                    onClick={handleSelectFile}
                    className="px-6 py-3 bg-purple-100 hover:bg-purple-200 text-purple-700 font-medium rounded-lg transition whitespace-nowrap"
                    title="直接选择日志文件"
                  >
                    📄 文件
                  </button>
                </div>
              </div>

              {/* 参数设置 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    保留最近几次有效仲裁
                  </label>
                  <input
                    type="number"
                    value={recentCount}
                    onChange={(e) => setRecentCount(Number(e.target.value))}
                    min="1"
                    max="10"
                    className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring focus:ring-purple-200 focus:ring-opacity-50 transition"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    排除小于(秒)
                  </label>
                  <input
                    type="number"
                    value={minDuration}
                    onChange={(e) => setMinDuration(Number(e.target.value))}
                    min="0"
                    className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring focus:ring-purple-200 focus:ring-opacity-50 transition"
                  />
                </div>
              </div>

              {/* 分析按钮 */}
              <button
                onClick={handleAnalyze}
                disabled={loading}
                className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:from-gray-400 disabled:to-gray-500 text-white font-bold rounded-lg shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 disabled:transform-none transition-all duration-200"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                    </svg>
                    分析中...
                  </span>
                ) : (
                  '🔍 开始分析'
                )}
              </button>
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4">
              <p className="text-red-700 font-medium">❌ {error}</p>
            </div>
          )}

          {/* 结果展示 */}
          {result && result.Missions.length > 0 && (
            <div className="space-y-4">
              <div className="text-white text-sm opacity-80">
                仅显示最近有效 {result.Missions.length} 把（排除 &lt; 1 分钟者）
              </div>

              {result.Missions.map((mission, idx) => {
                const totalTime = getTotalTime(mission);
                const minutes = Math.floor(totalTime / 60);
                const seconds = Math.floor(totalTime % 60);

                return (
                  <div key={mission.Index} className="bg-white/95 backdrop-blur rounded-xl shadow-lg overflow-hidden">
                    <div className="bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-3">
                      <h3 className="text-base font-semibold text-white">
                        最近有效第 {idx + 1} 把
                      </h3>
                    </div>

                    <div className="p-6">
                      {/* 状态标识（仅在不完整时显示） */}
                      {mission.Status !== 'ok' && (
                        <div className="mb-4 p-3 bg-yellow-50 border-l-4 border-yellow-400 text-yellow-800 text-sm">
                          <div className="font-semibold">⚠️ 数据可能不完整</div>
                          {mission.Note && <div className="text-xs mt-1">{mission.Note}</div>}
                        </div>
                      )}
                      
                      {/* 节点信息 */}
                      <div className="text-right text-sm font-medium text-indigo-700 mb-4">
                        {mission.NodeInfo ? [
                          mission.NodeInfo.NodeName,
                          mission.NodeInfo.SystemName,
                          mission.NodeInfo.MissionType,
                          mission.NodeInfo.Faction
                        ].filter(Boolean).join(' · ') : (mission.MissionName || mission.NodeID || '未知节点')}
                      </div>
                      
                      {/* 数据网格 - 2x2 大卡片 */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-4">
                          <div className="text-xs text-gray-600 mb-1">无人机生成</div>
                          <div className="text-4xl font-bold text-gray-900">{mission.ShieldDroneCount}</div>
                        </div>
                        {mission.SpawnedAtEnd !== undefined && mission.SpawnedAtEnd !== null && (
                          <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-lg p-4">
                            <div className="text-xs text-gray-600 mb-1">敌人生成</div>
                            <div className="text-4xl font-bold text-gray-900">{mission.SpawnedAtEnd}</div>
                          </div>
                        )}
                        {mission.ShieldDronePerMin !== undefined && mission.ShieldDronePerMin !== null && (
                          <div className="bg-gradient-to-br from-green-50 to-teal-50 rounded-lg p-4">
                            <div className="text-xs text-gray-600 mb-1">无人机生成/分钟</div>
                            <div className="text-4xl font-bold text-gray-900">
                              {mission.ShieldDronePerMin.toFixed(2)}
                            </div>
                          </div>
                        )}
                        {totalTime > 0 && (
                          <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-lg p-4">
                            <div className="text-xs text-gray-600 mb-1">总时间</div>
                            <div className="text-4xl font-bold text-gray-900">
                              {minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m ${seconds}s`}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
