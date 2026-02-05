package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"

	"arbitration-log/internal/app"
)

func main() {
	var (
		filePath = flag.String("file", "", "ee.log/EE.log 文件路径（留空则弹窗选择或从 stdin 输入）")
		count    = flag.Int("count", 2, "最近有效记录数量")
		minSec   = flag.Int("min", 60, "小于该秒数视为无效并排除")
	)
	flag.Parse()

	// 支持直接传入位置参数：arbitration-log.exe "C:\...\EE.log"
	if strings.TrimSpace(*filePath) == "" && len(flag.Args()) > 0 {
		*filePath = flag.Args()[0]
	}

	opts := app.Options{
		FilePath:       *filePath,
		Count:          *count,
		MinDurationSec: float64(*minSec),
	}

	if err := app.Run(opts); err != nil {
		fmt.Fprintln(os.Stderr, "错误：", err)
		if runtime.GOOS == "windows" {
			fmt.Fprintln(os.Stderr, "按回车退出...")
			_, _ = fmt.Fscanln(os.Stdin)
		}
		os.Exit(1)
	}
}

