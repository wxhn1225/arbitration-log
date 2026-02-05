package parser

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type Options struct {
	Count          int
	MinDurationSec float64
	ChunkBytes     int // reader buffer size
}

type Result struct {
	Missions []Mission
	Warnings []string
}

type Mission struct {
	NodeID      string
	MissionName string

	TotalSec     *float64
	EnemySpawned *int
	Drones       int
	DronesPerMin *float64

	// debug-ish
	StateStartedTime *float64
	StateEndingTime  *float64
}

var (
	reTimePrefix        = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s+`)
	reStartMissionName  = regexp.MustCompile(`Script \[Info\]: ThemedSquadOverlay\.lua: Mission name:\s*(.+?)\s*-\s*仲裁`)
	reHostLoading       = regexp.MustCompile(`Script \[Info\]: ThemedSquadOverlay\.lua: Host loading .*"name":"([^"]+)_EliteAlert"`)
	reEnd               = regexp.MustCompile(`Script \[Info\]: Background\.lua: EliteAlertMission at ([A-Za-z0-9_]+)\b`)
	reAnyOnAgentCreated = regexp.MustCompile(`AI \[Info\]: OnAgentCreated\b`)
	reSpawned           = regexp.MustCompile(`\bSpawned\s+(\d+)\b`)
	reShieldDrone       = regexp.MustCompile(`AI \[Info\]: OnAgentCreated /Npc/CorpusEliteShieldDroneAgent\d*\b`)

	reStateStarted = regexp.MustCompile(`GameRulesImpl - changing state from SS_WAITING_FOR_PLAYERS to SS_STARTED`)
	reStateEnding  = regexp.MustCompile(`GameRulesImpl - changing state from SS_STARTED to SS_ENDING`)
)

func parseTime(line string) *float64 {
	m := reTimePrefix.FindStringSubmatch(line)
	if len(m) < 2 {
		return nil
	}
	v, err := parseFloat(m[1])
	if err != nil || !isFinite(v) {
		return nil
	}
	return &v
}

func pickTotalSec(stateDur, onAgentDur, dur *float64) *float64 {
	if stateDur != nil && isFinite(*stateDur) && *stateDur > 0 {
		return stateDur
	}
	if onAgentDur != nil && isFinite(*onAgentDur) && *onAgentDur > 0 {
		return onAgentDur
	}
	if dur != nil && isFinite(*dur) && *dur > 0 {
		return dur
	}
	return nil
}

func calcPerMin(count int, spanSec *float64) *float64 {
	if spanSec == nil || !isFinite(*spanSec) || *spanSec <= 0 {
		return nil
	}
	v := float64(count) / (*spanSec / 60.0)
	if !isFinite(v) {
		return nil
	}
	return &v
}

type run struct {
	startTime *float64
	endTime   *float64

	missionName string
	nodeID      string
	needHost    int

	drones int
	spawn  *int

	firstOnAgent *float64
	lastOnAgent  *float64

	stateStarted *float64
	stateEnding  *float64
}

