# pagenodes-mcp

Server that lets AI assistants build and deploy PageNodes flows.

Supports two interfaces:
- **MCP (Model Context Protocol)** - For Claude Code, Claude Desktop, Codex, Cursor, VS Code, etc.
- **HTTP REST API** - For Moltbot/Clawdbot skills, webhooks, or any HTTP client

## Install

```
npm install -g pagenodes-mcp
```

Or run directly:
```
npx pagenodes-mcp
```

## Quick Start

1. Start the MCP server: `npx pagenodes-mcp`
2. Open PageNodes in your browser
3. Enable MCP in PageNodes: hamburger menu (☰) → Settings → Enable "MCP Server Connection"
4. Configure your AI tool (see below)

## AI Tool Configuration

### Claude Code (CLI)

Claude Code connects via HTTP+SSE (recommended for network connections).

**Option 1: CLI command**
```bash
claude mcp add --transport sse pagenodes http://localhost:7778/sse
```

To make it available across all your projects, add `--scope user`:
```bash
claude mcp add --transport sse --scope user pagenodes http://localhost:7778/sse
```

**Option 2: Edit config directly**

Add to your settings file (`~/.claude.json` for user scope, or `.mcp.json` in your project root for project scope):
```json
{
  "mcpServers": {
    "pagenodes": {
      "type": "sse",
      "url": "http://localhost:7778/sse"
    }
  }
}
```

Verify with: `claude mcp list`

### Claude Desktop

Claude Desktop spawns MCP servers as subprocesses using stdio.

Open Settings → Developer → Edit Config (or edit `~/.config/claude/claude_desktop_config.json` on Linux, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "pagenodes": {
      "command": "npx",
      "args": ["pagenodes-mcp", "--stdio"]
    }
  }
}
```

Restart Claude Desktop after saving.

### OpenAI Codex CLI

Codex stores MCP config in `~/.codex/config.toml`.

**For HTTP/SSE** (edit config directly):

Add to `~/.codex/config.toml`:
```toml
[mcp_servers.pagenodes]
url = "http://localhost:7778/sse"
```

**For stdio** (CLI command):
```bash
codex mcp add pagenodes -- npx pagenodes-mcp --stdio
```

Or edit config directly:
```toml
[mcp_servers.pagenodes]
command = "npx"
args = ["pagenodes-mcp", "--stdio"]
```

### VS Code + GitHub Copilot

VS Code uses `.vscode/mcp.json` in your project (or workspace settings).

Create `.vscode/mcp.json`:
```json
{
  "servers": {
    "pagenodes": {
      "type": "http",
      "url": "http://localhost:7778/sse"
    }
  }
}
```

Or for stdio:
```json
{
  "servers": {
    "pagenodes": {
      "command": "npx",
      "args": ["pagenodes-mcp", "--stdio"]
    }
  }
}
```

Open Copilot Chat → click the tools icon to see available MCP servers.

### Cursor

Cursor supports global (`~/.cursor/mcp.json`) or project-level (`.cursor/mcp.json`) config.

Create or edit the config file:
```json
{
  "mcpServers": {
    "pagenodes": {
      "url": "http://localhost:7778/sse"
    }
  }
}
```

Or for stdio:
```json
{
  "mcpServers": {
    "pagenodes": {
      "command": "npx",
      "args": ["pagenodes-mcp", "--stdio"]
    }
  }
}
```

You can also use Command Palette → "MCP: Add Server" to configure via UI.

## Server Options

```
-p, --port <number>  HTTP/WebSocket port (default: 7778, env: PAGENODES_MCP_PORT)
--stdio              Enable stdio MCP transport
```

## Transport Modes

| Mode | Use Case | How it works |
|------|----------|--------------|
| **HTTP+SSE** | Network connections (Claude Code, Codex, VS Code, Cursor) | Client connects to `/sse`, posts to `/message` |
| **stdio** | Spawned subprocess (Claude Desktop) | JSON-RPC over stdin/stdout |

Both modes can run simultaneously - the server listens on HTTP while also accepting stdio if `--stdio` is passed.

## Connection Flow

```
PageNodes (browser) ──WebSocket──► MCP Server ◄──HTTP/stdio──► Claude
```

1. Start the MCP server
2. Open PageNodes in browser
3. Enable MCP connection in PageNodes settings (hamburger menu → Settings)
4. Claude can now create and deploy flows

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | SSE connection for MCP clients (returns `endpoint` event with POST URL) |
| `/message` | POST | JSON-RPC messages from SSE clients |
| `/mcp` | POST | Legacy direct JSON-RPC endpoint |
| `/health` | GET | Health check: `{ status, devices }` |
| `/func/{tool}` | POST | REST endpoint - call any tool via HTTP (see below) |
| `/generate_skill_definition` | GET | Generate Moltbot-compatible SKILL.md |
| `ws://` | WebSocket | PageNodes device connection (internal) |

