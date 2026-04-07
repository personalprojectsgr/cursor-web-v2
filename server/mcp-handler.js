const crypto = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { createLogger } = require('./logger');

const log = createLogger('mcp');

const WAIT_TIMEOUT_MS = 240_000;
const ROUTE_WAIT_MAX_MS = 30_000;
const ROUTE_POLL_MS = 200;
const MAX_DELIVERED_HISTORY = 200;
const HEARTBEAT_INTERVAL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 1_800_000;
const DEAD_AFTER_MS = 2_100_000;

const KEEPALIVE_TEXT = '';

const SESSION_STATES = {
  INITIALIZING: 'initializing',
  UNBOUND: 'unbound',
  BOUND: 'bound',
  WAITING: 'waiting',
  IDLE: 'idle',
  STALE: 'stale',
  DEAD: 'dead',
};

const ALIVE_STATES = new Set([
  SESSION_STATES.UNBOUND,
  SESSION_STATES.BOUND,
  SESSION_STATES.WAITING,
  SESSION_STATES.IDLE,
]);

class Session {
  constructor(id) {
    this.id = id;
    this.shortId = id.substring(0, 8);
    this.state = SESSION_STATES.INITIALIZING;
    this.windowKey = null;
    this.transport = null;
    this.pendingWaiter = null;
    this.createdAt = Date.now();
    this.lastWaiterStartedAt = 0;
    this.lastWaiterEndedAt = 0;
    this.lastActivityAt = Date.now();
    this.waiterCount = 0;
    this.messagesDelivered = 0;
    this.keepalivesIssued = 0;
    this.log = log.withContext({ sid: this.shortId });
  }

  get isAlive() {
    return ALIVE_STATES.has(this.state);
  }

  get isLooping() {
    return this.waiterCount > 0 && this.isAlive;
  }

  get hasWaiter() {
    return this.pendingWaiter !== null;
  }

  get ageMs() {
    return Date.now() - this.createdAt;
  }

  get idleSinceMs() {
    const ref = this.lastWaiterEndedAt || this.lastWaiterStartedAt || this.lastActivityAt;
    return Date.now() - ref;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  toDebug() {
    return {
      id: this.shortId,
      state: this.state,
      windowKey: this.windowKey ? windowShortName(this.windowKey) : null,
      hasWaiter: this.hasWaiter,
      ageMs: this.ageMs,
      idleSinceMs: this.idleSinceMs,
      waiterCount: this.waiterCount,
      delivered: this.messagesDelivered,
      keepalives: this.keepalivesIssued,
    };
  }
}

function windowShortName(windowKey) {
  if (!windowKey) return null;
  const segments = windowKey.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] || windowKey;
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.deliveredMessages = [];
    this._onWaiterChange = null;
    this._getActiveWindows = null;

