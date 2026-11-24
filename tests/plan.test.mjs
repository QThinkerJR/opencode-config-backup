import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { copyFixture, planFixture } from "./helpers.mjs";

test("V2 plan discovers files, local plugins, MCPs, and secrets", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);

  assert.equal(plan.schema_version, 2);
  assert.equal(plan.source.config_format, "v2");
  assert.equal(plan.source.opencode_version, null);

  const names = new Set(plan.items.map((item) => item.name));
  assert.ok(names.has("opencode.jsonc"));
  assert.ok(names.has("cli.json"));
  assert.ok(names.has("tui.json"));
  assert.ok(names.has("AGENTS.md"));
  assert.ok(!names.has("service.json"));
  assert.ok(!names.has("package.json"));
  assert.ok(!plan.items.some((item) => item.target_path?.includes("node_modules")));

  const local = plan.items.find((item) => item.target_path === "plugins/my-local-plugin");
  assert.ok(local);
  assert.equal(local.source_kind, "dir");
  assert.equal(local.metadata.api, "v2");
  const rewrite = plan.rewrites.find((item) => item.reason === "relocate-local-plugin");
  assert.match(rewrite.from_sha256, /^[a-f0-9]{64}$/);
  assert.equal(rewrite.from, undefined);
  assert.equal(rewrite.to, "./plugins/my-local-plugin");

  assert.ok(plan.items.some((item) => item.target_path === "plugins/global-plugin"));

  const mcp = Object.fromEntries(plan.extensions.filter((item) => item.type === "mcp").map((item) => [item.name, item]));
  assert.equal(mcp["npm-mcp"].classification, "installable");
  assert.equal(mcp.remote.classification, "remote");
  assert.equal(mcp.remote.auth_required, true);
  assert.equal(mcp.managed.classification, "managed");
  assert.equal(mcp.bare.classification, "manual");
  assert.ok(plan.rewrites.some((item) => item.kind === "delete" && item.pointer === "/mcp/servers/managed"));
  assert.ok(plan.manual_actions.some((item) => item.type === "mcp" && item.name === "bare"));
  assert.ok(plan.manual_actions.some((item) => item.type === "mcp-auth" && item.name === "remote"));

  const plugins = Object.fromEntries(plan.extensions.filter((item) => item.type === "plugin").map((item) => [item.name, item]));
  assert.equal(plugins["some-npm-plugin"].install_cmd, "opencode plugin add some-npm-plugin@1.2.3");
  assert.equal(plugins["disabled-plugin"].classification, "directive");
  assert.equal(plugins["tui-only-plugin"].install_cmd, null);
  assert.deepEqual(plugins["tui-only-plugin"].surfaces, ["tui"]);

  const secretValues = plan.secret_refs.filter((item) => item.kind === "value");
  assert.ok(secretValues.some((item) => item.pointer === "/providers/acme/settings/apiKey"));
  assert.ok(secretValues.some((item) => item.label.startsWith("AGENTS.md:")));
  assert.ok(plan.secret_refs.some((item) => item.kind === "env-reference"));
  assert.ok(plan.secret_refs.some((item) => item.kind === "embedded-reference"));
  assert.equal((JSON.stringify(plan).match(/literal-provider-key/g) ?? []).length, 0);
  assert.equal((JSON.stringify(plan).match(/literal-option-secret/g) ?? []).length, 0);
  assert.ok(plan.secret_refs.some((item) => item.pointer === "/plugins/2/options/clientSecret"));
  assert.ok(secretValues.some((item) => item.pointer === "/mcp/servers/bare/environment/TOKEN"));
  assert.equal((JSON.stringify(plan).match(/literal-bare-token/g) ?? []).length, 0);

  const codes = new Set(plan.warnings.map((warning) => warning.code));
  assert.ok(codes.has("TUI_LEGACY"));
  assert.ok(codes.has("TUI_AND_CLI"));
  assert.ok(codes.has("MCP_MANAGED_SKIPPED"));
  assert.ok(codes.has("MCP_NONPORTABLE_REMOVED"));

  assert.ok(plan.extensions.some((item) => item.type === "agent" && item.name === "legacy-agent"));
  assert.ok(plan.extensions.some((item) => item.type === "command" && item.name === "audit"));
  assert.ok(plan.extensions.some((item) => item.type === "theme" && item.name === "demo-theme" && item.selected));
  assert.ok(plan.extensions.some((item) => item.type === "skill" && item.name === "demo"));
  assert.ok(plan.manual_actions.some((item) => item.type === "skill-catalog"));
  assert.ok(plan.manual_actions.some((item) => item.type === "instruction-file"));
  assert.ok(plan.manual_actions.some((item) => item.type === "reference"));
  assert.ok(plan.auth.providers.some((item) => item.provider === "acme"));
  assert.ok(plan.auth.environment.includes("ACME_API_KEY"));
});

