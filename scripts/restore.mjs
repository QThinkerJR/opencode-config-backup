#!/usr/bin/env node
/**
 * Self-contained restore helper shipped inside a migration bundle.
 *
 * Safety rules:
 * - never restore into the home directory or a filesystem root;
 * - `~/...` targets are limited to known shared-skill locations;
 * - only the expected OpenCode config directory is accepted without
 *   --allow-custom-target;
 * - directories are staged and verified before the target is replaced;
 * - backups live under .restore-backups, never inside plugins/ or skills/.
 */
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

const PLACEHOLDER_RE = /<REDACTED:([^>]+)>/g;
const TEXT_EXT_RE = /\.(json|jsonc|md|mdx|txt|ya?ml|toml|env|ini|conf|properties|ts|tsx|js|jsx|mjs|cjs|sh|ps1|pem|key)$/i;
const ENV_FILE_RE = /(^|[\\/])\.env(?:\.[^\\/]+)?$/i;
const KEY_FILE_RE = /(^|[\\/])(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]+\.(?:pem|key))$/i;

function isTextTarget(file) {
  return TEXT_EXT_RE.test(file) || ENV_FILE_RE.test(file) || KEY_FILE_RE.test(file);
}

function parseArgs(argv) {
  const args = {
    bundle: null,
    target: null,
    approve: null,
    dryRun: false,
    secrets: null,
    json: false,
    home: null,
    allowCustomTarget: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--bundle") args.bundle = argv[++i];
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--approve") args.approve = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--secrets") args.secrets = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--home") args.home = argv[++i];
    else if (arg === "--allow-custom-target") args.allowCustomTarget = true;
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

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function sha256File(file) {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function isNoiseName(name) {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === ".svn" ||
    name === ".hg" ||
    name === ".npmrc" ||
    name === ".yarnrc" ||
    name === ".yarnrc.yml" ||
    name === ".pypirc" ||
    name === ".netrc" ||
    name === "_netrc" ||
    name === ".git-credentials" ||
    /\.bak(?:[.-].*)?$/i.test(name) ||
    /\.log$/i.test(name) ||
    /\.db(?:-(?:shm|wal))?$/i.test(name) ||
    /\.write-lock$/i.test(name)
  );
}

async function listFiles(root, options = {}) {
  const { exclude = (name) => isNoiseName(name) } = options;
  const results = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (exclude(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        results.push({ absolute, relative: path.relative(root, absolute), kind: "symlink" });
      } else if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        results.push({ absolute, relative: path.relative(root, absolute), kind: "file" });
      }
    }
  }
  results.sort((a, b) => a.relative.localeCompare(b.relative));
  return results;
}

async function hashDirectory(root) {
  const files = await listFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(String(file.relative).replace(/\\/g, "/"));
    hash.update("\0");
    if (file.kind === "file") hash.update(await fs.readFile(file.absolute));
    else hash.update("symlink");
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function timestamp() {
  const date = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function defaultConfigRoot(home) {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "opencode");
}

function resolveTarget(targetPath, targetRoot, home) {
  if (targetPath === "~") return home;
  if (targetPath.startsWith("~/")) return path.join(home, targetPath.slice(2));
  return path.join(targetRoot, targetPath);
}

function assertSafeTargetRoot(targetRoot, home, bundleDir, allowCustom) {
  const resolvedRoot = path.resolve(targetRoot);
  const resolvedHome = path.resolve(home);
  if (samePath(resolvedRoot, resolvedHome)) {
    throw new Error("refusing to restore into the home directory; pass the OpenCode config directory as --target");
  }
  if (samePath(resolvedRoot, path.parse(resolvedRoot).root)) {
    throw new Error("refusing to restore into a filesystem root");
  }
  if (isInside(resolvedRoot, resolvedHome)) {
    throw new Error("refusing a target directory that contains the home directory");
  }
  if (isInside(resolvedRoot, bundleDir) || isInside(bundleDir, resolvedRoot)) {
    throw new Error("the target directory and the bundle directory must not contain each other");
  }
  if (!allowCustom) {
    const expected = path.resolve(process.env.OPENCODE_CONFIG_DIR || defaultConfigRoot(home));
    if (!samePath(resolvedRoot, expected)) {
      throw new Error(`refusing unusual target ${resolvedRoot}; expected ${expected} or pass --allow-custom-target`);
    }
  }
}

const SHARED_TARGETS = ["~/.agents/skills", "~/.agents/.skill-lock.json", "~/.claude/skills"];

function assertSafeTarget(targetPath, target, targetRoot, home) {
  if (!targetPath || targetPath === ".") throw new Error("refusing empty target path");
  if (path.isAbsolute(targetPath) || /^[A-Za-z]:[\\/]/.test(targetPath)) {
    throw new Error(`refusing absolute target path: ${targetPath}`);
  }
  const normalized = targetPath.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) throw new Error(`refusing parent traversal in target path: ${targetPath}`);

  if (normalized === "~" || normalized.startsWith("~/")) {
    const allowed = SHARED_TARGETS.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
    if (!allowed) throw new Error(`refusing non-whitelisted home target: ${targetPath}`);
    if (samePath(target, home) || !isInside(home, target)) throw new Error(`refusing home/root target: ${targetPath}`);
    return;
  }

  if (samePath(target, targetRoot) || !isInside(targetRoot, target)) {
    throw new Error(`target escapes the restore root: ${targetPath}`);
  }
}

