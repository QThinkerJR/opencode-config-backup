# Confirmation Protocol

Every export and every restore uses the same loop:

```text
plan → show → user feedback → revise plan → show diff → ask again → confirm
```

There is **no separate review mode** and no `--review` flag. The confirmation loop is the review.

## Use the question tool

Use the `question` tool when it is available. It supports fixed options **and** a free-form answer automatically. Do not add a separate "type your own answer" option; the tool already provides one.

If the tool is unavailable (non-interactive client), ask in plain text and wait for the user's reply. Do not write the final bundle until the user says to proceed.

Suggested export question:

```text
Question:
"Plan ready. 38 items, 5 installs/auth steps, 3 secret labels.
Output: <path>. Confirm export?"

Options:
1. Confirm and export (Recommended)
2. Adjust
3. Cancel
```

Suggested restore question:

```text
Question:
"Restore plan ready. 21 create, 4 overwrite with .restore-backups, 2 skip,
1 missing secret. Target: <config-dir>. Confirm restore?"

Options:
1. Confirm restore (Recommended)
2. Adjust
3. Cancel
```

## Feedback handling

The user may type anything. Translate it into structured plan changes, then show what changed.

| Feedback | Action |
|---|---|
| "Exclude X" | Rerun `plan.mjs --exclude X`; or remove the item from `plan.json` and rehash. |
| "Include `~/.claude/skills`" | Rerun with `--include-claude-skills`. |
| "Use D:\backups\..." | Change the `build.mjs --out` path; no content change. |
| "Also include my project config" | Explain that default scope is global. If the user insists, add the project path as an extra source and mark it `ad-hoc`; do not silently scan projects. |
| "Treat MCP X as manual" | Set its extension `classification` to `manual`, add a manual action, remove any command rewrite, then rehash. |
| "Don't copy theme X" | Exclude the theme item and remove/flag the `cli.json` theme selection conflict. |
| "Keep this secret literal" | Explain the risk. Only after an explicit override, remove the secret ref; build/verify will still fail, so exclude the item or keep the redaction. |
| "Include my credentials" | Refuse by default. Explain that `auth.json` is out of scope and recommend `opencode auth login` or environment variables. Only a user-controlled separate secret transfer can opt in. |
| "Copy `service.json`" | Refuse. It contains a machine-specific password; it is state, not config. |

For changes not covered by `plan.mjs` flags:

1. Use the file tools to edit `plan.json` (never add secret values).
2. Recompute the hash:

   ```bash
   node scripts/rehash-plan.mjs --plan "<plan-dir>/plan.json"
   ```

3. Show the new summary and hash.
4. Ask again.

Never edit a plan after the user confirms; build refuses a mismatched hash.

## What to show

Keep the first round compact:

- output path;
- item count and classification counts;
- local plugins relocated;
- plugins/MCPs needing install or auth;
- secret labels (not values);
- manual actions;
- warnings that affect behavior (V1 plugin API, config coexistence, size limits).

For later rounds, show a diff:

```text
Changes since last round:
+ added: plugins/my-local-plugin
- removed: mcp example-mcp
~ classification: mcp bare → manual
~ redaction: removed /plugins/2/options/mode
Output: D:\backups\opencode
```

The user should not need to read `plan.json` unless they ask.

## Staging (optional)

Plan-only preview is fast. If the user wants to inspect actual files:

1. Build into a temp directory outside the config directory.
2. Show the file tree and key diffs.
3. Keep the staging path in the conversation; do not promote it to the final path.
4. On cancellation, delete staging.
5. On confirmation, build the final bundle from the approved plan (or move staging only if it was built from the same hash and verified).

Staging must already be redacted; never stage plaintext secrets.

## Confirmation rules

- Confirmation is per plan hash. If the plan changes, the old confirmation is invalid.
- If the user picks "Adjust" without text, ask a targeted follow-up (which items? which path? which redaction?).
- If the user selects "Confirm" but the plan has unresolved blockers (missing source file, invalid config, checksum failure), stop and explain. Do not build a broken bundle.
- If the user cancels, delete staging and report that nothing was written.

## Restore loop

The restore helper has its own plan hash:

1. Dry-run: `node tools/restore.mjs --bundle . --target "<config-dir>" --dry-run`
2. Show create/overwrite/skip actions, `.restore-backups` paths, missing secrets, plugin installs, MCP/auth/manual actions.
3. Accept feedback: exclude items, change target, provide secrets, skip a plugin install, or choose merge/skip for a conflict.
4. Rerun the dry-run and show the changed actions.
5. Apply with the exact hash:

   ```bash
   node tools/restore.mjs --bundle . --target "<config-dir>" --secrets "<secrets.json>" --approve "<hash>"
   ```

6. If a secret is missing, stop before writing; collect it into a temporary secrets JSON file and rerun the dry-run/confirmation.

## Non-interactive fallback

If no question UI exists, print the plan and a single explicit question:

```text
Type "confirm" to write <path>, or describe changes.
```

Do not infer confirmation from silence, a previous message, or a generic "ok" that was about a different step.
