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
    if (req.path !== '/health' || duration > 100) {
      log.debug(`${req.method} ${req.path} ${res.statusCode}`, { durationMs: duration });
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
    const result = await machineManager.executeCommand(wKey, 'get_mode_options', {});
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message, modes: [] });
  }
});

app.get('/api/model-options', async (req, res) => {
  const wKey = req.query.window || firstConnectedWindow();
  if (!wKey) return res.json({ ok: false, error: 'No windows connected', models: [] });
  try {
    const result = await machineManager.executeCommand(wKey, 'get_model_options', {});
    res.json(result);
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
        if (result.status === 'wait_exhausted') {
          socket.emit('command:result', { commandId, ok: false, error: 'Agent waiter never came back after 30s' });
          return;
        }
      }

      const cmdParams = { ...payload, ...(payload.params || {}) };
      if (targetWindowKey) {
        const cmdResult = await machineManager.executeCommand(targetWindowKey, type, cmdParams);
        socket.emit('command:result', { commandId, ...cmdResult });
      } else {
        const firstWindow = machineManager.windows.keys().next().value;
        if (firstWindow) {
          const cmdResult = await machineManager.executeCommand(firstWindow, type, cmdParams);
          socket.emit('command:result', { commandId, ...cmdResult });
        } else {
          socket.emit('command:result', { commandId, ok: false, error: 'No windows connected' });
        }
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
