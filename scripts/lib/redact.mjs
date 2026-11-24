import { collectStringNodes, findNode, parseJsonc, pointerJoin } from "./jsonc.mjs";

const NON_SECRET_KEYS = new Set([
  "$schema",
  "name",
  "description",
  "title",
  "id",
  "type",
  "version",
  "mode",
  "model",
  "modelID",
  "providerID",
  "agent",
  "theme",
  "source",
  "repository",
  "branch",
  "package",
  "command",
  "cwd",
  "path",
  "url",
  "uri",
  "endpoint",
  "host",
  "protocol",
  "format",
  "language",
  "locale",
  "preset",
  "variant",
  "reason",
  "message",
  "label",
  "template",
  "prompt",
  "system",
  "instructions",
  "skills",
  "plugins",
  "mcp",
  "agents",
  "commands",
  "providers",
  "references",
  "permissions",
  "policies",
  "sha256",
  "hash",
  "plan_hash",
  "from_sha256",
  "checksums",
  "pointer",
  "label",
  "kind",
  "item_id",
  "file",
]);

const STRONG_SECRET_WORDS = new Set([
  "secret",
  "password",
  "passwd",
  "pass",
  "passphrase",
  "credential",
  "authorization",
  "cookie",
  "pat",
]);

const WEAK_SECRET_WORDS = new Set([
  "key",
  "token",
]);

const FLAT_SECRET_KEYS = new Set([
  "apikey",
  "accesskey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "authkey",
  "session",
  "sessionid",
  "sessionkey",
  "sessiontoken",
  "clientsecret",
  "secretkey",
  "secretaccesskey",
  "privatekey",
  "password",
  "passwd",
  "pass",
  "passphrase",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "cookies",
  "token",
  "secret",
]);

const NON_SECRET_WORDS = new Set([
  "count",
  "limit",
  "max",
  "min",
  "num",
  "total",
  "size",
  "budget",
  "type",
  "name",
  "length",
  "ttl",
  "expires",
  "expiry",
  "endpoint",
  "url",
  "uri",
  "path",
  "file",
  "dir",
  "directory",
  "header",
  "headers",
  "prefix",
  "suffix",
  "field",
  "public",
  "algorithm",
  "mode",
  "keyname",
  "fingerprint",
  "hash",
  "id",
]);

const URL_LIKE_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//i;
const REFERENCE_RE = /^\{(env|file):[^}]+\}$/;
const EMBEDDED_REFERENCE_RE = /\{(env|file):[^}]+\}/;
const TOKEN_SHAPE_RE = /^[A-Za-z0-9+/=_-]{32,}$/;
const SECRET_PREFIX_RE =
  /^(sk-|sk_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|-----BEGIN |Bearer\s+|Basic\s+)/;
const ENV_REFERENCE_START_RE = /^(process\.env\.|import\.meta\.env\.|os\.environ|System\.getenv)/;

function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => {
      const lower = word.toLowerCase().replace(/\d+$/, "");
      if (lower.length > 3 && lower.endsWith("s") && !/(ss|us|is)$/.test(lower)) return lower.slice(0, -1);
      return lower;
    })
    .filter(Boolean);
}

export function isReferenceValue(value) {
  return typeof value === "string" && REFERENCE_RE.test(value);
}

export function containsReference(value) {
  return typeof value === "string" && EMBEDDED_REFERENCE_RE.test(value);
}

export function isSecretKey(key, options = {}) {
  if (!key || NON_SECRET_KEYS.has(key)) return false;
  const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "").replace(/\d+$/, "");
  if (FLAT_SECRET_KEYS.has(normalizedKey)) return true;
  if (/\d+$/.test(String(key)) && ["key", "token"].includes(normalizedKey)) return true;

  const words = keyWords(key);
  if (!words.length) return false;
  if (words.includes("public")) return false;

  const head = words[words.length - 1];
  if (NON_SECRET_WORDS.has(head)) return false;
  if (STRONG_SECRET_WORDS.has(head)) return true;
  if (words.some((word) => STRONG_SECRET_WORDS.has(word))) return true;

  if (words.includes("private") && words.includes("key")) return true;

  if (words.some((word) => WEAK_SECRET_WORDS.has(word))) {
    const qualifiers = words.filter((word) => !WEAK_SECRET_WORDS.has(word));
    if (!qualifiers.length) return options.allowBare === true;
    return !qualifiers.every((word) => NON_SECRET_WORDS.has(word));
  }

  return false;
}

export function isSecretHeaderName(name) {
  if (typeof name !== "string" || !name) return false;
  if (/^(authorization|cookie|set-cookie|proxy-authorization|session|session[-_]?id|token|key|secret|credential|password)$/i.test(name)) {
    return true;
  }
  if (!/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(name)) return false;
  return /(?:^|[-_])(?:auth|authorization|api[-_]?key|key|token|secret|session|session[-_]?id|credential|password)$/i.test(name);
}

