# Plan and Manifest Schema v2

The skill produces two related documents:

- **`plan.json`** — local, pre-confirmation. May contain absolute source paths; never contains secret values.
- **`manifest.json`** — shipped in the bundle. No absolute source paths; contains bundle paths, target paths, checksums, and labels.

Both use `schema_version: 2` and share `generator`, `source`/`bundle`, `items`, `extensions`, `rewrites`, `secret_refs`, `manual_actions`, `auth`, `warnings`.

## plan.json

```json
{
  "schema_version": 2,
  "generator": { "name": "opencode-config-backup", "version": "2.0.0" },
  "created_at": "2026-11-24T00:00:00.000Z",
  "source": {
    "opencode_version": "2.4.1",
    "config_format": "v2",
    "os": "win32",
    "shell": "powershell",
    "config_root": "<absolute source config dir>",
    "home": "<absolute source home>"
  },
  "options": {
    "scope": "global",
    "include_shared_skills": true,
    "include_claude_skills": false,
    "include_credentials": false,
    "max_item_bytes": 52428800,
    "max_total_bytes": 209715200
  },
  "items": [],
  "extensions": [],
  "rewrites": [],
  "secret_refs": [],
  "manual_actions": [],
  "auth": {
    "credentials_included": false,
    "providers": [],
    "environment": []
  },
  "opencode": { "plugins": [], "mcp": [], "agents": [] },
  "warnings": [],
  "plan_hash": "<sha256 of the plan without this field>"
}
```

`plan_hash` is the approval token. Any change to the plan (except `plan_hash`) changes it. `scripts/build.mjs` and `scripts/rehash-plan.mjs` compute it from a stable, key-sorted JSON serialization.

## manifest.json

```json
{
  "schema_version": 2,
  "generator": { "name": "opencode-config-backup", "version": "2.0.0" },
  "bundle": {
    "created_at": "2026-11-24T00:00:00.000Z",
    "source": {
      "opencode_version": "2.4.1",
      "config_format": "v2",
      "os": "win32"
    },
    "item_count": 38,
    "plan_hash": "<approved plan hash>"
  },
  "options": {},
  "items": [],
  "extensions": [],
  "rewrites": [],
  "secret_refs": [],
  "manual_actions": [],
  "auth": {},
  "warnings": [],
  "opencode": {},
  "checksums": {
    "files/opencode.jsonc": "<sha256>",
    "tools/restore.mjs": "<sha256>",
    "RESTORE.md": "<sha256>"
  },
  "verification": {
    "commands": ["opencode --version", "opencode debug config", "..."]
  }
}
```

`manifest.json` and `checksums.json` are not included in `checksums` (self-reference would be circular). `RESTORE.md`, `files/**`, and `tools/restore.mjs` are checksummed.

## items

Physical copy/install units.

```json
{
  "id": "plugin:local:plugins/my-local-plugin",
  "type": "config|agent|command|skill|skills-root|theme|plugin|plugin-data|skill-metadata|instruction",
  "name": "my-local-plugin",
  "classification": "config|custom|installable|managed|derived|manual|directive|state",
  "origin": "user|plugin|shared|builtin|external",
  "target_path": "plugins/my-local-plugin",
  "bundle_path": "files/plugins/my-local-plugin",
  "format": "json|jsonc|markdown|text|directory",
  "enabled": true,
  "size": 1234,
  "sha256": "<bundle file hash or null for directories>",
  "metadata": {
    "api": "v1|v2|unknown",
    "package_name": "my-local-plugin",
    "package_version": "1.0.0",
    "entry_files": ["index.ts", "package.json"],
    "copy_includes": ["package.json", "src", "dist"],
    "relocated": true
  },
  "defined_in": ["config:opencode.jsonc"],
  "provided_by": null,
  "warnings": []
}
```

- `target_path` is relative to the config dir, or `~/.agents/skills` / `~/.claude/skills` for shared roots.
- `bundle_path` always starts with `files/`.
- `source_path` exists only in `plan.json`, never in `manifest.json`.
- `source_hash` exists in `plan.json` for drift detection.
- `sha256` is present for file items in `manifest.json`; directories are verified through the `checksums` map.

## extensions

Logical entities, including plugin-provided and config-declared ones.

```json
{
  "type": "agent|command|skill|plugin|mcp|theme",
  "name": "reviewer",
  "classification": "custom|installable|derived|manual|remote|managed|directive",
  "origin": "user|plugin-or-builtin",
  "defined_in": ["config:opencode.jsonc"],
  "path": "/agents/reviewer",
  "bundle_item": "plugin:local:plugins/my-local-plugin",
  "provider": null,
  "surfaces": ["server"],
  "kind": "npm|git|local|directive",
  "spec": "package@1.2.3",
  "package_name": "package",
  "declared_version": "1.2.3",
  "install_cmd": "opencode plugin add package@1.2.3",
  "install_note": null,
  "installed_version": "1.2.3",
  "installed_source": "package",
  "opencode_id": "package",
  "enabled": true,
  "auth_required": false,
  "command": ["npx", "-y", "pkg"],
  "url": null,
  "reason": null,
  "selected": false,
  "config_format": "v1|v2|file"
}
```

