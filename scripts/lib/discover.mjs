import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import {
  dirSize,
  hashDirectory,
  isNoiseName,
  isTextFile,
  listFilesRecursive,
  normalizeSlashes,
  pathExists,
  relativeInside,
  sha256File,
  statOrNull,
} from "./paths.mjs";

const KNOWN_DIRS = new Set([
  "agent",
  "agents",
  "mode",
  "modes",
  "command",
  "commands",
  "skill",
  "skills",
  "plugins",
  "themes",
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".cache",
  "log",
  "logs",
  "storage",
  "snapshot",
  "snapshots",
  "repos",
  "shell",
  "tool-output",
  "bin",
]);

const ROOT_CONFIG_EXCLUDES = new Set([
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "service.json",
  "auth.json",
  ".gitignore",
  ".DS_Store",
  "Thumbs.db",
]);

const ROOT_CONFIG_EXTENSIONS = /\.(json|jsonc|md|mdx)$/i;

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function makeItem(partial) {
  return {
    id: partial.id,
    type: partial.type,
    name: partial.name,
    classification: partial.classification,
    origin: partial.origin ?? "user",
    source_path: partial.source_path,
    target_path: partial.target_path,
    bundle_path: partial.bundle_path,
    format: partial.format,
    enabled: partial.enabled ?? true,
    source_kind: partial.source_kind,
    size: partial.size ?? 0,
    source_hash: partial.source_hash ?? null,
    defined_in: partial.defined_in ?? null,
    provided_by: partial.provided_by ?? null,
    warnings: partial.warnings ?? [],
    metadata: partial.metadata ?? {},
  };
}

async function hashAndSize(sourcePath, sourceKind) {
  if (sourceKind === "file") {
    const stat = await statOrNull(sourcePath);
    if (!stat || !stat.isFile()) return { size: 0, source_hash: null };
    return { size: stat.size, source_hash: await sha256File(sourcePath) };
  }
  const stat = await statOrNull(sourcePath);
  if (!stat || !stat.isDirectory()) return { size: 0, source_hash: null };
  return {
    size: await dirSize(sourcePath, { exclude: (name) => name === "node_modules" || name === ".git" }),
    source_hash: await hashDirectory(sourcePath, {
      exclude: (name) => name === "node_modules" || name === ".git",
    }),
  };
}

export async function discoverRootConfigFiles(configDir) {
  const entries = await readdirSafe(configDir);
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (ROOT_CONFIG_EXCLUDES.has(name)) continue;
    if (isNoiseName(name)) continue;
    if (!ROOT_CONFIG_EXTENSIONS.test(name)) continue;
    const sourcePath = path.join(configDir, name);
    const { size, source_hash } = await hashAndSize(sourcePath, "file");
    const format = /\.jsonc$/i.test(name) ? "jsonc" : /\.json$/i.test(name) ? "json" : "markdown";
    items.push(
      makeItem({
        id: `config:${normalizeSlashes(name)}`,
        type: "config",
        name,
        classification: "config",
        source_path: sourcePath,
        target_path: normalizeSlashes(name),
        bundle_path: `files/${normalizeSlashes(name)}`,
        format,
        source_kind: "file",
        size,
        source_hash,
      }),
    );
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function discoverMarkdownTree(configDir, dirName, type) {
  const sourceDir = path.join(configDir, dirName);
  const stat = await statOrNull(sourceDir);
  if (!stat || !stat.isDirectory()) return [];
  const files = await listFilesRecursive(sourceDir, {
    exclude: (name) => isNoiseName(name),
  });
  const items = [];
  for (const file of files) {
    if (file.kind !== "file" || !/\.md$/i.test(file.absolute)) continue;
    const target = normalizeSlashes(path.join(dirName, file.relative));
    const { size, source_hash } = await hashAndSize(file.absolute, "file");
    items.push(
      makeItem({
        id: `${type}:${target}`,
        type,
        name: path.basename(file.absolute, ".md"),
        classification: "custom",
        source_path: file.absolute,
        target_path: target,
        bundle_path: `files/${target}`,
        format: "markdown",
        source_kind: "file",
        size,
        source_hash,
      }),
    );
  }
  return items;
}

export async function discoverAgents(configDir) {
  const results = [];
  for (const dir of ["agents", "agent", "mode", "modes"]) {
    results.push(...(await discoverMarkdownTree(configDir, dir, "agent")));
  }
  return results;
}

export async function discoverCommands(configDir) {
  const results = [];
  for (const dir of ["commands", "command"]) {
    results.push(...(await discoverMarkdownTree(configDir, dir, "command")));
  }
  return results;
}

function collectSkillExtensions(rootDir, sourceDir) {
  const extensions = [];
  const visit = async (dir, relative = "") => {
    const entries = await readdirSafe(dir);
    const hasSkill = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (hasSkill) {
      const id = path.basename(dir);
      extensions.push({
        type: "skill",
        name: id,
        classification: "custom",
        defined_in: `skill-root:${normalizeSlashes(relativeInside(rootDir, dir)) || "."}`,
        path: normalizeSlashes(relativeInside(sourceDir, dir)),
        origin: "user",
      });
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, path.join(relative, entry.name));
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        extensions.push({
          type: "skill",
          name: path.basename(entry.name, ".md"),
          classification: "custom",
          defined_in: `skill-root:${normalizeSlashes(relativeInside(rootDir, dir)) || "."}`,
          path: normalizeSlashes(relativeInside(sourceDir, absolute)),
          origin: "user",
        });
      }
    }
  };
  return visit(sourceDir).then(() => extensions);
}

