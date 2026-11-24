#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value), null, 2), "utf8").digest("hex");
}

async function main() {
  const argv = process.argv.slice(2);
  let planPath = null;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") planPath = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/rehash-plan.mjs --plan <plan.json> [--out <plan.json>]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!planPath) throw new Error("--plan is required");
  const source = path.resolve(planPath);
  const plan = JSON.parse(await fs.readFile(source, "utf8"));
  if (plan.schema_version !== 2) throw new Error(`unsupported plan schema: ${plan.schema_version}`);
  delete plan.plan_hash;
  plan.plan_hash = hash(plan);
  const destination = path.resolve(out ?? source);
  await fs.writeFile(destination, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`Plan hash: ${plan.plan_hash}`);
  console.log(`Plan: ${destination}`);
}

main().catch((error) => {
  console.error(`rehash failed: ${error.stack || error.message}`);
  process.exit(1);
});