    this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL_MS);
    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
  }

  setOnWaiterChange(fn) { this._onWaiterChange = fn; }
  setActiveWindowsProvider(fn) { this._getActiveWindows = fn; }

  createSession(id, transport) {
    const sess = new Session(id);
    sess.transport = transport;
    this.sessions.set(id, sess);
    this._transition(sess, SESSION_STATES.UNBOUND, 'created');
    return sess;
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  _transition(sess, newState, reason) {
    const oldState = sess.state;
    if (oldState === newState) return;
    sess.state = newState;
    sess.touch();
    sess.log.info(`SESSION ${oldState} -> ${newState}`, {
      reason,
      wk: sess.windowKey ? windowShortName(sess.windowKey) : null,
    });
    this._fireChange();
  }

  bindToWindow(sess, windowKey, reason) {
    if (!windowKey) return;
    const prev = sess.windowKey;
    if (prev === windowKey) return;
    sess.windowKey = windowKey;
    sess.log.info('BIND session to window', {
      window: windowShortName(windowKey),
      previousWindow: prev ? windowShortName(prev) : null,
      reason,
    });
    if (sess.state === SESSION_STATES.UNBOUND) {
      this._transition(sess, SESSION_STATES.BOUND, 'bound-to-window');
    }
    this._fireChange();
  }

  autoBindUnbound(windowKey) {
    if (!windowKey) return;
    const alreadyBound = this._findBoundAliveSession(windowKey);
    if (alreadyBound) return;

    let best = null;
    let bestTime = -1;
    for (const [, sess] of this.sessions) {
      if (sess.windowKey || !sess.isAlive) continue;
      const sortKey = sess.lastWaiterStartedAt || sess.createdAt;
      if (sortKey > bestTime) {
        best = sess;
        bestTime = sortKey;
      }
    }
    if (best) {
      best.log.info('AUTO-BIND candidate found', {
        state: best.state,
        waiterCount: best.waiterCount,
        window: windowShortName(windowKey),
      });
      this.bindToWindow(best, windowKey, 'auto-bind-from-ext-state');
    }
  }

  _tryBindSelfToActiveWindow(sess) {
    if (sess.windowKey) return;
    if (!this._getActiveWindows) return;

    const activeWindows = this._getActiveWindows();
    if (!activeWindows || activeWindows.length === 0) return;

    const boundKeys = new Set();
    for (const [sid, s] of this.sessions) {
      if (s.windowKey && s.isAlive && sid !== sess.id) {
        boundKeys.add(s.windowKey);
      }
    }

    for (const wk of activeWindows) {
      if (!boundKeys.has(wk)) {
        this.bindToWindow(sess, wk, 'self-bind-on-wait');
        return;
      }
    }
  }

  handleWaitForResponse(sessionId) {
    const sess = this.getSession(sessionId);
    if (!sess) {
      log.error('wait_for_response: session not found', { sessionId });
      return Promise.resolve({ content: [{ type: 'text', text: '' }] });
    }

    sess.waiterCount++;
    sess.lastWaiterStartedAt = Date.now();
    sess.touch();

    const slog = sess.log.withContext({ waiter: sess.waiterCount });
    slog.info('WAIT_FOR_RESPONSE called', {
      state: sess.state,
      wk: sess.windowKey ? windowShortName(sess.windowKey) : 'UNBOUND',
      hadWaiter: sess.hasWaiter,
    });

    if (!sess.windowKey) {
      this._tryBindSelfToActiveWindow(sess);
      slog.info('WAIT_FOR_RESPONSE post-bind', {
        wk: sess.windowKey ? windowShortName(sess.windowKey) : 'still-UNBOUND',
      });
    }

    if (sess.pendingWaiter) {
      slog.warn('OVERWRITE stale waiter', {
        staleAge: Date.now() - sess.pendingWaiter.createdAt,
      });
      sess.pendingWaiter = null;
    }

    this._transition(sess, SESSION_STATES.WAITING, 'awaiting-message');

    return new Promise((resolve) => {
      const waiterId = crypto.randomUUID();

      const timer = setTimeout(() => {
        if (sess.pendingWaiter && sess.pendingWaiter._id === waiterId) {
          sess.keepalivesIssued++;
          slog.info('WAIT_FOR_RESPONSE keepalive (timeout, auto-renew)', {
            waitedMs: WAIT_TIMEOUT_MS,
            keepaliveNum: sess.keepalivesIssued,
          });
          sess.pendingWaiter = null;
          sess.lastWaiterEndedAt = Date.now();
          this._transition(sess, SESSION_STATES.IDLE, 'keepalive-timeout');
        }
        resolve({ content: [{ type: 'text', text: KEEPALIVE_TEXT }] });
      }, WAIT_TIMEOUT_MS);

      sess.pendingWaiter = {
        _id: waiterId,
        createdAt: Date.now(),
        resolve: (result) => {
          clearTimeout(timer);
          if (sess.pendingWaiter && sess.pendingWaiter._id === waiterId) {
            sess.pendingWaiter = null;
          }
          sess.lastWaiterEndedAt = Date.now();
          this._transition(sess, SESSION_STATES.IDLE, 'waiter-resolved');
          resolve(result);
        },
      };
      this._fireChange();
    });
  }

  async routeMessage(text, images, msgId, targetWindowKey) {
    const id = msgId || crypto.randomUUID();
    const traceId = id.substring(0, 8);
    const targetShort = targetWindowKey ? windowShortName(targetWindowKey) : 'ANY';

    const rlog = log.withContext({ trace: traceId, target: targetShort });
    rlog.info('ROUTE begin', {
      textLen: text?.length ?? 0,
      images: images?.length ?? 0,
      sessionCount: this.sessions.size,
    });

    let loopedSession = this._findLoopedSession(targetWindowKey);

    if (!loopedSession && targetWindowKey) {
      const anyLooped = this._findLoopedSession(null);
      if (anyLooped) {
        rlog.info('ROUTE target mismatch, binding to available looped session', {
          targetKey: targetWindowKey,
          sessWk: anyLooped.windowKey,
          sid: anyLooped.shortId,
        });
        loopedSession = anyLooped;
      }
    }

    if (!loopedSession) {
      rlog.info('ROUTE -> NOT_LOOPED (no looped session anywhere)', {
        target: targetShort,
        allSessions: [...this.sessions.values()].map(s => ({
          id: s.shortId, st: s.state, wk: s.windowKey ? windowShortName(s.windowKey) : null,
          waiterCount: s.waiterCount, hasWaiter: s.hasWaiter,
        })),
      });
      return { accepted: false, id, status: 'not_looped', reason: 'no_looped_session' };
    }

    let waiter = loopedSession.hasWaiter ? loopedSession : null;

    if (!waiter) {
      rlog.info('ROUTE session looped but no waiter, waiting up to ' + ROUTE_WAIT_MAX_MS + 'ms', {
        sid: loopedSession.shortId,
        state: loopedSession.state,
        idleMs: loopedSession.idleSinceMs,
      });
      waiter = await this._waitForWaiter(targetWindowKey, ROUTE_WAIT_MAX_MS, rlog);
    }

    if (!waiter) {
      rlog.warn('ROUTE -> WAIT_EXHAUSTED (waiter never came back)', {
        sid: loopedSession.shortId,
        state: loopedSession.state,
        waitedMs: ROUTE_WAIT_MAX_MS,
      });
      return { accepted: false, id, status: 'wait_exhausted', reason: 'waiter_never_returned' };
    }

    const waitedMs = Date.now() - waiter.pendingWaiter.createdAt;
    waiter.messagesDelivered++;
    const slog = rlog.withContext({ sid: waiter.shortId, wk: waiter.windowKey ? windowShortName(waiter.windowKey) : null });
    slog.info('ROUTE -> DELIVER to waiter', { waitedMs });
    waiter.pendingWaiter.resolve(buildMcpResult(text, images));
    this._trackDelivered(id, 'delivered');
    return { accepted: true, id, status: 'delivered', reason: 'waiter_direct' };
  }

  _findLoopedSession(targetWindowKey) {
    let best = null;
    let bestTime = -1;
    for (const [, sess] of this.sessions) {
      if (!sess.isLooping) continue;
      if (targetWindowKey && sess.windowKey !== targetWindowKey) continue;
      const sortKey = sess.lastWaiterStartedAt || sess.createdAt;
      if (sortKey > bestTime) {
        best = sess;
        bestTime = sortKey;
      }
    }
    return best;
  }

  _waitForWaiter(targetWindowKey, maxWaitMs, rlog) {
    return new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        const sess = this._findLoopedSession(targetWindowKey);
        if (sess && sess.hasWaiter) {
          rlog.info('ROUTE wait: waiter arrived', { elapsedMs: Date.now() - start, sid: sess.shortId });
          resolve(sess);
          return;
        }
        if (Date.now() - start >= maxWaitMs) {
          rlog.warn('ROUTE wait: exhausted', { elapsedMs: Date.now() - start });
          resolve(null);
          return;
        }
        setTimeout(poll, ROUTE_POLL_MS);
      };
      poll();
    });
  }

  _findBoundAliveSession(windowKey) {
    for (const [, sess] of this.sessions) {
      if (sess.windowKey === windowKey && sess.isAlive) return sess;
    }
    return null;
  }

  isLoopedForWindow(windowKey) {
    if (!windowKey) {
      return [...this.sessions.values()].some(s => s.isLooping);
    }
    for (const [, sess] of this.sessions) {
      if (sess.windowKey === windowKey && sess.isLooping) return true;
    }
    return false;
  }

  isMcpLoopActive() {
    return [...this.sessions.values()].some(s => s.isLooping);
  }

  hasPendingWaiter() {
    return [...this.sessions.values()].some(s => s.hasWaiter);
  }

  clearLoop() {
    for (const [, sess] of this.sessions) {
      sess.lastWaiterEndedAt = 0;
      sess.lastWaiterStartedAt = 0;
      if (sess.pendingWaiter) {
        sess.pendingWaiter.resolve({ content: [{ type: 'text', text: '/stop' }] });
      }
      this._transition(sess, SESSION_STATES.DEAD, 'clear-loop');
    }
    log.info('ALL LOOPS CLEARED', { sessionCount: this.sessions.size });
    return [];
  }

  clearLoopForSession(sessionId) {
    const sess = this.getSession(sessionId);
    if (!sess) return [];
    sess.lastWaiterEndedAt = 0;
    sess.lastWaiterStartedAt = 0;
    if (sess.pendingWaiter) {
      sess.pendingWaiter.resolve({ content: [{ type: 'text', text: '/stop' }] });
    }
    this._transition(sess, SESSION_STATES.DEAD, 'clear-loop-single');
    return [];
  }

  getSessionInfo() {
    const info = {};
    for (const [sid, sess] of this.sessions) {
      info[sid] = sess.toDebug();
    }
    return info;
  }

  getDebugDump() {
    const sessArr = [];
    for (const [, sess] of this.sessions) {
      sessArr.push(sess.toDebug());
    }
    return {
      sessionCount: this.sessions.size,
      sessions: sessArr,
      deliveredRecent: this.deliveredMessages.slice(-10),
    };
  }

  getMessageStatus(id) {
    return this.deliveredMessages.find(m => m.id === id) || null;
  }

  _trackDelivered(id, status) {
    const existing = this.deliveredMessages.find(m => m.id === id);
    if (existing) {
      existing.status = status;
      existing.at = Date.now();
      return;
    }
    this.deliveredMessages.push({ id, status, at: Date.now() });
    if (this.deliveredMessages.length > MAX_DELIVERED_HISTORY) this.deliveredMessages.shift();
  }

  _fireChange() {
    if (!this._onWaiterChange) return;
    const perSession = {};
    for (const [sid, s] of this.sessions) {
      perSession[sid] = {
        waiting: s.hasWaiter,
        loopActive: s.isLooping,
        windowKey: s.windowKey,
        state: s.state,
      };
    }
    this._onWaiterChange({
      waiting: [...this.sessions.values()].some(s => s.hasWaiter),
      loopActive: [...this.sessions.values()].some(s => s.isLooping),
      perSession,
    });
  }

  _heartbeat() {
    const sessInfo = [];
    for (const [, sess] of this.sessions) {
      sessInfo.push({
        id: sess.shortId,
        st: sess.state,
        wk: sess.windowKey ? windowShortName(sess.windowKey) : '-',
        w: sess.hasWaiter ? 'Y' : 'N',
        idle: Math.round(sess.idleSinceMs / 1000) + 's',
        age: Math.round(sess.ageMs / 1000) + 's',
        delivered: sess.messagesDelivered,
        ka: sess.keepalivesIssued,
      });
    }
    log.info('HEARTBEAT', {
      sessions: sessInfo.length,
      detail: sessInfo.length > 0 ? JSON.stringify(sessInfo) : 'none',
    });
  }

  _cleanup() {
    const toDelete = [];

    for (const [sid, sess] of this.sessions) {
      if (sess.state === SESSION_STATES.DEAD) {
        toDelete.push(sid);
        continue;
      }

      if (sess.hasWaiter) continue;
      if (sess.isLooping) continue;

      if (sess.idleSinceMs > STALE_AFTER_MS) {
        this._transition(sess, SESSION_STATES.STALE, `idle ${Math.round(sess.idleSinceMs / 1000)}s`);
      }

      if (sess.state === SESSION_STATES.STALE && sess.idleSinceMs > DEAD_AFTER_MS) {
        this._transition(sess, SESSION_STATES.DEAD, 'stale-expired');
        toDelete.push(sid);
      }
    }

    for (const sid of toDelete) {
      const sess = this.sessions.get(sid);
      if (sess) {
        sess.log.info('SESSION removed', { ageMs: sess.ageMs });
        this.sessions.delete(sid);
      }
    }

    if (toDelete.length > 0) {
      this._fireChange();
    }
  }
}

