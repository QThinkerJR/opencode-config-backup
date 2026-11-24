import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEdits,
  findNode,
  parseJsonc,
  valueAtPointer,
} from "../scripts/lib/jsonc.mjs";

test("JSONC parses comments, trailing commas, and ranges", () => {
  const text = `{
    // line comment
    "name": "demo", /* block */
    "plugins": ["a", "b",],
    "nested": { "ok": true },
  }`;
  const root = parseJsonc(text, "fixture.jsonc");
  assert.equal(valueAtPointer(root, "/name"), "demo");
  assert.deepEqual(valueAtPointer(root, "/plugins"), ["a", "b"]);
  assert.equal(valueAtPointer(root, "/nested/ok"), true);
  const node = findNode(root, "/plugins/1");
  assert.equal(node.value, "b");
  assert.ok(node.start > 0);
  assert.ok(node.end > node.start);
  assert.ok(node.keyStart === undefined || node.keyStart >= 0);
});

test("applyEdits preserves the rest of the document", () => {
  const text = `{\n  // keep me\n  "key": "old",\n  "other": 1\n}`;
  const root = parseJsonc(text);
  const node = findNode(root, "/key");
  const updated = applyEdits(text, [{ start: node.start, end: node.end, text: '"new"' }]);
  assert.match(updated, /\/\/ keep me/);
  assert.match(updated, /"key": "new"/);
  assert.equal(valueAtPointer(parseJsonc(updated), "/other"), 1);
});

test("JSONC reports invalid syntax", () => {
  assert.throws(() => parseJsonc('{ "broken": }'), /unexpected token|expected/);
  assert.throws(() => parseJsonc('{ "a": 1 '), /expected|unexpected/);
});

test("object members expose key ranges for deletion", () => {
  const text = `{ "a": 1, "b": 2 }`;
  const root = parseJsonc(text);
  const node = findNode(root, "/a");
  assert.equal(text.slice(node.keyStart, node.keyEnd), '"a"');
});
