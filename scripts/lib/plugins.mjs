import path from "node:path";
import { promises as fs } from "node:fs";
import {
  isAbsolutePath,
  isInside,
  isLocalPathSpec,
  normalizeSlashes,
  resolveLocalPath,
  toHomeRelative,
} from "./paths.mjs";

const PACKAGE_MANAGERS = new Set([
  "npx",
  "bunx",
  "uvx",
  "pnpm",
  "yarn",
  "docker",
  "deno",
  "pipx",
  "uv",
]);

const GIT_PREFIXES = ["github:", "gitlab:", "bitbucket:", "git+", "git@", "ssh://"];
const WRAPPER_NAMES = new Set(["cmd", "cmd.exe"]);

export function parsePluginSpec(value, options = {}) {
  const { baseDir = process.cwd(), home } = options;
  if (typeof value !== "string") {
    return { kind: "unknown", spec: String(value), reason: "not-a-string" };
  }
  const spec = value.trim();
  if (!spec) return { kind: "unknown", spec, reason: "empty" };

  if (spec.startsWith("-")) {
    return {
      kind: "directive",
      spec,
      disabled: true,
      target: spec.slice(1),
    };
  }
  if (spec === "*" || spec === ".*" || spec.endsWith(".*")) {
    return { kind: "directive", spec, wildcard: true };
  }

  if (isLocalPathSpec(spec)) {
    return {
      kind: "local",
      spec,
      localPath: resolveLocalPath(spec, baseDir, home),
    };
  }

  if (GIT_PREFIXES.some((prefix) => spec.startsWith(prefix)) || /\.git(?:#.*)?$/i.test(spec) || spec.includes("::path:")) {
    return { kind: "git", spec };
  }

  const { name, version } = splitNpmSpec(spec);
  if (!name) return { kind: "unknown", spec };
  return { kind: "npm", spec, packageName: name, declaredVersion: version };
}

export function splitNpmSpec(spec) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 0) return { name: null, version: null };
    const at = spec.indexOf("@", slash);
    if (at < 0) return { name: spec, version: null };
    return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  }
  const at = spec.indexOf("@");
  if (at <= 0) return { name: spec, version: null };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export async function readLocalPluginManifest(dir) {
  const result = {
    name: path.basename(dir),
    version: null,
    exports: null,
    files: null,
    dependencies: {},
    api: "unknown",
    hasPackageJson: false,
    entryFiles: [],
  };
  let pkg = null;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    result.hasPackageJson = true;
  } catch {
    // Conventional local plugin directory without package.json.
  }

  if (pkg) {
    if (typeof pkg.name === "string") result.name = pkg.name;
    if (typeof pkg.version === "string") result.version = pkg.version;
    if (pkg.exports) result.exports = pkg.exports;
    if (Array.isArray(pkg.files)) result.files = pkg.files.filter((item) => typeof item === "string");
    result.dependencies = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const names = Object.keys(result.dependencies);
    if (names.some((name) => name === "@opencode/plugin" || name.startsWith("@opencode/plugin/"))) {
      result.api = "v2";
    } else if (names.some((name) => name === "@opencode-ai/plugin" || name.startsWith("@opencode-ai/plugin/"))) {
      result.api = "v1";
    }
  }

  for (const file of [
    "server.ts",
    "server.tsx",
    "server.js",
    "index.ts",
    "index.tsx",
    "index.js",
    "tui.ts",
    "tui.tsx",
    "tui.js",
    "rpc.ts",
    "rpc.js",
    "gui-experimental.cjs",
    "gui-experimental.js",
    "package.json",
  ]) {
    try {
      await fs.access(path.join(dir, file));
      result.entryFiles.push(file);
    } catch {
      // ignore
    }
  }
  return result;
}

