import { promises as fs } from "node:fs";
import { applyEdits } from "./jsonc.mjs";
import { analyzeJsonc, analyzeText } from "./redact.mjs";
import { isNoiseName, isKeyFile, listFilesRecursive, normalizeSlashes } from "./paths.mjs";

const SCAN_EXT_RE = /\.(md|mdx|json|jsonc|txt|ya?ml|toml|ini|conf|properties|pem|key)$/i;
const ENV_FILE_RE = /(^|[\\/])\.env(?:\.[^\\/]+)?$/i;
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

export async function scanTreeSecrets(root, targetPath) {
  const files = await listFilesRecursive(root, {
    exclude: (name) => isNoiseName(name) || name === "node_modules" || name === ".git",
  });
  const entries = [];
  const refs = [];
  for (const file of files) {
    if (file.kind !== "file") continue;
    if (!SCAN_EXT_RE.test(file.absolute) && !ENV_FILE_RE.test(file.absolute) && !isKeyFile(file.absolute)) continue;
    if (LOCKFILES.has(file.absolute.split(/[\\/]/).pop())) continue;
    const relative = normalizeSlashes(file.relative);
    const labelBase = `${targetPath}/${relative}`;
    let text;
    try {
      text = await fs.readFile(file.absolute, "utf8");
    } catch {
      continue;
    }
    const isJson = /\.(json|jsonc)$/i.test(file.absolute);
    const analysis = isJson
      ? analyzeJsonc(text, { source: labelBase, labelPrefix: labelBase })
      : analyzeText(text, { source: labelBase });
    if (analysis.edits.length || analysis.secretRefs.length) {
      entries.push({ absolute: file.absolute, relative, text, analysis, isJson });
    }
    for (const ref of analysis.secretRefs) {
      refs.push({ ...ref, file: relative });
    }
  }
  return { entries, refs };
}

export async function applyTreeSecretEdits(entries) {
  const refs = [];
  for (const entry of entries) {
    if (entry.analysis.edits.length) {
      await fs.writeFile(entry.absolute, applyEdits(entry.text, entry.analysis.edits), "utf8");
    }
    refs.push(...entry.analysis.secretRefs.map((ref) => ({ ...ref, file: entry.relative })));
  }
  return refs;
}