export function isRedactedValue(value) {
  if (typeof value !== "string") return false;
  if (value === "<REDACTED>" || value.startsWith("<REDACTED:")) return true;
  const equals = value.indexOf("=");
  if (equals === -1) return false;
  const assigned = value.slice(equals + 1);
  return assigned === "<REDACTED>" || assigned.startsWith("<REDACTED:");
}

function isPlaceholderValue(value) {
  if (isRedactedValue(value)) return true;
  const colon = value.indexOf(":");
  if (colon === -1) return false;
  return isRedactedValue(value.slice(colon + 1).trim());
}

export function looksLikeSecretValue(value, key = "") {
  if (typeof value !== "string" || !value) return false;
  if (isRedactedValue(value)) return false;
  if (isReferenceValue(value)) return false;
  if (ENV_REFERENCE_START_RE.test(value)) return false;
  if (NON_SECRET_KEYS.has(key)) return false;
  if (isSecretKey(key)) return true;
  if (SECRET_PREFIX_RE.test(value)) return true;
  if (value.length >= 32 && TOKEN_SHAPE_RE.test(value)) {
    if (!/[A-Z]/.test(value) && value.includes("-")) return false;
    return true;
  }
  return false;
}

export function urlHasSecret(value) {
  if (typeof value !== "string" || !URL_LIKE_RE.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.password) return true;
    if (url.username && !["git", "ssh"].includes(url.username.toLowerCase()) && looksLikeSecretValue(url.username, "")) {
      return true;
    }
    for (const [key, parameter] of url.searchParams) {
      if (isSecretKey(key, { allowBare: true }) || looksLikeSecretValue(parameter, key)) return true;
    }
    return false;
  } catch {
    return /\/\/[^/\s]*:[^/\s]*@/.test(value) || /[?&][^=]*(key|token|secret|password)[^=]*=/i.test(value);
  }
}

export function sanitizeUrlForDisplay(value) {
  if (typeof value !== "string" || !urlHasSecret(value)) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const [key, parameter] of url.searchParams) {
      if (isSecretKey(key, { allowBare: true }) || looksLikeSecretValue(parameter, key)) {
        url.searchParams.set(key, "<REDACTED>");
      }
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/\s]*:[^/\s]*@/, "//<REDACTED>@");
  }
}

