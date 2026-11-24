import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const CREDENTIAL_NAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
]);

export const NOISE_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".DS_Store",
  "Thumbs.db",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  ".gitignore",
  ...CREDENTIAL_NAMES,
]);

export const NOISE_FILE_PATTERNS = [
  /\.bak(?:[.-].*)?$/i,
  /\.write-lock$/i,
  /\.log$/i,
  /\.db(?:-shm|-wal)?$/i,
  /\.sqlite(?:-shm|-wal)?$/i,
  /^\.opencode\.jsonc\.write-lock$/i,
  /^\.tui\.json\.write-lock$/i,
];

export function normalizeSlashes(value) {
  return String(value).replace(/\\/g, "/");
}

export function isWindowsAbsolute(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\/.test(value) || /^\\\\\?\\/.test(value);
}

export function isPosixAbsolute(value) {
  return value.startsWith("/") && !value.startsWith("//");
}

export function isAbsolutePath(value) {
  return isWindowsAbsolute(value) || isPosixAbsolute(value);
}

export function isLocalPathSpec(value) {
  if (typeof value !== "string") return false;
  if (!value) return false;
  if (value.startsWith("file://")) return true;
  if (value.startsWith("./") || value.startsWith("../") || value === "." || value === "..") return true;
  if (value.startsWith("~/") || value === "~") return true;
  return isAbsolutePath(value);
}

export function resolveLocalPath(spec, baseDir, home = os.homedir()) {
  let raw = spec;
  if (raw.startsWith("file://")) {
    raw = decodeURIComponent(raw.slice("file://".length));
  }
  if (raw === "~" || raw.startsWith("~/")) {
    raw = path.join(home, raw.slice(1));
  }
  if (isAbsolutePath(raw)) return path.normalize(raw);
  return path.resolve(baseDir, raw);
}

export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function relativeInside(parent, child) {
  return path.relative(path.resolve(parent), path.resolve(child));
}

export function toPortableRelative(absPath, baseDir) {
  const relative = normalizeSlashes(path.relative(baseDir, absPath));
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("../") || relative === ".." || isAbsolutePath(relative)) return null;
  return `./${relative}`;
}

export function toHomeRelative(absPath, home = os.homedir()) {
  if (!isInside(home, absPath)) return null;
  const relative = normalizeSlashes(path.relative(home, absPath));
  return relative ? `~/${relative}` : "~";
}

export function slugify(value, fallback = "item") {
  const base = normalizeSlashes(String(value))
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || fallback;
}

export function isNoiseName(name) {
  return NOISE_NAMES.has(name) || NOISE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isCredentialFile(name) {
  return CREDENTIAL_NAMES.has(path.basename(String(name)));
}

export function isTextFile(name) {
  return /\.(json|jsonc|md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|css|yaml|yml|toml|sh|ps1|py|go|rs|java|kt|swift|pem|key)$/i.test(name) ||
    /(^|[\\/])id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(name);
}

export function isKeyFile(name) {
  return /(^|[\\/])(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]+\.(?:pem|key))$/i.test(name);
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

export async function readJsonFile(target) {
  const text = await fs.readFile(target, "utf8");
  return JSON.parse(text);
}

export async function readTextFile(target) {
  return fs.readFile(target, "utf8");
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function sha256File(target) {
  const hash = createHash("sha256");
  const handle = await fs.open(target, "r");
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

export async function listFilesRecursive(root, options = {}) {
  const {
    exclude = (name) => isNoiseName(name),
    followSymlinks = false,
    limit = 100000,
  } = options;
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
      if (entry.isSymbolicLink() && !followSymlinks) {
        results.push({ absolute, relative: path.relative(root, absolute), kind: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        results.push({ absolute, relative: path.relative(root, absolute), kind: "file" });
        if (results.length > limit) throw new Error(`too many files under ${root}`);
      }
    }
  }
  results.sort((a, b) => a.relative.localeCompare(b.relative));
  return results;
}

export async function dirSize(root, options = {}) {
  const files = await listFilesRecursive(root, options);
  let total = 0;
  for (const file of files) {
    if (file.kind !== "file") continue;
    const stat = await fs.stat(file.absolute);
    total += stat.size;
  }
  return total;
}

export async function hashDirectory(root, options = {}) {
  const files = await listFilesRecursive(root, options);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(normalizeSlashes(file.relative));
    hash.update("\0");
    if (file.kind === "file") {
      hash.update(await fs.readFile(file.absolute));
    } else {
      hash.update(`symlink:${await fs.readlink(file.absolute).catch(() => "")}`);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function assertSafeRelativeTarget(target) {
  const normalized = normalizeSlashes(target);
  if (normalized.startsWith("/") || isWindowsAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`unsafe target path: ${target}`);
  }
  return normalized;
}

export function defaultConfigDir(env = process.env, home = os.homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(home, ".config", "opencode");
}
