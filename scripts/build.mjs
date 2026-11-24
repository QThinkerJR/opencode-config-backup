#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyEdits } from "./lib/jsonc.mjs";
import { analyzeJsonc, analyzeText } from "./lib/redact.mjs";
import { applyRewrites } from "./lib/rewrites.mjs";
import { replaceHomePath } from "./lib/sanitize.mjs";
import { applyTreeSecretEdits, scanTreeSecrets } from "./lib/tree-secrets.mjs";
import {
  hashDirectory,
  isCredentialFile,
  isInside,
  isKeyFile,
  isTextFile,
  listFilesRecursive,
  normalizeSlashes,
  sha256File,
  sha256Text,
  statOrNull,
} from "./lib/paths.mjs";
import { verifyBundle } from "./verify-bundle.mjs";

let activeOutDir = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const GENERATOR = { name: "opencode-config-backup", version: "2.0.0" };

function parseArgs(argv) {
  const args = { plan: null, out: null, approve: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--plan") args.plan = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--approve") args.approve = argv[++i];
    else if (arg === "--json") args.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value), null, 2);
}

function planHash(plan) {
  const { plan_hash: _ignored, ...withoutHash } = plan;
  return sha256Text(stableStringify(withoutHash));
}

function applyTextEdits(text, edits) {
  return applyEdits(text, edits);
}

async function copyDirectory(source, destination, item) {
  const includes = item?.metadata?.copy_includes;
  const normalizedIncludes = Array.isArray(includes)
    ? includes.map((entry) => normalizeSlashes(entry).replace(/^\.\//, "").replace(/\/$/, ""))
    : null;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: async (sourcePath) => {
      const name = path.basename(sourcePath);
      if (name === "node_modules" || name === ".git" || name === ".svn" || name === ".hg") return false;
      if (isCredentialFile(name)) return false;
      if (/\.bak(?:[.-].*)?$/i.test(name) || /\.write-lock$/i.test(name) || /\.log$/i.test(name)) return false;
      if (/\.db(?:-(?:shm|wal))?$/i.test(name)) return false;
      if (name === ".gitignore" || name === ".DS_Store" || name === "Thumbs.db") return false;
      try {
        const stat = await fs.lstat(sourcePath);
        if (stat.isSymbolicLink()) return false;
      } catch {
        return false;
      }
      if (!normalizedIncludes) return true;
      const relative = normalizeSlashes(path.relative(source, sourcePath));
      if (!relative || relative === ".") return true;
      return normalizedIncludes.some(
        (entry) =>
          relative === entry ||
          relative.startsWith(`${entry}/`) ||
          entry.startsWith(`${relative}/`),
      );
    },
  });
}

async function rewriteCopiedHomePaths(root, home) {
  if (!home) return;
  const files = await listFilesRecursive(root);
  for (const file of files) {
    if (file.kind !== "file") continue;
    if (!isTextFile(file.absolute) && !isKeyFile(file.absolute)) continue;
    let text;
    try {
      text = await fs.readFile(file.absolute, "utf8");
    } catch {
      continue;
    }
    const rewritten = replaceHomePath(text, home);
    if (rewritten !== text) await fs.writeFile(file.absolute, rewritten, "utf8");
  }
}

async function redactCopiedTextTree(root, item) {
  const { entries } = await scanTreeSecrets(root, item.target_path);
  return applyTreeSecretEdits(entries);
}

