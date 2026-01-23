import http from 'http';
import { WebSocketServer } from 'ws';
import rawr from 'rawr';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the guide markdown
const guidePath = path.join(__dirname, 'PAGENODES.md');
const guideContent = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf-8') : '';

// Default port
export const DEFAULT_PORT = 7778;

// State
let pagenodesPeer = null;
let pagenodesConnected = false;
let clientUrl = null;  // URL of the connected PageNodes browser instance

// SSE connections: Map<sessionId, { res, log }>
const sseConnections = new Map();

// MCP tool definitions
const MCP_TOOLS = [
  {
    name: 'get_started',
    description: 'CALL THIS FIRST. Returns the integration guide, node catalog, and current flow state needed to build flows.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_flows',
    description: 'Get the current flows, nodes, and config nodes',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_flow',
    description: 'Create a new flow tab. Returns { success, flow: { id, type, label } } - use the returned id for adding nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Flow tab label' }
      },
      required: ['label']
    }
  },
  {
    name: 'add_nodes',
    description: 'Add multiple nodes to a flow with automatic wire resolution. Each node has a tempId for wiring - the server converts tempIds to real generated IDs in wires and streamWires. Node properties (payload, topic, func, broker, etc.) go at top level, not nested.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'ID of the flow to add to (from get_flows or create_flow response)' },
        nodes: {
          type: 'array',
          description: 'Array of nodes. Each node has tempId, type, x, y, wires, and any node-specific properties at top level (e.g., payload, topic, func, broker).',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              tempId: { type: 'string', description: 'Temporary ID for wiring (e.g., "a", "b", "inject1")' },
              type: { type: 'string', description: 'Node type (e.g., "inject", "debug", "function")' },
              x: { type: 'number', description: 'X position on canvas' },
              y: { type: 'number', description: 'Y position on canvas' },
              name: { type: 'string', description: 'Optional display name' },
              wires: {
                type: 'array',
                description: 'Wires using tempIds: [["b", "c"]] connects output 0 to nodes b and c',
                items: { type: 'array', items: { type: 'string' } }
              },
              streamWires: {
                type: 'array',
                description: 'Audio stream wires using tempIds (same format as wires). For audio nodes only.',
                items: { type: 'array', items: { type: 'string' } }
              }
            },
            required: ['tempId', 'type', 'x', 'y']
          }
        }
      },
      required: ['flowId', 'nodes']
    }
  },
  {
    name: 'update_node',
    description: 'Update a node\'s properties or position',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the node to update' },
        updates: { type: 'object', description: 'Properties to update (can include x, y, name, or config properties)' }
      },
      required: ['nodeId', 'updates']
    }
  },
  {
    name: 'delete_node',
    description: 'Delete a node from a flow',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the node to delete' }
      },
      required: ['nodeId']
    }
  },
  {
    name: 'deploy',
    description: 'Deploy the current flows to the runtime',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_debug_output',
    description: 'Get recent debug panel messages (newest first)',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of messages to return (default: 10)', default: 10 }
      },
      required: []
    }
  },
  {
    name: 'get_errors',
    description: 'Get recent runtime errors from the flow (newest first). Includes node information, error message, stack trace, and message ID for correlation.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of errors to return (default: 10)', default: 10 }
      },
      required: []
    }
  },
  {
    name: 'get_logs',
    description: 'Get recent logs from PageNodes (UI, runtime, audio, etc.). Returns entries with timestamp (t), context (c), level (l), and message (m).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of logs to return (default: 100)', default: 100 },
        context: { type: 'string', description: 'Filter by context (e.g., "ui", "runtime", "audio", "mcp", "worker")' },
        level: { type: 'string', description: 'Filter by level ("log", "warn", "error")' }
      },
      required: []
    }
  },
  {
    name: 'clear_logs',
    description: 'Clear all logs from the buffer.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_inject_nodes',
    description: 'Get all inject nodes in the current flows. Use this to find nodes you can trigger.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'inject_node',
    description: 'Trigger an inject node with an optional payload. Returns { success, _msgid } where _msgid can be used to trace the message in debug output. The node must be deployed first.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the inject node to trigger' },
        payload: {
          description: 'Optional payload to inject (string, number, boolean, or object). If not provided, uses the node\'s configured payload.',
        }
      },
      required: ['nodeId']
    }
  },
  {
    name: 'get_node_details',
    description: 'Get full details for a specific node type including all properties, defaults, and help documentation. Use this when you need to understand how to configure a particular node.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Node type (e.g., "inject", "http request", "mqtt in")' }
      },
      required: ['type']
    }
  },
  {
    name: 'trigger_node',
    description: 'Send a message to ANY node\'s input (not just inject nodes). Use this to trigger flows that start with non-inject nodes, or to send test messages mid-flow. Returns { success, _msgid, nodeType }.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the node to trigger' },
        msg: {
          type: 'object',
          description: 'Message object to send. Can include payload, topic, and any other properties.',
          additionalProperties: true
        }
      },
      required: ['nodeId']
    }
  },
  {
    name: 'clear_debug',
    description: 'Clear all debug messages from the buffer. Useful before running a test to get a clean slate.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'clear_errors',
    description: 'Clear all error messages from the buffer. Useful before running a test to get a clean slate.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_node_statuses',
    description: 'Get the current status of all nodes (connection states, ready indicators, etc.). Returns an object mapping node IDs to their status objects.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_canvas_svg',
    description: 'Get the SVG content of the flow canvas. Returns the visual representation of the current flow including nodes, wires, and their positions. Useful for understanding the visual layout.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_mcp_messages',
    description: 'Get messages from the MCP output queue. Messages are sent by mcp-output nodes in flows (e.g., voice recognition output). Returns and clears messages by default.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of messages to return (default: 100)', default: 100 },
        clear: { type: 'boolean', description: 'Clear returned messages from queue (default: true)', default: true }
      },
      required: []
    }
  },
  {
    name: 'send_mcp_message',
    description: 'Send a message to all mcp-input nodes in the flows. Use this to inject messages, trigger speech output, or control flows directly without needing a pre-configured inject node.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { description: 'Message payload (string, number, boolean, or object)' },
        topic: { type: 'string', description: 'Optional topic for filtering (mcp-input nodes can filter by topic)', default: '' }
      },
      required: ['payload']
    }
  }
];

