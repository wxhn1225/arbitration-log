package main

import (
	_ "embed"
	"encoding/json"
	"log"
)

//go:embed node-map.zh.json
var nodeMapJSON []byte

// NodeInfo 用于导出给前端（无 JSON 标签，自动大写）
type NodeInfo struct {
	NodeID      string
	NodeName    string
	SystemName  string
	MissionType string
	Faction     string
}

// nodeInfoJSON 用于从 JSON 文件加载（小写标签）
type nodeInfoJSON struct {
	NodeID      string `json:"nodeId"`
	NodeName    string `json:"nodeName"`
	SystemName  string `json:"systemName"`
	MissionType string `json:"missionType"`
	Faction     string `json:"faction"`
}

var nodeMap map[string]*NodeInfo

func LoadNodeMap() {
	if nodeMap != nil {
		return
	}

	var tempMap map[string]*nodeInfoJSON
	if err := json.Unmarshal(nodeMapJSON, &tempMap); err != nil {
		log.Printf("Failed to load node map: %v", err)
		nodeMap = make(map[string]*NodeInfo)
		return
	}

	// 转换为 NodeInfo
	nodeMap = make(map[string]*NodeInfo)
	for k, v := range tempMap {
		nodeMap[k] = &NodeInfo{
			NodeID:      v.NodeID,
			NodeName:    v.NodeName,
			SystemName:  v.SystemName,
			MissionType: v.MissionType,
			Faction:     v.Faction,
		}
	}
}

func GetNodeInfo(nodeID string) *NodeInfo {
	if nodeMap == nil {
		LoadNodeMap()
	}
	return nodeMap[nodeID]
}
