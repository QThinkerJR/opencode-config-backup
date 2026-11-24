import test from "node:test";
import assert from "node:assert/strict";
import { applyEdits } from "../scripts/lib/jsonc.mjs";
import { analyzeJsonc, analyzeText } from "../scripts/lib/redact.mjs";
import { sanitizeCommand, sanitizeCommandString, sanitizePlanForOutput } from "../scripts/lib/sanitize.mjs";

test("redaction preserves env and file references", () => {
  const text = JSON.stringify(
    {
      apiKey: "{env:API_KEY}",
      nested: { file: "{file:./key.txt}" },
      headers: { Authorization: "Bearer {env:MCP_KEY}" },
    },
    null,
    2,
  );
  const analysis = analyzeJsonc(text);
  assert.equal(analysis.edits.length, 0);
  assert.ok(analysis.secretRefs.every((ref) => ref.kind.endsWith("reference")));
});

test("redaction removes literal secrets but keeps non-secret env values", () => {
  const text = JSON.stringify(
    {
      password: "literal-secret",
      environment: {
        LOG_LEVEL: "info",
        MCP_TOKEN: "literal-secret-token-value-1234567890",
      },
      headers: {
        "X-Api-Key": "literal-header-secret",
      },
    },
    null,
    2,
  );
  const analysis = analyzeJsonc(text);
  const pointers = analysis.secretRefs.filter((ref) => ref.kind === "value").map((ref) => ref.pointer).sort();
  assert.deepEqual(pointers, ["/environment/MCP_TOKEN", "/headers/X-Api-Key", "/password"]);
  const redacted = applyEdits(text, analysis.edits);
  assert.doesNotMatch(redacted, /literal-secret/);
  assert.match(redacted, /"LOG_LEVEL": "info"/);
  assert.match(redacted, /<REDACTED:\/password>/);
});

test("text scan finds assignment-like secrets and token prefixes", () => {
  const text = "Global rules\nAPI_KEY=supersecretvalue1234567890\nUse sk-abcdefghijklmnopqrstuvwx";
  const analysis = analyzeText(text, { source: "AGENTS.md" });
  assert.ok(analysis.secretRefs.length >= 2);
  const redacted = applyEdits(text, analysis.edits);
  assert.doesNotMatch(redacted, /supersecretvalue/);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwx/);
  assert.match(redacted, /<REDACTED:AGENTS\.md:\d+:\d+>/);
});

test("camelCase compound secret keys are detected", () => {
  const text = JSON.stringify({
    apiToken: "alpha-token-1234567890",
    authToken: "bravo-token-1234567890",
    secretKey: "charlie-secret-1234567890",
    privateKeyPem: "delta-private-1234567890",
    clientPassword: "echo-password-1234567890",
  });
  const analysis = analyzeJsonc(text);
  assert.equal(analysis.edits.length, 5);
  const redacted = applyEdits(text, analysis.edits);
  assert.doesNotMatch(redacted, /alpha-token|bravo-token|charlie-secret|delta-private|echo-password/);
});

test("non-HTTP connection URLs and NAME=value command args are redacted", () => {
  const json = JSON.stringify({
    environment: { DATABASE_URL: "postgres://admin:supersecret@db.example.com/app" },
    command: ["docker", "run", "-e", "API_KEY=short-secret", "image"],
  });
  const analysis = analyzeJsonc(json);
  assert.equal(analysis.edits.length, 2);
  const redacted = applyEdits(json, analysis.edits);
  assert.doesNotMatch(redacted, /supersecret|short-secret/);
  assert.match(redacted, /"image"/);
});

test("command arguments after assignments or flags keep their value", () => {
  const json = JSON.stringify({
    command: ["docker", "run", "-e", "API_KEY=short-secret", "image", "tool", "--api-key=other-secret", "target"],
  });
  const analysis = analyzeJsonc(json);
  assert.equal(analysis.edits.length, 2);
  const redacted = applyEdits(json, analysis.edits);
  assert.doesNotMatch(redacted, /short-secret|other-secret/);
  assert.match(redacted, /"image"/);
  assert.match(redacted, /"target"/);
});

test("sanitized command masks pass the bundle secret scanner", () => {
  const command = sanitizeCommand(["docker", "run", "-e", "API_KEY=short-secret", "image", "tool", "--api-key=other-secret", "target"]);
  assert.deepEqual(command, ["docker", "run", "-e", "API_KEY=<REDACTED>", "image", "tool", "--api-key=<REDACTED>", "target"]);
  const manifest = JSON.stringify({ items: [{ command }] });
  assert.equal(analyzeJsonc(manifest).edits.length, 0);

  const headerCommand = sanitizeCommand([
    "curl",
    "-H",
    "X-Api-Key: literal-header-secret",
    "https://example.com",
  ]);
  assert.deepEqual(headerCommand, ["curl", "-H", "X-Api-Key: <REDACTED>", "https://example.com"]);
  const headerManifest = JSON.stringify({ items: [{ command: headerCommand }] });
  assert.equal(analyzeJsonc(headerManifest).edits.length, 0);
});

