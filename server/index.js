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
        result.push({ chatKey: wKey + '|' + i, windowKey: wKey, tabIndex: i, title: tab.title });
      }
    });
  }
  return result;
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const skip = req.path === '/health' || req.path === '/mcp' || req.path.startsWith('/socket.io');
    if (!skip && duration > 500) {
      log.info(`SLOW ${req.method} ${req.path} ${res.statusCode}`, { ms: duration });
    }
  });
  next();
});

app.use(express.json());

app.post('/mcp', mcp.handleMcpPost);
app.get('/mcp', mcp.handleMcpGet);
app.delete('/mcp', mcp.handleMcpDelete);

app.get('/api/machines', (req, res) => {
  res.json(machineManager.listMachines());
});

app.post('/api/machines', (req, res) => {
  const { name, host, port } = req.body;
  if (!host) return res.status(400).json({ error: 'host is required' });
  const result = machineManager.addMachine(name || host, host, port || 9222);
  res.json(result);
});

app.delete('/api/machines/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const result = machineManager.removeMachine(key);
  res.json(result);
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
    mcp: { waiting: mcpWaiting, loopActive: mcpLoopActive },
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
      const result = await sendBridgeCommand(bridgeSocketId, wKey, 'get_mode_options', {}, 'api_mode');
      res.json(result);
    } else {
      const result = await machineManager.executeCommand(wKey, 'get_mode_options', {});
      res.json(result);
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
      const result = await sendBridgeCommand(bridgeSocketId, wKey, 'get_model_options', {}, 'api_model');
      res.json(result);
    } else {
      const result = await machineManager.executeCommand(wKey, 'get_model_options', {});
      res.json(result);
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
      socket.data.machineName = info.machineName;
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
      log.info('Bridge disconnected', { socketId: socket.id, machineKey: socket.data.machineKey });
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

      if (type === 'send_message') {
        log.info('PHONE send_message', { targetWindowKey, chatTabIndex: resolvedTabIndex, targetChatKey, textLen: text?.length ?? 0 });
      }

      if (type === 'send_message' && (text || (images && images.length > 0))) {
// #region agent log
fetch('http://127.0.0.1:7793/ingest/0ff6b19b-66bd-46e6-8794-6351cffa8ca4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d88471'},body:JSON.stringify({sessionId:'d88471',location:'index.js:214',message:'PRE resolvePendingWait',data:{targetChatKey,textLen:text?.length,hasImages:!!(images&&images.length)},timestamp:Date.now(),hypothesisId:'H2'})}).catch(()=>{});
// #endregion
        const result = await mcp.resolvePendingWait(text || '', images, msgId, targetChatKey);
// #region agent log
fetch('http://127.0.0.1:7793/ingest/0ff6b19b-66bd-46e6-8794-6351cffa8ca4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d88471'},body:JSON.stringify({sessionId:'d88471',location:'index.js:216',message:'POST resolvePendingWait',data:{accepted:result.accepted,status:result.status,id:result.id},timestamp:Date.now(),hypothesisId:'H2H5'})}).catch(()=>{});
// #endregion
        if (result.accepted) {
          socket.emit('command:result', { commandId, ok: true, mcpResolved: true, mcpStatus: result.status, msgId: result.id });
          return;
        }
        if (result.status === 'wait_exhausted') {
          socket.emit('command:result', { commandId, ok: false, error: 'Agent waiter never came back after 60s' });
          return;
        }
      }

      const cmdParams = { ...payload, ...(payload.params || {}) };
      const targetWKey = targetWindowKey || firstConnectedWindow();

      if (targetWKey) {
        const bridgeSocketId = machineManager.getBridgeForWindow(targetWKey);
        if (bridgeSocketId) {
          const bridgeResult = await sendBridgeCommand(bridgeSocketId, targetWKey, type, cmdParams, commandId);
          socket.emit('command:result', { commandId, ...bridgeResult });
        } else {
          const cmdResult = await machineManager.executeCommand(targetWKey, type, cmdParams);
          socket.emit('command:result', { commandId, ...cmdResult });
        }
      } else {
        socket.emit('command:result', { commandId, ok: false, error: 'No windows connected' });
      }
    });

    socket.on('phone:bind_mcp_session', (payload) => {
      if (payload.sessionId && payload.chatKey) {
        mcp.bindSessionToChat(payload.sessionId, payload.chatKey);
        socket.emit('mcp:session_bound', { sessionId: payload.sessionId, chatKey: payload.chatKey });
      }
    });

    socket.on('disconnect', () => {
      log.info('Phone disconnected', { socketId: socket.id });
    });
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

    bridgeSocket.emit('bridge:command', {
      commandId: cmdId,
      windowKey,
      type,
      params,
    });
  });
}

machineManager._onSessionRebind = (oldWindowKey, newWindowKey) => {
  mcp.rebindStaleSessions(oldWindowKey, newWindowKey);
};

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