function collectPlaceholders(text) {
  const result = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) result.push(match[1]);
  return result;
}

function applySecrets(text, secrets, missing, jsonMode = false) {
  return text.replace(PLACEHOLDER_RE, (_match, label) => {
    if (Object.prototype.hasOwnProperty.call(secrets, label)) {
      const value = String(secrets[label]);
      return jsonMode ? JSON.stringify(value).slice(1, -1) : value;
    }
    missing.add(label);
    return `<REDACTED:${label}>`;
  });
}

async function applySecretsToTree(root, secrets, missing) {
  const files = await listFiles(root);
  for (const file of files) {
    if (file.kind !== "file") continue;
    let text;
    try {
      text = await fs.readFile(file.absolute, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("<REDACTED:")) continue;
    const jsonMode = /\.(json|jsonc)$/i.test(file.absolute);
    const replaced = applySecrets(text, secrets, missing, jsonMode);
    if (replaced !== text) await fs.writeFile(file.absolute, replaced, "utf8");
  }
}

async function hashDirectoryWithSecrets(root, secrets, missing) {
  const files = await listFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(String(file.relative).replace(/\\/g, "/"));
    hash.update("\0");
    if (file.kind !== "file") {
      hash.update("symlink");
    } else if (isTextTarget(file.absolute)) {
      const text = await fs.readFile(file.absolute, "utf8");
      if (text.includes("<REDACTED:")) {
        hash.update(applySecrets(text, secrets, missing, /\.(json|jsonc)$/i.test(file.absolute)));
      } else {
        hash.update(text);
      }
    } else {
      hash.update(await fs.readFile(file.absolute));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertNoPlaceholdersInTree(root) {
  const files = await listFiles(root);
  for (const file of files) {
    if (file.kind !== "file") continue;
    if (!isTextTarget(file.absolute)) continue;
    const text = await fs.readFile(file.absolute, "utf8").catch(() => "");
    if (text.includes("<REDACTED:")) {
      throw new Error(`unresolved placeholder remains in ${file.absolute}`);
    }
  }
}

async function verifyBundleChecksums(bundleDir, manifest) {
  if (manifest.schema_version !== 2) {
    throw new Error(`unsupported manifest schema: ${manifest.schema_version}; this restore helper requires schema 2`);
  }
  const checksumsPath = path.join(bundleDir, "checksums.json");
  const checksums = JSON.parse(await fs.readFile(checksumsPath, "utf8"));
  const errors = [];
  for (const [relative, expected] of Object.entries(checksums)) {
    const absolute = path.join(bundleDir, relative);
    if (!(await exists(absolute))) {
      errors.push(`missing checksummed file: ${relative}`);
      continue;
    }
    const actual = await sha256File(absolute);
    if (actual !== expected) errors.push(`checksum mismatch: ${relative}`);
  }
  for (const item of manifest.items ?? []) {
    if (item.sha256 && checksums[item.bundle_path] && item.sha256 !== checksums[item.bundle_path]) {
      errors.push(`manifest checksum mismatch: ${item.bundle_path}`);
    }
  }
  const filesRoot = path.join(bundleDir, "files");
  const bundleFiles = await listFiles(filesRoot, { exclude: () => false });
  const knownLabels = new Set((manifest.secret_refs ?? []).map((ref) => ref.label));
  for (const file of bundleFiles) {
    if (file.kind !== "file") continue;
    const relative = `files/${String(file.relative).replace(/\\/g, "/")}`;
    if (!Object.prototype.hasOwnProperty.call(checksums, relative)) {
      errors.push(`unlisted file in bundle: ${relative}`);
    }
    if (!isTextTarget(file.absolute)) continue;
    const text = await fs.readFile(file.absolute, "utf8").catch(() => "");
    for (const label of collectPlaceholders(text)) {
      if (!knownLabels.has(label)) errors.push(`unknown redaction label ${label} in ${relative}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(checksums, "tools/restore.mjs")) {
    errors.push("tools/restore.mjs is not checksummed");
  }
  return errors;
}

function backupRelative(targetPath, timestampValue) {
  return `.restore-backups/${timestampValue}/${targetPath.replace(/^~\//, "")}`;
}

async function buildPlan(bundleDir, manifest, targetRoot, home, secrets) {
  const actions = [];
  const missingSecrets = new Set();
  const linkWarnings = [];
  for (const item of manifest.items ?? []) {
    if (!item.bundle_path) continue;
    const source = path.join(bundleDir, item.bundle_path);
    const target = resolveTarget(item.target_path, targetRoot, home);
    assertSafeTarget(item.target_path, target, targetRoot, home);
    const sourceStat = await fs.stat(source).catch(() => null);
    if (!sourceStat) {
      actions.push({
        item_id: item.id,
        type: item.type,
        bundle_path: item.bundle_path,
        target_path: item.target_path,
        target,
        action: "missing-source",
        kind: "file",
        backup: null,
      });
      continue;
    }
    const kind = sourceStat.isDirectory() ? "directory" : "file";
    const targetExists = await exists(target);
    let action = targetExists ? "overwrite" : "create";

    if (targetExists) {
      const linkTarget = await describeLinkTarget(target);
      if (linkTarget) {
        linkWarnings.push({
          target_path: item.target_path,
          target,
          link_target: linkTarget,
          merge: kind === "directory" && (item.type === "skills-root" || item.type === "plugin-data"),
        });
      }
    }

    if (kind === "file") {
      const sourceText = await fs.readFile(source, "utf8").catch(() => null);
      if (sourceText !== null && sourceText.includes("<REDACTED:")) {
        const withoutSecrets = applySecrets(sourceText, secrets, missingSecrets, /\.(json|jsonc)$/i.test(target));
        if (targetExists) {
          const targetText = await fs.readFile(target, "utf8").catch(() => null);
          if (targetText !== null && targetText === withoutSecrets) action = "skip";
        }
      } else if (targetExists) {
        const [sourceHash, targetHash] = await Promise.all([sha256File(source), sha256File(target)]);
        if (sourceHash === targetHash) action = "skip";
      }
    } else {
      const sourceHash = await hashDirectoryWithSecrets(source, secrets, missingSecrets);
      if (targetExists) {
        const targetHash = await hashDirectory(target);
        if (sourceHash === targetHash) action = "skip";
      }
    }

    actions.push({
      item_id: item.id,
      type: item.type,
      bundle_path: item.bundle_path,
      target_path: item.target_path,
      target,
      action,
      kind,
      backup: action === "overwrite" ? backupRelative(item.target_path, "<timestamp>") : null,
    });
  }
  return { actions, missingSecrets: [...missingSecrets].sort(), linkWarnings };
}

function planHash(actions, missingSecrets) {
  return sha256Text(stableStringify({ actions, missingSecrets }));
}

async function writeBackup(target, backup, kind) {
  await fs.mkdir(path.dirname(backup), { recursive: true });
  const source = await fs.realpath(target).catch(() => target);
  if (kind === "directory") await fs.cp(source, backup, { recursive: true, dereference: true });
  else await fs.copyFile(source, backup);
}

async function describeLinkTarget(target) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat || !stat.isSymbolicLink()) return null;
  return fs.realpath(target).catch(() => "(unresolved)");
}

async function applyPlan(bundleDir, plan, secrets, missingSecrets, targetRoot, home) {
  if (plan.missingSecrets.length) {
    throw new Error(`missing secret values: ${plan.missingSecrets.join(", ")}`);
  }
  const stamp = timestamp();
  for (const action of plan.actions) {
    if (action.action === "missing-source") throw new Error(`bundle source missing: ${action.bundle_path}`);
    if (action.action === "skip") continue;
    const source = path.join(bundleDir, action.bundle_path);
    const baseRoot = action.target_path.startsWith("~/") ? home : targetRoot;
    const backup = action.backup ? path.join(baseRoot, action.backup.replace("<timestamp>", stamp)) : null;
    const stagingRoot = path.join(baseRoot, ".restore-tmp");
    const stagingName = `${String(action.item_id).replace(/[^A-Za-z0-9._-]+/g, "-")}-${process.pid}-${stamp}`;
    const tmp = path.join(stagingRoot, stagingName);
    await fs.mkdir(path.dirname(action.target), { recursive: true });
    await fs.mkdir(stagingRoot, { recursive: true });

    try {
      if (action.kind === "directory") {
        await fs.cp(source, tmp, { recursive: true });
        await applySecretsToTree(tmp, secrets, missingSecrets);
        await assertNoPlaceholdersInTree(tmp);
      } else {
        const text = await fs.readFile(source, "utf8").catch(() => null);
        if (text !== null && text.includes("<REDACTED:")) {
          const replaced = applySecrets(text, secrets, missingSecrets, /\.(json|jsonc)$/i.test(action.target));
          if (collectPlaceholders(replaced).length) throw new Error(`unresolved placeholder remains in ${action.target}`);
          await fs.writeFile(tmp, replaced, "utf8");
        } else {
          await fs.copyFile(source, tmp);
        }
      }

      const merge = action.kind === "directory" && (action.type === "skills-root" || action.type === "plugin-data");
      if (merge && (await exists(action.target))) {
        const mergeTarget = await fs.realpath(action.target).catch(() => action.target);
        if (backup) await writeBackup(action.target, backup, "directory");
        try {
          await fs.cp(tmp, mergeTarget, { recursive: true, force: true });
          await fs.rm(tmp, { recursive: true, force: true });
          continue;
        } catch (error) {
          if (backup && (await exists(backup))) {
            await fs.rm(mergeTarget, { recursive: true, force: true }).catch(() => {});
            await fs.rename(backup, mergeTarget).catch(() => {});
          }
          throw error;
        }
      }

      const hadTarget = await exists(action.target);
      if (hadTarget) {
        if (backup) await writeBackup(action.target, backup, action.kind);
        await fs.rm(action.target, { recursive: true, force: true });
      }
      try {
        await fs.rename(tmp, action.target);
      } catch (error) {
        if (hadTarget && backup && (await exists(backup))) {
          await fs.rename(backup, action.target).catch(() => {});
        }
        throw error;
      }
    } catch (error) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  if (missingSecrets.size) throw new Error(`missing secret values: ${[...missingSecrets].sort().join(", ")}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node tools/restore.mjs --bundle <dir> [--target <config-dir>] [--dry-run] [--secrets <json>] --approve <hash>

  --target   OpenCode config directory (default: $OPENCODE_CONFIG_DIR or ~/.config/opencode)
  --home     Home directory for ~ targets (default: current user)
  --secrets  JSON object mapping <REDACTED:label> labels to values
  --approve  Apply only when this matches the displayed plan hash
  --allow-custom-target  Permit a target other than the default OpenCode config directory
`);
    process.exit(0);
  }
  const bundleDir = path.resolve(args.bundle ?? ".");
  const manifest = JSON.parse(await fs.readFile(path.join(bundleDir, "manifest.json"), "utf8"));
  const checksumErrors = await verifyBundleChecksums(bundleDir, manifest);
  if (checksumErrors.length) {
    throw new Error(`bundle checksums failed:\n${checksumErrors.map((error) => `- ${error}`).join("\n")}`);
  }
  const home = path.resolve(args.home ?? os.homedir());
  const targetRoot = path.resolve(args.target ?? (process.env.OPENCODE_CONFIG_DIR || defaultConfigRoot(home)));
  assertSafeTargetRoot(targetRoot, home, bundleDir, args.allowCustomTarget);

  const secrets = args.secrets ? JSON.parse(await fs.readFile(path.resolve(args.secrets), "utf8")) : {};
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error("--secrets must contain a JSON object");
  }
  const plan = await buildPlan(bundleDir, manifest, targetRoot, home, secrets);
  const hash = planHash(plan.actions, plan.missingSecrets);

  if (args.dryRun || !args.approve) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ...plan, plan_hash: hash }, null, 2)}\n`);
    } else {
      console.log(`Restore plan: ${bundleDir} -> ${targetRoot}`);
      for (const action of plan.actions) {
        console.log(`- [${action.action}] ${action.kind} ${action.target_path} -> ${action.target}`);
      }
      if (plan.missingSecrets.length) console.log(`Missing secrets: ${plan.missingSecrets.join(", ")}`);
      for (const warning of plan.linkWarnings) {
        const mode = warning.merge ? "merge writes through the link" : "backups follow the link";
        console.log(`Symlink target: ${warning.target_path} -> ${warning.link_target} (${mode})`);
      }
      console.log(`Plan hash: ${hash}`);
      console.log("No files were written. Re-run with --approve <hash> to apply.");
    }
    return;
  }

  if (args.approve !== hash) throw new Error(`approval hash does not match restore plan (expected ${hash})`);
  for (const warning of plan.linkWarnings) {
    const mode = warning.merge ? "merge writes through the link" : "backups follow the link";
    console.warn(`warning: ${warning.target_path} is a symlink/junction -> ${warning.link_target}; ${mode}`);
  }
  await applyPlan(bundleDir, plan, secrets, new Set(), targetRoot, home);
  console.log(`Restore complete: ${targetRoot}`);
  console.log(`Applied: ${plan.actions.filter((action) => action.action !== "skip").length}; skipped: ${plan.actions.filter((action) => action.action === "skip").length}`);
}

main().catch((error) => {
  console.error(`restore failed: ${error.stack || error.message}`);
  process.exit(1);
});