test("secret header arguments in command arrays are redacted", () => {
  const json = JSON.stringify({
    command: [
      "curl",
      "-H",
      "X-Api-Key: literal-header-secret",
      "-H",
      "Cookie: session=literal-cookie-secret",
      "https://example.com",
    ],
  });
  const analysis = analyzeJsonc(json);
  assert.equal(analysis.edits.length, 2);
  const redacted = applyEdits(json, analysis.edits);
  assert.doesNotMatch(redacted, /literal-header-secret|literal-cookie-secret/);
  assert.match(redacted, /https:\/\/example\.com/);
});

test("secret header names in headers objects are redacted", () => {
  const text = JSON.stringify({
    headers: {
      "X-Custom-Auth": "short",
      "X-Session": "short",
      "X-Session-Timeout": "30",
      "Session-Id": "short",
      Session: "short",
    },
  });
  const analysis = analyzeJsonc(text);
  assert.equal(analysis.edits.length, 4);
  const redacted = applyEdits(text, analysis.edits);
  assert.match(redacted, /"X-Session-Timeout":"30"/);
});

test("flat and numeric secret key names are detected", () => {
  const text = JSON.stringify({
    APIKEY: "literal-apikey",
    SESSION: "literal-session",
    accesstoken: "literal-access-token",
    clientsecret: "literal-client-secret",
    MY_KEY2: "literal-key-two",
    TOKEN1: "literal-token-one",
    pass: "literal-pass",
  });
  const analysis = analyzeJsonc(text);
  assert.equal(analysis.edits.length, 7);
  const redacted = applyEdits(text, analysis.edits);
  assert.doesNotMatch(
    redacted,
    /literal-apikey|literal-session|literal-access-token|literal-client-secret|literal-key-two|literal-token-one|literal-pass/,
  );
});

test("cookie prose without an assignment is not redacted", () => {
  assert.equal(analyzeText("cookie: chocolate-chip-recipe-ingredients", { source: "notes.md" }).edits.length, 0);
  assert.equal(analyzeText("browser_cookie=chocolate-chip-preferences-1", { source: "notes.md" }).edits.length, 0);
  assert.equal(analyzeText("session_cookie=abcdefghijklmnop", { source: "notes.md" }).edits.length, 1);
});