## REST API (for Moltbot / HTTP clients)

Every MCP tool is also available as a REST endpoint:

```bash
# List connected devices
curl -X POST http://localhost:7778/func/list_devices

# Get flows from a device
curl -X POST http://localhost:7778/func/get_flows \
  -H "Content-Type: application/json" \
  -d '{"deviceId": "device-abc123"}'

# Deploy
curl -X POST http://localhost:7778/func/deploy \
  -H "Content-Type: application/json" \
  -d '{"deviceId": "device-abc123"}'
```

### Moltbot / Clawdbot Integration

Generate a SKILL.md file for Moltbot:

```bash
curl http://localhost:7778/generate_skill_definition > ~/.clawdbot/skills/pagenodes/SKILL.md
```

This creates a skill definition with all available functions documented. Moltbot can then control PageNodes via the REST API.

## Tools

Once connected, the AI assistant has access to these tools (also available via `/func/{tool}` REST endpoint):

| Tool | Description |
|------|-------------|
| `list_devices` | List all connected PageNodes devices |
| `get_device_details` | Get detailed info about a specific device |
| `get_started` | **CALL THIS FIRST.** Returns guide, node catalog, and current state |
| `get_flows` | Get current flows, nodes, and config nodes |
| `get_node_details` | Get full details for a specific node type |
| `create_flow` | Create a new flow tab |
| `add_nodes` | Add multiple nodes with automatic wire resolution |
| `update_node` | Update a node's properties or position |
| `delete_node` | Delete a node from a flow |
| `deploy` | Deploy flows to the runtime |
| `get_debug_output` | Get recent debug panel messages |
| `get_errors` | Get recent runtime errors |
| `get_logs` | Get recent logs (UI, runtime, audio, etc.) with optional filters |
| `clear_logs` | Clear the log buffer |
| `get_inject_nodes` | List all inject nodes (triggerable) |
| `inject_node` | Trigger an inject node |
| `trigger_node` | Send a message to any node's input |
| `clear_debug` | Clear debug message buffer |
| `clear_errors` | Clear error message buffer |
| `get_node_statuses` | Get status of all nodes (connection states, etc.) |
| `get_canvas_svg` | Get SVG of the flow canvas |
| `get_mcp_messages` | Get messages from mcp-out nodes |
| `send_mcp_message` | Send a message to mcp-in nodes |
| `get_custom_tools` | List custom tools defined by tool-in nodes |
| `use_custom_tool` | Execute a custom tool (AI-defined tool backed by a flow) |

## Custom Tools (AI-Defined Tools)

PageNodes allows AI agents to create their own tools. Using `tool-in` and `tool-out` nodes, you define custom tools backed by PageNodes flows. This means AI can extend its own capabilities at runtime.

### How It Works

1. **Create a tool-in node** with a name (e.g., `get_weather`) and description
2. **Wire it through your flow** - http requests, functions, hardware access, whatever
3. **End with a tool-out node** which returns `msg.payload` as the result
4. **Deploy** - the tool persists and is callable via `use_custom_tool`

### Example

```
[tool-in: search_web]
    ↓
[http request: search API]
    ↓
[function: format results]
    ↓
[tool-out]
```

Now any AI can call:
```javascript
use_custom_tool({
  deviceId: "device-abc123",
  name: "search_web",
  message: { payload: "PageNodes tutorial" }
})
```

The flow executes and returns the result from `tool-out`.

### Discovery

Custom tools with full descriptions appear in `get_device_details`:
```json
{
  "nodeCatalog": [...],
  "customTools": [
    { "name": "search_web", "description": "Searches the web and returns top 5 results" },
    { "name": "get_weather", "description": "Gets current weather for a city" }
  ]
}
```

The `list_devices` response includes tool names for quick reference. Use `get_custom_tools` or `get_device_details` for full details including descriptions.

### AI-to-AI Collaboration

Custom tools persist in the flow. One AI can create complex tools - multi-step logic, error handling, API integrations - and expose them with clear descriptions. Another AI connects later, sees the available tools, and uses them without knowing the implementation.

A more capable model can build tools that simpler models can use. The tools become infrastructure that accumulates over time.

## License

ISC
