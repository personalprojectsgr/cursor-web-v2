const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createLogger } = require('./logger');
const { MachineManager } = require('./machine-manager');
const mcp = require('./mcp-handler');

const log = createLogger('server');
const PORT = parseInt(process.env.PORT || '3000', 10);
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin123';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6,
  pingTimeout: 30000,
  pingInterval: 15000,
});

const machineManager = new MachineManager(io);

let mcpWaiting = false;
let mcpLoopActive = false;
let mcpPerSession = {};

mcp.setOnWaiterChange((status) => {
  mcpWaiting = status.waiting;
  mcpLoopActive = status.loopActive;
  mcpPerSession = status.perSession || {};
  io.to('phones').emit('mcp:status', { waiting: mcpWaiting, loopActive: mcpLoopActive, perSession: mcpPerSession });
});

mcp.setActiveChatProvider(() => {
  const result = [];
  for (const [wKey, wInfo] of machineManager.windows) {
    const state = machineManager.states.get(wKey);
    const tabs = (state && state.chatTabs) || [{ title: state?.chatTitle || 'Chat', isActive: true }];
    tabs.forEach((tab, i) => {
      if (tab.isActive) {
        result.push({
          chatKey: wKey + '|' + i,
          windowKey: wKey,
          tabIndex: i,
          title: tab.title,
          documentTitle: state?.documentTitle || null,
        });
      }
    });
  }
  return result;
});

app.use(express.json({ limit: '10mb' }));

app.get('/sse', mcp.handleMcpSse);
app.post('/messages', mcp.handleMcpMessages);

app.get('/mcp', mcp.handleMcpSse);
app.post('/mcp/messages', mcp.handleMcpMessages);

app.post('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This server uses SSE transport. Connect via GET /mcp or GET /sse' },
    id: req.body && req.body.id ? req.body.id : null,
  });
});
app.delete('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This server uses SSE transport. Connect via GET /mcp or GET /sse' },
    id: null,
  });
});

app.get('/api/machines', (req, res) => {
  res.json(machineManager.listMachines());
});

app.post('/api/machines', (req, res) => {
  const { name, host, port } = req.body;
  if (!host) return res.status(400).json({ error: 'host is required' });
  res.json(machineManager.addMachine(name || host, host, port || 9222));
});

app.delete('/api/machines/:key', (req, res) => {
  res.json(machineManager.removeMachine(decodeURIComponent(req.params.key)));
});

app.post('/api/machines/:key/test', async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const machine = machineManager.machines.get(key);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  try {
    const { discoverTargets } = require('./cdp-client');
    const targets = await discoverTargets(machine.host, machine.port);
    res.json({ ok: true, targets: targets.length, titles: targets.map(t => t.title) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.use(express.static(path.join(__dirname, '..', 'client')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    machines: machineManager.listMachines(),
    windows: machineManager.windows.size,
    bridges: machineManager.bridges.size,
    mcp: { waiting: mcpWaiting, loopActive: mcpLoopActive, redis: require('./redis').isAvailable() },
  });
});

app.get('/debug/sessions', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    mcp: mcp.getDebugDump(),
    machines: machineManager.listMachines(),
    windows: Array.from(machineManager.windows.keys()),
  });
});

app.get('/api/mode-options', async (req, res) => {
  const wKey = req.query.window || firstConnectedWindow();
  if (!wKey) return res.json({ ok: false, error: 'No windows connected', modes: [] });
  try {
    const bridgeSocketId = machineManager.getBridgeForWindow(wKey);
    if (bridgeSocketId) {
      res.json(await sendBridgeCommand(bridgeSocketId, wKey, 'get_mode_options', {}, 'api_mode'));
    } else {
      res.json(await machineManager.executeCommand(wKey, 'get_mode_options', {}));
    }
  } catch (e) {
    res.json({ ok: false, error: e.message, modes: [] });
  }
});

app.get('/api/model-options', async (req, res) => {
  const wKey = req.query.window || firstConnectedWindow();
  if (!wKey) return res.json({ ok: false, error: 'No windows connected', models: [] });
  try {
    const bridgeSocketId = machineManager.getBridgeForWindow(wKey);
    if (bridgeSocketId) {
      res.json(await sendBridgeCommand(bridgeSocketId, wKey, 'get_model_options', {}, 'api_model'));
    } else {
      res.json(await machineManager.executeCommand(wKey, 'get_model_options', {}));
    }
  } catch (e) {
    res.json({ ok: false, error: e.message, models: [] });
  }
});

function firstConnectedWindow() {
  const iter = machineManager.windows.keys().next();
  return iter.done ? null : iter.value;
}

