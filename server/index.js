const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createLogger } = require('./logger');
const { RoomManager } = require('./rooms');
const { handleMcpPost, handleMcpGet, handleMcpDelete, getDebugDump } = require('./mcp-handler');

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

const roomManager = new RoomManager();

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/health' || duration > 100) {
      log.debug(`${req.method} ${req.path} ${res.statusCode}`, { durationMs: duration, ip: req.ip });
    }
  });
  next();
});

app.post('/mcp', express.json(), handleMcpPost);
app.get('/mcp', handleMcpGet);
app.delete('/mcp', handleMcpDelete);

app.use(express.static(path.join(__dirname, '..', 'client')));

app.get('/health', (req, res) => {
  const stats = roomManager.getStats();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    ...stats,
  });
});

app.get('/stats', (req, res) => {
  res.json(roomManager.getStats());
});

app.get('/debug/sessions', (req, res) => {
  const dump = getDebugDump();
  const stats = roomManager.getStats();
  res.json({
    timestamp: new Date().toISOString(),
    mcp: dump,
    extensions: stats.extensionWindowKeys,
    phones: stats.phoneCount,
  });
});

io.use((socket, next) => {
  const { password, role } = socket.handshake.auth || {};
  const timer = log.timed('auth');

  if (!password) {
    timer.fail('Auth failed: no password', { socketId: socket.id, role });
    return next(new Error('Password required'));
  }

  if (password !== AUTH_PASSWORD) {
    timer.fail('Auth failed: wrong password', { socketId: socket.id, role });
    return next(new Error('Invalid password'));
  }

  socket.data.role = role || 'phone';
  timer.end('Auth successful', { socketId: socket.id, role: socket.data.role });
  next();
});

io.on('connection', (socket) => {
  const role = socket.data.role;
  const windowKey = socket.handshake.auth?.windowKey;
  log.info('Socket connected', {
    socketId: socket.id,
    role,
    windowKey: windowKey || undefined,
    transport: socket.conn.transport.name,
    ip: socket.handshake.address,
  });

  if (role === 'extension') {
    roomManager.registerExtension(socket);
  } else {
    roomManager.registerPhone(socket);
  }

  socket.on('error', (err) => {
    log.error('Socket error', { socketId: socket.id, role, error: err.message });
  });
});

io.engine.on('connection_error', (err) => {
  log.error('Engine connection error', { code: err.code, message: err.message });
});

server.listen(PORT, () => {
  log.info(`Server started on port ${PORT}`, {
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'development',
  });
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { reason: String(reason) });
});
