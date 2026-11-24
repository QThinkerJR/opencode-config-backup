# Inventory Rules (OpenCode V2, V1-tolerant)

These are the discovery and classification rules used by `scripts/plan.mjs`. They follow OpenCode V2 documentation and remain tolerant of supported V1 layouts.

## 1. Locations

### Global config

- `opencode debug paths` → `config` line (preferred).
- Fallback: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.

### Root config files

Capture root files matching `*.json`, `*.jsonc`, `*.md`, `*.mdx`, except noise/state:

- Capture: `opencode.json(c)`, `cli.json`, `tui.json(c)`, `AGENTS.md`, plugin config files (for example `my-plugin.json`), other root user config.
- Exclude: `service.json`, `auth.json`, `package.json`, `package-lock.json`, `bun.lock`, `bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, `.gitignore`, `.npmrc`, `.yarnrc*`, `.pypirc`, `.netrc`, `.git-credentials`, `*.bak*`, `*.write-lock`, `*.db*`, logs, `node_modules`, `.git`.
- `service.json` is state and contains a machine-specific password. Never copy it.
- Credential storage may be a legacy `auth.json` or the V2 SQLite database. Never copy it by default. Credential files such as `.npmrc`, `.yarnrc*`, `.pypirc`, `.netrc`, and `.git-credentials` are never copied.

### Extension directories

Capture these trees if present:

| Type | Directories |
|---|---|
| Agents | `agents/`, `agent/`, `mode/`, `modes/` |
| Commands | `commands/`, `command/` |
| Skills | `skills/`, `skill/` |
| Global discovered plugins | `plugins/` |
| Themes | `themes/` |

V2 prefers plural names but discovers the V1 singular names too.

### Shared skills

- `~/.agents/skills/` + `~/.agents/.skill-lock.json` — default; OpenCode V2 compatibility source.
- `~/.claude/skills/` — opt-in with `--include-claude-skills`; shared with Claude Code.
- `~/.claude/CLAUDE.md` — a fallback for a missing global `AGENTS.md`; record only, do not copy by default to avoid cross-agent bleed.

### Plugin data directories

Unknown top-level directories under the config dir may be plugin-owned data (for example `my-plugin/`). Include a directory only when:

- it is not a known extension/state directory;
- it is not hidden, a write-lock, or a cache;
- it is text-only;
- no file is larger than 2 MB and the tree is under 5 MB.

Otherwise warn and skip. Example: `my-plugin/append.md` is a user prompt customization and should be included.

## 2. Config documents

- Parse every root `*.json`/`*.jsonc` with a JSONC-aware parser; never reserialize the whole file. Keep comments and formatting.
- Both `opencode.json` and `opencode.jsonc` may exist and both are active. Preserve both; warn about coexistence and duplicate plugin/MCP IDs.
- `cli.json` is V2 CLI config. `tui.json(c)` is V1 legacy; V2 auto-migrates when `cli.json` is absent. If both exist, do not restore `tui.json` over `cli.json`.
- Detect config format from `opencode.json(c)` only:
  - V2 keys: `plugins`, `agents`, `commands`, `providers`, `permissions`, `snapshots`, `media`, `mcp.servers`.
  - V1 keys: `plugin`, `agent`, `command`, `provider`, `permission`, `snapshot`, `attachment`, direct `mcp` entries.
  - Both → `hybrid`; neither → `unknown`.
- Do not auto-convert V1 to V2. V2 reads supported V1 fields; conversion is a separate, optional modernization step.

## 3. Plugins

### Where

- `plugins` array in `opencode.json(c)`.
- legacy `plugin` array in V1 files.
- `plugins` array in `cli.json` for TUI-only plugins.
- legacy `plugin` array in `tui.json(c)`.
- global `plugins/` directory (auto-discovered by V2).
- local plugin directories referenced from config.

### Forms

| Form | Classification | Restore |
|---|---|---|
| `"npm-package"` | installable | `opencode plugin add npm-package` |
| `"npm-package@1.2.3"` / range / tag | installable | preserve the declared spec verbatim |
| `"github:owner/repo"`, `git+...`, `.git` URL | installable git | `opencode plugin add <spec>` |
| `"./plugins/local"`, `"../shared/plugin"`, absolute path, `file://` | local custom | copy directory, relocate to `./plugins/<slug>`, rewrite config |
| `{ "package": "...", "options": {...} }` | same as package | preserve options; redact secrets in options |
| `["package", {options}]` (V1 tuple) | same as package | preserve options |
| `"-name"` | directive (disabled) | keep the directive; do not install |
| `"*"`, `".*"`, `"team.*"` | directive (wildcard) | keep; do not install |