function parentKeyFor(pointer) {
  const parts = pointer.split("/").slice(1);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

function commandArgShouldRedact(root, pointer, value) {
  const match = /\/command\/(\d+)$/.exec(pointer);
  if (!match) return false;
  if (typeof value !== "string" || isPlaceholderValue(value)) return false;
  if (isReferenceValue(value)) return false;
  const index = Number(match[1]);
  const arrayPointer = pointer.slice(0, -`/${match[1]}`.length);
  const array = findNode(root, arrayPointer);
  const previous = array?.children?.[index - 1]?.value;
  if (typeof previous === "string" && /^--?[^=]+$/.test(previous)) {
    const flag = previous.replace(/^--?/, "");
    if (isSecretKey(flag, { allowBare: true })) return true;
  }
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(value);
  if (assignment && isSecretKey(assignment[1], { allowBare: true })) return true;
  const equals = /^--?([^=]+)=(.+)$/.exec(value);
  if (equals && isSecretKey(equals[1], { allowBare: true })) return true;
  if (/^Authorization\s*:\s*(Bearer|Basic)\s+/i.test(value)) return true;
  const header = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(\S.*)$/.exec(value);
  if (header && isSecretHeaderName(header[1])) return true;
  return urlHasSecret(value);
}

function shouldRedact(value, key, pointer) {
  if (typeof value !== "string" || !value) return false;
  if (isRedactedValue(value)) return false;
  if (isReferenceValue(value)) return false;
  if (URL_LIKE_RE.test(value)) return urlHasSecret(value);

  const parentKey = parentKeyFor(pointer);
  const envContext = parentKey === "environment" || parentKey === "env";
  const headerContext = parentKey === "headers";
  if (parentKey === "checksums" || parentKey === "secret_refs" || pointer.includes("/secret_refs/") || /(sha256|hash)$/i.test(key)) return false;

  if (headerContext) {
    if (isSecretHeaderName(key)) return true;
    if (value.startsWith("Bearer ") || value.startsWith("Basic ")) return true;
    return isSecretKey(key, { allowBare: true });
  }

  if (envContext) {
    if (isSecretKey(key, { allowBare: true })) return true;
    if (value.startsWith("Bearer ") || value.startsWith("Basic ")) return true;
    if (SECRET_PREFIX_RE.test(value)) return true;
    return false;
  }

  if (isSecretKey(key)) return true;
  if (SECRET_PREFIX_RE.test(value)) return true;
  if (NON_SECRET_KEYS.has(key)) return false;
  if (value.length >= 32 && TOKEN_SHAPE_RE.test(value)) {
    if (!/[A-Z]/.test(value) && value.includes("-")) return false;
    return true;
  }
  return false;
}

export function analyzeJsonc(text, options = {}) {
  const { source = "<jsonc>", labelPrefix = "" } = options;
  const root = parseJsonc(text, source);
  const edits = [];
  const secretRefs = [];
  const labelFor = (pointer, key) => {
    const pointerLabel = pointer || `/${key || "value"}`;
    return labelPrefix ? `${labelPrefix}#${pointerLabel}` : pointerLabel;
  };

  for (const node of collectStringNodes(root)) {
    const pointer = node.pointer || "";
    const key = node.key ?? pointer.split("/").filter(Boolean).at(-1) ?? "";
    const label = labelFor(pointer, key);
    if (containsReference(node.value)) {
      secretRefs.push({
        pointer,
        key,
        kind: isReferenceValue(node.value)
          ? node.value.startsWith("{file:")
            ? "file-reference"
            : "env-reference"
          : "embedded-reference",
        label,
      });
      continue;
    }
    if (!shouldRedact(node.value, key, pointer) && !commandArgShouldRedact(root, pointer, node.value)) continue;
    secretRefs.push({ pointer, key, kind: "value", label });
    edits.push({
      start: node.start,
      end: node.end,
      text: JSON.stringify(`<REDACTED:${label}>`),
      pointer,
      kind: "redact",
    });
  }

  return { root, edits, secretRefs };
}

function dedupeEdits(edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const result = [];
  for (const edit of sorted) {
    if (result.some((existing) => edit.start < existing.end && edit.end > existing.start)) continue;
    result.push(edit);
  }
  return result;
}

export function analyzeText(text, options = {}) {
  const { source = "<text>" } = options;
  const edits = [];
  const secretRefs = [];
  const patterns = [
    {
      re: /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|passwd|password|token|secret|authorization)\s*[:=]\s*)(["']?)([A-Za-z0-9_./+=:@-]{16,})\2/gi,
      valueGroup: 3,
      keyGroup: 1,
    },
    {
      re: /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|passwd|password|token|secret)\s*[:=]\s*)(["'])([^"'\r\n]{8,})\2/gi,
      valueGroup: 3,
      keyGroup: 1,
    },
    {
      re: /\b((?:cookie|(?:session|auth)[-_]?cookie)\s*=\s*)(["']?)([A-Za-z0-9_./+=:@-]{8,})\2/gi,
      valueGroup: 3,
      keyGroup: 1,
    },
    {
      re: /\b(Authorization\s*:\s*(?:Bearer|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
      valueGroup: 2,
      keyGroup: 1,
    },
    {
      re: /\b((?:Set-)?Cookie\s*:\s*)([^\r\n=]*=[^\r\n]+)/gi,
      valueGroup: 2,
      keyGroup: 1,
    },
    {
      re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
      valueGroup: 0,
      keyGroup: 0,
    },
    {
      re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi,
      valueGroup: 2,
      keyGroup: 1,
    },
    {
      re: /\b([a-z][a-z0-9+.-]*:\/\/):([^\s@/]+)@/gi,
      valueGroup: 2,
      keyGroup: 1,
    },
    {
      re: /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g,
      valueGroup: 1,
      keyGroup: 0,
    },
    {
      re: /\bAuthorization\s*:\s*Basic\s+([A-Za-z0-9+/=]{16,})/gi,
      valueGroup: 1,
      keyGroup: 0,
    },
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.re)) {
      const value = match[pattern.valueGroup];
      if (!value || value.startsWith("<REDACTED:")) continue;
      if (ENV_REFERENCE_START_RE.test(value)) continue;
      const offset = (match.index ?? 0) + match[0].indexOf(value);
      if (text[offset + value.length] === "(") continue;
      if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) continue;
      const before = text.slice(0, offset);
      const line = before.split("\n").length;
      const lineStart = before.lastIndexOf("\n") + 1;
      const column = offset - lineStart + 1;
      const label = `${source}:${line}:${column}`;
      secretRefs.push({
        pointer: `line:${line}:${column}`,
        key: pattern.keyGroup ? String(match[pattern.keyGroup] ?? "text").replace(/[:=]\s*$/, "").trim() : "text",
        kind: "value",
        label,
      });
      edits.push({
        start: offset,
        end: offset + value.length,
        text: `<REDACTED:${label}>`,
        pointer: `line:${line}:${column}`,
        kind: "redact-text",
      });
    }
  }

  const uniqueEdits = dedupeEdits(edits);
  const kept = new Set(uniqueEdits.map((edit) => edit.pointer));
  const uniqueRefs = [];
  const seenPointers = new Set();
  for (const ref of secretRefs) {
    if (!kept.has(ref.pointer) || seenPointers.has(ref.pointer)) continue;
    seenPointers.add(ref.pointer);
    uniqueRefs.push(ref);
  }
  return { edits: uniqueEdits, secretRefs: uniqueRefs };
}

export function mergeSecretRefs(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of group ?? []) {
      const key = `${item.pointer}\0${item.kind}\0${item.label ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

export function buildPointer(...parts) {
  let pointer = "";
  for (const part of parts) {
    if (part === undefined || part === null) continue;
    if (typeof part === "number") {
      pointer += `/${part}`;
    } else {
      pointer = pointerJoin(pointer, part);
    }
  }
  return pointer;
}
