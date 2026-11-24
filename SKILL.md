---
name: opencode-config-backup
description: "Back up and migrate a user's OpenCode GLOBAL customizations into a portable, platform-independent bundle. Use when the user wants to back up, export, snapshot, transfer, migrate, or restore OpenCode V2 configuration and extensions: config files, agents, commands, skills, prompt templates, plugins (npm/git/local/TUI/GUI), MCP servers, themes, CLI settings, and auth requirements. Produces plan.json + manifest.json + RESTORE.md + files/; uses a confirmation loop with options and free-form feedback; relocates local plugins; redacts secrets; never migrates credentials by default."
license: MIT
compatibility: Requires OpenCode V2 (CLI and/or Desktop) and Node.js 22+. Git is needed for git-based plugins or skills cloned from Git. V1 config is read on a best-effort basis; V1 plugin implementations do not run in V2.
metadata:
  author: qthinker
  version: "2.0.0"
---

# OpenCode Global Config Backup & Migration

Create a portable bundle of a user's **global** OpenCode customization set, then restore it on another machine, OS, or client. The skill is V2-native and V1-tolerant.

The bundle contains:

- `RESTORE.md` — a self-running restore prompt with the same confirmation loop.
- `manifest.json` — machine-readable record of physical items, logical extensions, rewrites, secret references, manual actions, auth requirements, checksums.
- `files/` — mirrored and relocated user content, redacted where needed.
- `checksums.json` — integrity hashes.
- `tools/restore.mjs` — self-contained file/directory restore helper.

## Scope

**In scope (default):**

- The OpenCode global config directory: `~/.config/opencode` (`XDG_CONFIG_HOME` respected).
- Root config files: `opencode.json(c)`, `cli.json`, `AGENTS.md`, plugin config files, and other root `*.json(c)` / `*.md` files that are not runtime noise.
- Agents: `agents/`, `agent/`, `mode/`, `modes/` (V2 discovers all four).
- Commands: `commands/`, `command/`.
- Skills: `skills/`, `skill/`; `~/.agents/skills/` and `~/.agents/.skill-lock.json`; `~/.claude/skills/` only with `--include-claude-skills`.
- Plugins: `plugins/` array/`plugin` legacy array, global `plugins/` directory, local plugin directories, TUI-only plugins in `cli.json`, GUI parts inside local plugins.
- MCP servers: `mcp.servers` and legacy direct `mcp` entries, local and remote.
- Themes: `themes/*.json` and the `cli.json` theme selection.
- Prompt templates: command Markdown bodies, agent bodies/system prompts, `AGENTS.md`, configured instructions, plugin data directories such as `my-plugin/append.md`.
- Auth requirements only: provider IDs, methods, environment variable names. Credentials are **not** copied.

**Out of scope (default):**

- Project-level `opencode.json(c)` and `.opencode/` directories.
- System/managed config (`/etc/opencode`, `%ProgramData%\opencode`, macOS managed preferences).
- Desktop app-data, sessions, database, logs, snapshots, shell history, tool output.
- `~/.opencode/` (CLI install data) and `node_modules/`, `.git/`, `.bak`, lock files at the config root.
- Credential storage (legacy `auth.json` or V2 SQLite) and `service.json` (contains a machine-specific password).
- Credential files such as `.npmrc`, `.yarnrc*`, `.pypirc`, `.netrc`, and `.git-credentials`.
- OAuth MCP credentials; restore re-authenticates.

Global shared skill trees are included because OpenCode consumes them; note the category bleed to the user. `~/.claude/skills` is opt-in.

## Architecture

```text
discover 鈹€鈹€鈻?plan.json 鈹€鈹€鈻?confirmation loop 鈹€鈹€鈻?build 鈹€鈹€鈻?verify
                鈻?                 鈹?                鈹斺攢鈹€ feedback 鈼€鈹€鈹€鈹€鈹€鈹€鈹?```