### Local plugin relocation

V2 requires configured local plugin paths to be directories.

- If the path is already inside the config dir: keep a config-relative path (for example `./plugins/foo`); copy the directory to the same target.
- If the path is outside the config dir: copy to `files/plugins/<slug>` and rewrite the config entry to `./plugins/<slug>`.
- Slug source: `package.json` name, else directory basename; sanitize and dedupe.
- Copy `package.json`, exports entrypoints, `src`, `dist` (including `gui-experimental.cjs`), README, license, and lockfiles. If `package.json` declares `files`, honor it plus exports targets, package metadata, lockfiles, and docs; otherwise copy the package tree except noise and report any dropped support files.
- Exclude `node_modules`, `.git`, `.svn`, `.hg`, `*.bak`, logs, DBs, write-locks, `.gitignore`, OS metadata.
- Detect plugin API:
  - `@opencode/plugin` → V2.
  - `@opencode-ai/plugin` → V1; add `V1_PLUGIN_API` warning. Do not claim it will load in V2.
- A single-file local path is not a valid V2 plugin directory: warn and emit a manual action.
- Local plugin `options` are preserved in config and scanned for secrets.

### TUI / GUI plugins

- TUI-only packages are declared in `cli.json.plugins`; they have `surfaces: ["tui"]` and no `opencode plugin add` install command. The terminal client loads them.
- Packages in `opencode.json(c)` may contain server, TUI, GUI, and RPC parts. `surfaces` records the declaration surface; one package can be both.
- Desktop GUI parts are loaded from the same global config; app-data is not copied.

### Plugin-provided extensions

`opencode plugin list`, `opencode mcp list`, and `opencode debug agents` reveal extensions contributed by plugins. Record them as `derived` with `provided_by`/`origin: plugin-or-builtin`; do not copy them as separate files. Verify them after restore by re-running the same commands.

## 4. MCP servers

### Shapes

- V2: `mcp.servers.<name>`.
- V1: direct keys under `mcp.<name>`.
- V2 replaces `enabled` with `disabled`; preserve whichever form is in the source.
- Remote OAuth fields use V2 snake_case (`client_id`, `client_secret`, `callback_port`, `redirect_uri`).

### Local command analysis

| Command shape | Classification | Action |
|---|---|---|
| `npx`, `bunx`, `uvx`, `pnpm`, `yarn`, `docker`, `deno`, `pipx`, `uv` | installable | keep command; package manager fetches at runtime |
| `cmd /c <inner>` | installable if inner is portable | rewrite to inner; warn |
| `sh -c "<simple>"` | installable if simple | rewrite to inner; warn |
| `powershell -Command ...` | manual | unsafe to rewrite; remove non-portable entry and surface manual action |
| absolute path under `@opencode/`, `.cache/opencode`, or OpenCode data | managed | remove from portable config; let OpenCode manage it |
| absolute path to a package manager (for example `C:/.../uvx.exe`) | installable | rewrite to bare `<pm> <args>` |
| other absolute binary | manual | remove from portable config; manual action with original command |
| bare binary (for example `example-tool`) | manual | keep command; tell the user to install the binary |

For manual MCPs with absolute paths, remove the server entry from the copied config (`kind: "delete"`) and record everything known in `manual_actions`. Never leave a source-machine absolute path in a portable config.

### Other MCP fields

- `cwd`: if under home, rewrite to `~/...`; otherwise warn and remove the non-portable entry. Do not rewrite it to `.`, because V2 resolves relative `cwd` from the workspace, not the config directory.
- `environment` values: redact secret-like values; preserve plain values such as `LOG_LEVEL=info`; preserve `{env:...}`/`{file:...}`.
- `disabled`/`enabled`: preserve exactly. Do not auto-enable.
- Remote `url`, headers, OAuth: config is portable; credentials are not. Add an `mcp-auth` manual action when auth may be required.
- `pool`, `protocol`, `timeout`, `codemode`: preserve in config.
- Plugin-provided MCPs (for example `context7`, `gh_grep`) may not appear in config; record as `derived`.