export function parseCommandArray(value) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function unwrapCommand(command) {
  if (!command || command.length < 2) return { command, wrapper: null, safe: true };
  const program = command[0].toLowerCase().replace(/\.exe$/i, "");
  if (WRAPPER_NAMES.has(program)) {
    const flagIndex = command.findIndex((item, index) => index > 0 && /^\/c$/i.test(item));
    if (flagIndex > 0 && command.length > flagIndex + 1) {
      return {
        command: command.slice(flagIndex + 1),
        wrapper: "cmd",
        original: command,
        safe: true,
      };
    }
    return { command, wrapper: "cmd", original: command, safe: false };
  }
  if (["powershell", "pwsh"].includes(program)) {
    return { command, wrapper: "powershell", original: command, safe: false };
  }
  if (["sh", "bash", "zsh", "fish"].includes(program)) {
    const flagIndex = command.findIndex((item, index) => index > 0 && /^-c$/i.test(item));
    if (flagIndex > 0 && command.length === flagIndex + 2 && !/[;&|`$(){}]/.test(command[flagIndex + 1])) {
      const inner = command[flagIndex + 1].trim().split(/\s+/);
      if (inner.length) {
        return { command: inner, wrapper: "shell", original: command, safe: true };
      }
    }
    return { command, wrapper: "shell", original: command, safe: false };
  }
  return { command, wrapper: null, safe: true };
}

export function analyzeMcpServer(name, server, options = {}) {
  const { configDir = "", home = "" } = options;
  const result = {
    name,
    kind: "manual",
    reason: null,
    type: "local",
    enabled: !server?.disabled && server?.enabled !== false,
    command: null,
    portableCommand: null,
    installCmd: null,
    wrapper: null,
    cwd: server?.cwd ?? null,
    cwdRewrite: null,
    environment: server?.environment ?? null,
    environmentKeys: Object.keys(server?.environment ?? {}),
    headers: server?.headers ?? null,
    url: server?.url ?? null,
    authRequired: false,
    warnings: [],
  };

  if (!server || typeof server !== "object") {
    result.reason = "invalid-server-object";
    return result;
  }

  if (server.type === "remote" || (!server.command && typeof server.url === "string")) {
    result.type = "remote";
    result.kind = "remote";
    result.authRequired = server.oauth !== false || Boolean(server.headers && Object.keys(server.headers).length);
    result.headersKeys = Object.keys(server.headers ?? {});
    result.headers = server.headers ?? null;
    return result;
  }

  const command = parseCommandArray(server.command);
  if (!command) {
    result.reason = "invalid-command";
    return result;
  }
  result.command = command;
  result.installCmd = command.join(" ");

  if (result.cwd) {
    if (home && isInside(home, result.cwd)) {
      result.cwdRewrite = toHomeRelative(result.cwd, home);
    } else {
      result.warnings.push({
        code: "MCP_CWD_NOT_PORTABLE",
        message: `cwd is outside the home directory; remove it or provide it manually: ${result.cwd}`,
      });
    }
  }

  const unwrapped = unwrapCommand(command);
  result.wrapper = unwrapped.wrapper;
  result.portableCommand = unwrapped.command;
  if (unwrapped.wrapper && unwrapped.safe) {
    result.installCmd = unwrapped.command.join(" ");
  }
  const program = unwrapped.command[0] ?? "";
  const programBase = path.basename(normalizeSlashes(program)).toLowerCase().replace(/\.exe$/i, "");

  if (isAbsolutePath(program)) {
    if (PACKAGE_MANAGERS.has(programBase)) {
      result.kind = "installable";
      result.portableCommand = [programBase, ...unwrapped.command.slice(1)];
      result.installCmd = result.portableCommand.join(" ");
      result.reason = `absolute-package-manager:${programBase}`;
      return result;
    }
    const normalized = normalizeSlashes(program).toLowerCase();
    if (
      normalized.includes("/@opencode/") ||
      normalized.includes("/@opencode-ai/") ||
      normalized.includes("/.cache/opencode/") ||
      normalized.includes("/appdata/local/opencode/") ||
      normalized.includes("/.local/share/opencode/")
    ) {
      result.kind = "managed";
      result.reason = "opencode-managed-binary";
      return result;
    }
    result.kind = "manual";
    result.reason = "absolute-binary";
    return result;
  }

  if (PACKAGE_MANAGERS.has(programBase)) {
    result.kind = "installable";
    result.reason = `package-manager:${programBase}`;
    return result;
  }

  result.kind = "manual";
  result.reason = "bare-binary";
  return result;
}

export function pluginKeyFromSpec(parsed) {
  if (parsed.kind === "npm") return `npm:${parsed.packageName}`;
  if (parsed.kind === "git") return `git:${parsed.spec}`;
  if (parsed.kind === "local") return `local:${normalizeSlashes(parsed.localPath)}`;
  return `${parsed.kind}:${parsed.spec}`;
}

export function pluginOptionsSecretPaths(options, basePointer) {
  const pointers = [];
  const walk = (value, pointer) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (typeof child === "string") {
        pointers.push({ pointer: childPointer, key });
      } else if (child && typeof child === "object") {
        walk(child, childPointer);
      }
    }
  };
  walk(options, basePointer);
  return pointers;
}