1. **Discover/plan** with `scripts/plan.mjs`. Read-only. Produces `plan.json` + `plan.md`; no final bundle yet.
2. **Confirmation loop** with the `question` tool. Show options and accept free-form feedback. Apply feedback, regenerate the plan, show the diff, and ask again until the user confirms.
3. **Build** with `scripts/build.mjs`. Only accepts the exact `plan_hash` the user approved. Writes the bundle.
4. **Verify** with `scripts/verify-bundle.mjs`. Build runs it automatically and refuses to ship a bad bundle.
5. **Restore** with the bundle's `RESTORE.md` and `tools/restore.mjs`; use the same confirmation loop.

## Non-negotiable rules

1. **No final writes before confirmation.** The plan stage may write only `plan.json`/`plan.md` (and optional staging under a temp directory). Never write the final bundle until the user confirms.
2. **One confirmation loop, no separate "review mode".** Every export uses the same plan → feedback → re-plan → confirm protocol. The user can always type changes instead of choosing an option.
3. **Never store secret values in the plan or manifest.** Record only pointers, key names, and labels. Read secret values only at restore time, preferably from environment variables or a temporary secrets file.
4. **Never migrate credentials by default.** credential storage is out of scope. Record provider requirements and prompt `opencode auth login` or environment variables on restore.
5. **Do not restore machine-specific absolute paths verbatim.** Local plugin directories are copied and relocated; managed MCP binaries are removed; non-portable manual MCPs are removed and surfaced as manual actions; `cwd` is normalized to `~` or `.`.
6. **Preserve V2 config semantics.** `opencode.json(c)` is edited structurally (JSONC-aware) so comments and formatting survive. Do not merge all config files into one.
7. **Fail closed on safety.** Checksum mismatch, unresolved secret, invalid JSONC, or an unsafe target path stops the restore/build. Network failures for plugins/MCPs fail soft and are summarized.
8. **Do not print secrets into the conversation.** `opencode debug agents` prints system prompts and `opencode debug config` may contain sensitive values; parse only the fields you need.

## Step 0 — Detect the environment

Prefer OpenCode's own commands; fall back to XDG paths.

```bash
opencode debug paths
opencode --version
opencode debug config
opencode plugin list --builtin
opencode mcp list
opencode debug agents
opencode auth list
```

Rules:

