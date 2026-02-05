package app

import (
	"bufio"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"

	"arbitration-log/internal/nodemap"
	"arbitration-log/internal/parser"
)

type Options struct {
	FilePath       string
	Count          int
	MinDurationSec float64
}

func readPathFromStdin() (string, error) {
	fmt.Println("请输入 ee.log/EE.log 文件路径，然后回车：")
	in := bufio.NewReader(os.Stdin)
	s, err := in.ReadString('\n')
	if err != nil && !errors.Is(err, os.ErrClosed) {
		// 有些终端可能没有 \n，继续处理
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "", fmt.Errorf("未提供文件路径")
	}
	return s, nil
}

func Run(opts Options) error {
	if opts.Count <= 0 {
		opts.Count = 2
	}
	if opts.MinDurationSec <= 0 {
		opts.MinDurationSec = 60
	}

	path := strings.TrimSpace(opts.FilePath)
	if path == "" {
		p, err := readPathFromStdin()
		if err != nil {
			return err
		}
		path = p
	}

	fmt.Println("ee.log 默认路径：%LOCALAPPDATA%\\Warframe")
	fmt.Println("开始解析：", path)

	meta, _ := nodemap.LoadEmbeddedZh() // 无映射也不影响解析

	res, err := parser.ParseFile(path, parser.Options{
		Count:          opts.Count,
		MinDurationSec: opts.MinDurationSec,
		ChunkBytes:     4 * 1024 * 1024,
	}, func(p float64) {
		// 简单进度：覆盖同一行
		fmt.Printf("\r进度：%3.0f%%", p*100)
	})
	fmt.Println()
	if err != nil {
		return err
	}

	if len(res.Warnings) > 0 {
		for _, w := range res.Warnings {
			fmt.Println("提示：", w)
		}
	}

	if len(res.Missions) == 0 {
		fmt.Println("暂无有效记录（可能都 < 1 分钟或未找到仲裁标记）")
		return nil
	}

	for i, m := range res.Missions {
		fmt.Println()
		fmt.Printf("最近有效第 %d 把\n", i+1)

		if m.NodeID != "" {
			if meta != nil {
				if nm, ok := meta[m.NodeID]; ok {
					line := strings.Join(filterEmpty([]string{nm.NodeName, nm.SystemName, nm.MissionType, nm.Faction}), " · ")
					if line != "" {
						fmt.Println(line)
					} else {
						fmt.Println(m.NodeID)
					}
				} else {
					fmt.Println(m.NodeID)
				}
			} else {
				fmt.Println(m.NodeID)
			}
		}

		fmt.Printf("总时间：%s\n", parser.FormatDuration(m.TotalSec))
		fmt.Printf("敌人生成：%s\n", fmtMaybeInt(m.EnemySpawned))
		fmt.Printf("无人机生成：%d\n", m.Drones)
		fmt.Printf("无人机生成/分钟：%s\n", fmtMaybeFloat2(m.DronesPerMin))
	}

	return nil
}

func filterEmpty(xs []string) []string {
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		if strings.TrimSpace(x) != "" {
			out = append(out, x)
		}
	}
	return out
}

func fmtMaybeInt(v *int) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprintf("%d", *v)
}

func fmtMaybeFloat2(v *float64) string {
	if v == nil || !isFinite(*v) {
		return "-"
	}
	return fmt.Sprintf("%.2f", *v)
}

func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

