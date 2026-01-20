# PageNodes - MCP Integration Guide

PageNodes is a visual flow programming editor that runs entirely in the browser. Users drag nodes onto a canvas, connect them with wires, and deploy to run. No server required - the runtime executes in a Web Worker.

This MCP server allows AI agents like Claude to programmatically create, modify, and deploy flows.

> **How it works:** Use `add_nodes` to add multiple nodes at once. Give each node a `tempId` (like "a", "b", "c") and use those tempIds in `wires`. The server automatically converts tempIds to real generated IDs.

## Architecture

### PageNodes (standalone)
```
Browser Tab
├── Editor UI (React)
│   ├── Canvas - drag/drop nodes, draw wires
│   ├── Palette - available node types
│   ├── Sidebar - debug output, node help
│   └── Deploy button
│
└── Runtime (Web Worker)
    ├── Flow execution engine
    ├── Node instances
    └── Message passing
```

### With MCP Server
```
Browser Tab                         External
├── Editor UI ◄───────────────────► User
│       │
│       ▼
└── Runtime (Web Worker)
        │
        │ WebSocket + rawr RPC
        ▼
    MCP Server (this)
        │
        │ stdio / SSE
        ▼
    AI Agent (Claude)
```

The MCP server bridges Claude to the PageNodes runtime. Claude calls MCP tools, which translate to RPC calls to the browser. The browser returns node definitions, current state, and operation results.

## How PageNodes Works

### Message Flow
Nodes process messages and pass them downstream. A message is a JavaScript object:
```javascript
{
  payload: "the main data",
  topic: "optional category",
  // ...any other properties
}
```

Nodes receive messages on input ports, do something, and send messages out output ports.

### Node Types
The node catalog (from `get_started`) contains all available nodes. Each entry describes:
- `type` - unique identifier (e.g., "inject", "function", "mqtt in")
- `category` - grouping (common, input, output, ai, logic, transforms, networking, hardware, storage)
- `inputs` / `outputs` - number of ports
- `defaults` - configurable properties with types and default values
- `description` - what the node does

Use `get_node_details` to get full property definitions for a specific node type. The response may include:
- `defaults` - All configurable properties with types, defaults, and descriptions
- `help` - HTML documentation explaining usage
- `relatedDocs` - Array of external documentation links: `[{ label: "MDN Docs", url: "https://..." }]`

The `relatedDocs` field is useful for researching advanced node features, browser APIs, or protocol specifications.

### Config Nodes
Some nodes share configuration via config nodes. For example:
- Multiple MQTT nodes can share one `mqtt-broker` config
- Multiple LLM nodes can share one `llm-config` with model settings

Config nodes don't appear on the canvas - they're referenced by ID from regular nodes.

### Wires

Wires connect nodes together. Without wires, messages cannot flow between nodes.

Each node has a `wires` property - an array of arrays. Each inner array lists the nodes that output port connects to:

```javascript
wires: [
  ["b", "c"],  // output 0 connects to nodes "b" and "c"
  ["d"]        // output 1 connects to node "d"
]
```

Most nodes have 1 output, so typically: `wires: [["targetTempId"]]`

**Examples:**
```javascript
wires: [["b"]]           // output 0 → node b
wires: [["b", "c"]]      // output 0 → nodes b AND c (fan-out)
wires: [["b"], ["c"]]    // output 0 → b, output 1 → c (e.g., switch)
wires: [[]]              // no connections (terminal node like debug)
```

### Deploy
Changes don't take effect until deployed. Deploy pushes the current flow configuration to the runtime, which instantiates nodes and starts message flow.

## Creating Flows

### Using add_nodes

The `add_nodes` tool adds multiple nodes in a single call. Each node gets a `tempId` that you use for wiring. The server converts tempIds to real IDs automatically.

**Node properties go at top level** (not nested). The server builds `_node` from tempId/type/x/y/wires and puts everything else as node config.

