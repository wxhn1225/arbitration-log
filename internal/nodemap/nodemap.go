package nodemap

import (
	_ "embed"
	"encoding/json"
)

type NodeMeta struct {
	NodeID      string `json:"nodeId"`
	NodeName    string `json:"nodeName"`
	SystemName  string `json:"systemName"`
	MissionType string `json:"missionType"`
	Faction     string `json:"faction"`
}

//go:embed node-map.zh.json
var nodeMapZhJSON []byte

func LoadEmbeddedZh() (map[string]NodeMeta, error) {
	if len(nodeMapZhJSON) == 0 {
		return nil, nil
	}
	var m map[string]NodeMeta
	if err := json.Unmarshal(nodeMapZhJSON, &m); err != nil {
		return nil, err
	}
	return m, nil
}

