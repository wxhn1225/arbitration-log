package main

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type MissionResult struct {
	Index                   int
	NodeID                  string
	MissionName             string
	StartKind               string
	StartLine               int
	EndLine                 *int
	StartTime               *float64
	EndTime                 *float64
	DurationSec             *float64
	StateStartedTime        *float64
	StateEndingTime         *float64
	StateDurationSec        *float64
	SpawnedAtEnd            *int
	FirstOnAgentCreatedTime *float64
	LastOnAgentCreatedTime  *float64
	OnAgentCreatedSpanSec   *float64
	ShieldDronePerMin       *float64
	ShieldDroneCount        int
	Status                  string
	Note                    string
	NodeInfo                *NodeInfo
}

type ParseResult struct {
	Missions []*MissionResult
	Warnings []string
}

var (
	reTimePrefix        = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s+`)
	reStartMissionName  = regexp.MustCompile(`Script \[Info\]: ThemedSquadOverlay\.lua: Mission name:\s*(.+?)\s*-\s*仲裁`)
	reHostLoading       = regexp.MustCompile(`Script \[Info\]: ThemedSquadOverlay\.lua: Host loading .*"name":"([^"]+)_EliteAlert"`)
	reEnd               = regexp.MustCompile(`Script \[Info\]: Background\.lua: EliteAlertMission at ([A-Za-z0-9_]+)\b`)
	reStateStarted      = regexp.MustCompile(`GameRulesImpl - changing state from SS_WAITING_FOR_PLAYERS to SS_STARTED`)
	reStateEnding       = regexp.MustCompile(`GameRulesImpl - changing state from SS_STARTED to SS_ENDING`)
	reAnyOnAgentCreated = regexp.MustCompile(`AI \[Info\]: OnAgentCreated\b`)
	reSpawned           = regexp.MustCompile(`\bSpawned\s+(\d+)\b`)
	reShieldDrone       = regexp.MustCompile(`AI \[Info\]: OnAgentCreated /Npc/CorpusEliteShieldDroneAgent\d*\b`)
)

func (m *MissionResult) GetTotalTime() float64 {
	if m.StateDurationSec != nil && *m.StateDurationSec > 0 {
		return *m.StateDurationSec
	}
	if m.OnAgentCreatedSpanSec != nil && *m.OnAgentCreatedSpanSec > 0 {
		return *m.OnAgentCreatedSpanSec
	}
	if m.DurationSec != nil && *m.DurationSec > 0 {
		return *m.DurationSec
	}
	return 0
}

func parseTime(line string) *float64 {
	match := reTimePrefix.FindStringSubmatch(line)
	if match == nil {
		return nil
	}
	val, err := strconv.ParseFloat(match[1], 64)
	if err != nil {
		return nil
	}
	return &val
}

func calcPerMin(count int, spanSec *float64) *float64 {
	if spanSec == nil || *spanSec <= 0 {
		return nil
	}
	perMin := float64(count) / (*spanSec / 60.0)
	return &perMin
}

func AnalyzeLog(filePath string, recentCount int, minDuration float64) (*ParseResult, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("无法打开文件: %v", err)
	}
	defer file.Close()

	// 流式解析，不把所有行加载到内存
	missions, warnings, err := parseFileStream(file)
	if err != nil {
		return nil, fmt.Errorf("解析文件失败: %v", err)
	}

	// 过滤：只保留时长 >= minDuration 的任务
	// 注意：不过滤 incomplete 状态，让用户能看到所有任务的诊断信息
	var filtered []*MissionResult
	for _, m := range missions {
		totalTime := m.GetTotalTime()
		if totalTime >= minDuration {
			filtered = append(filtered, m)
		}
	}

	// 按时间排序（使用 StartTime）
	sort.Slice(filtered, func(i, j int) bool {
		ti := filtered[i].StartTime
		tj := filtered[j].StartTime
		if ti == nil {
			return false
		}
		if tj == nil {
			return true
		}
		return *ti < *tj
	})

	// 保留最近的 N 个
	if len(filtered) > recentCount {
		filtered = filtered[len(filtered)-recentCount:]
	}

	// 加载节点信息
	LoadNodeMap()
	
	// 为每个任务补充节点信息
	for _, m := range filtered {
		if m.NodeID != "" {
			m.NodeInfo = GetNodeInfo(m.NodeID)
		}
	}

	// 重新编号
	for i, m := range filtered {
		m.Index = i + 1
	}

	return &ParseResult{
		Missions: filtered,
		Warnings: warnings,
	}, nil
}