- Resolve the config directory from `opencode debug paths` (`config` line). Fallback: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
- Run probes from a neutral directory (the user's home) or filter to the global config. Do not accidentally include a project's `.opencode`.
- `opencode plugin list` and `plugin check` are read-only. `plugin add`, `plugin remove`, and `plugin update` mutate the user's configuration; never run them while enumerating.
- `auth list` is safe; never run `auth export` in the agent shell because it prints secrets.
- If Desktop is installed, its app-data is runtime data; only the global config is backed up.

## Step 1 — Generate the plan

```bash
node scripts/plan.mjs \
  --config "<config-dir>" \
  --home "<home-dir>" \
  --out "<plan-dir>" \
  --opencode
```

Useful flags:

- `--opencode` — probe installed plugins, MCP status, derived agents, and auth methods. Recommended when the CLI is available.
- `--include-claude-skills` — include `~/.claude/skills` (shared with Claude Code).
- `--exclude <id,name or target>` — exclude an item; repeat or comma-separate.
- `--max-item-mb` / `--max-total-mb` — size limits.
- `--json` — print the plan to stdout as well as writing files.

Then read `plan.json` and `plan.md`. The plan contains:

- `items` — physical files/directories to copy, with `source_path`, `target_path`, `bundle_path`, classification, and optional rewrites.
- `extensions` — logical agents, commands, skills, plugins, MCPs, themes; includes `providedBy`/`defined_in`.
- `rewrites` — structural config edits (local plugin relocation, MCP command/cwd normalization, removal of managed/non-portable MCPs).
- `secret_refs` — pointers and labels only; `kind` distinguishes actual values from `{env:...}`/`{file:...}` references.
- `manual_actions` — bare binaries, non-portable MCPs, auth, external references, instructions, skill catalogs.
- `auth` — provider requirements and environment variable names.
- `warnings` — V1 compatibility, config coexistence, plugin data skips, size limits.

## Step 2 — Confirmation loop (required)

Use the `question` tool to show a compact plan and accept feedback. Do not add a separate "free-form" option: the question tool adds it automatically.

Suggested payload:

```text
Question: "Plan ready: 38 items, 5 extensions need install/auth, 3 secrets.
Output will be <path>. Confirm export?"

Options:
1. Confirm and export (Recommended)
2. Adjust
3. Cancel
```

The user may instead type free-form feedback, for example:

- "Exclude the `example-mcp` server."
- "Include my local plugin source, but not its tests."
- "Also include `~/.claude/skills`."
- "Do not copy the theme; keep the current one."
- "Output to D:\backups\opencode instead."

Feedback handling:

1. Translate the feedback into structured plan changes.
2. For common cases, rerun `plan.mjs` with `--exclude` or `--include-claude-skills`.
3. For changes not covered by flags, edit `plan.json` with the file tools and then recompute the hash:

   ```bash
   node scripts/rehash-plan.mjs --plan "<plan-dir>/plan.json"
   ```

4. Show **what changed** since the previous round: added/removed items, classification changes, redaction changes, output path, manual actions.
5. Ask again. Repeat until the user selects **Confirm and export** or **Cancel**.

Never proceed because the user selected "Adjust" without feedback; ask a targeted follow-up. If a request conflicts with a safety rule (credentials, `service.json`, an unsafe path), explain the risk and require an explicit override; still do not copy credentials.

If the user wants to inspect actual files, generate a staging bundle in a temp directory and show the file tree or a diff. Do not promote staging to the final output until confirmation. Clean staging on cancel.

## Step 3 — Build and verify

After confirmation, run with the exact plan hash:

```bash
node scripts/build.mjs \
  --plan "<plan-dir>/plan.json" \
  --out "<bundle-dir>" \
  --approve "<plan_hash>"
```

The build:

- refuses a stale/missing approval hash;
- rejects an output inside the source config directory;
- verifies source hashes before editing;
- copies local plugin directories without `node_modules`/`.git`, preserving `package.json`, `dist`, and lockfiles;
- rewrites local plugin paths to `./plugins/<slug>`;
- normalizes command wrappers and `cwd`;
- removes OpenCode-managed and non-portable MCP entries, recording manual actions;
- redacts values and preserves `{env:...}`/`{file:...}` references;
- generates `manifest.json`, `RESTORE.md`, `checksums.json`, and `tools/restore.mjs`;
- runs `verify-bundle.mjs` and fails on errors.

Then report:

- bundle path, item/extension counts;
- secret labels to re-supply (never values);
- manual actions;
- warnings;
- `plan_hash`.

## Step 4 — Restore

On the target machine, open the bundle's `RESTORE.md` in an OpenCode session and execute it. The restore prompt is self-contained; the skill does not need to be installed there.

Restore workflow:

1. Detect the target config directory with `opencode debug paths`.
2. `node tools/restore.mjs --bundle . --target "<config-dir>" --dry-run` (use `--allow-custom-target` only when intentionally restoring to a non-default config directory; `--target` defaults to `OPENCODE_CONFIG_DIR` when set, otherwise `~/.config/opencode`)
3. Show the plan (create/overwrite/skip, `.restore-backups` copies, missing secrets, plugin installs, MCP auth, manual actions). Use the `question` tool with options plus free-form feedback; repeat until confirmed.
4. For literal secrets, create a temporary JSON file mapping each `<REDACTED:label>` label to its value and pass `--secrets <file>`. Prefer `{env:NAME}` references and environment variables; never paste secret values into chat.
5. Apply with the exact plan hash:

   ```bash
   node tools/restore.mjs --bundle . --target "<config-dir>" --secrets "<secrets.json>" --approve "<restore-plan-hash>"
   ```

6. Install server plugins from `manifest.extensions` where `type=plugin`, `classification=installable`, and `surfaces` contains `server`; run their `install_cmd`. TUI-only plugins are already in `cli.json`; do not add them to `opencode.json`.
7. Restore local plugin dependencies only if `package.json` declares runtime dependencies not provided by OpenCode.
8. Check MCPs with `opencode mcp list`; preserve disabled servers; authenticate remote servers via `/mcps` or `opencode mcp auth`, not through a background shell.
9. Prompt for auth providers via `opencode auth login` or environment variables.
10. Verify with the commands in `RESTORE.md`; ensure no `<REDACTED:...>` remains.

The restore helper stages content, rejects unresolved placeholders, and backs up replaced files/directories under `<config-dir>/.restore-backups/<timestamp>/`. It skips identical content and fails before writing if a required secret is missing.

## What is classified how

- **`config`** — root config files, copied after structural redaction/rewrite.
- **`custom`** — user-authored agents, commands, skills, themes, plugin data, local plugins.
- **`installable`** — npm/git plugins and package-manager MCPs; restore installs or lets the package manager fetch them.
- **`managed`** — MCP plugins/binaries managed by OpenCode (for example an OpenCode-installed helper); removed from the portable config, recorded for the target.
- **`derived`** — plugin-provided agents/MCPs/plugins discovered by `opencode` probes; not copied, verified after restore.
- **`manual`** — bare binaries, non-portable absolute-path MCPs, external references/instructions, remote skill catalogs.
- **`directive`** — plugin disable/wildcard entries (`-name`, `*`); preserved as directives, never installed.
- **`state`** — `service.json`, credential storage, credential files (`.npmrc`, `.netrc`, ...), DB/log/snapshot/write-lock files; never copied.

See `references/inventory-rules.md` for the full per-type matrix.

## Secret policy (summary)

- Preserve `{env:NAME}` and `{file:path}` references; they are indirection, not secrets.
- Redact literal values under secret-like keys, authorization/cookie headers, command/header arguments, token-shaped strings, PEM private-key files, and known prefixes (`sk-`, `ghp_`, `AKIA`, `xox...`).
- Do not over-redact plain environment values such as `LOG_LEVEL=info`.
- Store only JSON pointers/key names/labels in the plan/manifest.
- Never copy credential storage (`auth.json` or V2 SQLite), `service.json`, or credential files such as `.npmrc`/`.netrc`.
- Build re-scans the bundle, rejects credentials in lockfiles, and removes its partial output on failure.

See `references/secret-policy.md`.

## V1 → V2 compatibility

- V2 reads supported V1 config fields and file layouts: `agent/`, `modes/`, `command/`, `plugin`, direct `mcp` entries, `tui.json(c)`.
- V2 **does not run V1 plugin implementations**. Local plugins are inspected; `@opencode-ai/plugin` dependencies produce a `V1_PLUGIN_API` warning. Do not claim they will load; port them first.
- `tui.json(c)` is legacy CLI config. V2 auto-migrates it to `cli.json` when `cli.json` is absent. Do not restore `tui.json` over an existing `cli.json`.
- No automatic V1 → V2 config conversion is performed; the bundle preserves behavior and flags deprecated fields.

## Gotchas

- `opencode plugin add/remove/update` mutate global config; `plugin list/check` are read-only. Never enumerate by running `add`.
- `opencode auth export` prints secrets. Use it only in a user-controlled terminal, never in an agent transcript.
- `opencode mcp auth` is interactive; use `/mcps` or the user-facing flow.
- V2 config hot-reloads; use `opencode reload` (or `/reload`) if needed. Restart the service only for local plugin dependency/native changes.
- `opencode debug agents` prints full system prompts; parse only IDs/modes/descriptions.
- The bundle must live outside the config directory; the build rejects an output inside it.
- A local plugin directory must remain a directory in V2. A single-file V1 plugin is a manual action, not a portable plugin.
- Shared `~/.agents/skills` and `~/.claude/skills` are cross-agent data; mention this category bleed.
- If Node.js is unavailable, use the file tools and the rules in `references/` as a manual fallback. The plan/build/restore scripts are convenience and determinism tools, not a hard runtime dependency for reading the bundle.

## References

- `references/confirmation-protocol.md` — exact question payloads, feedback mapping, plan hash, staging, cancellation.
- `references/inventory-rules.md` — discovery paths, classifications, V1/V2, local plugin relocation, MCP command rules, exclusions.
- `references/secret-policy.md` — redaction rules, references, auth/service handling, restore prompts.
- `references/manifest-schema.md` — plan.json and manifest.json schema v2, fields, compatibility.
- `references/restore-template.md` — the self-running restore prompt.
