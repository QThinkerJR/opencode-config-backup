import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildPlan,
  copyFixture,
  planFixture,
  runScript,
  runScriptStatus,
  writeSecrets,
} from "./helpers.mjs";

async function dryRun(bundle, target, home, secrets) {
  const stdout = runScript(
    path.join(bundle, "tools", "restore.mjs"),
    ["--bundle", bundle, "--target", target, "--home", home, "--secrets", secrets, "--dry-run", "--json", "--allow-custom-target"],
  );
  return JSON.parse(stdout);
}

test("restore applies a bundle, re-supplies secrets, and is idempotent", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out: bundle, manifest } = await buildPlan(fixture, plan);
  const { file: secrets } = await writeSecrets(fixture, manifest);
  const target = path.join(fixture.root, "target");
  const restoreHome = path.join(fixture.root, "restore-home");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(restoreHome, { recursive: true });

  const first = await dryRun(bundle, target, restoreHome, secrets);
  assert.ok(first.actions.some((action) => action.action === "create"));
  runScript(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    target,
    "--home",
    restoreHome,
    "--secrets",
    secrets,
    "--approve",
    first.plan_hash,
    "--allow-custom-target",
  ]);

  const restoredAgents = await fs.readFile(path.join(target, "AGENTS.md"), "utf8");
  assert.doesNotMatch(restoredAgents, /<REDACTED:/);
  assert.match(restoredAgents, /restored-1/);

  const restoredConfig = await fs.readFile(path.join(target, "opencode.jsonc"), "utf8");
  assert.doesNotMatch(restoredConfig, /<REDACTED:/);
  assert.match(restoredConfig, /restored-\d+/);
  assert.match(restoredConfig, /"\.\/plugins\/my-local-plugin"/);

  const restoredSkill = await fs.readFile(
    path.join(restoreHome, ".agents", "skills", "demo", "SKILL.md"),
    "utf8",
  );
  assert.match(restoredSkill, /Demo skill/);

  const second = await dryRun(bundle, target, restoreHome, secrets);
  assert.ok(second.actions.every((action) => action.action === "skip"));
});

test("restore JSON-escapes secret values in JSON targets", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out: bundle, manifest } = await buildPlan(fixture, plan);
  const weird = 'a"b\\c\nline';
  const values = {};
  for (const ref of manifest.secret_refs.filter((item) => item.kind === "value")) values[ref.label] = weird;
  const { file: secrets } = await writeSecrets(fixture, manifest, values);
  const target = path.join(fixture.root, "target");
  const restoreHome = path.join(fixture.root, "restore-home");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(restoreHome, { recursive: true });
  const dry = await dryRun(bundle, target, restoreHome, secrets);
  runScript(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    target,
    "--home",
    restoreHome,
    "--secrets",
    secrets,
    "--approve",
    dry.plan_hash,
    "--allow-custom-target",
  ]);
  const { parseJsonc } = await import("../scripts/lib/jsonc.mjs");
  const config = parseJsonc(await fs.readFile(path.join(target, "opencode.jsonc"), "utf8")).value;
  assert.equal(config.providers.acme.settings.apiKey, weird);
  const skillConfig = JSON.parse(
    await fs.readFile(path.join(restoreHome, ".agents", "skills", "demo", "config.json"), "utf8"),
  );
  assert.equal(skillConfig.apiKey, weird);
});

test("restore refuses to use the home directory as a target root", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out: bundle } = await buildPlan(fixture, plan);
  const result = runScriptStatus(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    fixture.root,
    "--home",
    fixture.root,
    "--dry-run",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /home directory|config directory/i);
});

test("restore rejects ~/ and parent-traversal target paths", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out: bundle } = await buildPlan(fixture, plan);
  const manifestPath = path.join(bundle, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.items[0].target_path = "~/";
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const homeResult = runScriptStatus(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    path.join(fixture.root, "target"),
    "--home",
    path.join(fixture.root, "restore-home"),
    "--dry-run",
    "--allow-custom-target",
  ]);
  assert.notEqual(homeResult.status, 0);
  assert.match(homeResult.stderr, /home target|non-whitelisted/i);

  manifest.items[0].target_path = "~/.config/opencode/../..";
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const traversal = runScriptStatus(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    path.join(fixture.root, "target"),
    "--home",
    path.join(fixture.root, "restore-home"),
    "--dry-run",
    "--allow-custom-target",
  ]);
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /parent traversal|home target/i);
});

test("restore rejects unlisted files and unsupported manifest schemas", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out: bundle } = await buildPlan(fixture, plan);
  await fs.writeFile(path.join(bundle, "files", "unlisted.txt"), "extra", "utf8");
  const unlisted = runScriptStatus(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    path.join(fixture.root, "target"),
    "--home",
    path.join(fixture.root, "restore-home"),
    "--dry-run",
    "--allow-custom-target",
  ]);
  assert.notEqual(unlisted.status, 0);
  assert.match(unlisted.stderr, /unlisted file/i);

  const manifestPath = path.join(bundle, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.schema_version = 1;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const schema = runScriptStatus(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    path.join(fixture.root, "target"),
    "--home",
    path.join(fixture.root, "restore-home"),
    "--dry-run",
    "--allow-custom-target",
  ]);
  assert.notEqual(schema.status, 0);
  assert.match(schema.stderr, /schema/i);
});

