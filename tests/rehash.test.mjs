import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { copyFixture, planFixture, runNode, runNodeStatus } from "./helpers.mjs";

test("edited plans require a new hash before build", async (t) => {
  const fixture = await copyFixture("v2");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { out, plan } = await planFixture(fixture);
  const planPath = path.join(out, "plan.json");
  const edited = JSON.parse(await fs.readFile(planPath, "utf8"));
  edited.items = edited.items.filter((item) => item.id !== "command:commands/audit.md");
  await fs.writeFile(planPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");

  const stale = runNodeStatus("scripts/build.mjs", [
    "--plan",
    planPath,
    "--out",
    path.join(fixture.root, "stale-bundle"),
    "--approve",
    plan.plan_hash,
  ]);
  assert.notEqual(stale.status, 0);

  const rehash = runNode("scripts/rehash-plan.mjs", ["--plan", planPath]);
  const newHash = /Plan hash: ([a-f0-9]+)/.exec(rehash)?.[1];
  assert.ok(newHash);
  assert.notEqual(newHash, plan.plan_hash);

  runNode("scripts/build.mjs", [
    "--plan",
    planPath,
    "--out",
    path.join(fixture.root, "bundle"),
    "--approve",
    newHash,
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(fixture.root, "bundle", "manifest.json"), "utf8"));
  assert.ok(!manifest.items.some((item) => item.id === "command:commands/audit.md"));
});