## 5. Agents and commands

- File-based agents: `agents/`, `agent/`, `mode/`, `modes/`; only `.md` files.
- File-based commands: `commands/`, `command/`; only `.md` files.
- JSON forms: `agents` (V2) / `agent` (V1); `commands` (V2) / `command` (V1). The config file item covers the content; add logical extensions for preview and verification.
- Merge duplicate logical names across files/JSON into one extension with multiple `defined_in` entries.
- Agent Markdown body is the system prompt; command Markdown body is the prompt template. Both are scanned for secrets.
- V1 agent frontmatter fields (`permission`, `disable`, `prompt`, `tools`, `temperature`) are preserved and flagged as V1; V2 translates supported fields.

## 6. Skills

- Skills roots: `skills/`, `skill/`; copy the whole tree, preserving support files.
- A directory containing `SKILL.md` is one skill; do not recurse inside it for more skills.
- Root-level `.md` files are flat skills.
- Nested grouping directories are allowed; copy the tree and discover `SKILL.md` files.
- Shared roots: `~/.agents/skills`, optional `~/.claude/skills`.
- Config `skills` array (V2) / `{paths, urls}` (V1):
  - local path inside config dir → already discovered; warn if it does not exist;
  - local path outside config dir → manual action (could be project-specific);
  - HTTP catalog URL → manual action; restore re-downloads on demand.
- Preserve `.skill-lock.json` if present; it is metadata for the cross-agent skills CLI, not a V2 requirement.
- Exclude `node_modules`, `.git`, caches; enforce size limits. Symlinks are not copied and produce a `SYMLINK_SKIPPED` warning.

## 7. Themes and CLI settings

- `themes/*.json` are custom themes; the filename without `.json` is the theme name.
- `cli.json.theme.name` selects a theme. If a selected custom theme file is missing, add `THEME_MISSING`.
- Copy `cli.json` (theme, keybinds, TUI plugins, attention sounds, session settings) as config.
- If `cli.json` references local sound files or local TUI plugin directories outside the config dir, record manual actions; do not copy arbitrary audio by default.
- `tui.json(c)` is legacy; keep it but warn if `cli.json` also exists.

## 8. Instructions and references

- `instructions`: local files/globs and HTTP URLs. Local files outside the config dir are manual actions by default; HTTP URLs are recorded for re-fetch. Missing files are skipped by OpenCode.
- `references`: local directories and Git repositories. Record both; do not copy large external directories by default. Git repositories are re-cloned on restore.
- Global `AGENTS.md` is a config file and is copied/redacted. `CLAUDE.md` is a fallback only when no `AGENTS.md` exists; optional shared copy.

## 9. Exclusions and size

Never include:

- `service.json`, `auth.json`, credentials, OAuth tokens, and credential files such as `.npmrc`, `.yarnrc*`, `.pypirc`, `.netrc`, and `.git-credentials`;
- sessions, database (`opencode.db*`), logs, snapshots, shell history, tool output;
- `node_modules`, `.git`, `.svn`, `.hg`, VCS metadata;
- `*.bak*`, `.restore-backups`, `*.write-lock`, temporary/cache files;
- files above the per-item limit (default 50 MB) or trees above the total limit (default 200 MB) without explicit user approval;
- symlinks that escape the source tree (skip and warn).

Private key files (`.pem`, `.key`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`) are copied only after PEM contents are replaced with placeholders. Raw DER/binary key material without PEM armor is not scanned; exclude it or recreate it manually on the target.

## 10. Verification after restore

Run:

```bash
opencode debug config
opencode plugin list
opencode mcp list
opencode debug agents
opencode reload
```

Check:

- restored config files are listed as sources;
- expected server plugin IDs are installed;
- MCPs are connected, disabled, or awaiting auth as expected;
- expected custom agents exist;
- the selected theme file exists;
- no `<REDACTED:...>` remains;
- no source-machine absolute path remains in config files.
