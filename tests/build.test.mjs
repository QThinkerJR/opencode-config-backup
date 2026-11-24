import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildPlan, copyFixture, planFixture, runNode, runNodeStatus } from "./helpers.mjs";

test("build produces a verified, redacted, portable bundle", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out, manifest } = await buildPlan(fixture, plan);

  const files = [];
  async function walk(dir, base = "") {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = path.join(base, entry.name);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else files.push(relative.replace(/\\/g, "/"));
    }
  }
  await walk(out);
  assert.ok(files.includes("RESTORE.md"));
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.includes("checksums.json"));
  assert.ok(files.includes("tools/restore.mjs"));
  assert.ok(files.includes("files/opencode.jsonc"));
  assert.ok(files.includes("files/AGENTS.md"));
  assert.ok(files.includes("files/plugins/my-local-plugin/index.ts"));
  assert.ok(files.includes("files/plugins/my-local-plugin/package-lock.json"));
  assert.ok(files.includes("files/plugins/my-local-plugin/dist/gui-experimental.cjs"));
  assert.ok(!files.includes("files/plugins/my-local-plugin/docs/ignored.md"));
  const bundleText = (
    await Promise.all(files.map((file) => fs.readFile(path.join(out, file), "utf8").catch(() => "")))
  ).join("\n");
  assert.doesNotMatch(bundleText, /literal-env-file-secret/);
  assert.ok(files.includes("files/plugins/global-plugin/index.ts"));
  assert.ok(files.includes("files/_shared/agents-skills/demo/SKILL.md"));
  assert.ok(!files.some((file) => file.includes("node_modules")));
  assert.ok(!files.includes("files/service.json"));
  assert.ok(!files.includes("files/package.json"));

  const opencode = await fs.readFile(path.join(out, "files", "opencode.jsonc"), "utf8");
  assert.match(opencode, /"\.\/plugins\/my-local-plugin"/);
  assert.doesNotMatch(opencode, /C:\/Users\/me/);
  assert.doesNotMatch(opencode, /"cmd"/);
  assert.match(opencode, /"npx"/);
  assert.match(opencode, /Bearer \{env:MCP_KEY\}/);
  assert.match(opencode, /<REDACTED:opencode\.jsonc#\/providers\/acme\/settings\/apiKey>/);
  assert.doesNotMatch(opencode, /literal-provider-key/);
  assert.doesNotMatch(opencode, /literal-option-secret/);
  assert.doesNotMatch(JSON.stringify(manifest), /literal-option-secret|literal-provider-key|literal-command-secret|literal-bare-token/);
  assert.doesNotMatch(JSON.stringify(plan), /literal-command-secret/);

  const agents = await fs.readFile(path.join(out, "files", "AGENTS.md"), "utf8");
  assert.match(agents, /<REDACTED:AGENTS\.md:\d+:\d+>/);
  assert.doesNotMatch(agents, /supersecretvalue/);

  assert.ok(manifest.items.some((item) => item.target_path === "plugins/my-local-plugin"));
  assert.ok(manifest.extensions.some((item) => item.name === "bare" && item.classification === "manual"));
  assert.ok(manifest.secret_refs.some((item) => item.kind === "value"));
  assert.equal(manifest.bundle.plan_hash, plan.plan_hash);
  assert.ok(!manifest.items.some((item) => "source_path" in item));

  assert.doesNotThrow(() =>
    runNode("scripts/verify-bundle.mjs", ["--bundle", out]),
  );
});

test("home paths in plugin-data directories are rewritten", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixture.config, "helper-notes"), { recursive: true });
  await fs.writeFile(
    path.join(fixture.config, "helper-notes", "README.md"),
    `Path: ${fixture.home}/rules/x.md\n`,
    "utf8",
  );
  const { plan } = await planFixture(fixture);
  const { out } = await buildPlan(fixture, plan);
  const text = await fs.readFile(path.join(out, "files", "helper-notes", "README.md"), "utf8");
  assert.doesNotMatch(text, new RegExp(fixture.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.match(text, /~\/rules\/x\.md/);
});