// 流式解析文件，避免把整个文件加载到内存
func parseFileStream(file *os.File) ([]*MissionResult, []string, error) {
	scanner := bufio.NewScanner(file)
	// 增加缓冲区大小以处理较长的行（支持超大文件）
	buf := make([]byte, 0, 2*1024*1024) // 2MB 初始缓冲
	scanner.Buffer(buf, 20*1024*1024)   // 20MB 最大行长度

	var missions []*MissionResult
	var warnings []string

	type currentMission struct {
		startLine0               int
		startLine                int
		startTime                *float64
		nodeID                   string
		missionName              string
		startKind                string
		shieldDroneCount         int
		lastSpawned              *int
		firstOnAgentTime         *float64
		lastOnAgentTime          *float64
		stateStartedTime         *float64
		stateEndingTime          *float64
		inStartedState           bool
		hasSeenEnding            bool
		endLine                  int      // 最后一次匹配到的结束标记行号
		endTime                  *float64 // 最后一次匹配到的结束标记时间
	}

	var current *currentMission
	lineNum := 0

	flushCurrent := func(reason string) {
		if current == nil {
			return
		}

		// 检查是否找到了结束标记，或者至少有 SS_ENDING 状态
		// 如果有 SS_ENDING，说明任务已经结束了，即使没有明确的结束标记也算完整
		isComplete := current.endLine > 0 || (current.stateEndingTime != nil)
		
		if isComplete {
			// 任务完整（有结束标记或有 SS_ENDING）
			var durationSec *float64
			if current.startTime != nil && current.endTime != nil {
				dur := *current.endTime - *current.startTime
				durationSec = &dur
			}

			spanSec := calcSpan(current.firstOnAgentTime, current.lastOnAgentTime)
			
			var stateDurationSec *float64
			if current.stateStartedTime != nil && current.stateEndingTime != nil {
				dur := *current.stateEndingTime - *current.stateStartedTime
				stateDurationSec = &dur
			}

			note := "区间内未找到 OnAgentCreated"
			if current.lastOnAgentTime != nil {
				note = fmt.Sprintf("最后一条 OnAgentCreated 位于第 %d 行附近", current.endLine)
			}

			missions = append(missions, &MissionResult{
				Index:                   len(missions) + 1,
				NodeID:                  current.nodeID,
				MissionName:             current.missionName,
				StartKind:               current.startKind,
				StartLine:               current.startLine,
				EndLine:                 &current.endLine,
				StartTime:               current.startTime,
				EndTime:                 current.endTime,
				DurationSec:             durationSec,
				StateStartedTime:        current.stateStartedTime,
				StateEndingTime:         current.stateEndingTime,
				StateDurationSec:        stateDurationSec,
				SpawnedAtEnd:            current.lastSpawned,
				FirstOnAgentCreatedTime: current.firstOnAgentTime,
				LastOnAgentCreatedTime:  current.lastOnAgentTime,
				OnAgentCreatedSpanSec:   spanSec,
				ShieldDronePerMin:       calcPerMin(current.shieldDroneCount, spanSec),
				ShieldDroneCount:        current.shieldDroneCount,
				Status:                  "ok",
				Note:                    note,
			})
		} else {
			// 没找到结束标记
			spanSec := calcSpan(current.firstOnAgentTime, current.lastOnAgentTime)
			
			// 构建更详细的备注信息
			noteDetails := reason
			if current.nodeID == "" {
				noteDetails += "（NodeID 为空，无法匹配结束标记）"
			} else {
				noteDetails += fmt.Sprintf("（NodeID: %s）", current.nodeID)
			}
			
			m := &MissionResult{
				Index:                   len(missions) + 1,
				NodeID:                  current.nodeID,
				MissionName:             current.missionName,
				StartKind:               current.startKind,
				StartLine:               current.startLine,
				StartTime:               current.startTime,
				ShieldDroneCount:        current.shieldDroneCount,
				SpawnedAtEnd:            current.lastSpawned,
				FirstOnAgentCreatedTime: current.firstOnAgentTime,
				LastOnAgentCreatedTime:  current.lastOnAgentTime,
				OnAgentCreatedSpanSec:   spanSec,
				ShieldDronePerMin:       calcPerMin(current.shieldDroneCount, spanSec),
				Status:                  "incomplete",
				Note:                    noteDetails,
			}
			
			if current.stateStartedTime != nil && current.stateEndingTime != nil {
				duration := *current.stateEndingTime - *current.stateStartedTime
				m.StateDurationSec = &duration
			}
			
			missions = append(missions, m)
		}
		
		current = nil
	}

	for scanner.Scan() {
		line := scanner.Text()
		lineNum++

		// 任务开始标记
		mName := reStartMissionName.FindStringSubmatch(line)
		mHost := reHostLoading.FindStringSubmatch(line)

		if current == nil {
			if mName != nil {
				current = &currentMission{
					startLine0:  lineNum - 1,
					startLine:   lineNum,
					startTime:   parseTime(line),
					startKind:   "missionName",
					missionName: strings.TrimSpace(mName[1]),
				}
				// 尝试从下一行获取 NodeID（通常紧贴下一行）
				continue
			}
			if mHost != nil {
				current = &currentMission{
					startLine0: lineNum - 1,
					startLine:  lineNum,
					startTime:  parseTime(line),
					startKind:  "hostLoading",
					nodeID:     mHost[1],
				}
				continue
			}
		} else {
			// 补齐信息
			if current.missionName == "" && mName != nil {
				current.missionName = strings.TrimSpace(mName[1])
			}
			if current.nodeID == "" && mHost != nil {
				current.nodeID = mHost[1]
			}

			// 新的任务开始 - 用边界作为结束点
			if (mName != nil || mHost != nil) && lineNum-1 != current.startLine0 {
				// 如果还没找到正式的结束标记，用当前行之前作为边界
				// 这样至少任务有个明确的范围
				if current.endLine == 0 {
					current.endLine = lineNum - 1
					// endTime 使用最后一个 OnAgentCreated 的时间作为近似
					if current.lastOnAgentTime != nil {
						current.endTime = current.lastOnAgentTime
					}
				}
				
				flushCurrent("边界：下一个任务开始")
				// 重新处理当前行
				if mName != nil {
					current = &currentMission{
						startLine0:  lineNum - 1,
						startLine:   lineNum,
						startTime:   parseTime(line),
						startKind:   "missionName",
						missionName: strings.TrimSpace(mName[1]),
					}
				} else if mHost != nil {
					current = &currentMission{
						startLine0: lineNum - 1,
						startLine:  lineNum,
						startTime:  parseTime(line),
						startKind:  "hostLoading",
						nodeID:     mHost[1],
					}
				}
				continue
			}

		// 状态切换
		if reStateStarted.MatchString(line) {
			t := parseTime(line)
			if t != nil {
				current.stateStartedTime = t
				current.inStartedState = true
			}
		}
		
		if reStateEnding.MatchString(line) {
			t := parseTime(line)
			if t != nil {
				// SS_ENDING 可能打印多次，始终更新到最后一次
				current.stateEndingTime = t
				// 第一次看到 SS_ENDING 时，停止统计生成
				if !current.hasSeenEnding {
					current.hasSeenEnding = true
				}
			}
		}

		// 只在 SS_STARTED 之后且未到第一个 SS_ENDING 时统计
		if current.inStartedState && !current.hasSeenEnding {
				// 无人机统计
				if reShieldDrone.MatchString(line) {
					current.shieldDroneCount++
				}

				// OnAgentCreated 统计
				if reAnyOnAgentCreated.MatchString(line) {
					t := parseTime(line)
					if current.firstOnAgentTime == nil {
						current.firstOnAgentTime = t
					}
					current.lastOnAgentTime = t

					if m := reSpawned.FindStringSubmatch(line); m != nil {
						if n, err := strconv.Atoi(m[1]); err == nil {
							current.lastSpawned = &n
						}
					}
				}
			}

			// 任务结束标记（不 break，继续找更靠后的）
			mEnd := reEnd.FindStringSubmatch(line)
			if mEnd != nil {
				endNodeID := mEnd[1]
				// 如果当前任务有 NodeID，严格匹配
				if current.nodeID != "" && endNodeID == current.nodeID {
					current.endLine = lineNum
					current.endTime = parseTime(line)
				} else if current.nodeID == "" {
					// 如果当前任务还没有 NodeID，尝试从结束标记推断
					// （这种情况很少见，但可以提高容错性）
					current.nodeID = endNodeID
					current.endLine = lineNum
					current.endTime = parseTime(line)
				}
			}
		}
	}

	// 文件结束时处理最后一个任务
	if current != nil {
		flushCurrent("文件结束")
	}

	if err := scanner.Err(); err != nil {
		return nil, nil, err
	}

	return missions, warnings, nil
}


func calcSpan(first, last *float64) *float64 {
	if first == nil || last == nil {
		return nil
	}
	span := *last - *first
	if !math.IsInf(span, 0) && !math.IsNaN(span) && span > 0 {
		return &span
	}
	return nil
}
