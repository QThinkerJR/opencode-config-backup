# opencode-config-backup

**English** · [简体中文](./README.zh.md)

> Back up and migrate your entire OpenCode **global** customization set — agents, commands, skills, prompt templates, plugins, MCP servers, themes, and CLI settings — into one portable folder that restores on any machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![OpenCode Skill](https://img.shields.io/badge/OpenCode-Skill-blueviolet.svg)](https://opencode.ai)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey.svg)](#requirements)

`opencode-config-backup` is an [OpenCode](https://opencode.ai) **V2-native** Skill that snapshots everything that makes your OpenCode environment *yours* into a self-restoring bundle. It handles the parts a plain file copy gets wrong: local plugin directories, npm/git/TUI plugins, MCP command portability, JSONC config coexistence, themes, prompt templates, and secrets.

The migration is a **confirmation loop**, not a one-shot write:

```text
scan → plan → show → your feedback → revised plan → show diff → confirm → build → verify
```

You always see what will be copied, installed, removed, or redacted before anything is written. You can choose options or type free-form changes until the plan is right.

---

## Why

OpenCode V2 spread customization across many places:

- `~/.config/opencode/opencode.json(c)` — plugins, MCPs, agents, commands, providers, permissions.
- `~/.config/opencode/agents/`, `agent/`, `mode/`, `modes/` — Markdown agents.
- `~/.config/opencode/commands/`, `command/` — Markdown prompt templates.
- `~/.config/opencode/skills/`, `skill/` — skills with scripts and references.
- `~/.config/opencode/plugins/` and local plugin directories — server, TUI, and GUI parts.
- `~/.config/opencode/themes/` — custom terminal themes.
- `~/.config/opencode/cli.json` — theme, keybinds, TUI plugins, session preferences.
- `~/.agents/skills/` and `~/.claude/skills/` — shared skill trees.
- OpenCode credential storage (legacy `auth.json` or V2 SQLite) — deliberately **not** copied.

Rebuilding that by hand on a new laptop is tedious. Worse, copying it verbatim breaks because configs contain absolute paths such as `C:/dev/my-mcp-server`, Windows-only `cmd /c` wrappers, managed binaries, and secrets.

This Skill turns it into **one portable bundle**:

- **Classifies** every extension as copy, install, managed, derived, or manual.
- **Relocates** local plugin directories and rewrites config references.
- **Normalizes** platform-specific MCP commands and `cwd` values.
- **Redacts** secrets while preserving `{env:...}` / `{file:...}` references.
- **Confirms before writing**, with options plus free-form feedback.
- **Verifies** the bundle and the restored environment.

## How it works

```text
 your machine                              any other machine
┌──────────────────────┐                  ┌──────────────────────┐
│ ~/.config/opencode   │    ┌────────┐    │ ~/.config/opencode   │
│   agents/            │    │  PLAN  │    │   agents/            │
│   commands/          │ ─▶ │   ↓    │ ─▶ │   commands/          │
│   skills/            │    │ BUILD  │    │   skills/            │
│   plugins/ (local)   │    │   ↓    │    │   plugins/           │
│   themes/            │    │ VERIFY │    │   themes/            │
│   cli.json           │    └────────┘    │   cli.json           │
│ ~/.agents/skills     │         │        │ ~/.agents/skills     │
└──────────────────────┘         │        └──────────────────────┘
                                 ▼
                         RESTORE.md + tools/restore.mjs
```

1. **Plan** — read-only discovery; produces `plan.json` and `plan.md`.
2. **Confirm** — show the plan; accept feedback; repeat until approved.
3. **Build** — only accepts the approved plan hash; writes the bundle.
4. **Verify** — checksum, secret, path, and structure checks.
5. **Restore** — open `RESTORE.md` on the target; same confirmation loop.

## Install

### Via the `skills` CLI (recommended)

```bash
npx skills add QThinkerJR/opencode-config-backup
```

### Via git clone

```bash
git clone https://github.com/QThinkerJR/opencode-config-backup.git \
  ~/.config/opencode/skills/opencode-config-backup
```

On Windows, use `%USERPROFILE%\.config\opencode\skills\opencode-config-backup`.

After installing, ask OpenCode to use the Skill. No restart is required in V2; config hot-reloads.

This project is distributed as a GitHub Skill; no npm package is published. The `npx` above runs the third-party `skills` installer.

## Usage — Back up / migrate

In any OpenCode session:

> Back up my OpenCode global config.

or:

> Migrate all my OpenCode customizations to a new machine.

The Skill will:

1. Locate the config directory with `opencode debug paths` and detect V1/V2/hybrid config.
2. Discover config files, agents, commands, skills, plugins, MCPs, themes, plugin data, and shared skills.
3. Cross-check installed plugins/MCPs/agents/auth with OpenCode.
4. Produce a plan and ask for confirmation.
5. Build `opencode-migration-<timestamp>/` and verify it.

Default output is chosen during the confirmation loop; use the `--out` path you approve.

### What the confirmation looks like

```text
Plan ready: 38 items, 5 installs/auth steps, 3 secret labels.
Output: D:\backups\opencode-migration-20261124\

1. Confirm and export (Recommended)
2. Adjust
3. Cancel

You can also type changes, for example:
"Exclude the example-mcp server; include ~/.claude/skills."
```

Every round shows what changed. Nothing is written to the final bundle until you confirm. The approved plan hash is embedded in the build command, so what you saw is what gets built.

## Usage — Restore

On the target machine:

> Restore my OpenCode config from `D:\backups\opencode-migration-20261124\`.

Open the bundle's `RESTORE.md` and ask the agent to execute it. The bundle is self-contained: it includes `tools/restore.mjs`, so the Skill does not need to be installed on the target.

The restore:

- detects the local config directory at runtime (`OPENCODE_CONFIG_DIR` is used when set); a non-default target requires `--allow-custom-target`;
- shows a dry-run plan with create/overwrite/skip and `.restore-backups` paths;
- accepts feedback and re-plans until confirmed;
- re-supplies literal secrets from a temporary JSON file (preferred: environment variables);
- installs server plugins, leaves TUI plugins in `cli.json`, and restores local plugin directories;
- prompts for MCP OAuth and provider login;
- verifies with `opencode debug config`, `plugin list`, `mcp list`, `debug agents`, and `reload`.

## What gets backed up

| Source | Captured |
|---|---|
| `~/.config/opencode/opencode.json(c)` | V2/V1 config, after structural redaction and portable rewrites |
| `~/.config/opencode/cli.json` | Theme, keybinds, TUI plugins, session preferences |
| `~/.config/opencode/tui.json(c)` | V1 legacy CLI config, preserved with warnings |
| `~/.config/opencode/AGENTS.md` | Global instructions |
| `agents/`, `agent/`, `mode/`, `modes/` | Markdown agents |
| `commands/`, `command/` | Markdown prompt templates |
| `skills/`, `skill/` | Skill trees with scripts/references |
| `plugins/` + local plugin dirs | V2 server/TUI/GUI plugins; `node_modules`/`.git` excluded |
| `themes/` | Custom themes |
| Plugin data dirs | Small text-only user customizations (for example `my-plugin/`) |
| `~/.agents/skills/` + lockfile | Cross-agent installable/custom skills |
| `~/.claude/skills/` | Optional shared Claude skills |
| Config `mcp.servers` | Local/remote MCP definitions, disabled state, env/header references |
| Config `providers` | Provider/model config; credentials are not copied |
| `opencode auth list` | Provider/auth method requirements only |

## What is excluded

- Project-level `opencode.json(c)` / `.opencode/` (global-only by default).
- System/managed config (`/etc/opencode`, `%ProgramData%\opencode`, macOS managed preferences).
- Desktop app data, sessions, database, logs, snapshots, shell history, tool output.
- Credentials/OAuth tokens and `service.json` (machine-specific password).
- Credential files such as `.npmrc`, `.yarnrc*`, `.pypirc`, `.netrc`, and `.git-credentials`.
- `node_modules/`, `.git/`, `.bak`, write-locks, caches, DB files.
- `~/.opencode/` (CLI install data).
- Credentials by default; restore re-authenticates.

## Local plugins

Local plugin directories are first-class:

- Copy the package directory without `node_modules` / `.git`.
- Keep `package.json`, exports entrypoints, `src`, `dist`, `gui-experimental.cjs`, and lockfiles.
- If `package.json` declares `files`, honor it plus `exports` targets, package metadata, lockfiles, and docs; otherwise copy the package tree except noise.
- Rewrite the config entry to `./plugins/<slug>`.
- Detect `@opencode/plugin` (V2) vs `@opencode-ai/plugin` (V1); V1 plugins are flagged as incompatible and are **not** claimed to work in V2.
- A single-file local plugin path is not valid in V2; it becomes a manual action.

## MCP portability

The plan analyzes each MCP command:

| Shape | Action |
|---|---|
| `npx` / `bunx` / `uvx` / `docker` | Keep; package manager fetches at runtime |
| `cmd /c npx ...` | Rewrite to the inner command |
| Absolute path to a package manager | Rewrite to the bare package manager |
| Absolute path inside OpenCode's packages/cache | Remove from portable config; OpenCode manages it |
| Other absolute binary | Remove from portable config; emit a manual action |
| Bare binary | Keep command; emit a manual action to install it |
| Remote URL | Keep; emit an MCP auth note |

Disabled servers stay disabled. `cwd` is rewritten to `~` or kept only when portable.

## Secrets and auth

- Preserve `{env:NAME}` / `{file:path}` — they are safe indirection.
- Redact literal API keys, tokens, passwords, authorization/cookie headers, secret command arguments, values under secret-like flat/numeric key names, URLs with userinfo/secret query parameters, and PEM private-key files (`.pem`, `.key`, `id_*`).
- Record only labels/pointers in the plan and manifest; labels include the target file plus JSON pointer.
- Never copy credential storage, `service.json`, or credential files such as `.npmrc`, `.yarnrc*`, `.pypirc`, `.netrc`, and `.git-credentials`.
- Lockfiles are copied for local plugins but checked for URL userinfo and known token prefixes; the build fails instead of rewriting them.
- Build failures remove their partial output directory, so unredacted copies are not left on disk.
- At restore, prefer environment variables; for literal secrets, use a temporary secrets JSON file. The restore helper stages content, refuses to write while a placeholder remains, and backs up replaced content under `.restore-backups`.
- Re-authenticate providers with `opencode auth login` / `/connect`, and remote MCPs with `/mcps` or `opencode mcp auth`.

## The generated bundle

```text
opencode-migration-<timestamp>/
├── RESTORE.md          # Self-running restore prompt
├── manifest.json       # Items, extensions, rewrites, secrets, auth, checksums
├── checksums.json      # Integrity hashes
├── tools/
│   └── restore.mjs     # Self-contained restore helper
└── files/              # Mirrored + relocated + redacted content
    ├── opencode.jsonc
    ├── cli.json
    ├── AGENTS.md
    ├── agents/
    ├── commands/
    ├── skills/
    ├── plugins/
    ├── themes/
    └── _shared/
        └── agents-skills/
```

- **`RESTORE.md`** — the prompt you run on the target. It includes the confirmation loop, backup behavior, plugin/MCP/auth steps, and verification.
- **`manifest.json`** — source of truth: physical items, logical extensions, rewrites, secret labels, manual actions, auth requirements, checksums.
- **`files/`** — user content, redacted where needed; local plugin paths relocated.
- **`checksums.json`** — every shipped file except `manifest.json`/`checksums.json`.

## Manifest at a glance

```jsonc
{
  "schema_version": 2,
  "bundle": {
    "created_at": "2026-11-24T...",
    "source": { "opencode_version": "2.4.1", "config_format": "v2", "os": "win32" },
    "item_count": 38,
    "plan_hash": "..."
  },
  "items": [
    {
      "id": "plugin:local:plugins/my-local-plugin",
      "type": "plugin",
      "classification": "custom",
      "target_path": "plugins/my-local-plugin",
      "bundle_path": "files/plugins/my-local-plugin",
      "metadata": { "api": "v2", "relocated": true }
    }
  ],
  "extensions": [],
  "rewrites": [],
  "secret_refs": [],
  "manual_actions": [],
  "auth": { "credentials_included": false, "providers": [], "environment": [] },
  "warnings": [],
  "checksums": {},
  "verification": { "commands": [] }
}
```

## Requirements

- [OpenCode](https://opencode.ai) V2 (CLI and/or Desktop). V1 config is read best-effort.
- Node.js 22+ for the plan/build/verify/restore helpers.
- Git for git-based plugins or skills cloned from Git.
- Package managers used by your MCPs/plugins (`npx`, `bunx`, `uvx`, `docker`, ...).

## Safety

- **Plan hash approval** — the build refuses a stale or missing hash.
- **No final writes before confirmation** — the plan is read-only; staging is temporary.
- **Backups before overwrite** — replaced files/directories go under `<config-dir>/.restore-backups/<timestamp>/`.
- **Idempotent** — identical files/directories are skipped.
- **Fail closed** — checksum mismatch, missing secrets, invalid JSONC, unsafe paths, or unresolved placeholders stop the build/restore.
- **Fail soft** — plugin downloads and MCP logins may fail; they are recorded and summarized.
- **Verification** — bundle self-check + OpenCode probes after restore.

## V1 → V2 notes

- V2 still reads supported V1 config fields and file layouts.
- V2 plugin implementations are a breaking change; V1 local plugins are flagged, not silently restored.
- `tui.json(c)` is legacy; V2 migrates it to `cli.json` when `cli.json` is absent. Do not restore it over an existing `cli.json`.
- No automatic config conversion is performed. To modernize V1 fields, ask OpenCode to migrate the config separately after restoring.

## Limitations

- Global scope only by default; project `.opencode/` is out of scope.
- Credentials are not migrated by default.
- Plugin/skill code files, binary files, binary key stores (`.p12`, `.pfx`, `.jks`), and raw DER key material without PEM armor are copied as-is and are not scanned for hardcoded secrets.
- Lockfiles are copied for local plugins and only checked for URL userinfo and known token prefixes.
- Shared skill trees are cross-agent data; mention this category bleed.
- Bare-binary MCPs and non-portable absolute commands become manual actions.
- Large files/trees are skipped or warned according to size limits.
- Reproducibility of floating versions (`@latest`, ranges) is intentionally preserved; restore does not pin them.
- The restore helper handles file/config/secret mechanics; plugin installation, MCP OAuth, and provider login are agent/user steps.

## Development

```bash
npm test
```

CI runs the same test suite on `ubuntu-latest` and `windows-latest` with Node 22.

Tests cover JSONC editing, redaction (config, text, command/header, PEM), V1/V2/hybrid planning, local plugin relocation, MCP portability, directory home-path rewriting, credential-file exclusion, bundle verification, restore idempotency/backups, symlink merge behavior, and missing-secret failure.

Fixtures under `tests/fixtures/` use synthetic credentials and paths only; see `tests/fixtures/README.md`.

## License

[MIT](./LICENSE) © QThinker