export async function discoverSkills(configDir) {
  const items = [];
  const extensions = [];
  for (const dir of ["skills", "skill"]) {
    const sourceDir = path.join(configDir, dir);
    const stat = await statOrNull(sourceDir);
    if (!stat || !stat.isDirectory()) continue;
    const collected = await collectSkillExtensions(configDir, sourceDir);
    if (!collected.length) continue;
    const { size, source_hash } = await hashAndSize(sourceDir, "dir");
    const target = normalizeSlashes(dir);
    items.push(
      makeItem({
        id: `skills-root:${target}`,
        type: "skills-root",
        name: dir,
        classification: "custom",
        source_path: sourceDir,
        target_path: target,
        bundle_path: `files/${target}`,
        format: "directory",
        source_kind: "dir",
        size,
        source_hash,
      }),
    );
    extensions.push(...collected);
  }
  return { items, extensions };
}

export async function discoverThemes(configDir) {
  const sourceDir = path.join(configDir, "themes");
  const stat = await statOrNull(sourceDir);
  if (!stat || !stat.isDirectory()) return { items: [], extensions: [] };
  const files = await listFilesRecursive(sourceDir, {
    exclude: (name) => isNoiseName(name),
  });
  const items = [];
  const extensions = [];
  for (const file of files) {
    if (file.kind !== "file" || !/\.json$/i.test(file.absolute)) continue;
    const target = normalizeSlashes(path.join("themes", file.relative));
    const { size, source_hash } = await hashAndSize(file.absolute, "file");
    const name = path.basename(file.absolute, ".json");
    items.push(
      makeItem({
        id: `theme:${target}`,
        type: "theme",
        name,
        classification: "custom",
        source_path: file.absolute,
        target_path: target,
        bundle_path: `files/${target}`,
        format: "json",
        source_kind: "file",
        size,
        source_hash,
      }),
    );
    extensions.push({
      type: "theme",
      name,
      classification: "custom",
      defined_in: `theme:${target}`,
      origin: "user",
    });
  }
  return { items, extensions };
}

export async function discoverPluginsDir(configDir) {
  const sourceDir = path.join(configDir, "plugins");
  const stat = await statOrNull(sourceDir);
  if (!stat || !stat.isDirectory()) return [];
  const entries = await readdirSafe(sourceDir);
  const items = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      const { size, source_hash } = await hashAndSize(absolute, "dir");
      const target = normalizeSlashes(path.join("plugins", entry.name));
      items.push(
        makeItem({
          id: `plugin-dir:${target}`,
          type: "plugin",
          name: entry.name,
          classification: "custom",
          source_path: absolute,
          target_path: target,
          bundle_path: `files/${target}`,
          format: "directory",
          source_kind: "dir",
          size,
          source_hash,
        }),
      );
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/i.test(entry.name)) {
      const { size, source_hash } = await hashAndSize(absolute, "file");
      const target = normalizeSlashes(path.join("plugins", entry.name));
      items.push(
        makeItem({
          id: `plugin-file:${target}`,
          type: "plugin",
          name: entry.name,
          classification: "custom",
          source_path: absolute,
          target_path: target,
          bundle_path: `files/${target}`,
          format: "text",
          source_kind: "file",
          size,
          source_hash,
        }),
      );
    }
  }
  return items;
}

async function isTextOnlyTree(dir) {
  const files = await listFilesRecursive(dir, {
    exclude: (name) => isNoiseName(name),
  });
  if (!files.length) return { ok: false, reason: "empty" };
  for (const file of files) {
    if (file.kind !== "file") continue;
    if (!isTextFile(file.absolute)) return { ok: false, reason: `non-text:${file.relative}` };
    const stat = await fs.stat(file.absolute);
    if (stat.size > 2 * 1024 * 1024) return { ok: false, reason: `large:${file.relative}` };
  }
  return { ok: true };
}