io.use((socket, next) => {
  const { password, role } = socket.handshake.auth || {};
  if (!password) return next(new Error('Password required'));
  if (password !== AUTH_PASSWORD) return next(new Error('Invalid password'));
  socket.data.role = role || 'phone';
  next();
});

io.on('connection', (socket) => {
  const role = socket.data.role;
  log.info('Socket connected', { socketId: socket.id, role });

  if (role === 'bridge') {
    socket.join('bridges');

    socket.on('bridge:hello', (info) => {
      socket.data.machineKey = info.machineKey;
      log.info('Bridge registered', { machineKey: info.machineKey, name: info.machineName });
      machineManager.registerBridge(socket.id, info.machineKey, info.machineName);
    });

    socket.on('bridge:state', (payload) => {
      machineManager.handleBridgeState(socket.id, payload);
    });

    socket.on('bridge:command_result', (result) => {
      const pending = bridgePendingCommands.get(result.commandId);
      if (pending) {
        bridgePendingCommands.delete(result.commandId);
        pending.resolve(result);
      }
    });

    socket.on('disconnect', () => {
      machineManager.removeBridge(socket.id);
    });
  }

  if (role === 'phone' || role === undefined) {
    socket.join('phones');
    machineManager.sendStateTo(socket);
    socket.emit('mcp:status', { waiting: mcpWaiting, loopActive: mcpLoopActive, perSession: mcpPerSession });

    socket.on('phone:command', async (payload) => {
      const { type, targetWindowKey, commandId, text, images, msgId, chatTabIndex } = payload;
      const resolvedTabIndex = typeof chatTabIndex === 'number' ? chatTabIndex : 0;
      const targetChatKey = targetWindowKey ? (targetWindowKey + '|' + resolvedTabIndex) : null;

      if (type === 'send_message' && (text || (images && images.length > 0))) {
        const result = await mcp.resolvePendingWait(text || '', images, msgId, targetChatKey);
        if (result.accepted) {
          socket.emit('command:result', { commandId, ok: true, mcpResolved: true, mcpStatus: result.status, msgId: result.id });
          return;
        }
        socket.emit('command:result', { commandId, ok: false, error: 'MCP: ' + result.status });
        return;
      }

      const cmdParams = { ...payload, ...(payload.params || {}) };
      const targetWKey = targetWindowKey || firstConnectedWindow();

      if (targetWKey) {
        const bridgeSocketId = machineManager.getBridgeForWindow(targetWKey);
        if (bridgeSocketId) {
          socket.emit('command:result', { commandId, ...(await sendBridgeCommand(bridgeSocketId, targetWKey, type, cmdParams, commandId)) });
        } else {
          socket.emit('command:result', { commandId, ...(await machineManager.executeCommand(targetWKey, type, cmdParams)) });
        }
      } else {
        socket.emit('command:result', { commandId, ok: false, error: 'No windows connected' });
      }
    });

    socket.on('phone:bind_mcp_session', (payload) => {
      if (payload.sessionId && payload.chatKey) {
        mcp.bindSessionToChat(payload.sessionId, payload.chatKey);
      }
    });

    socket.on('disconnect', () => {});
  }

  socket.on('error', (err) => {
    log.error('Socket error', { socketId: socket.id, error: err.message });
  });
});

const bridgePendingCommands = new Map();
let bridgeCmdIdCounter = 0;

function sendBridgeCommand(bridgeSocketId, windowKey, type, params, clientCommandId) {
  return new Promise((resolve) => {
    const cmdId = 'bc_' + (++bridgeCmdIdCounter);
    const timeout = setTimeout(() => {
      bridgePendingCommands.delete(cmdId);
      resolve({ ok: false, error: 'Bridge command timeout' });
    }, 20000);

    bridgePendingCommands.set(cmdId, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
    });

    const bridgeSocket = io.sockets.sockets.get(bridgeSocketId);
    if (!bridgeSocket) {
      clearTimeout(timeout);
      bridgePendingCommands.delete(cmdId);
      resolve({ ok: false, error: 'Bridge socket gone' });
      return;
    }

    bridgeSocket.emit('bridge:command', { commandId: cmdId, windowKey, type, params });
  });
}

machineManager._onSessionRebind = (oldWindowKey, newWindowKey) => {
  mcp.rebindStaleSessions(oldWindowKey, newWindowKey);
};

const redisOk = mcp.initRedis();
log.info('Redis', { available: redisOk });

machineManager.startAllDiscovery();

server.listen(PORT, () => {
  log.info(`Server started on port ${PORT}`, { nodeVersion: process.version });
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { reason: String(reason) });
});
