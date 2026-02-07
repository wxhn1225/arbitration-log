import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const srcRegions = path.join(repoRoot, "warframe-public-export-plus", "ExportRegions.json");
const srcDict = path.join(repoRoot, "warframe-public-export-plus", "dict.zh.json");

const outDir = path.join(repoRoot, "public", "warframe-public-export-plus");
mkdirSync(outDir, { recursive: true });

copyFileSync(srcRegions, path.join(outDir, "ExportRegions.json"));
copyFileSync(srcDict, path.join(outDir, "dict.zh.json"));

console.log(
  `Copied warframe data to ${path.relative(repoRoot, outDir)} (ExportRegions.json, dict.zh.json)`
);

