# Figma MCP Free

- [Install](#install)
- [Features](#features)
- [Manual Setup](#manual-setup)
- [Tools](#tools)
- [Structure](#structure)
- [How It Works](#how-it-works)

<br/>

A plugin + MCP server that streams live Figma document data to AI coding tools without hitting Figma's REST API rate limits. Figma's free-tier API limits are brutal (a handful of requests per month), so I built this to bypass that entirely — the plugin reads directly from the Figma canvas and streams data over a local WebSocket to the MCP server.

## Install

### Automatic (recommended)

Clone the repo and run the installer — it detects every installed AI tool and configures them all in one shot.

**macOS / Linux**
```bash
git clone https://github.com/slashdoodleart/figma-mcp-free.git
cd figma-mcp-free
chmod +x install.sh && ./install.sh
```

**Windows (PowerShell)**
```powershell
git clone https://github.com/slashdoodleart/figma-mcp-free.git
cd figma-mcp-free
.\install.ps1
```

The installer:
- Builds the MCP server from source
- Auto-detects and configures: **Claude Desktop**, **Claude Code**, **Cursor**, **VS Code**, **VS Code Insiders**, **Windsurf**, **Gemini Code (Antigravity)**, **Zed**, **Codex** (when the `codex` CLI is on PATH)
- Sets Codex's MCP tool-call timeout to **600 seconds** to allow time for script approval
- Skips tools that aren't installed (re-run after installing any new tool)
- Prints the plugin install path

Then in Figma: **Plugins → Development → Import plugin from manifest** → select `plugin/manifest.json`.

## Features

- **Zero API calls** — reads directly from the Figma plugin API, no REST API tokens needed
- **Full design extraction** — layout (auto-layout → flexbox), typography (with accurate font weights + mixed text segments), fills (solid, gradient, image with variable bindings), effects (shadows, blurs → CSS), constraints, component data
- **Screenshot export** — PNG (with transparency), JPG, SVG, PDF at configurable scale — returned as viewable images to the AI
- **Target nodes by ID** — `get_design_context` and `get_screenshot` accept `nodeIds` to target specific nodes without selecting them in Figma
- **Design tokens** — extracts Figma variables (colors, spacing, typography) for token mapping
- **Structural metadata** — lightweight node tree for navigating large designs before deep-fetching
- **Leader election** — multiple MCP server instances auto-coordinate; only one holds the WebSocket
- **Works with any MCP client** — VS Code, Cursor, Windsurf, Claude Desktop, Gemini Code, Zed, etc.

## Manual Setup

### Supported tools & config locations

| Tool | Config file |
|------|-------------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `~/.claude/mcp.json` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code / GitHub Copilot | `~/Library/Application Support/Code/User/mcp.json` (macOS) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini Code (Antigravity) | `~/Library/Application Support/Google/GeminiCode/mcp_config.json` |
| Zed | `~/.config/zed/settings.json` |
| Codex CLI / IDE | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) |

For JSON-based clients, add the MCP server entry to `mcpServers` in the relevant file. For Codex's TOML configuration, see [Approved JavaScript editing](#approved-javascript-editing).

```json
{
  "mcpServers": {
    "figma-mcp-free": {
      "command": "node",
      "args": ["/absolute/path/to/figma-mcp-free/server/dist/index.js"]
    }
  }
}
```

Or use `npx` (no build required):

```json
{
  "mcpServers": {
    "figma-mcp-free": {
      "command": "npx",
      "args": ["-y", "figma-mcp-free"]
    }
  }
}
```

### VS Code / GitHub Copilot

Add to `~/Library/Application Support/Code/User/mcp.json` (global) or `.vscode/mcp.json` (workspace):

```json
{
  "servers": {
    "figma-bridge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figma-mcp-free"]
    }
  }
}
```

For the best experience, use the included VS Code agent (`Figma MCP Free`) and Copilot instructions in `.github/copilot-instructions.md` — they define the recommended design-to-code workflow.

## Tools

| Tool | Description |
|------|-------------|
| `get_metadata` | Lightweight node tree with IDs, types, positions, sizes. Use first on large designs. |
| `get_design_context` | Full design data — layout, typography, fills, effects, constraints, components. Primary tool. |
| `get_screenshot` | Export screenshot as PNG/JPG/SVG/PDF. PNG preserves transparency. |
| `get_variable_defs` | All Figma variable collections and values (design tokens). |
| `get_styles` | Local paint, text, effect, and grid styles. |
| `get_node` | Fetch a specific node by ID. |
| `get_selection` | Get currently selected nodes with full properties. |
| `get_document` | Full page document tree. |
| `save_screenshots` | Export + save screenshots directly to filesystem. |
| `create_design_system_rules` | Generate AI workflow rules tailored to your stack. |
| `request_script_execution` | Propose an async JavaScript edit; execute in the plugin only after the user approves the exact code. |

### Approved JavaScript editing

`request_script_execution` accepts `description` (1–4000 characters, in the user's language, naming the affected elements) and `code` (an async function body, up to 100000 characters). Inspect the target nodes with the read tools first, then request one coherent task. The existing plugin window shows the description, expandable exact code, and **Запустить / Отклонить** buttons. Code is text, never rendered as HTML. Only the current request's matching ID, code, approval token, and connection session can authorize it. Rejection returns `status: "rejected"`; the model must not resubmit without the user's request.

The plugin executes code in its **main sandbox**, using `new Function` to wrap an async function with injected `figma` and a separate `console`; the server and UI iframe never evaluate it. Before accepting requests, each plugin instance performs a harmless runtime probe that awaits a promise and reads `figma.root.id` through the same execution mechanism. The UI displays capability status. If the runtime disallows dynamic functions, editing fails closed with `unavailable`. This probe is a runtime compatibility check, not a security sandbox: approved code receives the Plugin API. Review code before approving it.

Editing is enabled only for `figma.editorType === "figma"` and `figma.mode === "default"`, checked again on approval. Dev Mode stays read-only and retains the existing read tools, consistent with [Figma's Dev Mode restrictions](https://developers.figma.com/docs/plugins/working-in-dev-mode/). Do not close the plugin, manage Undo, register background work, or leave document changes running after return. Load required fonts using `await figma.loadFontAsync(...)` before changing text. For example:

```json
{
  "description": "Переименовать фрейм 12:34 в «Главная»",
  "code": "const node = await figma.getNodeByIdAsync('12:34'); if (!node) throw new Error('Frame not found'); node.name = 'Главная'; console.info('Renamed', node.id); return { id: node.id, name: node.name };"
}
```

Requests queue in the main plugin (at most 20 waiting); only one approval is presented at a time and executions never overlap. Approval has **no bridge or follower HTTP timeout**. Execution has a separate deadline starting on approval. A timeout reports uncertainty, never forced cancellation: synchronous infinite loops block the plugin event loop and ordinary timers cannot stop them. The server can still report its own timeout. An asynchronous script that exceeds its deadline keeps the execution lock until it actually settles. If it later settles while connected, the same log file is updated with the eventual outcome; the original MCP timeout response remains a timeout. Closing the plugin or losing/replacing the connection invalidates waiting approvals. An already running script may continue. There is no automatic retry or reconnect replay. After timeout or lost connection, inspect the document before deciding whether to request another run.

Client-side MCP timeouts are independent. For `request_script_execution`, we recommend a **600-second tool-call timeout** so the user has time to read the code and approve or reject it. This includes approval waiting and execution; it does not change `FIGMA_SCRIPT_TIMEOUT_MS`, which starts only after approval. Ordinary read tools usually do not need a longer client timeout. Cancelling a client call is not proof that plugin execution stopped.

For **Codex CLI / IDE**, the installers configure this automatically when the `codex` CLI is on PATH. For manual setup, add this entry to `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`), replacing the server path:

```toml
[mcp_servers.figma-mcp-free]
command = "node"
args = ["/absolute/path/to/figma-mcp-free/server/dist/index.js"]
tool_timeout_sec = 600
```

If the server entry already exists, add or update `tool_timeout_sec` inside that table instead of creating another one. Codex's default is 60 seconds; see the [official MCP configuration documentation](https://developers.openai.com/codex/mcp/). Restart Codex / the IDE extension after changing the configuration. A project-level entry can override the installer-written user configuration, so update its timeout as well if present.

For **other MCP clients**, use the client's documented tool-call timeout setting; the name, units and configuration location vary. `tool_timeout_sec` is specific to Codex and should not be copied into other clients' JSON configs.

Results contain `requestId`, `status`, `result` or `error` (with available `stack`), absolute `logsPath`, and a short `logsTail`. Statuses are `success`, `error`, `rejected`, `unavailable`, `timeout`, and `unknown`. Execution errors are directly visible in the tool response and marked as MCP errors; partial edits are **not** automatically rolled back. The model must await confirmed success before claiming edits were applied. Results must be JSON-serializable (up to 256000 characters); no return value becomes `null`.

The plugin calls [`figma.commitUndo()`](https://developers.figma.com/docs/plugins/api/properties/figma-commitundo/) before and after each execution, including failed executions, to delimit its changes. Avoid concurrent manual edits during a run; they can interleave with async work. The post-run **Отменить изменения** button is deliberately **disabled** with an explanation: Figma exposes no reliable way to inspect the top of the shared undo history, so this plugin cannot prove `triggerUndo()` would undo only that run. It never risks undoing subsequent manual edits or another run. Use native Undo after inspecting the document. Independent restoration of an old run is not supported.

Each run receives its own `console.log/info/warn/error/debug`; the global plugin console is unchanged. Log arguments are safely bounded, cycles are marked, accessors are skipped, and excessive output is truncated with a warning (200 normal entries, 64000 characters total, at most 10 arguments per call, bounded depth and string length). Logs stream to the leader MCP server. Available logs and outcome are saved as a separate UTF-8 JSONL file when the run receives a terminal status, including rejection, timeout and disconnect. A server crash before persistence can lose buffered logs. Late logs are retained within the same limits while a timed-out script remains connected; logs unavailable due to connection loss cannot be recovered automatically.

Configure these environment variables on the **leader** MCP server (use identical settings for all instances that can become leader):

| Variable | Default | Meaning |
|----------|---------|---------|
| `FIGMA_SCRIPT_LOG_DIR` | `~/.figma-mcp-free/logs` | Log directory; relative paths resolve against server working directory, returned paths are absolute. |
| `FIGMA_SCRIPT_LOG_MAX_BYTES` | `1048576` | Maximum bytes per file (4096–16777216); oversized records/file contents are truncated. |
| `FIGMA_SCRIPT_LOG_MAX_FILES` | `100` | Maximum retained run files (1–10000). |
| `FIGMA_SCRIPT_LOG_MAX_DAYS` | `7` | Retention age (1–3650 days). Cleanup runs when saving logs. |
| `FIGMA_SCRIPT_TIMEOUT_MS` | `30000` | Execution deadline (100–600000 ms); never applies to approval waiting. |

Only generated `script-<UUID>.jsonl` files are pruned. Logging failures return `logsError` alongside the original execution status/result/error; `logsPath` then denotes the intended location and may not exist. They never trigger re-execution. Codex can read full logs using file tools when the directory is accessible in its environment; remote clients may need shared storage. Logs may contain document content: choose directory permissions and retention accordingly.

### Verification

Run `npm test` in `server/` for schema, real local WebSocket, follower HTTP, timeout/disconnect, JSONL persistence and retention tests. Run `npm run typecheck`, `npm test`, and `npm run build` in `plugin/` for type checking, simulated Plugin API execution lifecycle tests, and production bundles. The simulated tests do not establish compatibility with Figma's real sandbox.

Run `node --test scripts/tests/*.test.mjs` from the repository root to verify the installer's Codex timeout configuration helper.

Manual Figma acceptance checks (required before relying on editing in a particular runtime):

1. Import the built `plugin/manifest.json` in Figma Design. Verify the JavaScript runtime probe reports readiness. Approve a script using `await`, `figma.getNodeByIdAsync`, a small edit and a JSON return. Verify the document, tool result, and JSONL log.
2. Leave a request open for more than 30 seconds (also through a follower MCP process); verify it still waits. Reject it and verify `rejected` without edits. Try consecutive requests and repeated clicks; verify one execution per approval.
3. Run a script that changes a node, logs a circular object, then throws. Verify error and stack, captured logs, retained partial edits, and one native Undo group when there are no interleaved manual edits. Verify the plugin's rollback button remains disabled with its explanation, including after subsequent edits and runs.
4. Use a cooperative pending promise past the execution deadline. Verify `timeout`, no overlapping run, and the eventual outcome/log update after it settles. Do not use an infinite loop in a valuable document.
5. Disconnect/reconnect while waiting and while running; close the plugin during a run. Verify waiting approvals cannot be reused, old sessions cannot approve new work, and uncertain results never claim cancellation or success. Inspect the document before retrying.
6. Open in Dev Mode. Verify JavaScript editing is unavailable and the existing read tools still work. Return to Design, reload the plugin if needed, and repeat the runtime probe.

These are manual acceptance steps, not claims that a live Figma session has been tested.

## Local Development

```bash
git clone https://github.com/slashdoodleart/figma-mcp-free.git
cd figma-mcp-free

# Build server
cd server && npm install && npm run build

# Build plugin
cd ../plugin && npm install && npm run build
```

Then run `./install.sh` (or `.\install.ps1`) to configure your AI tools.

## Structure

```
figma-mcp-free/
├── plugin/                 # Figma plugin (TypeScript/React)
│   ├── src/main/
│   │   ├── code.ts         # Plugin handler — processes bridge requests
│   │   └── serializer.ts   # Serializes Figma nodes → structured JSON
│   └── src/ui/
│       └── App.tsx          # Plugin UI (connection status)
└── server/                 # MCP server (TypeScript/Node.js)
    └── src/
        ├── index.ts         # Entry point
        ├── bridge.ts        # WebSocket bridge to Figma plugin
        ├── leader.ts        # Leader: HTTP server + bridge
        ├── follower.ts      # Follower: proxies to leader via HTTP
        ├── node.ts          # Dynamic leader/follower role switching
        ├── election.ts      # Leader election & health monitoring
        ├── tools.ts         # MCP tool definitions
        ├── schema.ts        # Zod input schemas
        └── types.ts         # Shared types
```

## How It Works

### The Figma Plugin

Runs inside Figma and reads directly from the canvas using the Figma Plugin API. It serializes nodes into structured JSON with full layout, typography, visual styles, design tokens, and component data. Connects to the MCP server over WebSocket at `ws://localhost:1994`.

### The MCP Server

Receives tool calls from AI clients via stdio (MCP protocol), forwards them to the Figma plugin over the WebSocket, and returns the results. Multiple server instances use leader election — only one holds the WebSocket connection, others proxy requests via HTTP.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FIGMA (Browser)                                │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         Figma Plugin                                  │  │
│  │               Reads canvas → serializes → streams                    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ WebSocket (ws://localhost:1994)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PRIMARY MCP SERVER (Leader)                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  • Manages WebSocket to plugin          Endpoints:                  │    │
│  │  • Forwards MCP tool calls              • /ws    (plugin)           │    │
│  │  • Routes responses back                • /ping  (health)           │    │
│  │                                         • /rpc   (followers)        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                           ▲                              ▲
                           │ HTTP /rpc                    │ HTTP /rpc
         ┌─────────────────┴───────────┐    ┌─────────────┴───────────────┐
         │      FOLLOWER SERVER 1      │    │      FOLLOWER SERVER 2      │
         │  • Proxies to leader        │    │  • Proxies to leader        │
         │  • Takes over if leader     │    │  • Takes over if leader     │
         │    goes down                │    │    goes down                │
         └─────────────────────────────┘    └─────────────────────────────┘
                    ▲                                      ▲
                    │ MCP (stdio)                          │ MCP (stdio)
                    ▼                                      ▼
         ┌─────────────────────────────┐    ┌─────────────────────────────┐
         │       AI Tool / IDE 1       │    │       AI Tool / IDE 2       │
         └─────────────────────────────┘    └─────────────────────────────┘
```

## License

MIT
