import { applyEdits, findNode, parseJsonc } from "./jsonc.mjs";
import { stableHash } from "./sanitize.mjs";

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deleteNodeEdit(text, node) {
  let start = node.keyStart ?? node.start;
  let end = node.end;
  let before = start - 1;
  while (before >= 0 && /\s/.test(text[before])) before--;
  if (before >= 0 && text[before] === ",") {
    start = before;
  } else {
    let after = end;
    while (after < text.length && /\s/.test(text[after])) after++;
    if (text[after] === ",") end = after + 1;
  }
  return { start, end, text: "" };
}

export function applyRewrites(text, source, rewrites) {
  if (!rewrites.length) return text;
  let output = text;
  for (const rewrite of rewrites) {
    const root = parseJsonc(output, source);
    const node = findNode(root, rewrite.pointer);
    if (!node) throw new Error(`rewrite pointer not found: ${rewrite.pointer} in ${source}`);
    if (rewrite.kind === "delete") {
      output = applyEdits(output, [deleteNodeEdit(output, node)]);
      continue;
    }
    const sourceMatches = rewrite.from_sha256
      ? stableHash(node.value) === rewrite.from_sha256
      : deepEqual(node.value, rewrite.from);
    if (!sourceMatches) {
      throw new Error(`rewrite source value changed at ${rewrite.pointer} in ${source}`);
    }
    output = applyEdits(output, [
      {
        start: node.start,
        end: node.end,
        text: JSON.stringify(rewrite.to),
        pointer: rewrite.pointer,
      },
    ]);
  }
  return output;
}
