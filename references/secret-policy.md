# Secret Policy

The backup must never leak credentials. It also must not break portable configuration by redacting indirect references.

## Core rule

- **References are safe:** `{env:NAME}` and `{file:path}` are indirection. Preserve them exactly. They tell the target machine where to find a value; they do not contain the value.
- **Literal values are secrets when they look like secrets.** Replace the value with `<REDACTED:label>` in the bundle, record the label in the plan/manifest, and collect the value only at restore time.
- **Never store secret values in `plan.json`, `manifest.json`, `RESTORE.md`, logs, or chat.** Only labels, key names, and JSON pointers.

## What is scanned

1. Root JSON/JSONC config files (`opencode.json(c)`, `cli.json`, plugin configs, `tui.json(c)`).
2. Markdown/text files that are copied as agents, commands, `AGENTS.md`, skill files, themes, or plugin data.
3. JSON files inside copied directories (plugin/skill/theme data), using structural scanning where possible.
4. `.env`, `.env.*`, `.env.local`, and similar environment files.
5. Private-key files: `.pem`, `.key`, `id_rsa`, `id_dsa`, `id_ecdsa`, and `id_ed25519`.
6. Not scanned by default: `node_modules`, `.git`, binaries, database/log/snapshot/state files (which are not copied anyway), binary key stores such as `.p12`, `.pfx`, `.jks`, and raw DER key material without PEM armor. Credential files (`.npmrc`, `.yarnrc*`, `.pypirc`, `.netrc`, `.git-credentials`) are never copied. Generated code files (`.ts`, `.js`, `.py`, ...) are copied as-is; only config/markdown/text/env/key files are redacted. Lockfiles are copied for local plugins but are not rewritten; verification only checks them for URL userinfo and known token prefixes.

## Key heuristics

Redact a string value when any of these holds:

- The key matches `apiKey`, `api_key`, `token`, `access_token`, `refresh_token`, `client_secret`, `private_key`, `secret`, `password`, `passwd`, `pass`, `credential`, `authorization`, `cookie`, or a `PAT` segment. Flat compounds (`apikey`, `accesstoken`, `clientsecret`), exact `session`/`session-id`/`session-token` keys, and numeric suffixes (`KEY2`) are also covered.
- The value starts with a known secret prefix: `sk-`, `sk_`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `github_pat_`, `xox[baprs]-`, `AKIA`, `ASIA`, `AIza`, `-----BEGIN ...`, `Bearer `.
- The value is at least 32 characters and matches `^[A-Za-z0-9+/=_-]+$` (token-shaped), unless the key is a known non-secret.
- The value is under an `environment`/`env` object and the key is secret-like.
- The value is under a `headers` object and the header is `authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization`, `session`, `session-id`, or a name ending in `auth`, `api-key`, `key`, `token`, `secret`, `session`, `session-id`, `credential`, or `password`.
- The value is a literal API key under `providers.*.settings` or a model setting.
- The value is a URL with userinfo or a secret-like query parameter; the whole URL is replaced (the exact URL can be re-supplied at restore).
- The value is a command argument immediately after a secret-like flag (`--api-key`, `--token`, ...), an argument of the form `--api-key=...`, or a header-like argument such as `X-Api-Key: ...` or `Cookie: ...`.

Do **not** redact:

- `{env:...}` or `{file:...}` references, including embedded references such as `Bearer {env:MCP_KEY}`;
- safe URLs, package specs, model IDs, version strings, file paths, schema URLs;
- plain environment values such as `LOG_LEVEL=info`, `NODE_ENV=production`, `TZ=UTC`;
- 64-character SHA-256 hashes, checksums, and plan/manifest hashes;
- values whose key is in the non-secret allowlist (`name`, `description`, `title`, `id`, `type`, `version`, `mode`, `model`, `providerID`, `agent`, `theme`, `source`, `repository`, `branch`, `package`, `command`, `cwd`, `path`, `url`, `uri`, `endpoint`, `host`, `protocol`, `format`, `language`, `locale`, `preset`, `variant`, `reason`, `message`, `label`, `sha256`, `hash`, `plan_hash`, `from_sha256`, `checksums`, `pointer`, `item_id`, `file`, `template`, `prompt`, `system`, `instructions`, `skills`, `plugins`, `mcp`, `agents`, `commands`, `providers`, `references`, `permissions`, `policies`).

