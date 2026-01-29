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

// Device registration schema
// A device is any runtime that speaks the Ainura protocol - PageNodes, Rust, Go, whatever.
// The device just reports what nodes it has. Node details (properties, constraints, behavior)
// are queried from the device itself via get_node_details, since implementations vary.
/*
{
  id: string,                    // Unique identifier (user-assigned or auto-generated)
  type: string,                  // Runtime type: 'browser', 'electron', 'nodejs', 'embedded', 'rust', etc.
  name: string,                  // Human-readable name
  description?: string,          // What/where is this device
  url?: string,                  // Connection URL (for browser instances, hsync URLs, etc.)
  nodes: string[],               // Available node types - just names, no details
  status: 'online' | 'offline' | 'error',
  connectedAt: string,           // ISO timestamp
  lastSeen: string,              // ISO timestamp
  meta?: {
    location?: string,
    owner?: string,
    tags?: string[],
    runtime?: string,            // e.g., "pagenodes-2.0", "ainura-rust-0.1"
    version?: string
  }
}

Node details (properties, defaults, constraints, help) come from get_node_details(deviceId, type).
Two devices may have nodes with the same name but completely different implementations.
*/

// State - Multi-device architecture
// Map<deviceId, { peer, registration, ws, nodeCatalog }>
const devices = new Map();

// Aggregated node catalog across all devices
// Map<nodeType, { type, category, description, devices: string[] }>
const aggregatedNodeCatalog = new Map();

// Rebuild the aggregated node catalog from all connected devices
function rebuildAggregatedCatalog() {
  aggregatedNodeCatalog.clear();

  for (const [deviceId, device] of devices) {
    const catalog = device.nodeCatalog || [];
    for (const node of catalog) {
      if (!node.type) continue;

      if (aggregatedNodeCatalog.has(node.type)) {
        // Node type already exists - add this device to the list
        aggregatedNodeCatalog.get(node.type).devices.push(deviceId);
      } else {
        // New node type - create entry with minimal info
        aggregatedNodeCatalog.set(node.type, {
          type: node.type,
          category: node.category || 'unknown',
          description: node.description || '',
          devices: [deviceId]
        });
      }
    }
  }
}

// Get the aggregated catalog as an array, grouped by category
function getAggregatedCatalog() {
  const byCategory = {};

  for (const node of aggregatedNodeCatalog.values()) {
    const cat = node.category || 'other';
    if (!byCategory[cat]) {
      byCategory[cat] = [];
    }
    byCategory[cat].push({
      type: node.type,
      description: node.description,
      devices: node.devices
    });
  }

  return byCategory;
}

// SSE connections: Map<sessionId, { res, log }>
const sseConnections = new Map();

// Helper to get a device by ID - NO FALLBACK
// Claude must explicitly choose a device after querying list_devices
function getDevice(deviceId) {
  if (!deviceId) {
    return null;
  }
  return devices.get(deviceId);
}

// Generate a default device ID if none provided
function generateDeviceId() {
  return `device-${crypto.randomUUID().slice(0, 8)}`;
}