function buildMcpResult(text, images) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (images && images.length > 0) {
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const match = img.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const dataLen = match[2].length;
        log.info('BUILD MCP image', { idx: i, mimeType: match[1], base64Len: dataLen, approxKB: Math.round(dataLen / 1024) });
        content.push({ type: 'image', data: match[2], mimeType: match[1] });
      } else {
        log.info('BUILD MCP image (no data-url)', { idx: i, rawLen: img.length });
        content.push({ type: 'image', data: img, mimeType: 'image/png' });
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '(empty message)' });
  log.info('BUILD MCP result', {
    contentItems: content.length,
    textItems: content.filter(c => c.type === 'text').length,
    imageItems: content.filter(c => c.type === 'image').length,
    totalBytes: JSON.stringify(content).length,
  });
  return { content };
}

const manager = new SessionManager();

function createMcpServer(sessionIdRef) {
  const server = new McpServer({ name: 'cursor-remote', version: '2.0.0' });

  server.tool(
    'wait_for_response',
    'Blocks until the user sends a message from the CursorRemote mobile web client. Returns the message text and any attached images. On timeout returns empty string -- call again immediately to keep the loop alive.',
    {},
    async () => manager.handleWaitForResponse(sessionIdRef.id)
  );

  return server;
}

async function handleMcpPost(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const body = req.body;
  const method = body?.method || 'unknown';
  const toolName = body?.params?.name || null;
  log.debug('MCP POST', {
    sid: sessionId ? sessionId.substring(0, 8) : 'none',
    method,
    tool: toolName || undefined,
  });

  try {
    if (sessionId) {
      const sess = manager.getSession(sessionId);
      if (sess && sess.transport) {
        sess.touch();
        if (method !== 'unknown') {
          sess.log.debug('MCP request', { method, tool: toolName || undefined });
        }
        await sess.transport.handleRequest(req, res, req.body);
        return;
      }
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      log.info('MCP INIT request', { activeSessions: manager.sessions.size });

      const sessionIdRef = { id: 'pending-' + crypto.randomUUID() };

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          log.info('MCP INIT complete', { sid: sid.substring(0, 8), prevRef: sessionIdRef.id.substring(0, 16) });
          sessionIdRef.id = sid;
          manager.createSession(sid, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId || sessionIdRef.id;
        const sess = manager.getSession(sid);
        if (sess) {
          sess.log.info('TRANSPORT closed (session kept alive for grace period)');
        }
      };

      const server = createMcpServer(sessionIdRef);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null,
    });
  } catch (error) {
    log.error('MCP POST error', { error: error.message, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

async function handleMcpGet(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const sess = sessionId ? manager.getSession(sessionId) : null;
  if (!sess || !sess.transport) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  log.debug('MCP GET (SSE)', { sid: sessionId.substring(0, 8) });
  await sess.transport.handleRequest(req, res);
}

async function handleMcpDelete(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const sess = sessionId ? manager.getSession(sessionId) : null;
  if (!sess || !sess.transport) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  sess.log.info('MCP DELETE (session termination)');
  try {
    await sess.transport.handleRequest(req, res);
  } catch (error) {
    log.error('MCP DELETE error', { error: error.message });
    if (!res.headersSent) res.status(500).send('Error processing session termination');
  }
}

module.exports = {
  handleMcpPost,
  handleMcpGet,
  handleMcpDelete,
  resolvePendingWait: (text, images, msgId, targetWindowKey) => manager.routeMessage(text, images, msgId, targetWindowKey),
  hasPendingWaiter: () => manager.hasPendingWaiter(),
  isMcpLoopActive: () => manager.isMcpLoopActive(),
  isLoopedForWindow: (wk) => manager.isLoopedForWindow(wk),
  clearLoop: () => manager.clearLoop(),
  clearLoopForSession: (sid) => manager.clearLoopForSession(sid),
  setOnWaiterChange: (fn) => manager.setOnWaiterChange(fn),
  getMessageStatus: (id) => manager.getMessageStatus(id),
  bindSessionToWindow: (sessionId, windowKey) => {
    const sess = manager.getSession(sessionId);
    if (sess) manager.bindToWindow(sess, windowKey, 'external-bind');
  },
  autoBindUnboundSessions: (wk) => manager.autoBindUnbound(wk),
  setActiveWindowsProvider: (fn) => manager.setActiveWindowsProvider(fn),
  getSessionInfo: () => manager.getSessionInfo(),
  getDebugDump: () => manager.getDebugDump(),
};
