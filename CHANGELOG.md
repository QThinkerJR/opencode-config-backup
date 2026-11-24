# Changelog

## 2.0.0

OpenCode V2 migration release.

### Added

- V2-native discovery: `plugins`, `mcp.servers`, `agents`, `commands`, `providers`, `skills`, `cli.json`, `themes/`.
- Plan → confirmation loop → build → verify workflow with approved plan hashes.
- Free-form feedback support through the `question` tool; no separate review mode.
- Local plugin directory relocation and config path rewriting.
- Platform-portable MCP command analysis (npx/bunx/uvx/cmd wrappers/absolute binaries).
- Removal of OpenCode-managed and non-portable MCP entries, recorded as manual actions.
- JSONC-aware structural editing that preserves comments and formatting.
- Secret redaction that preserves `{env:...}` / `{file:...}` references, redacts URL userinfo/secret query parameters, secret-like command arguments (including `-H "X-Api-Key: ..."`), Bearer/Cookie text, quoted values, PEM private-key files, and flat/numeric secret-like keys, and sanitizes plan/manifest values (`from_sha256` instead of raw rewrite values).
- Per-file secret labels (`file#pointer`, `file:line:column`) to prevent cross-file collisions.
- Atomic restore staging with `.restore-backups`, JSON escaping for `.json`/`.jsonc`, directory-wide placeholder checks, unlisted-file and schema checks.
- Restore guard against home/root targets, `~/` parent traversal, and non-default target directories without an explicit flag.
- Local plugin copy that honors `files` plus exports, or copies the package tree when no allowlist exists.
- `manifest.json` schema v2 with extensions, rewrites, secret refs, manual actions, auth, checksums.
- Self-contained `tools/restore.mjs` with dry-run, plan hash approval, `.restore-backups`, secret substitution, and idempotent skips.
- Bundle verification for checksums, unlisted files, placeholders, absolute paths, forbidden state files, remaining secrets, and credentials in lockfiles; failed builds remove their partial output.
- Tests and CI for Windows and Linux.

### Changed

- Default scope is global only; shared `~/.agents/skills` included, `~/.claude/skills` opt-in.
- Credentials are never migrated by default; restore re-authenticates.
- TUI plugins in `cli.json` are not treated as server plugins.
- `tui.json(c)` is treated as V1 legacy and warns when `cli.json` also exists.
- V1-only layouts remain readable; V1 plugin API compatibility is flagged, not assumed.

### Removed

- V1-only `npm view` classification as the primary plugin rule.
- The blanket “never run `opencode plugin`” rule; `plugin list/check` are read-only, while add/remove/update mutate.
- Copying `service.json`, credential storage, sessions, database, logs, snapshots, and root `node_modules`.
- Storing raw plugin options, MCP command values, URLs, or rewrite source values in plan/manifest.
