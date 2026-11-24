# opencode-config-backup

[English](./README.md) · **简体中文**

> 把你的 OpenCode **全局**自定义内容——智能体、命令、技能、提示词模板、插件、MCP 服务器、主题与 CLI 设置——备份并迁移到一个可移植文件夹，在任意机器上一键恢复。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![OpenCode Skill](https://img.shields.io/badge/OpenCode-Skill-blueviolet.svg)](https://opencode.ai)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey.svg)](#环境要求)

`opencode-config-backup` 是一个 **V2 原生**的 [OpenCode](https://opencode.ai) Skill。它把“属于你自己的 OpenCode 环境”打包成可自恢复的迁移包，并处理普通文件复制处理不了的部分：本地插件目录、npm/git/TUI 插件、MCP 命令可移植性、JSONC 双配置共存、主题、提示词模板和密钥脱敏。

迁移采用**确认循环**，而不是一次性写入：

```text
扫描 → 计划 → 展示 → 用户反馈 → 修订计划 → 展示变化 → 确认 → 构建 → 校验
```

在真正写入之前，你始终能看到哪些内容会被复制、安装、移除或脱敏。你可以点选项，也可以直接输入修改意见，直到计划符合预期。

---

## 为什么需要它

OpenCode V2 的自定义内容分散在很多位置：

- `~/.config/opencode/opencode.json(c)` — 插件、MCP、agents、commands、providers、permissions。
- `~/.config/opencode/agents/`、`agent/`、`mode/`、`modes/` — Markdown 智能体。
- `~/.config/opencode/commands/`、`command/` — Markdown 提示词模板。
- `~/.config/opencode/skills/`、`skill/` — 带脚本和引用的技能。
- `~/.config/opencode/plugins/` 与本地插件目录 — server/TUI/GUI 部分。
- `~/.config/opencode/themes/` — 自定义终端主题。
- `~/.config/opencode/cli.json` — 主题、键位、TUI 插件、会话偏好。
- `~/.agents/skills/` 与 `~/.claude/skills/` — 跨 agent 共享技能。
- OpenCode 凭据存储（旧版 `auth.json` 或 V2 SQLite）——**默认不复制**。

手工在新电脑上重建既繁琐又容易出错。更糟的是，直接照抄会坏：配置里可能有 `C:/dev/my-mcp-server` 这类绝对路径、Windows 专用的 `cmd /c` 包装、由 OpenCode 管理的二进制，以及明文密钥。

这个 Skill 把它整理成**一个可移植迁移包**：

- **分类**每个扩展：复制、安装、托管、派生或手动处理。
- **重定位**本地插件目录并重写配置引用。
- **归一化**平台相关的 MCP 命令和 `cwd`。
- **脱敏**密钥，同时保留 `{env:...}` / `{file:...}` 引用。
- **写入前确认**，支持选项 + 自由反馈。
- **校验**迁移包与恢复后的环境。

## 工作原理

```text
 你的机器                                 任意其他机器
┌──────────────────────┐                  ┌──────────────────────┐
│ ~/.config/opencode   │    ┌────────┐    │ ~/.config/opencode   │
│   agents/            │    │  计划  │    │   agents/            │
│   commands/          │ ─▶ │   ↓    │ ─▶ │   commands/          │
│   skills/            │    │  构建  │    │   skills/            │
│   plugins/ (本地)    │    │   ↓    │    │   plugins/           │
│   themes/            │    │  校验  │    │   themes/            │
│   cli.json           │    └────────┘    │   cli.json           │
│ ~/.agents/skills     │         │        │ ~/.agents/skills     │
└──────────────────────┘         │        └──────────────────────┘
                                 ▼
                         RESTORE.md + tools/restore.mjs
```

1. **计划** — 只读扫描；生成 `plan.json` 和 `plan.md`。
2. **确认** — 展示计划，接受反馈；循环直到批准。
3. **构建** — 只接受已批准的 plan hash；写出迁移包。
4. **校验** — 校验和、密钥、路径、结构检查。
5. **恢复** — 在目标机器打开 `RESTORE.md`；使用同一套确认循环。

## 安装

### 通过 `skills` CLI（推荐）

```bash
npx skills add QThinkerJR/opencode-config-backup
```

### 通过 git clone

```bash
git clone https://github.com/QThinkerJR/opencode-config-backup.git \
  ~/.config/opencode/skills/opencode-config-backup
```

Windows 上使用 `%USERPROFILE%\.config\opencode\skills\opencode-config-backup`。

安装后在 OpenCode 中直接调用该 Skill。V2 配置热加载，无需重启。

本项目以 GitHub Skill 形式分发，**没有发布 npm 包**；上面的 `npx` 只是运行第三方 `skills` 安装器。

## 用法 —— 备份/迁移

在任意 OpenCode 会话中：

> 备份我的 OpenCode 全局配置。

或：

> 把我所有的 OpenCode 自定义内容迁移到新机器。

Skill 会：

1. 用 `opencode debug paths` 定位配置目录，并识别 V1/V2/hybrid 配置。
2. 发现配置文件、agents、commands、skills、plugins、MCP、themes、插件数据和共享技能。
3. 用 OpenCode 命令交叉核对已安装插件、MCP、agents 和认证方式。
4. 生成计划并请求确认。
5. 构建并校验 `opencode-migration-<时间戳>/`。

输出路径在确认循环中决定；只有你批准后才会写入正式迁移包。

### 确认界面示例

```text
计划就绪：38 项，5 个安装/认证步骤，3 个密钥标签。
输出：D:\backups\opencode-migration-20261124\

1. 确认并导出（推荐）
2. 继续调整
3. 取消

也可以直接输入修改意见，例如：
“排除 example-mcp 服务；包含 ~/.claude/skills。”
```

每一轮都会展示变化。最终确认前不会写入正式包；构建命令使用你批准的 plan hash，确保“看到的内容”和“写出的内容”一致。

## 用法 —— 恢复

在目标机器上：

> 从 `D:\backups\opencode-migration-20261124\` 恢复我的 OpenCode 配置。

打开迁移包里的 `RESTORE.md`，让 agent 执行。迁移包是自包含的：包含 `tools/restore.mjs`，目标机器不需要安装本 Skill。

恢复过程会：

- 运行时探测本地配置目录（设置 `OPENCODE_CONFIG_DIR` 时优先使用）；非默认目标目录必须显式 `--allow-custom-target`；
- 展示 create/overwrite/skip 与 `.restore-backups` 路径的试运行计划；
- 接受反馈并重新规划，直到确认；
- 通过临时密钥 JSON 文件补齐明文密钥（更推荐环境变量）；
- 安装 server 插件，TUI 插件保留在 `cli.json`，恢复本地插件目录；
- 提示 MCP OAuth 与 provider 登录；
- 用 `opencode debug config`、`plugin list`、`mcp list`、`debug agents`、`reload` 校验。

## 会备份哪些内容

| 来源 | 捕获内容 |
|---|---|
| `~/.config/opencode/opencode.json(c)` | V2/V1 配置，经过结构化脱敏与可移植重写 |
| `~/.config/opencode/cli.json` | 主题、键位、TUI 插件、会话偏好 |
| `~/.config/opencode/tui.json(c)` | V1 旧版 CLI 配置，保留并告警 |
| `~/.config/opencode/AGENTS.md` | 全局指令 |
| `agents/`、`agent/`、`mode/`、`modes/` | Markdown 智能体 |
| `commands/`、`command/` | Markdown 提示词模板 |
| `skills/`、`skill/` | 技能目录及脚本/引用 |
| `plugins/` + 本地插件目录 | V2 server/TUI/GUI 插件；排除 `node_modules`/`.git` |
| `themes/` | 自定义主题 |
| 插件数据目录 | 小型纯文本用户定制（例如 `my-plugin/`） |
| `~/.agents/skills/` + 锁文件 | 跨 agent 技能 |
| `~/.claude/skills/` | 可选的 Claude 共享技能 |
| 配置 `mcp.servers` | 本地/远程 MCP 定义、禁用状态、env/header 引用 |
| 配置 `providers` | provider/model 配置；凭据不复制 |
| `opencode auth list` | 仅记录 provider/认证方式需求 |

## 不备份哪些内容

- 项目级 `opencode.json(c)` / `.opencode/`（默认仅全局）。
- 系统/托管配置（`/etc/opencode`、`%ProgramData%\opencode`、macOS 托管偏好）。
- Desktop 应用数据、会话、数据库、日志、快照、shell 历史、工具输出。
- 凭据/OAuth token 与 `service.json`（含机器相关密码）。
- 凭据文件，例如 `.npmrc`、`.yarnrc*`、`.pypirc`、`.netrc`、`.git-credentials`。
- `node_modules/`、`.git/`、`.bak`、write-lock、缓存、DB 文件。
- `~/.opencode/`（CLI 安装数据）。
- 默认不迁移凭据；恢复时重新认证。

## 本地插件

本地插件目录是一等公民：

- 复制插件包目录，排除 `node_modules` / `.git`。
- 保留 `package.json`、exports 入口、`src`、`dist`、`gui-experimental.cjs`、锁文件。
- 如果 `package.json` 声明了 `files`，按它加上 `exports` 目标、包元数据、锁文件和文档；否则复制除噪声外的整个包。
- 把配置引用重写为 `./plugins/<slug>`。
- 识别 `@opencode/plugin`（V2）与 `@opencode-ai/plugin`（V1）；V1 插件会告警，不会声称能在 V2 运行。
- V1 单文件本地插件在 V2 无效，会变成手动操作。

## MCP 可移植性

计划会分析每个 MCP 命令：

| 形态 | 处理 |
|---|---|
| `npx` / `bunx` / `uvx` / `docker` | 保留；运行时由包管理器拉取 |
| `cmd /c npx ...` | 重写为内部命令 |
| 包管理器的绝对路径 | 重写为裸包管理器 |
| OpenCode 包/缓存内的绝对路径 | 从可移植配置移除；由 OpenCode 托管 |
| 其他绝对二进制 | 从配置移除；生成手动操作 |
| 裸二进制 | 保留命令；提示手动安装 |
| 远程 URL | 保留；提示 MCP 认证 |

禁用的服务器保持禁用。`cwd` 在可行时重写为 `~`，否则移除并转手动。

## 密钥与认证

- 保留 `{env:NAME}` / `{file:path}`——它们是安全的间接引用。
- 脱敏明文 API key、token、password、authorization/cookie header、命令中的密钥参数、扁平/数字后缀等密钥键名下的值、带 userinfo/密钥查询参数的 URL，以及 PEM 私钥文件（`.pem`、`.key`、`id_*`）。
- 计划和 manifest 只记录标签/指针；标签包含目标文件与 JSON pointer。
- 绝不复制凭据存储、`service.json`，以及 `.npmrc`、`.yarnrc*`、`.pypirc`、`.netrc`、`.git-credentials` 等凭据文件。
- lockfile 会随本地插件复制，但只检查 URL userinfo 和已知 token 前缀；发现即构建失败，不会改写 lockfile。
- 构建失败会删除本次生成的部分目录，避免未脱敏副本留在磁盘。
- 恢复时优先使用环境变量；明文密钥写入临时 JSON 文件。恢复 helper 会先暂存内容，只要还有占位符就拒绝写入，并把被替换内容备份到 `.restore-backups`。
- 用 `opencode auth login` / `/connect` 重新认证 provider；用 `/mcps` 或 `opencode mcp auth` 认证远程 MCP。

## 生成的迁移包

```text
opencode-migration-<时间戳>/
├── RESTORE.md          # 自运行恢复提示词
├── manifest.json       # 物理项、逻辑扩展、重写、密钥、认证、校验和
├── checksums.json      # 完整性哈希
├── tools/
│   └── restore.mjs     # 自包含恢复 helper
└── files/              # 镜像 + 重定位 + 脱敏后的内容
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

- **`RESTORE.md`** — 在目标机器运行的提示词，包含确认循环、备份、插件/MCP/认证步骤与校验。
- **`manifest.json`** — 唯一事实来源：物理项、逻辑扩展、重写、密钥标签、手动操作、认证需求、校验和。
- **`files/`** — 用户内容，按需脱敏；本地插件路径已重定位。
- **`checksums.json`** — 除 `manifest.json`/`checksums.json` 外所有文件的哈希。

## Manifest 速览

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

## 环境要求

- [OpenCode](https://opencode.ai) V2（CLI 和/或 Desktop）；V1 配置尽力兼容。
- Node.js 22+（用于 plan/build/verify/restore helpers）。
- Git（git 插件或从 Git 克隆的技能需要）。
- MCP/插件使用的包管理器（`npx`、`bunx`、`uvx`、`docker` 等）。

## 安全机制

- **Plan hash 批准** — 构建拒绝过期或缺失的 hash。
- **确认前不写正式包** — 计划阶段只读；staging 是临时的。
- **覆盖前备份** — 被替换的文件/目录保存到 `<config-dir>/.restore-backups/<时间戳>/`。
- **幂等** — 相同文件/目录跳过。
- **Fail closed** — 校验和错误、缺失密钥、无效 JSONC、不安全路径或未解析占位符会中止构建/恢复。
- **Fail soft** — 插件下载/MCP 登录失败会记录并汇总，不中断整体。
- **校验** — 迁移包自检 + 恢复后 OpenCode 探测。

## V1 → V2 说明

- V2 仍读取受支持的 V1 配置字段和文件布局。
- V2 插件 API 是破坏性变更；V1 本地插件会告警，不会静默恢复。
- `tui.json(c)` 是旧版；`cli.json` 不存在时 V2 会自动迁移。不要用 `tui.json` 覆盖已有 `cli.json`。
- 不做自动配置格式转换。需要现代化时，恢复后单独让 OpenCode 迁移配置。

## 限制

- 默认仅全局范围；项目 `.opencode/` 不在范围内。
- 默认不迁移凭据。
- 插件/技能代码文件、二进制文件、二进制密钥库（`.p12`、`.pfx`、`.jks`）以及无 PEM 头的 raw DER 密钥材料会原样复制，不做硬编码密钥扫描。
- lockfile 会随本地插件复制，仅检查 URL userinfo 和已知 token 前缀。
- 共享技能目录是跨 agent 数据；会提示类别交叉。
- 裸二进制 MCP 和不可移植的绝对命令会变成手动操作。
- 大文件/目录会按大小限制跳过或告警。
- `@latest`、范围版本等浮动版本保持原有语义，恢复时不会固定。
- 恢复 helper 负责文件/配置/密钥机械操作；插件安装、MCP OAuth、provider 登录由 agent/用户完成。

## 开发

```bash
npm test
```

CI 在 `ubuntu-latest` 与 `windows-latest` 上使用 Node 22 运行同一套测试。

测试覆盖 JSONC 编辑、脱敏（配置、文本、命令/header、PEM）、V1/V2/hybrid 计划、本地插件重定位、MCP 可移植性、目录项 home 路径改写、凭据文件排除、迁移包校验、恢复幂等/备份、symlink 合并行为、缺失密钥失败。

`tests/fixtures/` 下的凭据和路径均为合成数据，详见 `tests/fixtures/README.md`。

## 许可证

[MIT](./LICENSE) © QThinker
