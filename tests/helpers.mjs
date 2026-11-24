import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");
export const fixturesRoot = path.join(here, "fixtures");

export async function makeTemp(prefix = "ocb-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function copyFixture(name) {
  const root = await makeTemp();
  const source = path.join(fixturesRoot, name);
  const target = path.join(root, "fixture");
  await fs.cp(source, target, { recursive: true });
  return {
    root,
    fixture: target,
    config: path.join(target, "config"),
    home: path.join(target, "home"),
    external: path.join(target, "external"),
  };
}

export function runNode(script, args, options = {}) {
  return execFileSync(process.execPath, [path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
}

export function runScript(scriptPath, args, options = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
}

export function runScriptStatus(scriptPath, args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
}

export function runNodeStatus(script, args, options = {}) {
  return spawnSync(process.execPath, [path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
}

export async function planFixture(fixture, extraArgs = []) {
  const out = path.join(fixture.root, "plan");
  const stdout = runNode("scripts/plan.mjs", [
    "--config",
    fixture.config,
    "--home",
    fixture.home,
    "--out",
    out,
    ...extraArgs,
  ]);
  const plan = JSON.parse(await fs.readFile(path.join(out, "plan.json"), "utf8"));
  return { out, plan, stdout };
}

export async function buildPlan(fixture, plan, outName = "bundle") {
  const out = path.join(fixture.root, outName);
  const stdout = runNode("scripts/build.mjs", [
    "--plan",
    path.join(fixture.root, "plan", "plan.json"),
    "--out",
    out,
    "--approve",
    plan.plan_hash,
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(out, "manifest.json"), "utf8"));
  return { out, manifest, stdout };
}

export async function writeSecrets(fixture, manifest, values = {}) {
  const secrets = {};
  for (const ref of manifest.secret_refs ?? []) {
    if (ref.kind !== "value") continue;
    secrets[ref.label] = values[ref.label] ?? `restored-${Object.keys(secrets).length + 1}`;
  }
  const file = path.join(fixture.root, "secrets.json");
  await fs.writeFile(file, JSON.stringify(secrets, null, 2), "utf8");
  return { file, secrets };
}