export async function discoverPluginData(configDir) {
  const entries = await readdirSafe(configDir);
  const items = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith(".") || KNOWN_DIRS.has(name) || /\.write-lock$/i.test(name)) continue;
    const absolute = path.join(configDir, name);
    const textOnly = await isTextOnlyTree(absolute);
    if (!textOnly.ok) {
      if (textOnly.reason !== "empty") {
        warnings.push({
          code: "PLUGIN_DATA_SKIPPED",
          message: `skipped possible plugin data directory ${name}: ${textOnly.reason}`,
        });
      }
      continue;
    }
    const { size, source_hash } = await hashAndSize(absolute, "dir");
    if (size > 5 * 1024 * 1024) {
      warnings.push({
        code: "PLUGIN_DATA_TOO_LARGE",
        message: `skipped possible plugin data directory ${name}: ${size} bytes`,
      });
      continue;
    }
    const target = normalizeSlashes(name);
    items.push(
      makeItem({
        id: `plugin-data:${target}`,
        type: "plugin-data",
        name,
        classification: "custom",
        origin: "plugin",
        source_path: absolute,
        target_path: target,
        bundle_path: `files/${target}`,
        format: "directory",
        source_kind: "dir",
        size,
        source_hash,
      }),
    );
  }
  return { items, warnings };
}

export async function discoverSharedSkills(home, options = {}) {
  const { includeClaudeSkills = false } = options;
  const items = [];
  const extensions = [];
  const warnings = [];

  const agentsSkills = path.join(home, ".agents", "skills");
  if (await pathExists(agentsSkills)) {
    const { size, source_hash } = await hashAndSize(agentsSkills, "dir");
    items.push(
      makeItem({
        id: "shared-skills:agents",
        type: "skills-root",
        name: "~/.agents/skills",
        classification: "custom",
        origin: "shared",
        source_path: agentsSkills,
        target_path: "~/.agents/skills",
        bundle_path: "files/_shared/agents-skills",
        format: "directory",
        source_kind: "dir",
        size,
        source_hash,
      }),
    );
    extensions.push(...(await collectSkillExtensions(home, agentsSkills)));
  }

  const lockfile = path.join(home, ".agents", ".skill-lock.json");
  if (await pathExists(lockfile)) {
    const { size, source_hash } = await hashAndSize(lockfile, "file");
    items.push(
      makeItem({
        id: "skill-metadata:agents-lockfile",
        type: "skill-metadata",
        name: ".skill-lock.json",
        classification: "config",
        origin: "shared",
        source_path: lockfile,
        target_path: "~/.agents/.skill-lock.json",
        bundle_path: "files/_shared/.skill-lock.json",
        format: "json",
        source_kind: "file",
        size,
        source_hash,
      }),
    );
  }

  if (includeClaudeSkills) {
    const claudeSkills = path.join(home, ".claude", "skills");
    if (await pathExists(claudeSkills)) {
      const { size, source_hash } = await hashAndSize(claudeSkills, "dir");
      items.push(
        makeItem({
          id: "shared-skills:claude",
          type: "skills-root",
          name: "~/.claude/skills",
          classification: "custom",
          origin: "shared",
          source_path: claudeSkills,
          target_path: "~/.claude/skills",
          bundle_path: "files/_shared/claude-skills",
          format: "directory",
          source_kind: "dir",
          size,
          source_hash,
        }),
      );
      extensions.push(...(await collectSkillExtensions(home, claudeSkills)));
      warnings.push({
        code: "SHARED_CLAUDE_SKILLS",
        message: "~/.claude/skills is shared with Claude Code and other agents.",
      });
    }
  }

  return { items, extensions, warnings };
}

export async function discoverAll(configDir, home = os.homedir(), options = {}) {
  const rootConfigs = await discoverRootConfigFiles(configDir);
  const agents = await discoverAgents(configDir);
  const commands = await discoverCommands(configDir);
  const skills = await discoverSkills(configDir);
  const themes = await discoverThemes(configDir);
  const plugins = await discoverPluginsDir(configDir);
  const pluginData = await discoverPluginData(configDir);
  const shared = await discoverSharedSkills(home, options);
  return {
    items: [
      ...rootConfigs,
      ...agents,
      ...commands,
      ...skills.items,
      ...themes.items,
      ...plugins,
      ...pluginData.items,
      ...shared.items,
    ],
    extensions: [...skills.extensions, ...themes.extensions, ...shared.extensions],
    warnings: [...pluginData.warnings, ...shared.warnings],
  };
}
