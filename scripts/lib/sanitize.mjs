import { createHash } from "node:crypto";
import {
  isReferenceValue,
  isSecretHeaderName,
  isSecretKey,
  looksLikeSecretValue,
  sanitizeUrlForDisplay,
} from "./redact.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value), null, 2);
}

export function stableHash(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function replaceHomePath(value, home) {
  if (typeof value !== "string" || !home) return value;
  const slashed = home.replace(/\\/g, "/").replace(/\/+$/, "");
  const variants = new Set([
    home,
    slashed,
    home.replace(/\//g, "\\"),
  ]);
  let result = value;
  for (const variant of variants) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), "~");
  }
  return result;
}

const URL_LIKE_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//i;

function replaceAnyHomePath(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/gi, "~")
    .replace(/\/home\/[^/\s]+/gi, "~")
    .replace(/\/Users\/[^/\s]+/gi, "~");
}

function sanitizeHeaderValue(value) {
  return value.replace(
    /((?:authorization|proxy-authorization|x-api-key|api-key|auth|session|cookie|set-cookie|token|credential|password)\s*:\s*)(?:Bearer\s+|Basic\s+)?\S+/gi,
    "$1<REDACTED>",
  );
}

export function sanitizeCommandString(value, home = "") {
  if (typeof value !== "string") return value;
  let output = replaceAnyHomePath(replaceHomePath(value, home));
  output = output.replace(/\b[A-Za-z_][A-Za-z0-9_]*=\S+/g, (match) => {
    const key = match.slice(0, match.indexOf("="));
    return isSecretKey(key, { allowBare: true }) ? `${key}=<REDACTED>` : match;
  });
  output = output.replace(/(--?[^\s=]+)=(\S+)/g, (match, flag, _value) => {
    return isSecretKey(flag.replace(/^--?/, ""), { allowBare: true }) ? `${flag}=<REDACTED>` : match;
  });
  output = output.replace(/(--?[^\s=]+)\s+(\S+)/g, (match, flag, next) => {
    return isSecretKey(flag.replace(/^--?/, ""), { allowBare: true }) ? `${flag} <REDACTED>` : match;
  });
  output = sanitizeHeaderValue(output);
  output = output.replace(/(?:https?|wss?|postgres|mysql|mongodb|redis|amqp|ftp|ssh|git\+ssh|git\+https|git|file):\/\/\S+/gi, (url) => sanitizeUrlForDisplay(url));
  return output;
}

export function sanitizeCommand(command, home = "") {
  if (!Array.isArray(command)) return command;
  const result = [];
  let secretNext = false;
  for (const raw of command) {
    if (typeof raw !== "string") {
      result.push(raw);
      secretNext = false;
      continue;
    }
    let item = replaceAnyHomePath(replaceHomePath(raw, home));
    if (URL_LIKE_RE.test(item)) {
      result.push(sanitizeUrlForDisplay(item));
      secretNext = false;
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(item);
    if (assignment && isSecretKey(assignment[1], { allowBare: true })) {
      result.push(`${assignment[1]}=<REDACTED>`);
      secretNext = false;
      continue;
    }
    const equals = /^(--?[^=]+)=(.+)$/.exec(item);
    if (equals && isSecretKey(equals[1].replace(/^--?/, ""), { allowBare: true })) {
      result.push(`${equals[1]}=<REDACTED>`);
      secretNext = false;
      continue;
    }
    if (/^Authorization\s*:\s*(Bearer|Basic)\s+/i.test(item)) {
      result.push(item.replace(/^Authorization\s*:\s*(Bearer|Basic)\s+.*$/i, "Authorization: $1 <REDACTED>"));
      secretNext = false;
      continue;
    }
    if (secretNext) {
      result.push(isReferenceValue(item) ? item : "<REDACTED>");
      secretNext = false;
      continue;
    }
    if (/^--?[^=]+$/.test(item) && isSecretKey(item.replace(/^--?/, ""), { allowBare: true })) {
      result.push(item);
      secretNext = true;
      continue;
    }
    result.push(sanitizeHeaderValue(item));
  }
  return result;
}

export function sanitizeForOutput(value, key = "", home = "", options = {}) {
  const envContext = options.envContext === true || key === "environment" || key === "env";
  const headerContext = options.headerContext === true || key === "headers";
  if (typeof value === "string") {
    if (isReferenceValue(value)) return value;
    if (key === "command" || key === "install_cmd") return sanitizeCommandString(value, home);
    if (URL_LIKE_RE.test(value)) return sanitizeUrlForDisplay(value);
    if (isSecretKey(key, { allowBare: envContext || headerContext }) || looksLikeSecretValue(value, key)) {
      return "<REDACTED>";
    }
    if (headerContext && isSecretHeaderName(key)) return "<REDACTED>";
    return replaceAnyHomePath(replaceHomePath(value, home));
  }
  if (Array.isArray(value)) {
    if (key === "command" || key === "install_cmd") return sanitizeCommand(value, home);
    return value.map((item) => sanitizeForOutput(item, key, home, options));
  }
  if (value && typeof value === "object") {
    const childOptions = {
      envContext: envContext || key === "environment" || key === "env",
      headerContext: headerContext || key === "headers",
    };
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeForOutput(childValue, childKey, home, childOptions);
    }
    return result;
  }
  return value;
}