async function copyItem(item, plan, outDir) {
  if (!item.bundle_path) return { skipped: true, refs: [] };
  const destination = path.join(outDir, item.bundle_path);
  if (!isInside(path.join(outDir, "files"), destination) && !isInside(path.join(outDir, "tools"), destination)) {
    throw new Error(`unsafe bundle path: ${item.bundle_path}`);
  }

  if (item.source_kind === "directory" || item.source_kind === "dir" || item.format === "directory") {
    await copyDirectory(item.source_path, destination, item);
    await rewriteCopiedHomePaths(destination, plan.source?.home);
    let refs = [];
    if (item.redact) refs = await redactCopiedTextTree(destination, item);
    return { skipped: false, refs };
  }

  const source = item.source_path;
  const stat = await statOrNull(source);
  if (!stat || !stat.isFile()) throw new Error(`source file missing: ${source}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });

  if (item.format === "json" || item.format === "jsonc") {
    let text = await fs.readFile(source, "utf8");
    const rewrites = plan.rewrites.filter((rewrite) => rewrite.item_id === item.id);
    if (rewrites.length) text = applyRewrites(text, source, rewrites);
    let refs = [];
    if (item.redact) {
      const analysis = analyzeJsonc(text, { source, labelPrefix: item.target_path });
      if (analysis.edits.length) text = applyTextEdits(text, analysis.edits);
      refs = analysis.secretRefs;
    }
    await fs.writeFile(destination, text, "utf8");
    return { skipped: false, refs };
  }

  if (item.format === "markdown" || item.format === "text") {
    let text = await fs.readFile(source, "utf8");
    if (item.home_rewrite) text = replaceHomePath(text, plan.source.home);
    let refs = [];
    if (item.redact) {
      const analysis = analyzeText(text, { source: item.target_path });
      if (analysis.edits.length) text = applyTextEdits(text, analysis.edits);
      refs = analysis.secretRefs;
    }
    await fs.writeFile(destination, text, "utf8");
    return { skipped: false, refs };
  }

  await fs.copyFile(source, destination);
  return { skipped: false, refs: [] };
}

function replacePlaceholders(template, values) {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`{{${key}}}`).join(String(value));
  }
  if (output.includes("{{")) {
    const match = output.match(/\{\{[^}]+\}\}/);
    throw new Error(`unresolved RESTORE.md placeholder: ${match?.[0]}`);
  }
  return output;
}

async function collectChecksums(outDir) {
  const checksums = {};
  for (const dir of ["files", "tools"]) {
    const root = path.join(outDir, dir);
    if (!(await statOrNull(root))) continue;
    const files = await listFilesRecursive(root, {
      exclude: () => false,
      followSymlinks: false,
    });
    for (const file of files) {
      if (file.kind !== "file") continue;
      const relative = normalizeSlashes(path.relative(outDir, file.absolute));
      checksums[relative] = await sha256File(file.absolute);
    }
  }
  for (const name of ["RESTORE.md"]) {
    const absolute = path.join(outDir, name);
    if (await statOrNull(absolute)) checksums[name] = await sha256File(absolute);
  }
  return checksums;
}

function manifestFromPlan(plan, checksums) {
  const items = plan.items
    .filter((item) => item.bundle_path)
    .map((item) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      classification: item.classification,
      origin: item.origin,
      target_path: item.target_path,
      bundle_path: item.bundle_path,
      format: item.format,
      enabled: item.enabled,
      size: item.size,
      sha256: checksums[item.bundle_path] ?? null,
      metadata: item.metadata ?? {},
      defined_in: item.defined_in ?? null,
      provided_by: item.provided_by ?? null,
      warnings: item.warnings ?? [],
    }));

  return {
    schema_version: 2,
    generator: GENERATOR,
    bundle: {
      created_at: plan.created_at,
      source: {
        opencode_version: plan.source.opencode_version,
        config_format: plan.source.config_format,
        os: plan.source.os,
      },
      item_count: items.length,
      plan_hash: plan.plan_hash,
    },
    options: plan.options,
    items,
    extensions: plan.extensions,
    rewrites: plan.rewrites,
    secret_refs: plan.secret_refs,
    manual_actions: plan.manual_actions,
    auth: plan.auth,
    warnings: plan.warnings,
    opencode: plan.opencode,
    checksums,
    verification: {
      commands: [
        "opencode --version",
        "opencode debug config",
        "opencode plugin list",
        "opencode mcp list",
        "opencode debug agents",
      ],
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/build.mjs --plan <plan.json> --out <dir> --approve <hash>

The approved hash must match plan.json. Nothing is written without it.
`);
    process.exit(0);
  }
  if (!args.plan || !args.out || !args.approve) {
    throw new Error("--plan, --out, and --approve are required");
  }

  const planPath = path.resolve(args.plan);
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  if (plan.schema_version !== 2) throw new Error(`unsupported plan schema: ${plan.schema_version}`);
  const actualHash = planHash(plan);
  if (actualHash !== plan.plan_hash) throw new Error("plan hash is invalid; re-run plan.mjs");
  if (args.approve !== plan.plan_hash) {
    throw new Error(`approval hash does not match plan (expected ${plan.plan_hash}, got ${args.approve})`);
  }

  const outDir = path.resolve(args.out);
  const configRoot = path.resolve(plan.source.config_root);
  if (isInside(configRoot, outDir)) {
    throw new Error("output directory must be outside the OpenCode config directory");
  }
  if (await statOrNull(outDir)) {
    const entries = await fs.readdir(outDir);
    if (entries.length) throw new Error(`output directory is not empty: ${outDir}`);
  }
  await fs.mkdir(outDir, { recursive: true });
  activeOutDir = outDir;

  const secretRefs = [];
  const failures = [];
  for (const item of plan.items) {
    if (!item.bundle_path) continue;
    try {
      const sourceStat = await statOrNull(item.source_path);
      if (!sourceStat) throw new Error(`source missing: ${item.source_path}`);
      if (item.source_kind === "file" && item.source_hash) {
        const currentHash = await sha256File(item.source_path);
        if (currentHash !== item.source_hash) throw new Error(`source changed since plan: ${item.source_path}`);
      } else if ((item.source_kind === "dir" || item.format === "directory") && item.source_hash) {
        const currentHash = await hashDirectory(item.source_path, {
          exclude: (name) => name === "node_modules" || name === ".git",
        });
        if (currentHash !== item.source_hash) throw new Error(`source changed since plan: ${item.source_path}`);
      }
      const result = await copyItem(item, plan, outDir);
      secretRefs.push(...result.refs);
    } catch (error) {
      failures.push({ item_id: item.id, message: error.message });
    }
  }
  if (failures.length) {
    throw new Error(`failed items:\n${failures.map((failure) => `- ${failure.item_id}: ${failure.message}`).join("\n")}`);
  }

  const manifestPath = path.join(outDir, "manifest.json");
  const initialManifest = manifestFromPlan(plan, {});
  await fs.writeFile(manifestPath, `${JSON.stringify(initialManifest, null, 2)}\n`, "utf8");

  const restoreTemplate = await fs.readFile(path.join(ROOT, "references", "restore-template.md"), "utf8");
  const valueRefs = plan.secret_refs.filter((ref) => ref.kind === "value");
  const referenceRefs = plan.secret_refs.filter((ref) => ref.kind !== "value");
  const secretList =
    valueRefs.length === 0
      ? "none"
      : valueRefs.map((ref) => ref.label).join(", ");
  const referenceList =
    referenceRefs.length === 0
      ? "none"
      : referenceRefs.map((ref) => `${ref.kind}:${ref.label}`).join(", ");
  const manualList =
    plan.manual_actions.length === 0
      ? "none"
      : plan.manual_actions.map((action) => `${action.type}:${action.name}`).join(", ");
  const authList =
    plan.auth.providers.length === 0
      ? "none"
      : plan.auth.providers.map((provider) => `${provider.provider} (${provider.method})`).join(", ");

  const restore = replacePlaceholders(restoreTemplate, {
    bundle_version: plan.generator.version,
    backup_timestamp: plan.created_at,
    opencode_version: plan.source.opencode_version ?? "unknown",
    clients: "CLI/Desktop",
    item_count: initialManifest.items.length,
    custom_count: initialManifest.items.filter((item) => item.classification === "custom").length,
    installable_count: initialManifest.extensions.filter((item) => item.classification === "installable").length,
    config_count: initialManifest.items.filter((item) => item.classification === "config").length,
    secret_key_list: secretList,
    reference_list: referenceList,
    manual_action_list: manualList,
    auth_provider_list: authList,
    plan_hash: plan.plan_hash,
    verification_commands: initialManifest.verification.commands.join("\n"),
  });
  await fs.writeFile(path.join(outDir, "RESTORE.md"), `${restore.trimEnd()}\n`, "utf8");

  await fs.mkdir(path.join(outDir, "tools"), { recursive: true });
  await fs.copyFile(path.join(ROOT, "scripts", "restore.mjs"), path.join(outDir, "tools", "restore.mjs"));

  const checksums = await collectChecksums(outDir);
  const manifest = manifestFromPlan(plan, checksums);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const finalChecksums = await collectChecksums(outDir);
  await fs.writeFile(path.join(outDir, "checksums.json"), `${JSON.stringify(finalChecksums, null, 2)}\n`, "utf8");

  const verification = await verifyBundle(outDir);
  if (!verification.ok) {
    const shown = verification.errors.slice(0, 20);
    const extra = verification.errors.length > shown.length ? `\n- ... and ${verification.errors.length - shown.length} more` : "";
    throw new Error(`bundle verification failed:\n${shown.map((error) => `- ${error}`).join("\n")}${extra}`);
  }

  const summary = {
    out: outDir,
    items: manifest.items.length,
    files: Object.keys(finalChecksums).length,
    secret_refs: valueRefs.length,
    manual_actions: plan.manual_actions.length,
    warnings: plan.warnings.length,
    plan_hash: plan.plan_hash,
    verification: verification.ok,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    console.log(`Bundle: ${outDir}`);
    console.log(`Items: ${summary.items}; files: ${summary.files}`);
    console.log(`Secrets to re-supply: ${summary.secret_refs}`);
    console.log(`Manual actions: ${summary.manual_actions}`);
    console.log(`Verification: ${verification.ok ? "ok" : "failed"}`);
  }
  activeOutDir = null;
}

main().catch(async (error) => {
  if (activeOutDir) {
    await fs.rm(activeOutDir, { recursive: true, force: true }).catch(() => {});
  }
  console.error(`build failed: ${error.stack || error.message}`);
  process.exit(1);
});
