# imap-mcp-server（fork：收件人参数校验修复版 / fork: send-recipient validation fix）

> **本仓库是 [nikolausm/imap-mcp-server](https://github.com/nikolausm/imap-mcp-server) 的修改版（fork 式再发布）**，基于 npm 包 `imap-mcp-server@2.0.0`，修复了发送邮件类工具 `to` 参数始终报 `-32602` 参数验证错误的问题。除下述修复外，其余功能与上游保持一致。
>
> **This repository is a modified re-release (fork-style) of [nikolausm/imap-mcp-server](https://github.com/nikolausm/imap-mcp-server)**, based on the npm package `imap-mcp-server@2.0.0`, fixing the persistent `-32602` input-validation error on the `to` parameter of email-sending tools. Apart from the fix described below, all other functionality is identical to upstream.

一个强大的 Model Context Protocol (MCP) IMAP 邮件服务器，支持账号加密存储、连接池、邮件收发、文件夹管理、多账号，以及基于 Web 的设置向导。

A powerful Model Context Protocol (MCP) IMAP email server with encrypted account storage, connection pooling, email send/receive, folder management, multi-account support, and a web-based setup wizard.

## 本 fork 修复了什么 / What this fork fixes

**问题 / Problem**：调用 `imap_send_email`、`imap_save_draft`、`imap_forward_email` 等工具时，`to` / `cc` / `bcc` 参数始终返回 / calling tools such as `imap_send_email`, `imap_save_draft` and `imap_forward_email` always fails on the `to` / `cc` / `bcc` parameters with:

```
MCP error -32602: Input validation error: Invalid arguments for tool imap_send_email: Invalid input at to
```

**根因 / Root cause**：`addressList()` 工具函数使用 `z.preprocess` + `z.union([z.string(), z.array(z.string())])`。MCP 框架将 Zod Schema 转为 JSON Schema 时，`z.preprocess` 没有对应表示，导致 `to` 字段丢失 `type` 定义，客户端参数校验直接失败。

The `addressList()` helper uses `z.preprocess` + `z.union([z.string(), z.array(z.string())])`. When the MCP framework converts the Zod schema to JSON Schema, `z.preprocess` has no JSON Schema equivalent, so the `to` field loses its `type` definition and client-side validation fails immediately.

**修复 / Fix**：将 `to` / `cc` / `bcc` 等参数统一改为简单的 `z.string()`，确保生成的 JSON Schema 含明确的 `type: "string"`。

The `to` / `cc` / `bcc` parameters are changed to a plain `z.string()`, ensuring the generated JSON Schema carries an explicit `type: "string"`.

**修复位置 / Where**：`dist/index.js`（本仓库发布的是编译后的 npm 包内容；TypeScript 源码见上游仓库 / this repository ships the compiled npm package; the TypeScript source lives in the upstream repository）。

**详细过程 / Details**：见 [docs/bug-fix-2026-09-19.md](docs/bug-fix-2026-09-19.md)（中英对照 / bilingual）。

> 注意：上游有意保留“单个字符串或字符串数组”两种输入（README Troubleshooting 一节）。本 fork 为修复 schema 校验问题将参数改为仅接受字符串。如需同时保留数组输入，请先与上游讨论方案。
>
> Note: upstream intentionally keeps both "single string or array of strings" as valid input (see the Troubleshooting section of its README). This fork narrows the parameters to a plain string in order to fix the schema-validation issue. If you need array input preserved as well, please discuss the approach with upstream first.

## 安装与运行 / Installation & Usage

要求 **Node.js 22.12 或更新版本**。/ Requires **Node.js 22.12 or newer**.

### 方式一：克隆本仓库本地运行 / Option 1: Clone and run locally

```bash
git clone https://github.com/LukeLiu2000/imap-mcp-server.git
cd imap-mcp-server
npm install        # 安装运行时依赖（如需本地启动）/ install runtime deps (only if running locally)
node dist/index.js # 直接启动（dist 已包含修复）/ start directly (dist already contains the fix)
```

### 方式二：作为 MCP 服务器使用 / Option 2: Use as an MCP server

在支持 MCP 的客户端（Claude Desktop、Cursor、豆包等）中配置 / configure it in an MCP-capable client (Claude Desktop, Cursor, Doubao, etc.):

```json
{
  "mcpServers": {
    "imap": {
      "command": "npx",
      "args": ["-y", "imap-mcp-server"]
    }
  }
}
```

> 官方 npm 包为未修复版本；本仓库的 dist 已包含修复，可直接 `node dist/index.js` 启动本 fork。/ The official npm package is the unfixed version; this repository's `dist` already contains the fix and can be started directly with `node dist/index.js`.

### 配置账号 / Account setup

账号信息加密存储在 `~/.imap-mcp/accounts.json`，密钥在 `~/.imap-mcp/.key`。/ Account credentials are stored encrypted in `~/.imap-mcp/accounts.json`; the encryption key lives in `~/.imap-mcp/.key`.

```bash
npx -p imap-mcp-server imap-setup   # 启动 Web 设置向导 / launch the web setup wizard
```

## 常用功能示例 / Example usage

- 添加账号 / Add account："Add my Gmail account with username john@gmail.com"
- 查邮件 / Read emails："Show me the latest 5 emails from my Gmail account"
- 搜索邮件 / Search emails："Search for emails from boss@company.com in the last week"
- 发送邮件 / Send email："Send an email to client@example.com with subject 'Project Update'"
- 回复 / 转发 / Reply / Forward："Reply to the latest email from my boss"

## 与上游的关系 / Relationship with upstream

| 项目 / Item | 地址 / URL |
|---|---|
| 上游源码仓库 / Upstream source repo | <https://github.com/nikolausm/imap-mcp-server> |
| 本 fork / This fork | <https://github.com/LukeLiu2000/imap-mcp-server> |
| 上游 npm 包 / Upstream npm package | <https://www.npmjs.com/package/imap-mcp-server> |

上游仓库欢迎贡献（Pull Request / Issue）。如果你希望此修复合入官方版本，建议先在 [上游 Issues](https://github.com/nikolausm/imap-mcp-server/issues) 讨论方案（注意上游有意保留数组输入）。/ Upstream welcomes contributions (Pull Requests / Issues). If you want this fix merged into the official release, it is recommended to first discuss the approach in the [upstream Issues](https://github.com/nikolausm/imap-mcp-server/issues) (note that upstream intentionally keeps array input support).

## License / 许可证

[MIT](LICENSE)

Copyright (c) 2024 **Michael Nikolaus**（原始作者 / original author）

本仓库为上游项目的修改版（fork），根据 MIT 许可证条款发布，**保留原始版权声明**；修改部分归修改者所有。MIT 允许使用、复制、修改、发布和分发，包括商用，但须包含上述版权声明与本许可声明。/ This repository is a modified re-release (fork) of the upstream project, published under the MIT License with **the original copyright notice preserved**; modifications belong to their author. MIT permits use, copying, modification, publication and distribution, including commercial use, provided the above copyright notice and this permission notice are included.