export function sanitizePlanForOutput(plan, options = {}) {
  const home = options.home ?? plan.source?.home ?? "";
  const configRoot = options.configRoot ?? plan.source?.config_root ?? "";
  const replaceRoot = (value) => {
    if (typeof value !== "string" || !configRoot) return value;
    return value.replace(new RegExp(configRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<config>");
  };

  for (const extension of plan.extensions ?? []) {
    if (extension.options) extension.options = sanitizeForOutput(extension.options, "options", home);
    if (extension.command) extension.command = sanitizeCommand(extension.command, home);
    if (extension.install_cmd) extension.install_cmd = sanitizeCommandString(extension.install_cmd, home);
    if (extension.url) extension.url = sanitizeUrlForDisplay(replaceAnyHomePath(replaceHomePath(extension.url, home)));
    if (extension.spec) extension.spec = sanitizeForOutput(extension.spec, "spec", home);
    if (extension.installed_source) extension.installed_source = sanitizeForOutput(extension.installed_source, "source", home);
    if (extension.installed_status) extension.installed_status = sanitizeForOutput(extension.installed_status, "status", home);
    if (extension.headers) extension.headers = sanitizeForOutput(extension.headers, "headers", home);
    if (extension.environment) extension.environment = sanitizeForOutput(extension.environment, "environment", home);
    if (extension.cwd) extension.cwd = replaceAnyHomePath(replaceHomePath(extension.cwd, home));
  }

  for (const action of plan.manual_actions ?? []) {
    if (action.command) action.command = sanitizeCommand(action.command, home);
    if (action.url) action.url = sanitizeUrlForDisplay(action.url);
    if (action.source) action.source = sanitizeForOutput(action.source, "source", home);
    if (action.path) action.path = sanitizeForOutput(action.path, "path", home);
    if (action.cwd) action.cwd = replaceAnyHomePath(replaceHomePath(action.cwd, home));
    if (action.environment) action.environment = sanitizeForOutput(action.environment, "environment", home);
    if (action.headers) action.headers = sanitizeForOutput(action.headers, "headers", home);
  }

  for (const rewrite of plan.rewrites ?? []) {
    if (rewrite.kind === "delete") continue;
    if (Object.prototype.hasOwnProperty.call(rewrite, "from")) {
      rewrite.from_sha256 = stableHash(rewrite.from);
      delete rewrite.from;
    }
    if (Array.isArray(rewrite.to)) rewrite.to = sanitizeCommand(rewrite.to, home);
    else if (typeof rewrite.to === "string") rewrite.to = sanitizeCommandString(rewrite.to, home);
  }

  for (const warning of plan.warnings ?? []) {
    if (typeof warning.message === "string") {
      warning.message = sanitizeCommandString(
        replaceAnyHomePath(replaceHomePath(replaceRoot(warning.message), home)),
        home,
      );
    }
  }

  if (plan.opencode) {
    plan.opencode = sanitizeForOutput(plan.opencode, "opencode", home);
  }

  return plan;
}
