#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { analyzeJsonc, analyzeText } from "./lib/redact.mjs";
import {
  isCredentialFile,
  isKeyFile,
  isTextFile,
  listFilesRecursive,
  normalizeSlashes,
  sha256File,
  statOrNull,
} from "./lib/paths.mjs";

const FORBIDDEN_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "service.json",
  "auth.json",
  "opencode.db",
  "opencode.db-shm",
  "opencode.db-wal",
  "opencode-.db",
  "opencode-.db-shm",
  "opencode-.db-wal",
]);

const FORBIDDEN_SUFFIXES = [/\.bak(?:[.-].*)?$/i, /\.write-lock$/i, /\.db$/i, /\.db-(?:shm|wal)$/i, /\.log$/i];
const ABSOLUTE_HOME_RE = /(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/[^/\s]|\/Users\/[^/\s])/i;
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
]);
const LOCKFILE_SECRET_RE = /(?:\/\/[^/\s"'@]+:[^/\s"'@]+@|(?:sk-|sk_|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{10,})/;

function isForbiddenPath(relative) {
  const parts = normalizeSlashes(relative).split("/");
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) return true;
  const name = parts.at(-1) ?? "";
  if (isCredentialFile(name)) return true;
  return FORBIDDEN_SUFFIXES.some((pattern) => pattern.test(name));
}

function safeTargetPath(target) {
  if (typeof target !== "string" || !target) return false;
  const normalized = normalizeSlashes(target);
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

function isConfigLike(relative) {
  const normalized = normalizeSlashes(relative);
  if (!/\.(json|jsonc|md|mdx|yaml|yml|toml)$/i.test(normalized)) return false;
  if (normalized.startsWith("files/plugins/")) return false;
  if (normalized.startsWith("files/_shared/")) return false;
  if (normalized.startsWith("files/agents/")) return false;
  if (normalized.startsWith("files/agent/")) return false;
  if (normalized.startsWith("files/commands/")) return false;
  if (normalized.startsWith("files/command/")) return false;
  if (normalized.startsWith("files/mode/")) return false;
  if (normalized.startsWith("files/modes/")) return false;
  if (normalized.startsWith("files/skills/")) return false;
  if (normalized.startsWith("files/themes/")) return false;
  if (normalized.startsWith("files/plugin-data/")) return false;
  return true;
}

function collectPlaceholders(text) {
  const placeholders = [];
  for (const match of text.matchAll(/<REDACTED:([^>]+)>/g)) {
    placeholders.push(match[1]);
  }
  return placeholders;
}

export async function verifyBundle(bundleDir) {
  const errors = [];
  const warnings = [];
  const manifestPath = path.join(bundleDir, "manifest.json");
  const checksumsPath = path.join(bundleDir, "checksums.json");

  let manifest;
  let checksums;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`cannot read manifest.json: ${error.message}`], warnings, manifest: null };
  }
  try {
    checksums = JSON.parse(await fs.readFile(checksumsPath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`cannot read checksums.json: ${error.message}`], warnings, manifest };
  }

  if (manifest.schema_version !== 2) errors.push(`unsupported manifest schema: ${manifest.schema_version}`);
  if (!Array.isArray(manifest.items)) errors.push("manifest.items must be an array");
  if (!Array.isArray(manifest.extensions)) errors.push("manifest.extensions must be an array");
  if (!Array.isArray(manifest.secret_refs)) errors.push("manifest.secret_refs must be an array");
  if (!manifest.bundle?.plan_hash) errors.push("manifest is missing bundle.plan_hash");

  const checksumKeys = new Set(Object.keys(checksums).map(normalizeSlashes));
  if (manifest.checksums) {
    for (const [relative, expected] of Object.entries(manifest.checksums)) {
      const normalized = normalizeSlashes(relative);
      if (!checksumKeys.has(normalized)) errors.push(`checksums.json is missing ${normalized}`);
      else if (checksums[normalized] !== expected) errors.push(`checksum mismatch between manifest and checksums.json: ${normalized}`);
    }
  }

  for (const [relative, expected] of Object.entries(checksums)) {
    const normalized = normalizeSlashes(relative);
    const absolute = path.join(bundleDir, normalized);
    if (isForbiddenPath(normalized)) errors.push(`forbidden file in bundle: ${normalized}`);
    const stat = await statOrNull(absolute);
    if (!stat || !stat.isFile()) {
      errors.push(`checksummed file is missing: ${normalized}`);
      continue;
    }
    const actual = await sha256File(absolute);
    if (actual !== expected) errors.push(`checksum mismatch: ${normalized}`);
  }

  const allowedFiles = new Set();
  const allowedDirectories = [];
  for (const item of manifest.items ?? []) {
    if (!item.bundle_path) {
      errors.push(`item ${item.id} has no bundle_path`);
      continue;
    }
    const bundlePath = normalizeSlashes(item.bundle_path);
    if (!bundlePath.startsWith("files/")) errors.push(`item bundle path must start with files/: ${bundlePath}`);
    if (isForbiddenPath(bundlePath)) errors.push(`forbidden item bundle path: ${bundlePath}`);
    if (!safeTargetPath(item.target_path)) errors.push(`unsafe target_path for ${item.id}: ${item.target_path}`);
    const absolute = path.join(bundleDir, bundlePath);
    const stat = await statOrNull(absolute);
    if (!stat) {
      errors.push(`item bundle path is missing: ${bundlePath}`);
      continue;
    }
    if (stat.isDirectory()) {
      allowedDirectories.push(bundlePath);
      const files = await listFilesRecursive(absolute, { exclude: () => false });
      for (const file of files) {
        if (file.kind === "file") allowedFiles.add(normalizeSlashes(path.relative(bundleDir, file.absolute)));
      }
    } else {
      allowedFiles.add(bundlePath);
      if (item.sha256 && checksums[bundlePath] !== item.sha256) {
        errors.push(`item checksum mismatch: ${bundlePath}`);
      }
    }
  }

  const bundleFiles = await listFilesRecursive(bundleDir, {
    exclude: (name) => name === "manifest.json" || name === "checksums.json" || name === "RESTORE.md",
  });
  for (const file of bundleFiles) {
    if (file.kind !== "file") continue;
    const relative = normalizeSlashes(path.relative(bundleDir, file.absolute));
    if (relative === "RESTORE.md" || relative === "manifest.json" || relative === "checksums.json") continue;
    if (relative === "tools/restore.mjs") continue;
    if (!allowedFiles.has(relative)) errors.push(`unlisted file in bundle: ${relative}`);
  }

  const restorePath = path.join(bundleDir, "RESTORE.md");
  const restoreStat = await statOrNull(restorePath);
  if (!restoreStat) errors.push("RESTORE.md is missing");
  else {
    const restore = await fs.readFile(restorePath, "utf8");
    if (restore.includes("{{")) errors.push("RESTORE.md contains an unresolved placeholder");
    if (!restore.includes("OpenCode")) warnings.push("RESTORE.md does not mention OpenCode");
  }

  const secretLabels = new Set((manifest.secret_refs ?? []).map((ref) => ref.label));
  const allFiles = await listFilesRecursive(path.join(bundleDir, "files"), { exclude: () => false }).catch(() => []);
  for (const file of allFiles) {
    if (file.kind !== "file") continue;
    const relative = normalizeSlashes(path.relative(bundleDir, file.absolute));
    if (isForbiddenPath(relative)) errors.push(`forbidden file: ${relative}`);
    if (!isTextFile(file.absolute)) continue;
    if (
      !/\.(json|jsonc|md|mdx|txt|yaml|yml|toml|ini|conf|properties|pem|key)$/i.test(file.absolute) &&
      !/(^|[\\/])\.env(?:\.[^\\/]+)?$/i.test(file.absolute) &&
      !isKeyFile(file.absolute)
    ) {
      continue;
    }
    if (LOCKFILES.has(path.basename(file.absolute))) {
      const lockText = await fs.readFile(file.absolute, "utf8").catch(() => "");
      if (LOCKFILE_SECRET_RE.test(lockText)) {
        errors.push(`possible credential in lockfile: ${relative}`);
      }
      continue;
    }

    let text;
    try {
      text = await fs.readFile(file.absolute, "utf8");
    } catch {
      continue;
    }

    for (const placeholder of collectPlaceholders(text)) {
      if (!secretLabels.has(placeholder)) {
        errors.push(`unexpected redaction placeholder ${placeholder} in ${relative}`);
      }
    }

    if (/\.(json|jsonc)$/i.test(file.absolute)) {
      try {
        const analysis = analyzeJsonc(text, { source: relative });
        const remaining = analysis.secretRefs.filter((ref) => ref.kind === "value");
        if (remaining.length) errors.push(`possible secret left in ${relative}: ${remaining.map((ref) => ref.pointer).join(", ")}`);
      } catch (error) {
        if (isConfigLike(relative)) errors.push(`invalid JSONC in ${relative}: ${error.message}`);
        else warnings.push(`could not parse JSONC in ${relative}: ${error.message}`);
      }
    } else {
      const analysis = analyzeText(text, { source: relative });
      if (analysis.secretRefs.length) {
        errors.push(`possible secret left in ${relative}: ${analysis.secretRefs.map((ref) => ref.label).join(", ")}`);
      }
    }

    if (ABSOLUTE_HOME_RE.test(text)) {
      if (isConfigLike(relative)) errors.push(`absolute home path left in ${relative}`);
      else warnings.push(`absolute home path appears in ${relative}`);
    }
  }

  for (const name of ["manifest.json", "RESTORE.md"]) {
    const absolute = path.join(bundleDir, name);
    if (!(await statOrNull(absolute))) continue;
    const text = await fs.readFile(absolute, "utf8");
    if (ABSOLUTE_HOME_RE.test(text)) errors.push(`absolute home path left in ${name}`);
    try {
      const analysis = name.endsWith(".json")
        ? analyzeJsonc(text, { source: name })
        : analyzeText(text, { source: name });
      const remaining = analysis.secretRefs.filter((ref) => ref.kind === "value");
      if (remaining.length) {
        errors.push(`possible secret left in ${name}: ${remaining.map((ref) => ref.label ?? ref.pointer).join(", ")}`);
      }
    } catch (error) {
      errors.push(`cannot scan ${name}: ${error.message}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, manifest };
}

async function main() {
  const argv = process.argv.slice(2);
  let bundle = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundle") bundle = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/verify-bundle.mjs --bundle <dir>");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!bundle) throw new Error("--bundle is required");
  const result = await verifyBundle(path.resolve(bundle));
  if (result.warnings.length) {
    console.warn("Warnings:");
    for (const warning of result.warnings) console.warn(`- ${warning}`);
  }
  if (!result.ok) {
    console.error("Bundle verification failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Bundle verified: ${path.resolve(bundle)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`verify failed: ${error.stack || error.message}`);
    process.exit(1);
  });
}
