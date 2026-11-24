/**
 * Minimal JSONC parser with source ranges.
 *
 * The parser is intentionally dependency-free and keeps the byte range of
 * every value so callers can edit a single value without reserializing the
 * whole document (comments and formatting stay intact).
 */

export class JSONCParseError extends SyntaxError {
  constructor(message, source, offset) {
    super(`${source}: ${message} at offset ${offset}`);
    this.name = "JSONCParseError";
    this.source = source;
    this.offset = offset;
  }
}

export function escapePointer(key) {
  return String(key).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointer(key) {
  return String(key).replace(/~1/g, "/").replace(/~0/g, "~");
}

export function pointerJoin(pointer, key) {
  return `${pointer}/${escapePointer(key)}`;
}

export function parseJsonc(text, source = "<jsonc>") {
  let i = 0;
  const n = text.length;

  const fail = (message, offset = i) => {
    throw new JSONCParseError(message, source, offset);
  };

  const skipTrivia = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (i >= n) return;
      if (text.startsWith("//", i)) {
        i += 2;
        while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
        continue;
      }
      if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) fail("unterminated block comment");
        i = end + 2;
        continue;
      }
      return;
    }
  };

  const parseStringNode = (pointer, key) => {
    const start = i;
    if (text[i] !== '"') fail("expected string");
    i++;
    while (i < n) {
      const ch = text[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        const raw = text.slice(start, i);
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          fail("invalid string escape", start);
        }
        return { type: "string", value, start, end: i, pointer, key };
      }
      i++;
    }
    fail("unterminated string", start);
  };

  const parseObject = (pointer) => {
    const start = i;
    i++; // {
    const children = new Map();
    const objectValue = {};
    skipTrivia();
    if (text[i] === "}") {
      i++;
      return { type: "object", value: objectValue, children, start, end: i, pointer };
    }
    for (;;) {
      skipTrivia();
      if (text[i] !== '"') fail("expected object key");
      const keyNode = parseStringNode(pointer, undefined);
      const key = keyNode.value;
      skipTrivia();
      if (text[i] !== ":") fail("expected ':' after object key");
      i++;
      const childPointer = pointerJoin(pointer, key);
      const valueNode = parseValue(childPointer, key);
      valueNode.keyStart = keyNode.start;
      valueNode.keyEnd = keyNode.end;
      children.set(key, valueNode);
      objectValue[key] = valueNode.value;
      skipTrivia();
      if (text[i] === ",") {
        i++;
        skipTrivia();
        if (text[i] === "}") {
          i++;
          break;
        }
        continue;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      fail("expected ',' or '}'");
    }
    return { type: "object", value: objectValue, children, start, end: i, pointer };
  };

  const parseArray = (pointer) => {
    const start = i;
    i++; // [
    const children = [];
    const arrayValue = [];
    skipTrivia();
    if (text[i] === "]") {
      i++;
      return { type: "array", value: arrayValue, children, start, end: i, pointer };
    }
    for (let index = 0; ; index++) {
      const childPointer = `${pointer}/${index}`;
      const valueNode = parseValue(childPointer, undefined);
      children.push(valueNode);
      arrayValue.push(valueNode.value);
      skipTrivia();
      if (text[i] === ",") {
        i++;
        skipTrivia();
        if (text[i] === "]") {
          i++;
          break;
        }
        continue;
      }
      if (text[i] === "]") {
        i++;
        break;
      }
      fail("expected ',' or ']'");
    }
    return { type: "array", value: arrayValue, children, start, end: i, pointer };
  };

  const parseValue = (pointer, key) => {
    skipTrivia();
    const ch = text[i];
    const start = i;
    if (ch === "{") return parseObject(pointer);
    if (ch === "[") return parseArray(pointer);
    if (ch === '"') return parseStringNode(pointer, key);

    if (ch === "t" && text.startsWith("true", i)) {
      i += 4;
      return { type: "boolean", value: true, start, end: i, pointer, key };
    }
    if (ch === "f" && text.startsWith("false", i)) {
      i += 5;
      return { type: "boolean", value: false, start, end: i, pointer, key };
    }
    if (ch === "n" && text.startsWith("null", i)) {
      i += 4;
      return { type: "null", value: null, start, end: i, pointer, key };
    }

    const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (numberMatch) {
      i += numberMatch[0].length;
      return { type: "number", value: Number(numberMatch[0]), start, end: i, pointer, key };
    }

    fail("unexpected token", start);
  };

  const root = parseValue("", undefined);
  skipTrivia();
  if (i < n) fail("unexpected trailing content");
  return root;
}

export function findNode(root, pointer) {
  if (pointer === "" || pointer === "/") return pointer === "" ? root : null;
  const parts = pointer.split("/").slice(1).map(unescapePointer);
  let node = root;
  for (const part of parts) {
    if (!node) return null;
    if (node.type === "object") {
      node = node.children.get(part);
    } else if (node.type === "array") {
      if (!/^\d+$/.test(part)) return null;
      node = node.children[Number(part)];
    } else {
      return null;
    }
  }
  return node ?? null;
}

export function valueAtPointer(root, pointer) {
  return findNode(root, pointer)?.value;
}

export function walkNodes(node, visitor, pointer = "") {
  if (!node) return;
  visitor(node, pointer || node.pointer || "");
  if (node.type === "object") {
    for (const [key, child] of node.children) {
      walkNodes(child, visitor, pointerJoin(pointer, key));
    }
  } else if (node.type === "array") {
    for (let index = 0; index < node.children.length; index++) {
      walkNodes(node.children[index], visitor, `${pointer}/${index}`);
    }
  }
}

export function collectStringNodes(root) {
  const nodes = [];
  walkNodes(root, (node) => {
    if (node.type === "string") nodes.push(node);
  });
  return nodes;
}

export function applyEdits(text, edits) {
  if (!edits.length) return text;
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = text.length + 1;
  let output = text;
  for (const edit of sorted) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)) {
      throw new TypeError("edit start/end must be integers");
    }
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
      throw new RangeError(`edit out of range: ${edit.start}-${edit.end}`);
    }
    if (edit.end > previousStart) {
      throw new RangeError("overlapping edits");
    }
    previousStart = edit.start;
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

export function formatReplacement(value) {
  return JSON.stringify(value);
}

export function parseJsoncOrNull(text, source) {
  try {
    return { ok: true, root: parseJsonc(text, source) };
  } catch (error) {
    return { ok: false, error };
  }
}
