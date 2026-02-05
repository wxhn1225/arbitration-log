import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const regionsPath = path.join(
  repoRoot,
  "warframe-public-export-plus",
  "ExportRegions.json"
);
const dictPath = path.join(repoRoot, "warframe-public-export-plus", "dict.zh.json");

const outDir = path.join(repoRoot, "public");
const outPath = path.join(outDir, "node-map.zh.json");

function safeString(v) {
  return typeof v === "string" ? v : undefined;
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function t(dict, key) {
  if (!key) return undefined;
  const v = dict[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

const regions = loadJson(regionsPath);
const dict = loadJson(dictPath);

// ExportRegions.json 结构：{ "SolNode64": { name, systemName, missionName, factionName, ... }, ... }
const out = {};
for (const [nodeId, info] of Object.entries(regions)) {
  if (!info || typeof info !== "object") continue;

  const nameKey = safeString(info.name);
  const systemKey = safeString(info.systemName);
  const missionKey = safeString(info.missionName);
  const factionKey = safeString(info.factionName);

  // 只输出最小必要字段，保持前端加载轻量
  out[nodeId] = {
    nodeId,
    nodeName: t(dict, nameKey) ?? nameKey,
    systemName: t(dict, systemKey) ?? systemKey,
    missionType: t(dict, missionKey) ?? missionKey,
    faction: t(dict, factionKey) ?? factionKey,
  };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(out), "utf8");

console.log(`Generated ${path.relative(repoRoot, outPath)} (${Object.keys(out).length} nodes)`);