```javascript
add_nodes({
  flowId: "flow1",
  nodes: [
    { tempId: "a", type: "inject", x: 100, y: 100, wires: [["b"]], payloadType: "str", payload: "hello" },
    { tempId: "b", type: "function", x: 250, y: 100, wires: [["c"]], func: "return msg;" },
    { tempId: "c", type: "debug", x: 400, y: 100, active: true, tosidebar: true }
  ]
})
```

This creates: `[inject] → [function] → [debug]`

### Workflow

1. **Start here**: Call `get_started` first to get node catalog and current state
2. **Choose a flow**: Use existing flowId or `create_flow` for a new tab
3. **Plan the pipeline**: Decide what nodes you need and how they connect
4. **Get node details**: Call `get_node_details` for each node type you plan to use. This returns:
   - All configurable properties with types and defaults
   - Required vs optional fields
   - Help documentation explaining usage
5. **Call add_nodes**: Add all nodes with tempIds, wires, and proper config properties
6. **Deploy**: Call `deploy` to activate
7. **Check results**: Use `get_debug_output` to see debug output

> **Tip**: Don't guess at node properties. Always call `get_node_details("node-type")` to see exactly what properties are available and what they do.

### Example: Simple Transform Pipeline

Goal: `[inject "hello"] → [function: uppercase] → [debug]`

```javascript
// 1. Get a flow ID
const flows = await get_flows();
const flowId = flows.flows[0].id;

// 2. Add all nodes at once with tempIds
await add_nodes({
  flowId: flowId,
  nodes: [
    {
      tempId: "inject1",
      type: "inject",
      x: 100, y: 100,
      wires: [["func1"]],
      payloadType: "str",
      payload: "hello world"
    },
    {
      tempId: "func1",
      type: "function",
      x: 270, y: 100,
      wires: [["debug1"]],
      func: "msg.payload = msg.payload.toUpperCase();\nreturn msg;"
    },
    {
      tempId: "debug1",
      type: "debug",
      x: 440, y: 100
      // no wires - terminal node
    }
  ]
});

// 3. Deploy
await deploy();
```

### Example: Using Config Nodes

Config nodes (like MQTT broker) need to be created first since they have real IDs that regular nodes reference.

Goal: MQTT subscriber

```javascript
// 1. Get flow
const flows = await get_flows();
const flowId = flows.flows[0].id;

// 2. Create config node first (returns real ID)
const broker = await add_nodes({
  flowId: flowId,
  nodes: [{
    tempId: "broker",
    type: "mqtt-broker",
    x: 0, y: 0,  // config nodes don't show on canvas
    name: "Test Broker",
    broker: "wss://test.mosquitto.org:8081"
  }]
});
const brokerId = broker.nodes[0].id;  // real generated ID

// 3. Add flow nodes referencing the broker
await add_nodes({
  flowId: flowId,
  nodes: [
    {
      tempId: "mqtt",
      type: "mqtt in",
      x: 150, y: 100,
      wires: [["debug"]],
      broker: brokerId,  // reference the real config node ID
      topic: "test/topic",
      qos: 0
    },
    {
      tempId: "debug",
      type: "debug",
      x: 350, y: 100
    }
  ]
});

// 4. Deploy
await deploy();
```

## Node Positioning

Nodes have `x`, `y` coordinates on the canvas.

**Do not overlap existing nodes.** Always check current node positions via `get_flows` before adding new nodes.

**Avoid long straight lines.** Instead of placing 6 nodes in a horizontal row, use a wave pattern:

```
Bad (hard to read, runs off screen):
[1]───[2]───[3]───[4]───[5]───[6]

Good (wave pattern):
[1]───[2]───[3]
              │
[6]───[5]───[4]
```

