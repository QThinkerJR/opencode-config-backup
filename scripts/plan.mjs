#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { collectStringNodes, parseJsonc } from "./lib/jsonc.mjs";
import { analyzeJsonc, analyzeText, isReferenceValue, isSecretKey, urlHasSecret } from "./lib/redact.mjs";
import { replaceHomePath, sanitizePlanForOutput } from "./lib/sanitize.mjs";
import {
  analyzeMcpServer,
  parsePluginSpec,
  pluginKeyFromSpec,
  readLocalPluginManifest,
} from "./lib/plugins.mjs";
import { discoverAll } from "./lib/discover.mjs";
import { applyRewrites } from "./lib/rewrites.mjs";
import { scanTreeSecrets } from "./lib/tree-secrets.mjs";
import {
  defaultConfigDir,
  dirSize,
  hashDirectory,
  isAbsolutePath,
  isInside,
  listFilesRecursive,
  normalizeSlashes,
  sha256Text,
  slugify,
  statOrNull,
  toPortableRelative,
} from "./lib/paths.mjs";

const GENERATOR = { name: "opencode-config-backup", version: "2.0.0" };
const BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"]);

function parseArgs(argv) {
  const args = {
    config: null,
    home: os.homedir(),
    out: null,
    exclude: [],
    includeClaudeSkills: false,
    opencode: false,
    json: false,
    maxItemMb: 50,
    maxTotalMb: 200,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--config") args.config = argv[++i];
    else if (arg === "--home") args.home = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--exclude") args.exclude.push(...String(argv[++i]).split(",").map((item) => item.trim()).filter(Boolean));
    else if (arg === "--include-claude-skills") args.includeClaudeSkills = true;
    else if (arg === "--opencode") args.opencode = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--max-item-mb") args.maxItemMb = Number(argv[++i]);
    else if (arg === "--max-total-mb") args.maxTotalMb = Number(argv[++i]);
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

function withHash(plan) {
  const { plan_hash: _ignored, ...withoutHash } = plan;
  return { ...withoutHash, plan_hash: sha256Text(stableStringify(withoutHash)) };
}

function addWarning(plan, code, message, extra = {}) {
  plan.warnings.push({ code, message, ...extra });
}

function addLogicalExtension(plan, extension) {
  const definedIn = Array.isArray(extension.defined_in)
    ? extension.defined_in
    : extension.defined_in
      ? [extension.defined_in]
      : [];
  const existing = plan.extensions.find(
    (item) =>
      item.type === extension.type &&
      item.name === extension.name &&
      item.bundle_item === extension.bundle_item,
  );
  if (existing) {
    existing.defined_in = [...new Set([...(existing.defined_in ?? []), ...definedIn])];
    for (const [key, value] of Object.entries(extension)) {
      if (key === "defined_in" || key === "name" || key === "type") continue;
      if (existing[key] === undefined) existing[key] = value;
    }
    return existing;
  }
  const created = { ...extension, defined_in: definedIn };
  plan.extensions.push(created);
  return created;
}

function addManualAction(plan, action) {
  const id = action.id ?? `${action.type}:${action.name}:${action.reason ?? "manual"}`;
  if (plan.manual_actions.some((item) => item.id === id)) return;
  plan.manual_actions.push({ id, ...action });
}

function readOpenCode(args, cwd) {
  if (process.platform === "win32") {
    const command = [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `opencode ${args.join(" ")}`];
    return execFileSync(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return execFileSync("opencode", args, {
    cwd,
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryOpenCode(args, cwd) {
  try {
    return { ok: true, text: readOpenCode(args, cwd) };
  } catch (error) {
    return {
      ok: false,
      error: error.stderr?.toString?.() || error.message,
    };
  }
}

function parseVersion(text) {
  const match = String(text).match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function detectConfigFormat(docs) {
  let v1 = false;
  let v2 = false;
  for (const doc of docs) {
    if (!/^opencode\.jsonc?$/i.test(doc.item.name)) continue;
    const value = doc.root.value;
    if (!value || typeof value !== "object") continue;
    if ("plugins" in value || "agents" in value || "commands" in value || "providers" in value || "permissions" in value) v2 = true;
    if ("plugin" in value || "agent" in value || "command" in value || "provider" in value || "permission" in value) v1 = true;
    if (value.mcp && typeof value.mcp === "object" && value.mcp.servers) v2 = true;
    if (value.mcp && typeof value.mcp === "object" && Object.keys(value.mcp).some((key) => key !== "servers" && key !== "timeout")) v1 = true;
  }
  if (v1 && v2) return "hybrid";
  if (v2) return "v2";
  if (v1) return "v1";
  return "unknown";
}

function pluginEntry(doc, key, index, entry) {
  const pointer = `/${key}/${index}`;
  if (typeof entry === "string") {
    return { spec: entry, options: null, pointer, packagePointer: pointer };
  }
  if (Array.isArray(entry) && typeof entry[0] === "string") {
    return { spec: entry[0], options: entry[1] ?? null, pointer, packagePointer: `${pointer}/0` };
  }
  if (entry && typeof entry === "object" && typeof entry.package === "string") {
    return { spec: entry.package, options: entry.options ?? null, pointer, packagePointer: `${pointer}/package` };
  }
  return null;
}

function configPluginEntries(doc) {
  const value = doc.root.value;
  const result = [];
  for (const key of ["plugins", "plugin"]) {
    if (!Array.isArray(value?.[key])) continue;
    value[key].forEach((entry, index) => {
      const parsed = pluginEntry(doc, key, index, entry);
      if (parsed) result.push({ ...parsed, key });
      else {
        result.push({
          spec: null,
          options: null,
          pointer: `/${key}/${index}`,
          packagePointer: `/${key}/${index}`,
          invalid: true,
        });
      }
    });
  }
  return result;
}

function configMcpEntries(doc) {
  const value = doc.root.value;
  const mcp = value?.mcp;
  const result = [];
  if (!mcp || typeof mcp !== "object") return result;
  if (mcp.servers && typeof mcp.servers === "object") {
    for (const [name, server] of Object.entries(mcp.servers)) {
      result.push({
        name,
        server,
        pointer: `/mcp/servers/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        format: "v2",
      });
    }
  }
  for (const [name, server] of Object.entries(mcp)) {
    if (name === "servers" || name === "timeout") continue;
    if (!server || typeof server !== "object") continue;
    result.push({
      name,
      server,
      pointer: `/mcp/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
      format: "v1",
    });
  }
  return result;
}

function commandHasAbsolutePath(command) {
  return Array.isArray(command) && command.some((item) => typeof item === "string" && isAbsolutePath(item));
}

function commandContainsSecret(command) {
  if (!Array.isArray(command)) return false;
  let secretNext = false;
  for (const item of command) {
    if (typeof item !== "string") {
      secretNext = false;
      continue;
    }
    if (isReferenceValue(item)) {
      secretNext = false;
      continue;
    }
    if (urlHasSecret(item)) return true;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(item);
    if (assignment && isSecretKey(assignment[1], { allowBare: true })) return true;
    const equals = /^--?([^=]+)=(.+)$/.exec(item);
    if (equals && isSecretKey(equals[1], { allowBare: true })) return true;
    if (secretNext) return true;
    if (/^--?[^=]+$/.test(item) && isSecretKey(item.replace(/^--?/, ""), { allowBare: true })) secretNext = true;
  }
  return false;
}

function tildeHomePath(value, home) {
  if (typeof value !== "string" || !home) return null;
  const normalizedHome = normalizeSlashes(home).replace(/\/+$/, "");
  const normalizedValue = normalizeSlashes(value);
  if (normalizedValue === normalizedHome) return "~";
  if (normalizedValue.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedValue.slice(normalizedHome.length + 1)}`;
  }
  return null;
}

function addHomePathRewrites(plan, doc, home) {
  const existing = new Set(plan.rewrites.filter((item) => item.item_id === doc.item.id).map((item) => item.pointer));
  for (const node of collectStringNodes(doc.root)) {
    const pointer = node.pointer || "";
    if (!pointer || existing.has(pointer)) continue;
    if (pointer.includes("/command/") || pointer.includes("/environment/") || pointer.includes("/headers/")) continue;
    const replacement = tildeHomePath(node.value, home);
    if (!replacement || replacement === node.value) continue;
    plan.rewrites.push({
      id: `home-path:${doc.item.id}:${pointer}`,
      item_id: doc.item.id,
      plugin_item_id: null,
      pointer,
      from: node.value,
      to: replacement,
      kind: "string",
      reason: "normalize-home-path",
    });
    existing.add(pointer);
    addWarning(plan, "HOME_PATH_NORMALIZED", `normalized home path at ${doc.item.target_path}${pointer}`, {
      item_id: doc.item.id,
    });
  }
}

const PLUGIN_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
];

function collectExportPaths(value, output) {
  if (typeof value === "string") {
    const normalized = normalizeSlashes(value).replace(/^\.\//, "");
    if (normalized && !normalized.includes("*")) output.add(normalized);
  } else if (Array.isArray(value)) {
    for (const item of value) collectExportPaths(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectExportPaths(item, output);
  }
}

function pluginCopyIncludes(manifest) {
  // If the package declares a published file list, honor it plus everything
  // the runtime may resolve (exports, package metadata, lockfile, docs).
  if (Array.isArray(manifest.files) && manifest.files.length) {
    const includes = new Set(["package.json", ...PLUGIN_LOCKFILES, "README.md", "LICENSE", "CHANGELOG.md"]);
    for (const entry of manifest.files) {
      const normalized = normalizeSlashes(entry).replace(/^\.\//, "").replace(/\/\*$/, "").replace(/\/$/, "");
      if (normalized) includes.add(normalized);
    }
    collectExportPaths(manifest.exports, includes);
    return [...includes];
  }
  // No allowlist: copy the whole package except noise, so local support files
  // and nested modules are not silently lost.
  return null;
}

function configExtensionEntries(doc, type) {
  const value = doc.root.value;
  const keys = type === "agent" ? ["agents", "agent"] : ["commands", "command"];
  const result = [];
  for (const key of keys) {
    const entries = value?.[key];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const name of Object.keys(entries)) {
      result.push({
        name,
        pointer: `/${key}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        format: key === "agents" || key === "commands" ? "v2" : "v1",
      });
    }
  }
  return result;
}

function collectSkillDeclarations(doc) {
  const value = doc.root.value;
  const declarations = [];
  const skills = value?.skills;
  if (Array.isArray(skills)) {
    skills.forEach((entry, index) => {
      if (typeof entry === "string") declarations.push({ value: entry, pointer: `/skills/${index}` });
    });
  } else if (skills && typeof skills === "object") {
    for (const key of ["paths", "urls"]) {
      if (!Array.isArray(skills[key])) continue;
      skills[key].forEach((entry, index) => {
        if (typeof entry === "string") declarations.push({ value: entry, pointer: `/skills/${key}/${index}` });
      });
    }
  }
  return declarations;
}

async function enrichFromOpenCode(plan, args) {
  const cwd = args.home;
  const versionResult = tryOpenCode(["--version"], cwd);
  if (versionResult.ok) {
    plan.source.opencode_version = parseVersion(versionResult.text) ?? versionResult.text.trim();
  } else {
    addWarning(plan, "OPENCODE_PROBE_FAILED", "opencode --version failed; version is unknown.");
  }

  const pluginResult = tryOpenCode(["plugin", "list", "--builtin"], cwd);
  if (pluginResult.ok) {
    const lines = pluginResult.text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const [, id, version, source] = match;
      if (id === "ID" || version === "VERSION" || source.trim() === "SOURCE") continue;
      if (source.trim() === "builtin") continue;
      plan.opencode.plugins.push({ id, version, source: source.trim() });
    }
    for (const installed of plan.opencode.plugins) {
      const extension = plan.extensions.find(
        (item) =>
          item.type === "plugin" &&
          (item.package_name === installed.source ||
            item.spec === installed.source ||
            item.name === installed.id ||
            item.name === installed.source),
      );
      if (extension) {
        extension.installed_version = installed.version;
        extension.installed_source = installed.source;
        extension.opencode_id = installed.id;
      } else {
        plan.extensions.push({
          type: "plugin",
          name: installed.id,
          classification: "derived",
          origin: "plugin-or-builtin",
          installed_version: installed.version,
          installed_source: installed.source,
          defined_in: [],
          path: null,
        });
        addWarning(
          plan,
          "PLUGIN_NOT_IN_CONFIG",
          `plugin ${installed.id} is installed but not declared in a scanned global config file.`,
          { name: installed.id },
        );
      }
    }
  } else {
    addWarning(plan, "OPENCODE_PROBE_FAILED", "opencode plugin list failed; installed versions are unknown.");
  }

  const mcpResult = tryOpenCode(["mcp", "list"], cwd);
  if (mcpResult.ok) {
    for (const line of mcpResult.text.split(/\r?\n/)) {
      const match = line.match(/^[✓○✗?]\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const [, name, status] = match;
      const extension = plan.extensions.find((item) => item.type === "mcp" && item.name === name);
      if (extension) extension.installed_status = status.trim();
      else {
        plan.extensions.push({
          type: "mcp",
          name,
          classification: "derived",
          origin: "plugin-or-builtin",
          installed_status: status.trim(),
          defined_in: [],
          path: null,
        });
      }
    }
  } else {
    addWarning(plan, "OPENCODE_PROBE_FAILED", "opencode mcp list failed; connection state is unknown.");
  }

  const agentsResult = tryOpenCode(["debug", "agents"], cwd);
  if (agentsResult.ok) {
    try {
      const agents = JSON.parse(agentsResult.text);
      const configAgentNames = new Set(plan.extensions.filter((item) => item.type === "agent").map((item) => item.name));
      for (const agent of agents) {
        if (!agent?.id || BUILTIN_AGENTS.has(agent.id) || configAgentNames.has(agent.id)) continue;
        plan.extensions.push({
          type: "agent",
          name: agent.id,
          classification: "derived",
          origin: "plugin-or-builtin",
          mode: agent.mode ?? null,
          description: agent.description ?? null,
          defined_in: [],
          path: null,
        });
      }
    } catch {
      addWarning(plan, "OPENCODE_PROBE_FAILED", "opencode debug agents returned unparseable JSON.");
    }
  } else {
    addWarning(plan, "OPENCODE_PROBE_FAILED", "opencode debug agents failed; derived agents are unknown.");
  }

  const authResult = tryOpenCode(["auth", "list"], cwd);
  if (authResult.ok) {
    for (const line of authResult.text.split(/\r?\n/)) {
      const parts = line.trim().split(/\s{2,}/).filter(Boolean);
      if (parts.length < 2) continue;
      const [provider, method, status] = parts;
      if (/^provider$/i.test(provider)) continue;
      plan.auth.providers.push({ provider, method, status: status ?? "unknown" });
    }
    addWarning(plan, "AUTH_NOT_INCLUDED", "Credentials are not included. Re-authenticate on the target machine.");
  } else {
    addWarning(plan, "OPENCODE_PROBE_FAILED", "opencode auth list failed; auth requirements are unknown.");
  }
}

async function warnSymlinks(plan) {
  for (const item of plan.items) {
    if (item.format !== "directory") continue;
    const files = await listFilesRecursive(item.source_path, {
      exclude: (name) => name === "node_modules" || name === ".git",
    }).catch(() => []);
    const symlinks = files.filter((file) => file.kind === "symlink");
    if (symlinks.length) {
      addWarning(
        plan,
        "SYMLINK_SKIPPED",
        `${item.target_path} contains ${symlinks.length} symlink(s); they are not copied.`,
        { item_id: item.id },
      );
    }
  }
}

function filterExcluded(plan, excludes) {
  if (!excludes.length) return;
  const tokens = new Set(excludes);
  const matchedTokens = new Set();
  const removedItems = new Set();

  for (const extension of [...plan.extensions]) {
    const matchedToken = [extension.name, extension.spec, extension.package_name].find((value) => value && tokens.has(value));
    if (!matchedToken) continue;
    matchedTokens.add(matchedToken);
    const definedIn = Array.isArray(extension.defined_in) ? extension.defined_in : [];
    const isArrayIndexPath = typeof extension.path === "string" && /^\/(?:plugins|plugin)\/\d+$/.test(extension.path);
    if (isArrayIndexPath) {
      addWarning(
        plan,
        "EXCLUDE_UNSUPPORTED",
        `cannot safely exclude ${extension.type} ${extension.name}: it is an indexed config entry; exclude the config file or edit the plan manually.`,
        { name: extension.name },
      );
      continue;
    }
    if (typeof extension.path === "string" && extension.path.startsWith("/")) {
      for (const itemId of definedIn) {
        if (!itemId.startsWith("config:")) continue;
        if (
          plan.rewrites.some(
            (rewrite) =>
              rewrite.item_id === itemId &&
              rewrite.pointer === extension.path &&
              rewrite.kind === "delete",
          )
        ) {
          continue;
        }
        plan.rewrites.push({
          id: `exclude:${itemId}:${extension.path}`,
          item_id: itemId,
          pointer: extension.path,
          kind: "delete",
          reason: "excluded-by-user",
        });
      }
    } else {
      for (const itemId of definedIn) {
        if (itemId) removedItems.add(itemId);
      }
    }
    if (extension.bundle_item) removedItems.add(extension.bundle_item);
    plan.extensions = plan.extensions.filter((item) => item !== extension);
    plan.manual_actions = plan.manual_actions.filter((action) => action.name !== extension.name);
    addWarning(plan, "EXCLUDED_BY_USER", `excluded by user: ${extension.type} ${extension.name}`, {
      name: extension.name,
    });
  }

  plan.items = plan.items.filter((item) => {
    const hit = tokens.has(item.id) || tokens.has(item.name) || tokens.has(item.target_path);
    if (hit) {
      matchedTokens.add(item.id);
      removedItems.add(item.id);
      addWarning(plan, "EXCLUDED_BY_USER", `excluded by user: ${item.id}`, { item_id: item.id });
      return false;
    }
    if (removedItems.has(item.id)) return false;
    return true;
  });
  for (const token of tokens) {
    if (!matchedTokens.has(token)) {
      addWarning(plan, "EXCLUDE_UNMATCHED", `--exclude did not match any item or extension: ${token}`, {
        name: token,
      });
    }
  }
  plan.extensions = plan.extensions.filter((extension) => {
    const definedIn = Array.isArray(extension.defined_in) ? extension.defined_in : extension.defined_in ? [extension.defined_in] : [];
    if (definedIn.some((id) => removedItems.has(id))) return false;
    if (extension.bundle_item && removedItems.has(extension.bundle_item)) return false;
    return true;
  });
  plan.rewrites = plan.rewrites.filter((rewrite) => !removedItems.has(rewrite.item_id) && !removedItems.has(rewrite.plugin_item_id));
  plan.manual_actions = plan.manual_actions.filter((action) => {
    const definedIn = Array.isArray(action.defined_in) ? action.defined_in : action.defined_in ? [action.defined_in] : [];
    return !definedIn.some((id) => removedItems.has(id));
  });
  plan.secret_refs = plan.secret_refs.filter((ref) => !removedItems.has(ref.item_id));
}

function writeSummary(plan) {
  const lines = [];
  lines.push("# OpenCode Migration Plan");
  lines.push("");
  lines.push(`- Generated: ${plan.created_at}`);
  lines.push(`- Source: ${plan.source.config_root}`);
  lines.push(`- OpenCode: ${plan.source.opencode_version ?? "unknown"}`);
  lines.push(`- Config format: ${plan.source.config_format}`);
  lines.push(`- Items: ${plan.items.length}`);
  lines.push(`- Extensions: ${plan.extensions.length}`);
  lines.push(`- Secrets to re-supply: ${plan.secret_refs.length}`);
  lines.push(`- Manual actions: ${plan.manual_actions.length}`);
  lines.push(`- Warnings: ${plan.warnings.length}`);
  lines.push("");
  lines.push("## Items");
  for (const item of plan.items) {
    lines.push(`- [${item.classification}] ${item.type} \`${item.name}\` -> \`${item.target_path}\``);
  }
  if (plan.manual_actions.length) {
    lines.push("");
    lines.push("## Manual actions");
    for (const action of plan.manual_actions) {
      lines.push(`- ${action.type} \`${action.name}\`: ${action.reason ?? "manual"}`);
    }
  }
  if (plan.warnings.length) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of plan.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }
  lines.push("");
  lines.push(`Plan hash: \`${plan.plan_hash}\``);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/plan.mjs [options]

  --config <dir>            OpenCode config directory (default: XDG config)
  --home <dir>              Home directory used for ~ resolution and shared skills
  --out <dir>               Plan output directory (default: .tmp/opencode-plan)
  --exclude <id,...>        Exclude items by id, name, or target path
  --include-claude-skills   Include ~/.claude/skills (shared with other agents)
  --opencode                Probe opencode for installed plugins, MCPs, agents, auth
  --json                    Print the plan JSON to stdout
`);
    process.exit(0);
  }

  const configDir = path.resolve(args.config ?? defaultConfigDir());
  const home = path.resolve(args.home);
  const stat = await statOrNull(configDir);
  if (!stat || !stat.isDirectory()) {
    console.error(`config directory not found: ${configDir}`);
    process.exit(1);
  }

  const plan = {
    schema_version: 2,
    generator: GENERATOR,
    created_at: new Date().toISOString(),
    source: {
      opencode_version: null,
      config_format: "unknown",
      os: process.platform,
      shell: process.platform === "win32" ? "powershell" : "bash",
      config_root: configDir,
      home,
    },
    options: {
      scope: "global",
      include_shared_skills: true,
      include_claude_skills: args.includeClaudeSkills,
      include_credentials: false,
      max_item_bytes: args.maxItemMb * 1024 * 1024,
      max_total_bytes: args.maxTotalMb * 1024 * 1024,
    },
    items: [],
    extensions: [],
    rewrites: [],
    secret_refs: [],
    manual_actions: [],
    auth: {
      credentials_included: false,
      providers: [],
      environment: [],
    },
    opencode: {
      plugins: [],
      mcp: [],
      agents: [],
    },
    warnings: [],
  };

  const discovered = await discoverAll(configDir, home, {
    includeClaudeSkills: args.includeClaudeSkills,
  });
  plan.items.push(...discovered.items);
  plan.extensions.push(...discovered.extensions);
  plan.warnings.push(...discovered.warnings);

  const configItems = plan.items.filter(
    (item) => item.type === "config" && (item.format === "json" || item.format === "jsonc"),
  );
  const docs = [];
  for (const item of configItems) {
    try {
      const text = await fs.readFile(item.source_path, "utf8");
      docs.push({ item, text, root: parseJsonc(text, item.source_path) });
    } catch (error) {
      item.classification = "manual";
      item.bundle_path = null;
      item.parse_error = error.message;
      addWarning(plan, "CONFIG_PARSE_ERROR", `cannot parse ${item.target_path}: ${error.message}`, {
        item_id: item.id,
      });
    }
  }
  plan.source.config_format = detectConfigFormat(docs);

  if (plan.items.some((item) => item.name === "opencode.json") && plan.items.some((item) => item.name === "opencode.jsonc")) {
    addWarning(plan, "CONFIG_JSON_AND_JSONC", "Both opencode.json and opencode.jsonc are present; restore both in source order.");
  }
  if (plan.items.some((item) => item.name === "tui.json" || item.name === "tui.jsonc")) {
    addWarning(plan, "TUI_LEGACY", "tui.json(c) is V1 legacy CLI configuration. V2 migrates it to cli.json when cli.json is absent.");
  }
  if (plan.items.some((item) => item.name === "tui.json") && plan.items.some((item) => item.name === "cli.json")) {
    addWarning(plan, "TUI_AND_CLI", "Both tui.json and cli.json exist; do not restore tui.json over an existing V2 cli.json.");
  }
  if (plan.source.config_format === "v1") {
    addWarning(plan, "V1_CONFIG", "The source uses V1 config fields. V2 still reads supported V1 fields; no automatic conversion is performed.");
  } else if (plan.source.config_format === "hybrid") {
    addWarning(plan, "HYBRID_CONFIG", "The source mixes V1 and V2 config fields. Restore preserves the files as-is.");
  }

  const pluginExtensions = new Map();
  const mcpExtensions = new Map();
  const localPluginItems = new Map();
  const themeNames = new Set(plan.extensions.filter((item) => item.type === "theme").map((item) => item.name));

  for (const doc of docs) {
    const surface = doc.item.name === "cli.json" || /^tui\.jsonc?$/i.test(doc.item.name) ? "tui" : "server";
    for (const entry of configPluginEntries(doc)) {
      if (entry.invalid || !entry.spec) {
        addWarning(plan, "PLUGIN_ENTRY_INVALID", `unsupported plugin entry at ${doc.item.target_path}${entry.pointer}`, {
          item_id: doc.item.id,
        });
        continue;
      }
      const parsed = parsePluginSpec(entry.spec, {
        baseDir: path.dirname(doc.item.source_path),
        home,
      });

      if (parsed.kind === "directive") {
        const name = parsed.target || parsed.spec;
        const key = `directive:${parsed.spec}`;
        if (!pluginExtensions.has(key)) {
          pluginExtensions.set(key, {
            type: "plugin",
            name,
            classification: "directive",
            origin: "user",
            kind: "directive",
            spec: parsed.spec,
            disabled: Boolean(parsed.disabled),
            wildcard: Boolean(parsed.wildcard),
            surfaces: [surface],
            defined_in: [doc.item.id],
            path: entry.pointer,
          });
        } else {
          pluginExtensions.get(key).defined_in.push(doc.item.id);
          if (!pluginExtensions.get(key).surfaces.includes(surface)) pluginExtensions.get(key).surfaces.push(surface);
        }
        continue;
      }

      if (parsed.kind === "local") {
        const localStat = await statOrNull(parsed.localPath);
        if (!localStat || !localStat.isDirectory()) {
          addWarning(plan, "LOCAL_PLUGIN_INVALID", `local plugin is not a directory: ${parsed.spec}`, {
            item_id: doc.item.id,
          });
          addManualAction(plan, {
            type: "plugin",
            name: entry.spec,
            reason: "local plugin is not a directory (V2 requires a directory)",
            spec: entry.spec,
            defined_in: [doc.item.id],
          });
          continue;
        }

        const manifest = await readLocalPluginManifest(parsed.localPath);
        const inside = isInside(configDir, parsed.localPath);
        let targetPath;
        let bundlePath;
        let rewriteTo = entry.spec;
        if (inside) {
          const relative = toPortableRelative(parsed.localPath, configDir);
          targetPath = relative ? normalizeSlashes(relative.replace(/^\.\//, "")) : normalizeSlashes(path.basename(parsed.localPath));
          bundlePath = `files/${targetPath}`;
          if (relative && relative !== entry.spec) rewriteTo = relative;
        } else {
          let slug = slugify(manifest.name || path.basename(parsed.localPath), "local-plugin");
          let candidate = `plugins/${slug}`;
          let suffix = 2;
          while (plan.items.some((item) => item.target_path === candidate)) {
            candidate = `plugins/${slug}-${suffix++}`;
          }
          targetPath = candidate;
          bundlePath = `files/${targetPath}`;
          rewriteTo = `./${targetPath}`;
        }

        const size = await dirSize(parsed.localPath, {
          exclude: (name) => name === "node_modules" || name === ".git",
        });
        let sourceHash = null;
        try {
          sourceHash = await hashDirectory(parsed.localPath, {
            exclude: (name) => name === "node_modules" || name === ".git",
          });
        } catch {
          sourceHash = null;
        }

        let pluginItem = plan.items.find((item) => item.target_path === targetPath && item.type === "plugin");
        if (!pluginItem) {
          pluginItem = {
            id: `plugin:local:${targetPath}`,
            type: "plugin",
            name: manifest.name || path.basename(parsed.localPath),
            classification: "custom",
            origin: "user",
            source_path: parsed.localPath,
            target_path: targetPath,
            bundle_path: bundlePath,
            format: "directory",
            enabled: true,
            source_kind: "dir",
            size,
            source_hash: sourceHash,
            defined_in: doc.item.id,
            provided_by: null,
            warnings: [],
            metadata: {
              api: manifest.api,
              package_name: manifest.name,
              package_version: manifest.version,
              has_package_json: manifest.hasPackageJson,
              entry_files: manifest.entryFiles,
              copy_includes: pluginCopyIncludes(manifest),
              relocated: !inside,
            },
          };
          plan.items.push(pluginItem);
        } else {
          pluginItem.metadata = {
            ...pluginItem.metadata,
            api: manifest.api,
            package_name: manifest.name,
            package_version: manifest.version,
            copy_includes: pluginCopyIncludes(manifest),
            relocated: !inside,
          };
        }
        localPluginItems.set(parsed.localPath, pluginItem);

        if (rewriteTo !== entry.spec) {
          plan.rewrites.push({
            id: `plugin-path:${doc.item.id}:${entry.packagePointer}`,
            item_id: doc.item.id,
            plugin_item_id: pluginItem.id,
            pointer: entry.packagePointer,
            from: entry.spec,
            to: rewriteTo,
            kind: "string",
            reason: inside ? "normalize-local-plugin-path" : "relocate-local-plugin",
          });
        }
        if (manifest.api === "v1") {
          addWarning(plan, "V1_PLUGIN_API", `local plugin ${manifest.name} targets the V1 plugin API and may not load in V2.`, {
            item_id: pluginItem.id,
          });
        }

        const key = pluginKeyFromSpec(parsed);
        if (!pluginExtensions.has(key)) {
          pluginExtensions.set(key, {
            type: "plugin",
            name: manifest.name || path.basename(parsed.localPath),
            classification: "custom",
            origin: "user",
            kind: "local",
            spec: entry.spec,
            version: manifest.version,
            api: manifest.api,
            bundle_item: pluginItem.id,
            surfaces: [surface],
            defined_in: [doc.item.id],
            path: entry.pointer,
            package_name: manifest.name,
          });
        } else {
          pluginExtensions.get(key).defined_in.push(doc.item.id);
          if (!pluginExtensions.get(key).surfaces.includes(surface)) pluginExtensions.get(key).surfaces.push(surface);
        }
        continue;
      }

      if (parsed.kind === "npm" || parsed.kind === "git") {
        const key = pluginKeyFromSpec(parsed);
        if (!pluginExtensions.has(key)) {
          pluginExtensions.set(key, {
            type: "plugin",
            name: parsed.packageName || parsed.spec,
            classification: "installable",
            origin: "user",
            kind: parsed.kind,
            spec: parsed.spec,
            package_name: parsed.packageName ?? null,
            declared_version: parsed.declaredVersion ?? null,
            install_cmd: surface === "server" ? `opencode plugin add ${parsed.spec}` : null,
            install_note:
              surface === "server" ? null : "declared in cli.json; the terminal client loads it directly",
            options: entry.options,
            surfaces: [surface],
            defined_in: [doc.item.id],
            path: entry.pointer,
          });
        } else {
          const existing = pluginExtensions.get(key);
          existing.defined_in.push(doc.item.id);
          if (!existing.surfaces.includes(surface)) existing.surfaces.push(surface);
          if (surface === "server") {
            existing.install_cmd = `opencode plugin add ${parsed.spec}`;
            existing.install_note = null;
          }
        }
        continue;
      }

      addWarning(plan, "PLUGIN_ENTRY_INVALID", `unsupported plugin spec: ${entry.spec}`, {
        item_id: doc.item.id,
      });
    }

    for (const entry of configMcpEntries(doc)) {
      const analysis = analyzeMcpServer(entry.name, entry.server, { configDir, home });
      for (const warning of analysis.warnings ?? []) {
        addWarning(plan, warning.code, warning.message, { name: entry.name });
      }
      const key = entry.name;
      if (!mcpExtensions.has(key)) {
        mcpExtensions.set(key, {
          type: "mcp",
          name: entry.name,
          classification: analysis.kind === "remote" ? "remote" : analysis.kind,
          origin: "user",
          kind: analysis.type,
          enabled: analysis.enabled,
          command: analysis.command,
          install_cmd: analysis.installCmd,
          url: analysis.url,
          auth_required: analysis.authRequired,
          reason: analysis.reason,
          defined_in: [doc.item.id],
          path: entry.pointer,
          format: entry.format,
        });
      } else {
        mcpExtensions.get(key).defined_in.push(doc.item.id);
        addWarning(plan, "MCP_DUPLICATE_DEFINITION", `MCP ${entry.name} is defined in more than one config file.`, {
          name: entry.name,
        });
      }

      const nonPortableManual =
        analysis.kind === "manual" &&
        (analysis.reason === "absolute-binary" ||
          commandHasAbsolutePath(analysis.command) ||
          (analysis.cwd && !analysis.cwdRewrite && isAbsolutePath(analysis.cwd)));
      const removeServer = analysis.kind === "managed" || nonPortableManual;
      if (analysis.kind === "managed") {
        plan.rewrites.push({
          id: `mcp-delete-managed:${doc.item.id}:${entry.pointer}`,
          item_id: doc.item.id,
          pointer: entry.pointer,
          kind: "delete",
          reason: "remove-managed-mcp",
        });
        addWarning(plan, "MCP_MANAGED_SKIPPED", `MCP ${entry.name} points at an OpenCode-managed binary; it was removed from the portable config.`, {
          name: entry.name,
        });
        addManualAction(plan, {
          type: "mcp-managed",
          name: entry.name,
          reason: "OpenCode-managed MCP; let the target OpenCode configure it, or add it manually",
          command: analysis.command,
          cwd: analysis.cwd,
          environment: analysis.environment,
          environment_keys: analysis.environmentKeys,
          headers: analysis.headers,
          server_type: analysis.type,
          enabled: analysis.enabled,
          defined_in: [doc.item.id],
        });
      } else if (analysis.kind === "manual") {
        addManualAction(plan, {
          type: "mcp",
          name: entry.name,
          reason: analysis.reason ?? "manual install command unknown",
          command: analysis.command,
          cwd: analysis.cwd,
          environment: analysis.environment,
          environment_keys: analysis.environmentKeys,
          headers: analysis.headers,
          server_type: analysis.type,
          enabled: analysis.enabled,
          defined_in: [doc.item.id],
        });
        if (nonPortableManual) {
          plan.rewrites.push({
            id: `mcp-delete-nonportable:${doc.item.id}:${entry.pointer}`,
            item_id: doc.item.id,
            pointer: entry.pointer,
            kind: "delete",
            reason: "remove-nonportable-mcp",
          });
          addWarning(
            plan,
            "MCP_NONPORTABLE_REMOVED",
            `MCP ${entry.name} contains absolute paths and was removed from the portable config; use the manual action on the target.`,
            { name: entry.name },
          );
        }
      } else if (analysis.kind === "remote" && analysis.authRequired) {
        addManualAction(plan, {
          type: "mcp-auth",
          name: entry.name,
          reason: "remote MCP may require OAuth or headers",
          url: analysis.url,
          headers: analysis.headersKeys,
          defined_in: [doc.item.id],
        });
      }

      if (!removeServer && analysis.command && commandContainsSecret(analysis.command)) {
        addWarning(
          plan,
          "MCP_COMMAND_SECRET_SKIPPED",
          `MCP ${entry.name} command contains a secret-like argument; left unrewritten so the secret can be redacted and restored normally.`,
          { name: entry.name },
        );
      } else if (!removeServer && analysis.command && analysis.portableCommand && analysis.installCmd) {
        const original = analysis.command;
        const portable = analysis.portableCommand;
        if (JSON.stringify(original) !== JSON.stringify(portable)) {
          plan.rewrites.push({
            id: `mcp-command:${doc.item.id}:${entry.pointer}`,
            item_id: doc.item.id,
            pointer: `${entry.pointer}/command`,
            from: original,
            to: portable,
            kind: "value",
            reason: "normalize-command-wrapper",
          });
          addWarning(plan, "MCP_COMMAND_NORMALIZED", `MCP ${entry.name} command wrapper was normalized for portability.`, {
            name: entry.name,
          });
        }
        if (analysis.cwd && analysis.cwdRewrite && analysis.cwdRewrite !== analysis.cwd) {
          plan.rewrites.push({
            id: `mcp-cwd:${doc.item.id}:${entry.pointer}`,
            item_id: doc.item.id,
            pointer: `${entry.pointer}/cwd`,
            from: analysis.cwd,
            to: analysis.cwdRewrite,
            kind: "string",
            reason: "normalize-cwd",
          });
        }
      } else if (!removeServer && analysis.cwd && analysis.cwdRewrite && analysis.cwdRewrite !== analysis.cwd) {
        plan.rewrites.push({
          id: `mcp-cwd:${doc.item.id}:${entry.pointer}`,
          item_id: doc.item.id,
          pointer: `${entry.pointer}/cwd`,
          from: analysis.cwd,
          to: analysis.cwdRewrite,
          kind: "string",
          reason: "normalize-cwd",
        });
      }
    }

    for (const entry of configExtensionEntries(doc, "agent")) {
      if (BUILTIN_AGENTS.has(entry.name)) continue;
      addLogicalExtension(plan, {
        type: "agent",
        name: entry.name,
        classification: "custom",
        origin: "user",
        mode: null,
        defined_in: [doc.item.id],
        path: entry.pointer,
        config_format: entry.format,
      });
    }
    for (const entry of configExtensionEntries(doc, "command")) {
      addLogicalExtension(plan, {
        type: "command",
        name: entry.name,
        classification: "custom",
        origin: "user",
        defined_in: [doc.item.id],
        path: entry.pointer,
        config_format: entry.format,
      });
    }

    for (const declaration of collectSkillDeclarations(doc)) {
      const value = declaration.value;
      if (/^https?:\/\//i.test(value)) {
        addManualAction(plan, {
          type: "skill-catalog",
          name: value,
          reason: "remote skill catalog; restore downloads it on demand",
          url: value,
          defined_in: [doc.item.id],
        });
      } else if (/^(\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(value) || value.startsWith("/") || value.startsWith("file://")) {
        const resolved = parsePluginSpec(value, { baseDir: path.dirname(doc.item.source_path), home });
        if (resolved.kind === "local" && isInside(configDir, resolved.localPath)) {
          addWarning(plan, "SKILL_PATH_ALREADY_DISCOVERED", `skill path ${value} is inside the config directory and should be discovered automatically.`, {
            item_id: doc.item.id,
          });
        } else {
          addManualAction(plan, {
            type: "skill-source",
            name: value,
            reason: "external skill source; copy or install manually",
            path: value,
            defined_in: [doc.item.id],
          });
        }
      }
    }

    const cliTheme = doc.item.name === "cli.json" ? doc.root.value?.theme?.name : null;
    if (typeof cliTheme === "string" && cliTheme) {
      const existingTheme = plan.extensions.find((extension) => extension.type === "theme" && extension.name === cliTheme);
      if (existingTheme) {
        existingTheme.selected = true;
        existingTheme.defined_in = Array.isArray(existingTheme.defined_in)
          ? [...new Set([...existingTheme.defined_in, doc.item.id])]
          : [existingTheme.defined_in, doc.item.id].filter(Boolean);
      } else {
        plan.extensions.push({
          type: "theme",
          name: cliTheme,
          classification: "custom",
          origin: "user",
          defined_in: [doc.item.id],
          path: "/theme/name",
          selected: true,
        });
      }
      if (!themeNames.has(cliTheme)) {
        addWarning(plan, "THEME_MISSING", `cli.json selects theme ${cliTheme}, but no custom themes/${cliTheme}.json was found.`, {
          item_id: doc.item.id,
          name: cliTheme,
        });
      }
    }

    const instructions = doc.root.value?.instructions;
    if (Array.isArray(instructions)) {
      for (const [index, value] of instructions.entries()) {
        if (typeof value !== "string") continue;
        if (/^https?:\/\//i.test(value)) {
          addManualAction(plan, {
            type: "instruction-url",
            name: value,
            reason: "remote instruction file",
            url: value,
            defined_in: [doc.item.id],
          });
        } else {
          addManualAction(plan, {
            type: "instruction-file",
            name: value,
            reason: "instruction file outside the global config directory; copy manually if needed",
            path: value,
            pointer: `/instructions/${index}`,
            defined_in: [doc.item.id],
          });
        }
      }
    }

    const references = doc.root.value?.references;
    if (references && typeof references === "object" && !Array.isArray(references)) {
      for (const [name, value] of Object.entries(references)) {
        if (typeof value === "string") {
          addManualAction(plan, {
            type: "reference",
            name,
            reason: "reference source; clone or copy manually",
            source: value,
            defined_in: [doc.item.id],
          });
        } else if (value && typeof value === "object") {
          addManualAction(plan, {
            type: "reference",
            name,
            reason: value.repository ? "git reference; clone on restore" : "local reference; copy manually if needed",
            source: value.repository ?? value.path ?? null,
            branch: value.branch ?? null,
            defined_in: [doc.item.id],
          });
        }
      }
    }

    const providers = doc.root.value?.providers ?? doc.root.value?.provider;
    if (providers && typeof providers === "object" && !Array.isArray(providers)) {
      for (const [providerId, provider] of Object.entries(providers)) {
        const env = Array.isArray(provider?.env) ? provider.env.filter((item) => typeof item === "string") : [];
        for (const name of env) {
          if (!plan.auth.environment.includes(name)) plan.auth.environment.push(name);
        }
        if (!plan.auth.providers.some((item) => item.provider === providerId)) {
          plan.auth.providers.push({
            provider: providerId,
            method: env.length ? "environment" : "config",
            status: "unknown",
          });
        }
      }
    }

    addHomePathRewrites(plan, doc, home);
  }

  for (const extension of pluginExtensions.values()) plan.extensions.push(extension);
  for (const extension of mcpExtensions.values()) plan.extensions.push(extension);

  // Ensure file-based definitions appear as logical extensions even when they
  // are not declared in JSON.
  for (const item of plan.items) {
    if (item.type === "agent" || item.type === "command") {
      addLogicalExtension(plan, {
        type: item.type,
        name: item.name,
        classification: "custom",
        origin: "user",
        mode: null,
        defined_in: [item.id],
        path: item.target_path,
        config_format: "file",
      });
    }
    if (item.type === "plugin" && item.format === "directory") {
      if (!item.metadata?.copy_includes) {
        const manifest = await readLocalPluginManifest(item.source_path);
        item.metadata = {
          ...item.metadata,
          api: manifest.api,
          package_name: manifest.name,
          package_version: manifest.version,
          has_package_json: manifest.hasPackageJson,
          entry_files: manifest.entryFiles,
          copy_includes: pluginCopyIncludes(manifest),
        };
        if (manifest.api === "v1") {
          addWarning(plan, "V1_PLUGIN_API", `local plugin ${manifest.name} targets the V1 plugin API and may not load in V2.`, {
            item_id: item.id,
          });
        }
      }
      addLogicalExtension(plan, {
        type: "plugin",
        name: item.name,
        classification: "custom",
        origin: "user",
        kind: "local",
        defined_in: [item.id],
        bundle_item: item.id,
        path: item.target_path,
      });
    }
  }

  // Scan config and text files for secrets. The plan records only pointers and labels.
  for (const item of plan.items) {
    if (!item.bundle_path) continue;
    try {
      if (item.format === "json" || item.format === "jsonc") {
        const text = await fs.readFile(item.source_path, "utf8");
        const itemRewrites = plan.rewrites.filter((rewrite) => rewrite.item_id === item.id);
        const scanText = itemRewrites.length ? applyRewrites(text, item.source_path, itemRewrites) : text;
        const analysis = analyzeJsonc(scanText, { source: item.source_path, labelPrefix: item.target_path });
        item.redact = "jsonc";
        item.secret_refs = analysis.secretRefs;
        for (const ref of analysis.secretRefs) {
          plan.secret_refs.push({ item_id: item.id, pointer: ref.pointer, key: ref.key, kind: ref.kind, label: ref.label });
        }
      } else if (item.format === "markdown" || item.format === "text") {
        const text = await fs.readFile(item.source_path, "utf8");
        const scanText = replaceHomePath(text, home);
        if (scanText !== text) {
          item.home_rewrite = true;
          addWarning(plan, "HOME_PATH_NORMALIZED", `normalized home path in ${item.target_path}`, {
            item_id: item.id,
          });
        }
        const analysis = analyzeText(scanText, { source: item.target_path });
        item.redact = "text";
        item.secret_refs = analysis.secretRefs;
        for (const ref of analysis.secretRefs) {
          plan.secret_refs.push({ item_id: item.id, pointer: ref.pointer, key: ref.key, kind: ref.kind, label: ref.label });
        }
      } else if (item.format === "directory") {
        const { refs } = await scanTreeSecrets(item.source_path, item.target_path);
        if (refs.length) {
          item.redact = "text";
          item.secret_refs = refs;
          for (const ref of refs) {
            plan.secret_refs.push({
              item_id: item.id,
              file: ref.file,
              pointer: ref.pointer,
              key: ref.key,
              kind: ref.kind,
              label: ref.label,
            });
          }
        }
      }
    } catch (error) {
      addWarning(plan, "SECRET_SCAN_FAILED", `secret scan failed for ${item.target_path}: ${error.message}`, {
        item_id: item.id,
      });
    }
  }
  const seenSecretRefs = new Set();
  plan.secret_refs = plan.secret_refs.filter((ref) => {
    const key = `${ref.item_id}\0${ref.file ?? ""}\0${ref.pointer}\0${ref.kind}`;
    if (seenSecretRefs.has(key)) return false;
    seenSecretRefs.add(key);
    return true;
  });

  for (const extension of plan.extensions) {
    extension.defined_in = Array.isArray(extension.defined_in)
      ? extension.defined_in
      : extension.defined_in
        ? [extension.defined_in]
        : [];
  }

  if (args.opencode) {
    await enrichFromOpenCode(plan, args);
  }

  const authByProvider = new Map();
  for (const provider of plan.auth.providers) {
    const existing = authByProvider.get(provider.provider);
    if (!existing) authByProvider.set(provider.provider, { ...provider });
    else if (existing.method === "config" && provider.method !== "config") {
      authByProvider.set(provider.provider, { ...provider });
    }
  }
  plan.auth.providers = [...authByProvider.values()];
  plan.auth.environment = [...new Set(plan.auth.environment)];

  filterExcluded(plan, args.exclude);

  const totalBytes = plan.items.reduce((sum, item) => sum + (item.size ?? 0), 0);
  if (totalBytes > plan.options.max_total_bytes) {
    addWarning(plan, "TOTAL_SIZE_LIMIT", `bundle source size ${totalBytes} exceeds ${plan.options.max_total_bytes} bytes.`);
  }
  for (const item of plan.items) {
    if ((item.size ?? 0) > plan.options.max_item_bytes) {
      addWarning(plan, "ITEM_SIZE_LIMIT", `${item.id} is ${item.size} bytes and exceeds the per-item limit.`, {
        item_id: item.id,
      });
    }
  }

  if (plan.secret_refs.length) {
    addWarning(plan, "SECRETS_REDACTED", `${plan.secret_refs.length} secret reference(s) will be redacted; values are not stored in the plan.`);
  }

  await warnSymlinks(plan);
  sanitizePlanForOutput(plan, { home, configRoot: configDir });
  const hashed = withHash(plan);
  const outDir = path.resolve(args.out ?? path.join(process.cwd(), ".tmp", "opencode-plan"));
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "plan.json"), `${JSON.stringify(hashed, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "plan.md"), `${writeSummary(hashed)}\n`, "utf8");

  if (args.json) {
    process.stdout.write(`${JSON.stringify(hashed, null, 2)}\n`);
  } else {
    const counts = hashed.items.reduce((acc, item) => {
      acc[item.classification] = (acc[item.classification] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`Plan: ${path.join(outDir, "plan.json")}`);
    console.log(`Items: ${hashed.items.length} (${Object.entries(counts).map(([key, value]) => `${key}:${value}`).join(", ")})`);
    console.log(`Extensions: ${hashed.extensions.length}`);
    console.log(`Secrets: ${hashed.secret_refs.length}`);
    console.log(`Manual actions: ${hashed.manual_actions.length}`);
    console.log(`Warnings: ${hashed.warnings.length}`);
    console.log(`Plan hash: ${hashed.plan_hash}`);
  }
}

main().catch((error) => {
  console.error(`plan failed: ${error.stack || error.message}`);
  process.exit(1);
});