// MCP Protocol Handler
class MCPHandler {
  constructor(log) {
    this.log = log || console.error.bind(console);
  }

  // Handle a JSON-RPC request and return the response
  async handleRequest(request) {
    const { id, method, params } = request;

    try {
      let result;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params);
          break;
        case 'notifications/initialized':
          // Client acknowledgment, no response needed
          return null;
        case 'tools/list':
          result = await this.handleToolsList();
          break;
        case 'tools/call':
          result = await this.handleToolCall(params);
          break;
        case 'ping':
          result = {};
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      if (id !== undefined) {
        return { jsonrpc: '2.0', id, result };
      }
      return null;
    } catch (err) {
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err.message }
        };
      }
      return null;
    }
  }

  // Handle initialize request
  async handleInitialize(params) {
    this.log('MCP Initialize:', params?.clientInfo?.name || 'unknown client');
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'pagenodes-mcp',
        version: '0.1.0'
      }
    };
  }

  // Handle tools/list request
  async handleToolsList() {
    return { tools: MCP_TOOLS };
  }

  // Handle tools/call request
  async handleToolCall(params) {
    const { name, arguments: args } = params;

    if (!pagenodesConnected) {
      return {
        content: [{
          type: 'text',
          text: `PageNodes is not connected to the MCP server.

IMPORTANT: Tell the user to:
1. Open PageNodes in their browser
2. Click the hamburger menu (☰) → Settings
3. Enable "MCP Server Connection"
4. Ensure the port matches (default: 7778)

The MCP server is running and waiting for PageNodes to connect. Once the user completes these steps, you can retry the operation.`
        }]
      };
    }

    try {
      let result;

      switch (name) {
        case 'get_started':
          result = await this.toolGetStarted();
          break;
        case 'get_flows':
          result = await this.toolGetFlows();
          break;
        case 'create_flow':
          result = await this.toolCreateFlow(args);
          break;
        case 'add_nodes':
          result = await this.toolAddNodes(args);
          break;
        case 'update_node':
          result = await this.toolUpdateNode(args);
          break;
        case 'delete_node':
          result = await this.toolDeleteNode(args);
          break;
        case 'deploy':
          result = await this.toolDeploy();
          break;
        case 'get_debug_output':
          result = await this.toolGetDebugOutput(args);
          break;
        case 'get_errors':
          result = await this.toolGetErrors(args);
          break;
        case 'get_logs':
          result = await this.toolGetLogs(args);
          break;
        case 'clear_logs':
          result = await this.toolClearLogs();
          break;
        case 'get_inject_nodes':
          result = await this.toolGetInjectNodes();
          break;
        case 'inject_node':
          result = await this.toolInjectNode(args);
          break;
        case 'get_node_details':
          result = await this.toolGetNodeDetails(args);
          break;
        case 'trigger_node':
          result = await this.toolTriggerNode(args);
          break;
        case 'clear_debug':
          result = await this.toolClearDebug();
          break;
        case 'clear_errors':
          result = await this.toolClearErrors();
          break;
        case 'get_node_statuses':
          result = await this.toolGetNodeStatuses();
          break;
        case 'get_canvas_svg':
          result = await this.toolGetCanvasSvg();
          break;
        case 'get_mcp_messages':
          result = await this.toolGetMcpMessages(args);
          break;
        case 'send_mcp_message':
          result = await this.toolSendMcpMessage(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${err.message}`
        }],
        isError: true
      };
    }
  }

  // Tool implementations
  async toolGetStarted() {
    const state = await pagenodesPeer.methods.getState();
    return {
      guide: guideContent,
      clientUrl: clientUrl || null,  // URL of the connected PageNodes browser instance
      ...state
    };
  }

  async toolGetFlows() {
    return await pagenodesPeer.methods.getFlows();
  }

  async toolCreateFlow(args) {
    return await pagenodesPeer.methods.createFlow(args.label);
  }

  async toolAddNodes(args) {
    return await pagenodesPeer.methods.addNodes(args.flowId, args.nodes);
  }

  async toolUpdateNode(args) {
    return await pagenodesPeer.methods.updateNode(args.nodeId, args.updates);
  }

  async toolDeleteNode(args) {
    return await pagenodesPeer.methods.deleteNode(args.nodeId);
  }

  async toolDeploy() {
    return await pagenodesPeer.methods.deploy();
  }

  async toolGetDebugOutput(args) {
    return await pagenodesPeer.methods.getDebugOutput(args?.limit || 10);
  }

  async toolGetErrors(args) {
    return await pagenodesPeer.methods.getErrors(args?.limit || 10);
  }

  async toolGetLogs(args) {
    return await pagenodesPeer.methods.getLogs(args?.limit || 100, args?.context || null, args?.level || null);
  }

  async toolClearLogs() {
    return await pagenodesPeer.methods.clearLogs();
  }

  async toolGetInjectNodes() {
    return await pagenodesPeer.methods.getInjectNodes();
  }

  async toolInjectNode(args) {
    return await pagenodesPeer.methods.inject(args.nodeId, args.payload);
  }

  async toolGetNodeDetails(args) {
    return await pagenodesPeer.methods.getNodeDetails(args.type);
  }

  async toolTriggerNode(args) {
    return await pagenodesPeer.methods.trigger(args.nodeId, args.msg);
  }

  async toolClearDebug() {
    return await pagenodesPeer.methods.clearDebug();
  }

  async toolClearErrors() {
    return await pagenodesPeer.methods.clearErrors();
  }

  async toolGetNodeStatuses() {
    return await pagenodesPeer.methods.getNodeStatuses();
  }

  async toolGetCanvasSvg() {
    return await pagenodesPeer.methods.getCanvasSvg();
  }

  async toolGetMcpMessages(args) {
    return await pagenodesPeer.methods.getMessages(args?.limit || 100, args?.clear !== false);
  }

  async toolSendMcpMessage(args) {
    return await pagenodesPeer.methods.sendMessage(args.payload, args.topic || '');
  }
}

// Logging helper
function createLogger(useStderr = true) {
  return (...args) => {
    if (useStderr) {
      process.stderr.write(args.join(' ') + '\n');
    } else {
      console.log(...args);
    }
  };
}

// Print status line
function printStatus(log) {
  const status = pagenodesConnected ? '\x1b[32m● Connected\x1b[0m' : '\x1b[33m○ Waiting\x1b[0m';
  const urlInfo = clientUrl ? ` - ${clientUrl}` : '';
  log(`[PageNodes: ${status}${urlInfo}]`);
}

// Start the server
export function startServer(port = DEFAULT_PORT, options = {}) {
  const { stdio = false } = options;
  const log = createLogger(stdio);
  const mcpHandler = new MCPHandler(log);

  // Helper to send SSE event
  function sendSSE(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Create HTTP server
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE endpoint - this is what Claude Code connects to
    if (req.method === 'GET' && (pathname === '/sse' || pathname === '/')) {
      const accept = req.headers.accept || '';

      // If client wants SSE (text/event-stream), set up SSE connection
      if (accept.includes('text/event-stream')) {
        const sessionId = crypto.randomUUID();

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        // Store the connection
        sseConnections.set(sessionId, { res, log });

        // Send the endpoint event telling client where to POST messages
        // The endpoint data is a plain URL string, not JSON
        res.write(`event: endpoint\ndata: http://localhost:${port}/message?sessionId=${sessionId}\n\n`);

        log(`SSE client connected (session: ${sessionId.slice(0, 8)}...)`);

        // Handle client disconnect
        req.on('close', () => {
          sseConnections.delete(sessionId);
          log(`SSE client disconnected (session: ${sessionId.slice(0, 8)}...)`);
        });

        return;
      }

      // Otherwise return health check JSON
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        pagenodes: pagenodesConnected ? 'connected' : 'waiting',
        clientUrl: clientUrl || null
      }));
      return;
    }

    // SSE message endpoint - client POSTs JSON-RPC requests here
    if (req.method === 'POST' && pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId');
      const connection = sseConnections.get(sessionId);

      if (!connection) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid or expired session' }));
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          const response = await mcpHandler.handleRequest(request);

          // Send response via SSE
          if (response) {
            sendSSE(connection.res, 'message', response);
          }

          // Acknowledge the POST
          res.writeHead(202);
          res.end();
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Legacy MCP POST endpoint (for direct HTTP clients)
    if (req.method === 'POST' && (pathname === '/mcp' || pathname === '/')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          const response = await mcpHandler.handleRequest(request);

          res.setHeader('Content-Type', 'application/json');
          if (response) {
            res.writeHead(200);
            res.end(JSON.stringify(response));
          } else {
            res.writeHead(202);
            res.end();
          }
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Health check
    if (req.method === 'GET' && pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        pagenodes: pagenodesConnected ? 'connected' : 'waiting',
        clientUrl: clientUrl || null
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // Attach WebSocket server to HTTP server
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('error', (err) => {
    log('WebSocket server error:', err.message);
  });

  wss.on('connection', (ws) => {
    pagenodesConnected = true;
    log(`\n✓ PageNodes connected`);
    printStatus(log);

    // Set up rawr peer over WebSocket
    pagenodesPeer = rawr({
      transport: rawr.transports.websocket(ws)
    });

    // Handle client registration (browser sends its URL)
    pagenodesPeer.addHandler('registerClient', (info) => {
      if (info && info.url) {
        clientUrl = info.url;
        printStatus(log);
      }
      return { success: true };
    });

    ws.on('close', () => {
      pagenodesConnected = false;
      pagenodesPeer = null;
      clientUrl = null;  // Reset client URL on disconnect
      log(`\n✗ PageNodes disconnected`);
      printStatus(log);
    });

    ws.on('error', (err) => {
      log('WebSocket error:', err.message);
    });
  });

  // Handle server errors before listening
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      log(`  PageNodes MCP Server v0.1.0`);
      log(`  Port ${port} already in use`);
      log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      log(`Another server is running on this port.`);
      process.exit(1);
    } else {
      log('Server error:', err.message);
    }
  });

  // Start listening
  httpServer.listen(port, () => {
    log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(`  PageNodes MCP Server v0.1.0`);
    log(`  HTTP + WebSocket on port ${port}`);
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    log(`SSE endpoint: http://localhost:${port}/sse`);
    log(`WebSocket:    ws://localhost:${port}/`);
    printStatus(log);
    log(`\nOpen PageNodes in browser and enable MCP in Settings.\n`);
  });

  // Handle stdio MCP if enabled (for backwards compatibility)
  if (stdio) {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false
    });

    rl.on('line', async (line) => {
      if (line.trim()) {
        try {
          const request = JSON.parse(line);
          const response = await mcpHandler.handleRequest(request);
          if (response) {
            process.stdout.write(JSON.stringify(response) + '\n');
          }
        } catch (err) {
          log('Error parsing stdin message:', err.message);
        }
      }
    });

    rl.on('close', () => {
      log('stdin closed, shutting down');
      process.exit(0);
    });
  }

  return { httpServer, wss, mcpHandler };
}
