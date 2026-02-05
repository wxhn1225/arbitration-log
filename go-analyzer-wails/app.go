package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// 启动时加载节点映射
	LoadNodeMap()
}

// GetDefaultPath 获取默认日志路径
func (a *App) GetDefaultPath() string {
	defaultPath := os.Getenv("LOCALAPPDATA")
	if defaultPath != "" {
		return filepath.Join(defaultPath, "Warframe")
	}
	return ""
}

// SelectLogFile 打开文件选择对话框
func (a *App) SelectLogFile() (string, error) {
	file, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择日志文件",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "日志文件 (*.log)",
				Pattern:     "*.log",
			},
			{
				DisplayName: "所有文件 (*.*)",
				Pattern:     "*.*",
			},
		},
	})
	return file, err
}

// SelectLogDirectory 打开目录选择对话框
func (a *App) SelectLogDirectory() (string, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择日志目录",
	})
	return dir, err
}

// AnalyzeRequest 分析请求参数
type AnalyzeRequest struct {
	LogPath     string  `json:"logPath"`
	RecentCount int     `json:"recentCount"`
	MinDuration float64 `json:"minDuration"`
}

// AnalyzeLog 分析日志文件
func (a *App) AnalyzeLog(req AnalyzeRequest) (*ParseResult, error) {
	// 默认值
	if req.RecentCount <= 0 {
		req.RecentCount = 2
	}
	if req.MinDuration < 0 {
		req.MinDuration = 60
	}

	// 查找日志文件
	possibleFiles := []string{
		filepath.Join(req.LogPath, "ee.log"),
		filepath.Join(req.LogPath, "EE.log"),
		req.LogPath,
	}

	var finalPath string
	for _, p := range possibleFiles {
		if _, err := os.Stat(p); err == nil {
			finalPath = p
			break
		}
	}

	if finalPath == "" {
		return nil, fmt.Errorf("找不到日志文件，请检查路径是否正确")
	}

	// 执行分析
	result, err := AnalyzeLog(finalPath, req.RecentCount, req.MinDuration)
	if err != nil {
		return nil, fmt.Errorf("分析失败: %v", err)
	}

	return result, nil
}