// MCP tool definitions
const MCP_TOOLS = [
  // === Multi-device management tools ===
  {
    name: 'list_devices',
    description: 'List all connected devices in the swarm. Devices can be any runtime (PageNodes, Rust, Go, etc.) that speaks the Ainura protocol. Returns IDs, types, and node lists. Use get_node_details to inspect specific node implementations.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by device type (browser, electron, nodejs, embedded, rust, etc.)' },
        node: { type: 'string', description: 'Filter by devices that have this node type (e.g., "gpio-out", "http-request")' },
        status: { type: 'string', description: 'Filter by status (online, offline, error)' }
      },
      required: []
    }
  },
  {
    name: 'get_device_details',
    description: 'Get detailed information about a specific device including its node list, current flows, and state. Use get_node_details to understand how specific nodes work on this device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'ID of the device to get details for' }
      },
      required: ['deviceId']
    }
  },
  // === Device-specific tools - deviceId REQUIRED ===
  // Claude must explicitly choose a device after examining capabilities via list_devices/get_device_details
  {
    name: 'get_started',
    description: 'Returns the integration guide, node catalog, and current flow state. Call WITHOUT deviceId to get an aggregated view of all connected devices and their available nodes (recommended first call). Call WITH deviceId to get full details for a specific device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Optional: ID of a specific device. Omit for aggregated view across all devices.' }
      },
      required: []
    }
  },
  {
    name: 'get_flows',
    description: 'Get the current flows, nodes, and config nodes from a specific device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'create_flow',
    description: 'Create a new flow tab on a specific device. Returns { success, flow: { id, type, label } } - use the returned id for adding nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to create flow on' },
        label: { type: 'string', description: 'Flow tab label' }
      },
      required: ['deviceId', 'label']
    }
  },
  {
    name: 'add_nodes',
    description: 'Add multiple nodes to a flow on a specific device. IMPORTANT: Verify the device has the required node types via get_device_details before adding nodes. Each node has a tempId for wiring.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to add nodes to. Verify it has required node capabilities first.' },
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
      required: ['deviceId', 'flowId', 'nodes']
    }
  },
  {
    name: 'update_node',
    description: 'Update a node\'s properties or position on a specific device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device containing the node' },
        nodeId: { type: 'string', description: 'ID of the node to update' },
        updates: { type: 'object', description: 'Properties to update (can include x, y, name, or config properties)' }
      },
      required: ['deviceId', 'nodeId', 'updates']
    }
  },
  {
    name: 'delete_node',
    description: 'Delete a node from a flow on a specific device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device containing the node' },
        nodeId: { type: 'string', description: 'ID of the node to delete' }
      },
      required: ['deviceId', 'nodeId']
    }
  },
  {
    name: 'deploy',
    description: 'Deploy the current flows to the runtime on a specific device. Use "all" for deviceId to deploy to all connected devices.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to deploy, or "all" to deploy to all connected devices' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'get_debug_output',
    description: 'Get recent debug panel messages (newest first) from a specific device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' },
        limit: { type: 'number', description: 'Maximum number of messages to return (default: 10)', default: 10 }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'get_errors',
    description: 'Get recent runtime errors from a specific device (newest first). Includes node information, error message, stack trace, and message ID for correlation.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' },
        limit: { type: 'number', description: 'Maximum number of errors to return (default: 10)', default: 10 }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'get_logs',
    description: 'Get recent logs from a specific device (UI, runtime, audio, etc.). Returns entries with timestamp (t), context (c), level (l), and message (m).',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' },
        limit: { type: 'number', description: 'Maximum number of logs to return (default: 100)', default: 100 },
        context: { type: 'string', description: 'Filter by context (e.g., "ui", "runtime", "audio", "mcp", "worker")' },
        level: { type: 'string', description: 'Filter by level ("log", "warn", "error")' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'clear_logs',
    description: 'Clear all logs from a specific device\'s buffer.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'get_inject_nodes',
    description: 'Get all inject nodes in the current flows on a specific device. Use this to find nodes you can trigger.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'inject_node',
    description: 'Trigger an inject node with an optional payload on a specific device. Returns { success, _msgid } where _msgid can be used to trace the message in debug output. The node must be deployed first.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device containing the node' },
        nodeId: { type: 'string', description: 'ID of the inject node to trigger' },
        payload: {
          description: 'Optional payload to inject (string, number, boolean, or object). If not provided, uses the node\'s configured payload.',
        }
      },
      required: ['deviceId', 'nodeId']
    }
  },
  {
    name: 'get_node_details',
    description: 'Get full details for a specific node type on a specific device. IMPORTANT: Node implementations vary by device type - always check the target device\'s node details before using.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device. Different device types have different node implementations.' },
        type: { type: 'string', description: 'Node type (e.g., "inject", "http request", "mqtt in")' }
      },
      required: ['deviceId', 'type']
    }
  },
  {
    name: 'trigger_node',
    description: 'Send a message to ANY node\'s input on a specific device (not just inject nodes). Use this to trigger flows that start with non-inject nodes, or to send test messages mid-flow. Returns { success, _msgid, nodeType }.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device containing the node' },
        nodeId: { type: 'string', description: 'ID of the node to trigger' },
        msg: {
          type: 'object',
          description: 'Message object to send. Can include payload, topic, and any other properties.',
          additionalProperties: true
        }
      },
      required: ['deviceId', 'nodeId']
    }
  },
  {
    name: 'clear_debug',
    description: 'Clear all debug messages from a specific device\'s buffer. Useful before running a test to get a clean slate.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'clear_errors',
    description: 'Clear all error messages from a specific device\'s buffer. Useful before running a test to get a clean slate.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'get_node_statuses',
    description: 'Get the current status of all nodes on a specific device (connection states, ready indicators, etc.). Returns an object mapping node IDs to their status objects.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'get_canvas_svg',
    description: 'Get the SVG content of the flow canvas from a specific device. Returns the visual representation of the current flow including nodes, wires, and their positions.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'get_mcp_messages',
    description: 'Get messages from the MCP output queue on a specific device. Messages are sent by mcp-output nodes in flows. Returns and clears messages by default.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' },
        limit: { type: 'number', description: 'Maximum number of messages to return (default: 100)', default: 100 },
        clear: { type: 'boolean', description: 'Clear returned messages from queue (default: true)', default: true }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'send_mcp_message',
    description: 'Send a message to mcp-input nodes on a specific device, or broadcast to all devices with "all".',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device, or "all" to broadcast to all devices' },
        payload: { description: 'Message payload (string, number, boolean, or object)' },
        topic: { type: 'string', description: 'Optional topic for filtering (mcp-input nodes can filter by topic)', default: '' }
      },
      required: ['deviceId', 'payload']
    }
  },
  // === Custom Tools - AI-defined tools backed by flows ===
  {
    name: 'get_custom_tools',
    description: 'List custom tools defined by tool-in nodes on a device. These are AI-callable tools backed by PageNodes flows.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device to query' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'use_custom_tool',
    description: 'Execute a custom tool defined by a tool-in node. The tool runs a flow and returns the result from the tool-out node.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'REQUIRED: ID of the device' },
        name: { type: 'string', description: 'Name of the custom tool to execute' },
        message: { type: 'object', description: 'Message object with payload property (e.g. { payload: "hello", topic: "greeting" })' }
      },
      required: ['deviceId', 'name']
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

  // Helper to require a device - NO IMPLICIT FALLBACK
  // Claude must explicitly specify which device to use
  requireDevice(deviceId) {
    const deviceCount = devices.size;

    // No deviceId provided - Claude must explicitly choose
    if (!deviceId) {
      if (deviceCount === 0) {
        return {
          error: true,
          content: [{
            type: 'text',
            text: `No PageNodes devices are connected to the MCP server.

IMPORTANT: Tell the user to:
1. Open PageNodes in their browser (or start an Electron/Node.js instance)
2. Click the hamburger menu (☰) → Settings
3. Enable "MCP Server Connection"
4. Ensure the port matches (default: 7778)

The MCP server is running and waiting for PageNodes to connect. Once connected, you can retry the operation.`
          }]
        };
      } else {
        // Devices exist but Claude didn't specify which one
        const deviceList = Array.from(devices.values()).map(d => ({
          id: d.registration.id,
          name: d.registration.name,
          type: d.registration.type
        }));
        return {
          error: true,
          content: [{
            type: 'text',
            text: `deviceId is required. You must explicitly choose a device after examining its capabilities.

Use list_devices to see available devices, then get_device_details to inspect capabilities before choosing.

Available devices:
${JSON.stringify(deviceList, null, 2)}

IMPORTANT: Do not assume devices have the same capabilities. A browser device cannot control GPIO. An embedded device may not have WebAudio. Always verify the target device has the nodes you need.`
          }]
        };
      }
    }

    // deviceId provided but not found
    const device = getDevice(deviceId);
    if (!device) {
      return {
        error: true,
        content: [{
          type: 'text',
          text: `Device "${deviceId}" not found. Use list_devices to see available devices.`
        }]
      };
    }

    return { error: false, device };
  }

  // Handle tools/call request
  async handleToolCall(params) {
    const { name, arguments: args } = params;

    // list_devices doesn't require a connected device
    if (name === 'list_devices') {
      try {
        const result = await this.toolListDevices(args);
        return {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        };
      }
    }

    try {
      let result;

      switch (name) {
        case 'get_device_details':
          result = await this.toolGetDeviceDetails(args);
          break;
        case 'get_started':
          result = await this.toolGetStarted(args);
          break;
        case 'get_flows':
          result = await this.toolGetFlows(args);
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
          result = await this.toolDeploy(args);
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
          result = await this.toolClearLogs(args);
          break;
        case 'get_inject_nodes':
          result = await this.toolGetInjectNodes(args);
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
          result = await this.toolClearDebug(args);
          break;
        case 'clear_errors':
          result = await this.toolClearErrors(args);
          break;
        case 'get_node_statuses':
          result = await this.toolGetNodeStatuses(args);
          break;
        case 'get_canvas_svg':
          result = await this.toolGetCanvasSvg(args);
          break;
        case 'get_mcp_messages':
          result = await this.toolGetMcpMessages(args);
          break;
        case 'send_mcp_message':
          result = await this.toolSendMcpMessage(args);
          break;
        case 'get_custom_tools':
          result = await this.toolGetCustomTools(args);
          break;
        case 'use_custom_tool':
          result = await this.toolUseCustomTool(args);
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

  // List all connected devices
  async toolListDevices(args) {
    const result = [];
    for (const [id, device] of devices) {
      const reg = device.registration;
      // Apply filters
      if (args?.type && reg.type !== args.type) continue;
      if (args?.status && reg.status !== args.status) continue;
      // Filter by node capability - just check if the node name is in the list
      if (args?.node && !reg.nodes?.includes(args.node)) continue;

      // Get custom tools for this device
      let customTools = [];
      try {
        const toolsResult = await device.peer.methods.getCustomTools();
        customTools = (toolsResult?.tools || []).map(t => t.name);
      } catch {
        // Device may not support custom tools
      }

      result.push({
        id,
        type: reg.type,
        name: reg.name,
        description: reg.description,
        status: reg.status,
        url: reg.url,
        connectedAt: reg.connectedAt,
        // Just the node names - use get_node_details for specifics
        nodes: reg.nodes || [],
        nodeCount: reg.nodes?.length || 0,
        customTools,
        meta: reg.meta
      });
    }
    return {
      count: result.length,
      devices: result,
      hint: 'Use get_node_details(deviceId, type) to inspect node implementation details - they vary by device.'
    };
  }

  // Get detailed info about a specific device
  async toolGetDeviceDetails(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const state = await device.peer.methods.getState();

    // Get custom tools with descriptions
    let customTools = [];
    try {
      const toolsResult = await device.peer.methods.getCustomTools();
      customTools = toolsResult?.tools || [];
    } catch {
      // Device may not support custom tools
    }

    return {
      registration: device.registration,
      ...state,
      customTools
    };
  }

  async toolGetStarted(args) {
    // If no deviceId provided, return aggregated view across all devices
    if (!args?.deviceId) {
      if (devices.size === 0) {
        return {
          guide: guideContent,
          connectedDevices: 0,
          devices: [],
          nodeCatalog: {},
          hint: 'No devices connected. Tell the user to open PageNodes and enable MCP in Settings.'
        };
      }

      // Return aggregated view - minimal info, grouped by category
      const deviceList = Array.from(devices.values()).map(d => ({
        id: d.registration.id,
        name: d.registration.name,
        type: d.registration.type
      }));

      return {
        guide: guideContent,
        connectedDevices: devices.size,
        devices: deviceList,
        nodeCatalog: getAggregatedCatalog(),
        hint: 'Use get_node_details(deviceId, type) for full node properties. Use list_devices for more device info.'
      };
    }

    // Specific device requested - return full details
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const state = await device.peer.methods.getState();
    return {
      guide: guideContent,
      deviceId: device.registration.id,
      deviceType: device.registration.type,
      deviceName: device.registration.name,
      connectedDevices: devices.size,
      ...state
    };
  }

  async toolGetFlows(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getFlows();
    return { deviceId: device.registration.id, ...result };
  }

  async toolCreateFlow(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.createFlow(args.label);
    return { deviceId: device.registration.id, ...result };
  }

  async toolAddNodes(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.addNodes(args.flowId, args.nodes);
    return { deviceId: device.registration.id, ...result };
  }

  async toolUpdateNode(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.updateNode(args.nodeId, args.updates);
    return { deviceId: device.registration.id, ...result };
  }

  async toolDeleteNode(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.deleteNode(args.nodeId);
    return { deviceId: device.registration.id, ...result };
  }

  async toolDeploy(args) {
    // Special case: deploy to all devices
    if (args?.deviceId === 'all') {
      const results = [];
      for (const [id, device] of devices) {
        try {
          const result = await device.peer.methods.deploy();
          results.push({ deviceId: id, success: true, ...result });
        } catch (err) {
          results.push({ deviceId: id, success: false, error: err.message });
        }
      }
      return { deployedTo: results.length, results };
    }

    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.deploy();
    return { deviceId: device.registration.id, ...result };
  }

  async toolGetDebugOutput(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getDebugOutput(args?.limit || 10);
    return { deviceId: device.registration.id, ...result };
  }

  async toolGetErrors(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getErrors(args?.limit || 10);
    return { deviceId: device.registration.id, ...result };
  }

  async toolGetLogs(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getLogs(args?.limit || 100, args?.context || null, args?.level || null);
    return { deviceId: device.registration.id, ...result };
  }

  async toolClearLogs(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.clearLogs();
    return { deviceId: device.registration.id, ...result };
  }

  async toolGetInjectNodes(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getInjectNodes();
    return { deviceId: device.registration.id, ...result };
  }

  async toolInjectNode(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.inject(args.nodeId, args.payload);
    return { deviceId: device.registration.id, ...result };
  }

  async toolGetNodeDetails(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getNodeDetails(args.type);
    return { deviceId: device.registration.id, ...result };
  }

  async toolTriggerNode(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.trigger(args.nodeId, args.msg);
    return { deviceId: device.registration.id, ...result };
  }

  async toolClearDebug(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.clearDebug();
    return { deviceId: device.registration.id, ...result };
  }

  async toolClearErrors(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.clearErrors();
    return { deviceId: device.registration.id, ...result };
  }

  async toolGetNodeStatuses(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getNodeStatuses();
    return { deviceId: device.registration.id, ...result };
  }

  async toolGetCanvasSvg(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getCanvasSvg();
    return { deviceId: device.registration.id, ...result };
  }

  async toolGetMcpMessages(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getMessages(args?.limit || 100, args?.clear !== false);
    return { deviceId: device.registration.id, ...result };
  }

  async toolSendMcpMessage(args) {
    // Special case: broadcast to all devices
    if (args?.deviceId === 'all') {
      const results = [];
      for (const [id, device] of devices) {
        try {
          const result = await device.peer.methods.sendMessage(args.payload, args.topic || '');
          results.push({ deviceId: id, success: true, ...result });
        } catch (err) {
          results.push({ deviceId: id, success: false, error: err.message });
        }
      }
      return { sentTo: results.length, results };
    }

    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.sendMessage(args.payload, args.topic || '');
    return { deviceId: device.registration.id, ...result };
  }

  // Get list of custom tools defined on a device
  async toolGetCustomTools(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    const result = await device.peer.methods.getCustomTools();
    return { deviceId: device.registration.id, ...result };
  }

  // Execute a custom tool on a device
  async toolUseCustomTool(args) {
    const { error, device, content } = this.requireDevice(args?.deviceId);
    if (error) return content;

    if (!args?.name) {
      return { error: 'Tool name is required' };
    }

    const result = await device.peer.methods.useCustomTool(args.name, args.message || {});
    return { deviceId: device.registration.id, result };
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
  const count = devices.size;
  if (count === 0) {
    log(`[Devices: \x1b[33m○ No devices connected\x1b[0m]`);
  } else {
    const deviceList = Array.from(devices.values())
      .map(d => `${d.registration.name || d.registration.id} (${d.registration.type})`)
      .join(', ');
    log(`[Devices: \x1b[32m● ${count} connected\x1b[0m - ${deviceList}]`);
  }
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
        devices: devices.size,
        deviceList: Array.from(devices.values()).map(d => ({
          id: d.registration.id,
          type: d.registration.type,
          name: d.registration.name
        }))
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
        devices: devices.size,
        deviceList: Array.from(devices.values()).map(d => ({
          id: d.registration.id,
          type: d.registration.type,
          name: d.registration.name,
          status: d.registration.status
        }))
      }));
      return;
    }

    // Generate Molt-compatible SKILL.md for the entire PageNodes API
    if (req.method === 'GET' && pathname === '/generate_skill_definition') {
      let skillMd = `---
name: pagenodes
description: "Control PageNodes visual programming flows - create nodes, wire them together, deploy, and trigger. Manage IoT devices, audio systems, and automation flows."
metadata: {"moltbot":{"requires":{"bins":["curl"]}}}
---

# PageNodes Skill

Control PageNodes visual programming flows via HTTP. Create nodes, wire them together, deploy, and trigger flows. Manage IoT devices, audio systems, and automation.

## Configuration

Set the PageNodes MCP server URL (default: http://localhost:7778):

\`\`\`bash
export PAGENODES_URL="http://localhost:7778"
\`\`\`

## Available Functions

All functions are called via HTTP POST to \`$PAGENODES_URL/func/{function_name}\` with a JSON body.

`;

      for (const tool of MCP_TOOLS) {
        const props = tool.inputSchema?.properties || {};
        const required = tool.inputSchema?.required || [];

        // Build example JSON body
        const exampleBody = {};
        for (const [name, schema] of Object.entries(props)) {
          if (schema.type === 'string') exampleBody[name] = `<${name}>`;
          else if (schema.type === 'number') exampleBody[name] = 0;
          else if (schema.type === 'boolean') exampleBody[name] = true;
          else if (schema.type === 'array') exampleBody[name] = [];
          else if (schema.type === 'object') exampleBody[name] = {};
          else exampleBody[name] = `<${name}>`;
        }

        // Build parameter list
        let paramsDoc = '';
        for (const [name, schema] of Object.entries(props)) {
          const isRequired = required.includes(name);
          const type = schema.type || 'any';
          const desc = schema.description || '';
          paramsDoc += `- **${name}** (${type}${isRequired ? ', required' : ''}): ${desc}\n`;
        }

        skillMd += `### ${tool.name}

${tool.description}

${paramsDoc || '_No parameters_'}

\`\`\`bash
curl -X POST $PAGENODES_URL/func/${tool.name} -H "Content-Type: application/json" -d '${JSON.stringify(exampleBody)}'
\`\`\`

`;
      }

      skillMd += `## Workflow

1. Call \`list_devices\` to see connected PageNodes instances
2. Use the deviceId in subsequent calls
3. Use \`get_flows\` to see existing flows and nodes
4. Use \`add_nodes\` to create new nodes with wiring
5. Call \`deploy\` to activate changes
6. Use \`inject_node\` or \`trigger_node\` to run flows
7. Check \`get_debug_output\` for results

## Notes

- All responses are JSON
- On error, response contains \`isError: true\` and error message in \`content\`
- deviceId is required for most operations - get it from \`list_devices\`
`;

      res.setHeader('Content-Type', 'text/markdown');
      res.writeHead(200);
      res.end(skillMd);
      return;
    }

    // Function execution endpoint - call any MCP tool via HTTP
    if (req.method === 'POST' && pathname.startsWith('/func/')) {
      const toolName = pathname.slice('/func/'.length);

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const args = body ? JSON.parse(body) : {};
          const result = await mcpHandler.handleToolCall({ name: toolName, arguments: args });

          res.setHeader('Content-Type', 'application/json');
          res.writeHead(result.isError ? 400 : 200);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
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
    // Temporary ID until registration
    let deviceId = null;

    // Set up rawr peer over WebSocket
    const peer = rawr({
      transport: rawr.transports.websocket(ws)
    });

    // Handle device registration
    // Any Ainura-compatible runtime sends this on connect with its identity and node list
    peer.addHandler('registerDevice', async (info) => {
      // Generate ID if not provided
      deviceId = info?.id || generateDeviceId();

      const registration = {
        id: deviceId,
        type: info?.type || 'unknown',
        name: info?.name || `Device ${deviceId.slice(0, 8)}`,
        description: info?.description || '',
        url: info?.url || null,
        // Just the node names - details come from get_node_details
        nodes: info?.nodes || info?.capabilities?.nodes || [],
        status: 'online',
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        meta: info?.meta || {}
      };

      // Store the device (initially without nodeCatalog)
      devices.set(deviceId, { peer, registration, ws, nodeCatalog: [] });

      log(`\n✓ Device registered: ${registration.name} (${registration.type}, ${registration.nodes.length} nodes)`);
      printStatus(log);

      // Fetch full node catalog asynchronously (with descriptions) for aggregation
      try {
        const state = await peer.methods.getState();
        if (state?.nodeCatalog) {
          devices.get(deviceId).nodeCatalog = state.nodeCatalog;
          rebuildAggregatedCatalog();
          log(`  → Node catalog loaded: ${state.nodeCatalog.length} node types`);
        }
      } catch (err) {
        log(`  → Could not fetch node catalog: ${err.message}`);
      }

      return { success: true, deviceId };
    });

    // Legacy registration (for backwards compatibility with existing PageNodes)
    peer.addHandler('registerClient', (info) => {
      deviceId = generateDeviceId();

      const registration = {
        id: deviceId,
        type: 'browser',
        name: info?.name || `Browser ${deviceId.slice(0, 8)}`,
        description: 'Legacy PageNodes client',
        url: info?.url || null,
        nodes: [],  // Legacy clients don't send node list upfront
        status: 'online',
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        meta: { legacy: true }
      };

      devices.set(deviceId, { peer, registration, ws, nodeCatalog: [] });

      log(`\n✓ Device connected (legacy): ${registration.name}`);
      printStatus(log);

      return { success: true, deviceId };
    });

    ws.on('close', () => {
      if (deviceId && devices.has(deviceId)) {
        const device = devices.get(deviceId);
        log(`\n✗ Device disconnected: ${device.registration.name}`);
        devices.delete(deviceId);
        rebuildAggregatedCatalog();  // Update aggregate after device leaves
        printStatus(log);
      }
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
    log(`  Ainura MCP Server v0.5.0`);
    log(`  Multi-device PageNodes orchestration`);
    log(`  HTTP + WebSocket on port ${port}`);
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    log(`SSE endpoint: http://localhost:${port}/sse`);
    log(`WebSocket:    ws://localhost:${port}/`);
    printStatus(log);
    log(`\nOpen PageNodes instances and enable MCP in Settings to connect devices.\n`);
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