func ParseFile(path string, opts Options, onProgress func(p float64)) (Result, error) {
	if opts.Count <= 0 {
		opts.Count = 2
	}
	if opts.MinDurationSec <= 0 {
		opts.MinDurationSec = 60
	}
	if opts.ChunkBytes <= 0 {
		opts.ChunkBytes = 4 * 1024 * 1024
	}

	f, err := os.Open(path)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return Result{}, err
	}
	size := st.Size()

	br := bufio.NewReaderSize(f, opts.ChunkBytes)

	var (
		cur      *run
		valid    []Mission // ring buffer (keep last N)
		warnings []string
		readN    int64
	)

	finalize := func() {
		if cur == nil {
			return
		}

		var dur *float64
		if cur.startTime != nil && cur.endTime != nil {
			v := *cur.endTime - *cur.startTime
			dur = &v
		}
		var onAgent *float64
		if cur.firstOnAgent != nil && cur.lastOnAgent != nil {
			v := *cur.lastOnAgent - *cur.firstOnAgent
			onAgent = &v
		}
		var stateDur *float64
		if cur.stateStarted != nil && cur.stateEnding != nil {
			v := *cur.stateEnding - *cur.stateStarted
			stateDur = &v
		}

		total := pickTotalSec(stateDur, onAgent, dur)

		m := Mission{
			NodeID:            cur.nodeID,
			MissionName:       cur.missionName,
			TotalSec:          total,
			EnemySpawned:      cur.spawn,
			Drones:            cur.drones,
			DronesPerMin:      calcPerMin(cur.drones, total),
			StateStartedTime:  cur.stateStarted,
			StateEndingTime:   cur.stateEnding,
		}

		if total != nil && *total >= opts.MinDurationSec {
			valid = append(valid, m)
			if len(valid) > opts.Count {
				// keep last N
				valid = valid[len(valid)-opts.Count:]
			}
		}

		cur = nil
	}

	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			readN += int64(len(line))
			line = strings.TrimRight(line, "\r\n")

			// start marker
			if m := reStartMissionName.FindStringSubmatch(line); len(m) >= 2 {
				// new run begins, finalize previous
				finalize()
				cur = &run{
					startTime:    parseTime(line),
					missionName: strings.TrimSpace(m[1]),
					needHost:    15,
				}
				goto progress
			}

			if cur != nil {
				// node capture (near start)
				if cur.nodeID == "" && cur.needHost > 0 {
					if h := reHostLoading.FindStringSubmatch(line); len(h) >= 2 {
						cur.nodeID = h[1]
					}
					cur.needHost--
				}

				// end marker: take last match
				if cur.nodeID != "" {
					if e := reEnd.FindStringSubmatch(line); len(e) >= 2 && e[1] == cur.nodeID {
						cur.endTime = parseTime(line)
					}
				}

				// drones
				if reShieldDrone.MatchString(line) {
					cur.drones++
				}

				// OnAgentCreated / spawned / on-agent time window
				if reAnyOnAgentCreated.MatchString(line) {
					if t := parseTime(line); t != nil {
						if cur.firstOnAgent == nil {
							cur.firstOnAgent = t
						}
						cur.lastOnAgent = t
					}
					if sm := reSpawned.FindStringSubmatch(line); len(sm) >= 2 {
						if n, e := parseInt(sm[1]); e == nil {
							cur.spawn = &n
						}
					}
				}

				// state times
				if cur.stateStarted == nil && reStateStarted.MatchString(line) {
					cur.stateStarted = parseTime(line)
				}
				if reStateEnding.MatchString(line) {
					cur.stateEnding = parseTime(line)
				}
			}
		}

	progress:
		if onProgress != nil && size > 0 {
			onProgress(math.Min(1, float64(readN)/float64(size)))
		}

		if err != nil {
			if err == io.EOF {
				break
			}
			return Result{}, err
		}
	}

	// finalize last run
	finalize()

	if len(valid) < opts.Count {
		warnings = append(warnings, fmt.Sprintf("有效记录不足：仅找到 %d 把（过滤阈值 %.0fs）。", len(valid), opts.MinDurationSec))
	}

	// normalize order: oldest -> newest
	return Result{Missions: valid, Warnings: warnings}, nil
}

func FormatDuration(v *float64) string {
	if v == nil || !isFinite(*v) {
		return "-"
	}
	sec := *v
	if sec < 60 {
		return fmt.Sprintf("%.1fs", sec)
	}
	m := int(sec) / 60
	s := int(sec) - m*60
	if m < 60 {
		return fmt.Sprintf("%dm %ds", m, s)
	}
	h := m / 60
	rm := m - h*60
	return fmt.Sprintf("%dh %dm", h, rm)
}

func parseFloat(s string) (float64, error) {
	return strconv.ParseFloat(s, 64)
}

func parseInt(s string) (int, error) {
	v, err := strconv.Atoi(s)
	return v, err
}

func isFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