test("home paths in directory items are rewritten", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const skillPath = path.join(fixture.home, ".agents", "skills", "demo", "SKILL.md");
  await fs.appendFile(skillPath, `\nPath: ${fixture.home}/rules/x.md\n`, "utf8");
  const { plan } = await planFixture(fixture);
  const { out } = await buildPlan(fixture, plan);
  const text = await fs.readFile(
    path.join(out, "files", "_shared", "agents-skills", "demo", "SKILL.md"),
    "utf8",
  );
  assert.doesNotMatch(text, new RegExp(fixture.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.match(text, /~\/rules\/x\.md/);
});

test("failed builds remove the partial bundle and reject lockfile credentials", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(fixture.external, "my-plugin", "package-lock.json"),
    JSON.stringify({ resolved: "https://user:pass@example.com/pkg.tgz" }, null, 2),
    "utf8",
  );
  const { plan } = await planFixture(fixture);
  const out = path.join(fixture.root, "bundle");
  const result = runNodeStatus("scripts/build.mjs", [
    "--plan",
    path.join(fixture.root, "plan", "plan.json"),
    "--out",
    out,
    "--approve",
    plan.plan_hash,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lockfile/i);
  assert.equal(await fs.stat(out).catch(() => null), null);
});

test("home paths in config strings are rewritten to ~", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const cliPath = path.join(fixture.config, "cli.json");
  const cli = JSON.parse(await fs.readFile(cliPath, "utf8"));
  cli.attention = { sounds: { permission: path.join(fixture.home, "sounds", "permission.wav") } };
  await fs.writeFile(cliPath, JSON.stringify(cli, null, 2), "utf8");
  await fs.writeFile(
    path.join(fixture.config, "AGENTS.md"),
    `Global rules\nRead ${fixture.home}/rules/opencode.md\n`,
    "utf8",
  );
  const { plan } = await planFixture(fixture);
  assert.ok(plan.rewrites.some((item) => item.reason === "normalize-home-path"));
  const { out } = await buildPlan(fixture, plan);
  const restoredCli = await fs.readFile(path.join(out, "files", "cli.json"), "utf8");
  assert.doesNotMatch(restoredCli, new RegExp(fixture.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.match(restoredCli, /~\/sounds\/permission\.wav/);
  const restoredAgents = await fs.readFile(path.join(out, "files", "AGENTS.md"), "utf8");
  assert.doesNotMatch(restoredAgents, new RegExp(fixture.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.match(restoredAgents, /~\/rules\/opencode\.md/);
});

test("multiple named MCP exclusions delete the right object entries", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture, ["--exclude", "toolbox,manualabs"]);
  const { out } = await buildPlan(fixture, plan);
  const config = await fs.readFile(path.join(out, "files", "opencode.jsonc"), "utf8");
  assert.doesNotMatch(config, /"toolbox"/);
  assert.doesNotMatch(config, /"manualabs"/);
  assert.match(config, /"npm-mcp"/);
});

test("credential files in plugin trees are not copied", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(fixture.config, "plugins", "global-plugin", ".npmrc"),
    "//registry.example.com/:_authToken=literal-registry-token\n",
    "utf8",
  );
  const { plan } = await planFixture(fixture);
  const { out } = await buildPlan(fixture, plan);
  assert.equal(
    await fs.stat(path.join(out, "files", "plugins", "global-plugin", ".npmrc")).catch(() => null),
    null,
  );
});

test("private key files in shared skill trees are redacted", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(fixture.home, ".agents", "skills", "demo", "id_ed25519"),
    "-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END OPENSSH PRIVATE KEY-----\n",
    "utf8",
  );
  const { plan } = await planFixture(fixture);
  const { out, manifest } = await buildPlan(fixture, plan);
  const bundled = await fs.readFile(
    path.join(out, "files", "_shared", "agents-skills", "demo", "id_ed25519"),
    "utf8",
  );
  assert.doesNotMatch(bundled, /MIIEvQIBADAN/);
  assert.match(bundled, /<REDACTED:/);
  assert.ok(manifest.secret_refs.some((ref) => String(ref.label).includes("id_ed25519")));
});

test("verify rejects tampered files and unexpected files", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out } = await buildPlan(fixture, plan);

  await fs.appendFile(path.join(out, "files", "AGENTS.md"), "\ntampered\n", "utf8");
  const tampered = runNodeStatus("scripts/verify-bundle.mjs", ["--bundle", out]);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /checksum mismatch/);

  await fs.writeFile(path.join(out, "files", "unexpected.txt"), "extra", "utf8");
  const extra = runNodeStatus("scripts/verify-bundle.mjs", ["--bundle", out]);
  assert.notEqual(extra.status, 0);
});

test("verify rejects an unresolved RESTORE placeholder", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out } = await buildPlan(fixture, plan);

  await fs.appendFile(path.join(out, "RESTORE.md"), "\n{{missing}}\n", "utf8");
  const result = runNodeStatus("scripts/verify-bundle.mjs", ["--bundle", out]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unresolved placeholder/);
});