test("Bearer tokens, cookies, quoted secrets, and private keys are redacted in text", () => {
  const text = [
    "Authorization: Bearer abcdefghijklmnop",
    "Cookie: session=abcdefghijklmnop",
    'PASSWORD="my secret with spaces"',
    "COOKIE=zyxwvutsrqponmlk",
    "postgres://admin:supersecret@db.example.com/app",
    "redis://:supersecret@cache:6379",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const analysis = analyzeText(text, { source: "notes.md" });
  assert.ok(analysis.edits.length >= 6);
  const redacted = applyEdits(text, analysis.edits);
  assert.doesNotMatch(redacted, /abcdefghijklmnop|my secret with spaces|supersecret|zyxwvutsrqponmlk|MIIEvQIBADAN/);
  assert.match(redacted, /<REDACTED:notes\.md:\d+:\d+>/);
});

test("bare key/token fields and metadata suffixes are not treated as secrets", () => {
  const text = JSON.stringify({
    key: "ctrl+x",
    keys: "ctrl+y",
    tokens: "4096",
    maxTokens: "4096",
    secretName: "my-deployment-secret",
    secretFile: ".env.secret",
    hostKeyFingerprint: "SHA256:abcdef",
    monkey: "literal-monkey",
    tokenizer: "bert-base",
    keyboard: "us",
    sessionTimeout: 30,
    publicKey: "ssh-rsa AAAA",
    apiKeyId: "abc",
  });
  assert.equal(analyzeJsonc(text).edits.length, 0);
});

test("bare key/token assignments and environment names are still secret", () => {
  const json = JSON.stringify({
    environment: { TOKEN: "literal-token-value", API_KEY: "literal-key-value" },
    command: ["tool", "--token", "literal-command-token"],
  });
  const analysis = analyzeJsonc(json);
  assert.equal(analysis.edits.length, 3);
  const redacted = applyEdits(json, analysis.edits);
  assert.doesNotMatch(redacted, /literal-token-value|literal-key-value|literal-command-token/);
});

test("git SSH spec userinfo is not treated as a secret", () => {
  const text = JSON.stringify({
    plugins: ["git+ssh://git@github.com/acme/opencode-plugin.git#main"],
  });
  assert.equal(analyzeJsonc(text).edits.length, 0);
});

test("quoted known-prefix keys do not produce overlapping edits", () => {
  const text = 'OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwx"';
  const analysis = analyzeText(text, { source: "AGENTS.md" });
  assert.equal(analysis.edits.length, 1);
  assert.doesNotThrow(() => applyEdits(text, analysis.edits));
});

test("code expressions and token-like key names are not mistaken for secrets", () => {
  const text = "const apiKey = process.env.OPENAI_API_KEY;\nconst token = tokenManager.getToken();";
  assert.equal(analyzeText(text, { source: "code.ts" }).secretRefs.length, 0);
  const json = JSON.stringify({ tokenizer: "bert-base", tokenCount: 42 });
  assert.equal(analyzeJsonc(json).edits.length, 0);
});

test("Basic authorization values are redacted", () => {
  const text = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
  const analysis = analyzeText(text, { source: "headers.txt" });
  assert.ok(analysis.secretRefs.length > 0);
  assert.match(applyEdits(text, analysis.edits), /REDACTED/);
});

test("display sanitizers mask command arguments and install specs", () => {
  assert.deepEqual(
    sanitizeCommand(["docker", "run", "-e", "API_KEY=short-secret", "image"]),
    ["docker", "run", "-e", "API_KEY=<REDACTED>", "image"],
  );
  assert.doesNotMatch(
    sanitizeCommandString("opencode plugin add git+https://user:pass@example.com/x?token=short-secret"),
    /user:pass|short-secret/,
  );
  const plan = {
    source: { home: "C:/Users/me" },
    extensions: [{ type: "plugin", options: { apiToken: "literal-token" }, install_cmd: "tool --token literal-token" }],
    manual_actions: [{ command: ["tool", "--secret", "literal-token"] }],
    rewrites: [{ kind: "value", to: ["tool", "--token", "literal-token"], from: "literal-token" }],
  };
  sanitizePlanForOutput(plan, { home: "C:/Users/me", configRoot: "C:/Users/me/.config/opencode" });
  assert.doesNotMatch(JSON.stringify(plan), /literal-token/);
});

test("plan sanitizer masks bare env values and secret header names", () => {
  const plan = {
    source: { home: "C:/Users/me" },
    extensions: [
      {
        type: "mcp",
        environment: { TOKEN: "literal-env-token" },
        headers: { "X-Custom-Auth": "literal-header-token" },
      },
    ],
    manual_actions: [
      {
        command: ["curl", "-H", "X-Session: literal-session-token"],
        environment: { TOKEN: "literal-manual-env-token" },
      },
    ],
    rewrites: [],
    warnings: [
      {
        code: "PLUGIN_ENTRY_INVALID",
        message:
          "unsupported plugin spec: git+https://user:pass@example.com/x.git and API_KEY=literal-warning-secret",
      },
    ],
  };
  sanitizePlanForOutput(plan, { home: "C:/Users/me", configRoot: "C:/Users/me/.config/opencode" });
  assert.doesNotMatch(
    JSON.stringify(plan),
    /literal-env-token|literal-header-token|literal-session-token|literal-manual-env-token|user:pass|literal-warning-secret/,
  );
});

test("secret arguments after a secret-like flag are redacted", () => {
  const text = JSON.stringify({
    mcp: {
      servers: {
        demo: {
          command: ["tool", "--api-key", "literal-command-secret-1234567890"],
        },
      },
    },
  });
  const analysis = analyzeJsonc(text);
  assert.equal(analysis.edits.length, 1);
  const redacted = applyEdits(text, analysis.edits);
  assert.doesNotMatch(redacted, /literal-command-secret/);
});

test("URLs with userinfo or secret query parameters are redacted", () => {
  const text = JSON.stringify({
    url: "https://user:pass@example.com/mcp?api_key=sk-abcdefghijklmnopqrstuvwx",
  });
  const analysis = analyzeJsonc(text);
  assert.equal(analysis.edits.length, 1);
  assert.equal(analysis.secretRefs[0].kind, "value");
  const redacted = applyEdits(text, analysis.edits);
  assert.doesNotMatch(redacted, /user:pass|sk-abcdefghijklmnopqrstuvwx/);
});

test("redaction leaves existing placeholders alone", () => {
  const text = JSON.stringify({ password: "<REDACTED:/password>" }, null, 2);
  const analysis = analyzeJsonc(text);
  assert.equal(analysis.edits.length, 0);
});