Guidelines:
- Horizontal spacing: ~150-170px between nodes
- Vertical spacing: ~80-100px between rows
- After 3-4 nodes horizontally, drop down and continue (or loop back)
- Left-to-right flow is conventional (inputs on left, outputs on right)
- Check existing nodes and place new flows in empty canvas areas

## User Gestures

Browser security APIs require user interaction before activating. These nodes will show "waiting for gesture" until the user clicks somewhere in the PageNodes UI:
- Camera, microphone (voicerec)
- Bluetooth, Serial, USB, MIDI
- Accelerometer, gyroscope, geolocation
- Notifications, audio oscillator

When creating flows with these nodes, tell the user they'll need to click in the browser to activate them.

## Common Patterns

### Periodic Polling
```
[inject repeat:"30"] → [http request] → [json] → [debug]
```
Inject with repeat interval triggers HTTP request every 30 seconds.

### Conditional Routing
```
[switch] → output0 (if msg.payload > 100)
        → output1 (if msg.payload <= 100)
        → output2 (otherwise)
```
Switch node routes messages based on conditions.

### Fan-out
```
[inject] → [nodeA]
        → [nodeB]
        → [nodeC]
```
One output wired to multiple targets: `wires: [["nodeA", "nodeB", "nodeC"]]`

### Aggregation
```
[source1] → [join] → [debug]
[source2] →
```
Join node combines messages from multiple sources.

### Cross-flow Communication
```
Flow 1: [...] → [link out name:"signal"]
Flow 2: [link in name:"signal"] → [...]
```
Link nodes pass messages between flows.

### Error Handling
```
[any node that might error]
        ↓ (error)
[catch] → [debug]
```
The `catch` node receives errors from other nodes in the flow. When a node calls `this.error()`, the error is routed to catch nodes. The error message includes:
- `msg.error.message` - Error text
- `msg.error.source.id` - ID of the node that errored
- `msg.error.source.type` - Type of the node
- `msg.error.source.name` - Name of the node
- `msg.error.stack` - Stack trace (if available)
- `msg._msgid` - Original message ID for tracing

Catch node scope options:
- **All nodes** - Catches errors from any node
- **Uncaught errors only** - Only catches errors not handled by another catch node

## Debugging

- **debug node**: Sends `msg.payload` (or full msg) to sidebar. Essential for seeing what's happening.
- **get_debug_output**: MCP tool to retrieve recent debug messages programmatically.
- **get_errors**: MCP tool to retrieve runtime errors (when nodes throw exceptions).
- **Node status**: Nodes show status indicators (colored dots + text) for their state.

## Testing Flows Programmatically

After deploying a flow, you can test it using `inject_node` and trace messages through the flow using `_msgid`.

### Workflow

1. **Find inject nodes**: Call `get_inject_nodes` to list all inject nodes with their IDs and configurations
2. **Trigger an inject**: Call `inject_node` with the node ID - returns `{ success: true, _msgid: "..." }`
3. **Check output**: Call `get_debug_output` and find messages with the matching `_msgid`
4. **Check errors**: Call `get_errors` to see if any nodes threw exceptions

### Message Tracing with `_msgid`

Every message in PageNodes has a `_msgid` for tracing. When you call `inject_node`, it returns the `_msgid` of the injected message. This same ID appears in debug output, allowing you to trace your specific message through the flow.

```javascript
// 1. Trigger inject (uses node's configured payload)
const result = await inject_node({ nodeId: "abc123" });
// Returns: { success: true, _msgid: "xyz789" }

// 2. Check debug output
const debug = await get_debug_output({ limit: 5 });
// Find entries where _msgid === "xyz789" to see your message

// 3. Check for errors
const errors = await get_errors({ limit: 5 });
// Errors also include _msgid for correlation
```

### Overriding Payload

You can inject a custom payload instead of using the node's configured value:

```javascript
// Inject with custom payload
await inject_node({ nodeId: "abc123", payload: "test data" });
await inject_node({ nodeId: "abc123", payload: { foo: "bar" } });
await inject_node({ nodeId: "abc123", payload: 42 });
```