Not every field appears on every extension; consumers must tolerate missing fields.

- A plugin can have `surfaces: ["server", "tui"]`.
- TUI-only plugins have `install_cmd: null` and `install_note`; they are declared in `cli.json`.
- `derived` extensions come from OpenCode probes and are not copied.
- `defined_in` is always an array in the normalized plan.

## rewrites

Structural edits applied to a config item before copying.

```json
{
  "id": "plugin-path:config:opencode.jsonc:/plugins/1",
  "item_id": "config:opencode.jsonc",
  "plugin_item_id": "plugin:local:plugins/my-local-plugin",
  "pointer": "/plugins/1",
  "from_sha256": "<sha256 of the original value>",
  "to": "./plugins/my-local-plugin",
  "kind": "string|value|delete",
  "reason": "relocate-local-plugin|normalize-command-wrapper|normalize-cwd|remove-managed-mcp|remove-nonportable-mcp|normalize-home-path|excluded-by-user"
}
```

- `string` replaces a string value.
- `value` replaces an array/object value (for example an MCP command).
- `delete` removes an object member or array element; the build handles commas and reparses after each delete.
- `from_sha256` is verified against the source value before editing. Raw `from` values are not stored in the shipped manifest. `delete` does not require a source hash.

## secret_refs

```json
{
  "item_id": "config:opencode.jsonc",
  "file": "optional/relative/path/inside/directory-item",
  "pointer": "/mcp/servers/foo/environment/API_KEY",
  "key": "API_KEY",
  "kind": "value|env-reference|file-reference|embedded-reference",
  "label": "opencode.jsonc#/mcp/servers/foo/environment/API_KEY"
}
```

Only `kind: "value"` requires a value at restore. References are recorded so the user can set the environment/file on the target. Labels include the target file (or skill-relative file) plus `#` and the JSON pointer, so identical pointers in different files do not collide. Text placeholders use `file:line:column`. The secrets JSON file is keyed by the exact label.

## manual_actions

```json
{
  "id": "mcp:example-tool:bare-binary",
  "type": "mcp|mcp-auth|mcp-managed|plugin|skill-source|skill-catalog|instruction-file|instruction-url|reference|auth",
  "name": "example-tool",
  "reason": "bare-binary",
  "command": ["example-tool", "serve", "--mcp"],
  "cwd": null,
  "environment": {},
  "environment_keys": [],
  "headers": null,
  "server_type": "local",
  "enabled": true,
  "url": null,
  "path": null,
  "branch": null,
  "defined_in": ["config:opencode.jsonc"]
}
```

Manual actions are for the user/agent on the target. They are not executed automatically.

## auth

```json
{
  "credentials_included": false,
  "providers": [
    { "provider": "acme", "method": "environment", "status": "unknown" }
  ],
  "environment": ["ACME_API_KEY"]
}
```

Credentials are never included. `opencode auth list` may enrich `providers`; config `providers.*.env` contributes `environment`.

## warnings

```json
{ "code": "V1_PLUGIN_API", "message": "...", "item_id": "plugin:local:..." }
```

Important codes:

- `CONFIG_JSON_AND_JSONC`, `TUI_AND_CLI`, `TUI_LEGACY`
- `V1_CONFIG`, `HYBRID_CONFIG`, `V1_PLUGIN_API`
- `CONFIG_PARSE_ERROR`, `LOCAL_PLUGIN_INVALID`
- `MCP_COMMAND_NORMALIZED`, `MCP_MANAGED_SKIPPED`, `MCP_NONPORTABLE_REMOVED`
- `THEME_MISSING`, `PLUGIN_DATA_SKIPPED`, `PLUGIN_DATA_TOO_LARGE`
- `SKILL_PATH_ALREADY_DISCOVERED`, `SHARED_CLAUDE_SKILLS`
- `ABSOLUTE_PATH_IN_TEXT`, `HOME_PATH_NORMALIZED`, `SYMLINK_SKIPPED`
- `SECRETS_REDACTED`, `SECRET_SCAN_FAILED`, `AUTH_NOT_INCLUDED`
- `ITEM_SIZE_LIMIT`, `TOTAL_SIZE_LIMIT`, `EXCLUDED_BY_USER`

## Compatibility

- v1 bundles (`schema_version: 1`) used a different item shape (`path`, `secretKeys`) and are **not** accepted by the v2 restore helper. Restore them with the v1 skill or a v1-compatible helper, then re-plan with this version.
- v2 `manifest.json` is the canonical source; do not infer from the directory tree alone.