test("--include-claude-skills adds the shared Claude tree", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture, ["--include-claude-skills"]);
  assert.ok(plan.items.some((item) => item.target_path === "~/.claude/skills"));
  assert.ok(plan.extensions.some((item) => item.type === "skill" && item.name === "claude-demo"));
  assert.ok(plan.warnings.some((warning) => warning.code === "SHARED_CLAUDE_SKILLS"));
});

test("V1 plan detects V1 fields and V1 local plugins", async (t) => {
  const fixture = await copyFixture("v1");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  assert.equal(plan.source.config_format, "v1");
  assert.ok(plan.warnings.some((warning) => warning.code === "V1_CONFIG"));
  assert.ok(plan.warnings.some((warning) => warning.code === "V1_PLUGIN_API"));
  assert.ok(plan.items.some((item) => item.target_path === "plugins/v1-local"));
  assert.ok(plan.extensions.some((item) => item.type === "agent" && item.name === "reviewer"));
  assert.ok(plan.extensions.some((item) => item.type === "command" && item.name === "review"));
});

test("hybrid plan warns about mixed config files", async (t) => {
  const fixture = await copyFixture("hybrid");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  assert.equal(plan.source.config_format, "hybrid");
  assert.ok(plan.warnings.some((warning) => warning.code === "HYBRID_CONFIG"));
  assert.ok(plan.warnings.some((warning) => warning.code === "CONFIG_JSON_AND_JSONC"));
  assert.ok(plan.items.some((item) => item.name === "opencode.json"));
  assert.ok(plan.items.some((item) => item.name === "opencode.jsonc"));
});

test("--exclude refuses unsafe indexed plugin deletion", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture, ["--exclude", "some-npm-plugin"]);
  assert.ok(plan.extensions.some((item) => item.name === "some-npm-plugin"));
  assert.ok(plan.warnings.some((warning) => warning.code === "EXCLUDE_UNSUPPORTED"));
  assert.ok(!plan.rewrites.some((item) => item.kind === "delete" && item.pointer === "/plugins/0"));
});

test("--exclude removes named MCP extensions and emits a delete rewrite", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture, ["--exclude", "toolbox"]);
  assert.ok(!plan.extensions.some((item) => item.type === "mcp" && item.name === "toolbox"));
  assert.ok(!plan.manual_actions.some((item) => item.name === "toolbox"));
  assert.ok(plan.rewrites.some((item) => item.kind === "delete" && item.pointer === "/mcp/servers/toolbox"));
});

test("--exclude removes items and their secret references", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture, ["--exclude", "config:AGENTS.md"]);
  assert.ok(!plan.items.some((item) => item.id === "config:AGENTS.md"));
  assert.ok(!plan.secret_refs.some((item) => item.item_id === "config:AGENTS.md"));
  assert.ok(plan.warnings.some((warning) => warning.code === "EXCLUDED_BY_USER"));
});
