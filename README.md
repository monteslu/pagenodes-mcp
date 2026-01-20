# pagenodes-mcp

MCP server that lets AI assistants build and deploy PageNodes flows.

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
| `/health` | GET | Health check: `{ status, pagenodes: "connected"\|"waiting" }` |
| `ws://` | WebSocket | PageNodes browser connection (internal) |

## Tools

Once connected, the AI assistant has access to:

| Tool | Description |
|------|-------------|
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
| `get_inject_nodes` | List all inject nodes (triggerable) |
| `inject_node` | Trigger an inject node |
| `trigger_node` | Send a message to any node's input |
| `clear_debug` | Clear debug message buffer |
| `clear_errors` | Clear error message buffer |
| `get_node_statuses` | Get status of all nodes (connection states, etc.) |
| `get_canvas_svg` | Get SVG of the flow canvas

## License

ISC