The heuristic can over- or under-detect. The plan shows labels, not values. The user can exclude an item or adjust the redaction through the confirmation loop.

## Structural editing

- Parse JSONC with source ranges.
- Replace only the target string's character range; do not reserialize the document.
- Preserve comments, trailing commas, indentation, and key order.
- For MCP command rewrites and deletions, apply one structural edit at a time and reparse; this avoids overlapping-range errors when several servers are removed.

## Text scanning

For Markdown and plain text, scan for:

- assignment patterns: `api_key = "..."`, `token: ...`, `password=...`, quoted values with spaces;
- `Authorization: Bearer ...` / `Authorization: Token ...` and `Cookie:` / `Set-Cookie:` headers;
- URLs with userinfo (`scheme://user:password@host`);
- PEM private-key blocks (`-----BEGIN ... PRIVATE KEY-----`);
- known token prefixes.

Replace only the value substring with `<REDACTED:file:line:column>`; do not rewrite the surrounding prose. References such as `API_KEY={env:API_KEY}` are left alone. Only config/markdown/text/env/key extensions are scanned; generated code files are not rewritten.

## Auth and service state

- Credentials may live in a legacy `auth.json` (data directory) or in the V2 SQLite database. **Never copy either by default.**
- Do not run `opencode auth export` in the agent shell; it prints secrets. If the user explicitly wants a credential transfer, use a user-controlled terminal, a separate secure channel, and `opencode auth import`; never put the exported JSON in this bundle.
- `service.json` contains a machine-specific service password and route. It is state, not config. **Never copy it.**
- Remote MCP OAuth credentials are stored outside config. Do not copy them; restore re-authenticates via `/mcps` or `opencode mcp auth`.
- Provider API keys may be literal in config or referenced via `{env:...}`. Redact literal values; preserve references; record the required environment variables in `auth.environment`.

## Placeholder format

Use:

```text
<REDACTED:opencode.jsonc#/mcp/servers/foo/environment/API_KEY>
<REDACTED:AGENTS.md:12:8>
<REDACTED:_shared/agents-skills/demo/config.json#/apiKey>
```

Labels must be stable and unique per item/file. The manifest stores:

```json
{
  "item_id": "config:opencode.jsonc",
  "pointer": "/mcp/servers/foo/environment/API_KEY",
  "key": "API_KEY",
  "kind": "value",
  "label": "opencode.jsonc#/mcp/servers/foo/environment/API_KEY"
}
```

`kind` may be `value`, `env-reference`, `file-reference`, or `embedded-reference`. Only `value` requires re-supplying at restore; references only require the target environment or file. The secrets JSON file is keyed by the exact label.

## Restore

- Prefer setting the referenced environment variables; no secret value is needed in the bundle.
- For literal secrets, create a temporary JSON file outside the config directory:

  ```json
  {
    "opencode.jsonc#/mcp/servers/foo/environment/API_KEY": "the-value",
    "AGENTS.md:12:8": "another-value",
    "_shared/agents-skills/demo/config.json#/apiKey": "a-third-value"
  }
  ```

  Pass it to `tools/restore.mjs --secrets <file>`.

- The helper refuses to apply while a `<REDACTED:...>` placeholder lacks a value.
- For `.json`/`.jsonc` targets the inserted value is JSON-escaped (`"`, `\`, newlines); for text files it is inserted raw.
- Directories are staged, secret-substituted, and checked for placeholders before the live target is replaced.
- Do not paste secret values into the conversation; use the temporary file or environment variables.
- After restore, verify no placeholder remains in any live config.

## Verification

`scripts/verify-bundle.mjs` re-scans the bundle and fails if:

- a possible literal secret remains;
- a placeholder has no matching manifest secret reference;
- a lockfile contains URL userinfo or a known token prefix (`package-lock.json` is not rewritten, so the build fails instead);
- a config file contains an absolute source-machine home path;
- `service.json`, `auth.json`, `node_modules`, `.git`, backups, logs, or DBs are present.

A failed build deletes its partial output directory so unredacted copies are not left on disk.

If a false positive blocks the build, exclude the item or adjust the plan with an explicit user override; never silently ship a likely secret.