If no payload is provided, the inject node uses its configured `payloadType`:
- `date` - Current timestamp (Date.now())
- `str` - String value
- `num` - Number value
- `json` - Parsed JSON object
- `bool` - Boolean value

### Triggering Any Node

Use `trigger_node` to send a message to ANY node's input, not just inject nodes:

```javascript
// Send a message directly to a function node
await trigger_node({
  nodeId: "functionNode123",
  msg: { payload: "test data", topic: "test" }
});

// Trigger a node mid-flow for testing
await trigger_node({
  nodeId: "switchNode456",
  msg: { payload: 150, _msgid: "trace123" }
});
```

This is useful for:
- Testing nodes in isolation
- Flows that start with event-driven nodes (mqtt-in, websocket-in)
- Sending test data to specific points in a flow

### Clean Slate Testing

Before running tests, clear the buffers to isolate results:

```javascript
// Clear previous output
await clear_debug();
await clear_errors();

// Run test
await inject_node({ nodeId: "abc123" });

// Check only the new output
const results = await get_debug_output({ limit: 10 });
```

### Monitoring Node Status

Check if nodes are connected/ready:

```javascript
const statuses = await get_node_statuses();
// Returns: { "nodeId1": { fill: "green", shape: "dot", text: "connected" }, ... }
```

Status objects have:
- `fill` - Color (green, yellow, red, grey, blue)
- `shape` - "dot" (filled) or "ring" (outline)
- `text` - Status message

### Viewing the Canvas

Get the visual SVG representation of the flow:

```javascript
const canvas = await get_canvas_svg();
// Returns: { svg: "<svg>...</svg>", width: "5000", height: "5000" }
```

The SVG contains:
- **Nodes**: `<g class="node">` elements with position via `transform="translate(x, y)"`
- **Node labels**: `<text class="node-type">` shows the node type/name
- **Node colors**: `fill` attribute on `<rect class="node-body">`
- **Wires**: `<path class="wire-inner">` bezier curves connecting nodes
- **Status indicators**: `<g class="node-status">` with colored circles/squares and text
- **Ports**: `<polygon class="port port-input">` and `port-output`

Use this to verify node placement, check for overlapping nodes, or understand the flow structure visually.

## Limitations

- **Browser sandbox**: No filesystem access (except File System Access API where supported), no raw sockets
- **CORS**: HTTP requests subject to browser same-origin policy
- **Tab lifecycle**: Flows stop when tab closes or sleeps
- **Gestures**: Hardware/media APIs need user click first
- **Storage**: IndexedDB/localStorage limits apply

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `get_started` | **CALL THIS FIRST.** Returns this guide + node catalog + current state. |
| `get_node_details` | Full definition for a node type (properties, defaults, help) |
| `get_flows` | Current flows, nodes, config nodes |
| `create_flow` | Create new flow tab |
| `add_nodes` | Add multiple nodes with tempIds. Wires use tempIds, auto-converted to real IDs. |
| `update_node` | Modify existing node (can update wires) |
| `delete_node` | Remove node |
| `deploy` | Push changes to runtime |
| `get_debug_output` | Retrieve recent debug messages (newest first) |
| `get_errors` | Retrieve recent runtime errors (newest first) |
| `get_inject_nodes` | List all inject nodes with their IDs and configurations |
| `inject_node` | Trigger an inject node, optionally with custom payload. Returns `_msgid` for tracing. |
| `trigger_node` | Send a message to ANY node's input. Works with any node type, not just inject. |
| `clear_debug` | Clear all debug messages. Use before tests for a clean slate. |
| `clear_errors` | Clear all error messages. Use before tests for a clean slate. |
| `get_node_statuses` | Get current status indicators for all nodes (connection states, etc.) |
| `get_canvas_svg` | Get the SVG of the flow canvas - see visual layout of nodes and wires |