test("restore backs up a symlinked directory target through the link", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out: bundle, manifest } = await buildPlan(fixture, plan);
  const { file: secrets } = await writeSecrets(fixture, manifest);
  const target = path.join(fixture.root, "target");
  const restoreHome = path.join(fixture.root, "restore-home");
  const linked = path.join(fixture.root, "linked-plugin");
  await fs.mkdir(path.join(target, "plugins"), { recursive: true });
  await fs.mkdir(restoreHome, { recursive: true });
  await fs.mkdir(linked, { recursive: true });
  await fs.writeFile(path.join(linked, "old.txt"), "old link content", "utf8");
  await fs.symlink(
    linked,
    path.join(target, "plugins", "global-plugin"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const dry = await dryRun(bundle, target, restoreHome, secrets);
  assert.equal(dry.linkWarnings.length, 1);
  assert.equal(dry.linkWarnings[0].link_target, await fs.realpath(linked));

  runScript(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    target,
    "--home",
    restoreHome,
    "--secrets",
    secrets,
    "--approve",
    dry.plan_hash,
    "--allow-custom-target",
  ]);

  const restored = path.join(target, "plugins", "global-plugin");
  assert.equal((await fs.lstat(restored)).isDirectory(), true);
  assert.ok((await fs.stat(path.join(restored, "index.ts"))).isFile());

  const backupRoot = path.join(target, ".restore-backups");
  const backupDirs = await fs.readdir(backupRoot);
  assert.ok(backupDirs.length > 0);
  const backedUp = await fs.readFile(path.join(backupRoot, backupDirs[0], "plugins", "global-plugin", "old.txt"), "utf8");
  assert.equal(backedUp, "old link content");
  assert.equal(await fs.readFile(path.join(linked, "old.txt"), "utf8"), "old link content");
});

test("restore merges into a symlinked skills root without replacing the link", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out: bundle, manifest } = await buildPlan(fixture, plan);
  const { file: secrets } = await writeSecrets(fixture, manifest);
  const target = path.join(fixture.root, "target");
  const restoreHome = path.join(fixture.root, "restore-home");
  const linked = path.join(fixture.root, "linked-skills");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(restoreHome, { recursive: true });
  await fs.mkdir(linked, { recursive: true });
  await fs.writeFile(path.join(linked, "old.txt"), "old skill content", "utf8");
  await fs.mkdir(path.join(restoreHome, ".agents"), { recursive: true });
  await fs.symlink(
    linked,
    path.join(restoreHome, ".agents", "skills"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const dry = await dryRun(bundle, target, restoreHome, secrets);
  assert.ok(dry.linkWarnings.some((warning) => warning.merge === true));
  runScript(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    target,
    "--home",
    restoreHome,
    "--secrets",
    secrets,
    "--approve",
    dry.plan_hash,
    "--allow-custom-target",
  ]);

  const skillsLink = path.join(restoreHome, ".agents", "skills");
  assert.equal((await fs.lstat(skillsLink)).isSymbolicLink(), true);
  assert.match(await fs.readFile(path.join(linked, "demo", "SKILL.md"), "utf8"), /Demo skill/);
  assert.equal(await fs.readFile(path.join(linked, "old.txt"), "utf8"), "old skill content");

  const backupRoot = path.join(restoreHome, ".restore-backups");
  const backupDirs = await fs.readdir(backupRoot);
  assert.ok(backupDirs.length > 0);
  const backedUp = await fs.readFile(
    path.join(backupRoot, backupDirs[0], ".agents", "skills", "old.txt"),
    "utf8",
  );
  assert.equal(backedUp, "old skill content");
});

test("restore backs up an overwritten file and fails closed without secrets", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { plan } = await planFixture(fixture);
  const { out: bundle, manifest } = await buildPlan(fixture, plan);
  const { file: secrets } = await writeSecrets(fixture, manifest);
  const target = path.join(fixture.root, "target");
  const restoreHome = path.join(fixture.root, "restore-home");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(restoreHome, { recursive: true });

  await fs.writeFile(path.join(target, "AGENTS.md"), "old content", "utf8");
  const dry = await dryRun(bundle, target, restoreHome, secrets);
  runScript(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    target,
    "--home",
    restoreHome,
    "--secrets",
    secrets,
    "--approve",
    dry.plan_hash,
    "--allow-custom-target",
  ]);
  const backupRoot = path.join(target, ".restore-backups");
  const backupDirs = await fs.readdir(backupRoot);
  assert.ok(backupDirs.length > 0);
  const backup = await fs.readFile(path.join(backupRoot, backupDirs[0], "AGENTS.md"), "utf8");
  assert.equal(backup, "old content");

  await fs.writeFile(path.join(target, "AGENTS.md"), "keep this", "utf8");
  const noSecrets = runScriptStatus(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    target,
    "--home",
    restoreHome,
    "--dry-run",
    "--json",
    "--allow-custom-target",
  ]);
  assert.equal(noSecrets.status, 0);
  const noSecretsPlan = JSON.parse(noSecrets.stdout);
  assert.ok(noSecretsPlan.missingSecrets.length > 0);
  const failed = runScriptStatus(path.join(bundle, "tools", "restore.mjs"), [
    "--bundle",
    bundle,
    "--target",
    target,
    "--home",
    restoreHome,
    "--approve",
    noSecretsPlan.plan_hash,
    "--allow-custom-target",
  ]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /missing secret/i);
  assert.equal(await fs.readFile(path.join(target, "AGENTS.md"), "utf8"), "keep this");
});
