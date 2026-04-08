const crypto = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { createLogger } = require('./logger');

const log = createLogger('mcp');

const WAIT_KEEPALIVE_MS = 240_000;
const ROUTE_POLL_MS = 200;
const ROUTE_WAIT_MAX_MS = 60_000;
const REAP_IDLE_MS = 86_400_000;
const CLEANUP_INTERVAL_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 120_000;
const MAX_DELIVERED = 200;

class Session {
  constructor(id) {
    this.id = id;
    this.shortId = id.substring(0, 8);
    this.chatKey = null;
    this.transport = null;
    this.pendingWaiter = null;
    this.pendingMessages = [];
    this.state = 'unbound';
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.lastWaiterAt = 0;
    this.lastResolvedAt = 0;
    this.waiterCount = 0;
    this.delivered = 0;
    this.keepalives = 0;
  }

  get isAlive() {
    return this.state !== 'dead';
  }

  get isLooping() {
    return this.waiterCount > 0 && this.isAlive;
  }

  get hasWaiter() {
    return this.pendingWaiter !== null;
  }

  get idleSinceMs() {
    const ref = this.lastResolvedAt || this.lastWaiterAt || this.lastActivityAt;
    return Date.now() - ref;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  toDebug() {
    return {
      id: this.shortId,
      state: this.state,
      chatKey: this.chatKey,
      hasWaiter: this.hasWaiter,
      waiterCount: this.waiterCount,
      delivered: this.delivered,
      keepalives: this.keepalives,
      queued: this.pendingMessages.length,
      idleSinceMs: this.idleSinceMs,
      ageMs: Date.now() - this.createdAt,
    };
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.deliveredLog = [];
    this._onWaiterChange = null;
    this._getActiveChats = null;
    this._heartbeat = setInterval(() => this._doHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this._cleanup = setInterval(() => this._doCleanup(), CLEANUP_INTERVAL_MS);
  }

  setOnWaiterChange(fn) { this._onWaiterChange = fn; }
  setActiveChatProvider(fn) { this._getActiveChats = fn; }

  create(id, transport) {
    const s = new Session(id);
    s.transport = transport;
    this.sessions.set(id, s);
    s.state = 'unbound';
    log.info('SESSION created', { sid: s.shortId });
    this._fire();
    return s;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  bind(sess, chatKey, reason) {
    if (!chatKey || sess.chatKey === chatKey) return;
    const prev = sess.chatKey;
    sess.chatKey = chatKey;
    sess.state = 'bound';
    sess.touch();
    log.info('SESSION bound', { sid: sess.shortId, chatKey, prev, reason });
    this._fire();
  }

  handleWait(sessionId) {
    const sess = this.get(sessionId);
    if (!sess) {
      log.error('wait_for_response: unknown session', { sessionId: sessionId?.substring(0, 8) });
      return Promise.resolve({ content: [{ type: 'text', text: '' }] });
    }

    sess.waiterCount++;
    sess.lastWaiterAt = Date.now();
    sess.touch();

    if (!sess.chatKey) this._tryAutoBind(sess);

    if (sess.pendingMessages.length > 0) {
      const queued = sess.pendingMessages.shift();
      sess.delivered++;
      sess.lastResolvedAt = Date.now();
      sess.state = sess.chatKey ? 'bound' : 'unbound';
      log.info('WAIT drain queued', { sid: sess.shortId, chatKey: sess.chatKey || 'UNBOUND', remaining: sess.pendingMessages.length });
      this._fire();
      return Promise.resolve(queued);
    }

    if (sess.pendingWaiter) {
      log.warn('Overwriting stale waiter', { sid: sess.shortId });
      try { sess.pendingWaiter.resolve({ content: [{ type: 'text', text: '' }] }); } catch (e) {}
      sess.pendingWaiter = null;
    }

    sess.state = 'waiting';
    log.info('WAIT called', {
      sid: sess.shortId,
      chatKey: sess.chatKey || 'UNBOUND',
      n: sess.waiterCount,
    });

    return new Promise((resolve) => {
      const wid = crypto.randomUUID();

      const timer = setTimeout(() => {
        if (sess.pendingWaiter && sess.pendingWaiter._id === wid) {
          sess.keepalives++;
          sess.pendingWaiter = null;
          sess.lastResolvedAt = Date.now();
          sess.state = sess.chatKey ? 'bound' : 'unbound';
          log.info('WAIT keepalive', { sid: sess.shortId, n: sess.keepalives });
        }
        resolve({ content: [{ type: 'text', text: '<!-- keepalive -->' }] });
      }, WAIT_KEEPALIVE_MS);

      sess.pendingWaiter = {
        _id: wid,
        createdAt: Date.now(),
        resolve: (result) => {
          clearTimeout(timer);
          if (sess.pendingWaiter && sess.pendingWaiter._id === wid) {
            sess.pendingWaiter = null;
          }
          sess.lastResolvedAt = Date.now();
          sess.state = sess.chatKey ? 'bound' : 'unbound';
          resolve(result);
        },
      };
      this._fire();
    });
  }

  async route(text, images, msgId, targetChatKey) {
    const id = msgId || crypto.randomUUID();
    const trace = id.substring(0, 8);

    log.info('ROUTE begin', { trace, targetChatKey, textLen: text?.length ?? 0 });

    if (!targetChatKey) {
      log.warn('ROUTE -> REJECTED (no targetChatKey)', { trace });
      return { accepted: false, id, status: 'no_target' };
    }

    let sess = this._findLooped(targetChatKey);

    if (!sess) {
      const bound = this._findBound(targetChatKey);
      if (bound) {
        const MAX_QUEUED = 10;
        if (bound.pendingMessages.length < MAX_QUEUED) {
          bound.pendingMessages.push(buildResult(text, images));
          this._trackDelivered(id);
          log.info('ROUTE -> QUEUED (not looped, bound fallback)', { trace, sid: bound.shortId, chatKey: bound.chatKey, queueLen: bound.pendingMessages.length });
          return { accepted: true, id, status: 'queued' };
        }
      }
      log.info('ROUTE -> NOT_LOOPED', { trace, targetChatKey });
      return { accepted: false, id, status: 'not_looped' };
    }

    if (sess.chatKey !== targetChatKey) {
      log.error('ROUTE -> ISOLATION MISMATCH', { trace, expected: targetChatKey, actual: sess.chatKey, sid: sess.shortId });
      return { accepted: false, id, status: 'isolation_mismatch' };
    }

    let target = sess.hasWaiter ? sess : null;

    if (!target) {
      log.info('ROUTE polling for waiter', { trace, sid: sess.shortId, chatKey: targetChatKey });
      target = await this._pollForWaiter(targetChatKey, ROUTE_WAIT_MAX_MS);
    }

    if (target && target.chatKey !== targetChatKey) {
      log.error('ROUTE -> POLL ISOLATION BREACH', { trace, expected: targetChatKey, got: target.chatKey, sid: target.shortId });
      return { accepted: false, id, status: 'isolation_breach' };
    }

    if (!target) {
      const MAX_QUEUED = 10;
      if (sess.pendingMessages.length < MAX_QUEUED) {
        sess.pendingMessages.push(buildResult(text, images));
        this._trackDelivered(id);
        log.info('ROUTE -> QUEUED', { trace, sid: sess.shortId, chatKey: sess.chatKey, queueLen: sess.pendingMessages.length });
        return { accepted: true, id, status: 'queued' };
      }
      log.warn('ROUTE -> EXHAUSTED (queue full)', { trace, sid: sess.shortId });
      return { accepted: false, id, status: 'wait_exhausted' };
    }

    target.delivered++;
    target.pendingWaiter.resolve(buildResult(text, images));
    this._trackDelivered(id);
    log.info('ROUTE -> DELIVERED', { trace, sid: target.shortId, chatKey: target.chatKey, targetChatKey });
    return { accepted: true, id, status: 'delivered' };
  }

  clearLoop() {
    let count = 0;
    for (const [, s] of this.sessions) {
      if (s.pendingWaiter) {
        try { s.pendingWaiter.resolve({ content: [{ type: 'text', text: '/stop' }] }); } catch (e) {}
      }
      s.state = 'dead';
      count++;
    }
    log.info('ALL LOOPS CLEARED', { count });
    this._fire();
  }

  clearLoopForSession(sessionId) {
    const s = this.get(sessionId);
    if (!s) return;
    if (s.pendingWaiter) {
      try { s.pendingWaiter.resolve({ content: [{ type: 'text', text: '/stop' }] }); } catch (e) {}
    }
    s.state = 'dead';
    log.info('SESSION killed', { sid: s.shortId, chatKey: s.chatKey });
    this._fire();
  }

  isLoopedForChat(chatKey) {
    if (!chatKey) return [...this.sessions.values()].some(s => s.isLooping);
    for (const [, s] of this.sessions) {
      if (s.chatKey === chatKey && s.isLooping) return true;
    }
    return false;
  }

  getSessionInfo() {
    const info = {};
    for (const [sid, s] of this.sessions) info[sid] = s.toDebug();
    return info;
  }

  getDebugDump() {
    return {
      sessionCount: this.sessions.size,
      sessions: [...this.sessions.values()].map(s => s.toDebug()),
      deliveredRecent: this.deliveredLog.slice(-10),
    };
  }

  getMessageStatus(id) {
    return this.deliveredLog.find(m => m.id === id) || null;
  }

  _tryAutoBind(sess) {
    if (sess.chatKey) return;
    if (!this._getActiveChats) return;

    const active = this._getActiveChats();
    if (!active || active.length === 0) return;

    const taken = new Set();
    for (const [sid, s] of this.sessions) {
      if (s.chatKey && s.isAlive && sid !== sess.id) taken.add(s.chatKey);
    }

    for (const chat of active) {
      if (!taken.has(chat.chatKey)) {
        this.bind(sess, chat.chatKey, 'auto-bind');
        return;
      }
    }
  }

  autoBindUnbound(chatKey) {
    if (!chatKey) return;
    const already = [...this.sessions.values()].find(s => s.chatKey === chatKey && s.isAlive);
    if (already) return;

    let best = null;
    let bestTime = -1;
    for (const [, s] of this.sessions) {
      if (s.chatKey || !s.isAlive) continue;
      const t = s.lastWaiterAt || s.createdAt;
      if (t > bestTime) { best = s; bestTime = t; }
    }
    if (best) this.bind(best, chatKey, 'auto-bind-from-state');
  }

  rebindStale(oldWindowKey, newWindowKey) {
    let count = 0;
    for (const [, s] of this.sessions) {
      if (!s.isAlive || !s.chatKey) continue;
      const parts = s.chatKey.split('|');
      const sessionWindowKey = parts.slice(0, 2).join('|');
      const tabIndex = parts[2] || '0';
      if (sessionWindowKey === oldWindowKey) {
        const newChatKey = newWindowKey + '|' + tabIndex;
        log.info('SESSION rebind (window changed)', { sid: s.shortId, from: s.chatKey, to: newChatKey });
        s.chatKey = newChatKey;
        s.touch();
        count++;
      }
    }
    if (count > 0) this._fire();
    return count;
  }

  _findLooped(chatKey) {
    let best = null;
    let bestTime = -1;
    for (const [, s] of this.sessions) {
      if (!s.isLooping) continue;
      if (chatKey && s.chatKey !== chatKey) continue;
      const t = s.lastWaiterAt || s.createdAt;
      if (t > bestTime) { best = s; bestTime = t; }
    }
    return best;
  }

  _findBound(chatKey) {
    if (!chatKey) return null;
    let best = null;
    let bestTime = -1;
    for (const [, s] of this.sessions) {
      if (!s.isAlive || s.chatKey !== chatKey) continue;
      const t = s.lastWaiterAt || s.lastActivityAt || s.createdAt;
      if (t > bestTime) { best = s; bestTime = t; }
    }
    return best;
  }

  _pollForWaiter(chatKey, maxMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const s = this._findLooped(chatKey);
        if (s && s.hasWaiter) return resolve(s);
        if (Date.now() - start >= maxMs) return resolve(null);
        setTimeout(tick, ROUTE_POLL_MS);
      };
      tick();
    });
  }

  _trackDelivered(id) {
    this.deliveredLog.push({ id, at: Date.now() });
    if (this.deliveredLog.length > MAX_DELIVERED) this.deliveredLog.shift();
  }

  _fire() {
    if (!this._onWaiterChange) return;
    const perSession = {};
    for (const [sid, s] of this.sessions) {
      perSession[sid] = {
        waiting: s.hasWaiter,
        loopActive: s.isLooping,
        chatKey: s.chatKey,
        state: s.state,
      };
    }
    this._onWaiterChange({
      waiting: [...this.sessions.values()].some(s => s.hasWaiter),
      loopActive: [...this.sessions.values()].some(s => s.isLooping),
      perSession,
    });
  }

  _doHeartbeat() {
    const arr = [...this.sessions.values()].map(s => ({
      sid: s.shortId,
      st: s.state,
      ck: s.chatKey || '-',
      w: s.hasWaiter ? 'Y' : 'N',
      n: s.waiterCount,
      d: s.delivered,
      idle: Math.round(s.idleSinceMs / 1000) + 's',
    }));
    if (arr.length > 0) log.info('HEARTBEAT', { sessions: JSON.stringify(arr) });
  }

  _doCleanup() {
    const toDelete = [];
    const GRACE_MS = 300_000;
    for (const [sid, s] of this.sessions) {
      if (s.state === 'dead') { toDelete.push(sid); continue; }
      if (s.hasWaiter || s.isLooping) continue;
      if (s.waiterCount > 0 && s.idleSinceMs < GRACE_MS) continue;
      if (s.idleSinceMs > REAP_IDLE_MS) {
        log.info('SESSION reap', { sid: s.shortId, idleMs: s.idleSinceMs });
        s.state = 'dead';
        toDelete.push(sid);
      }
    }
    for (const sid of toDelete) this.sessions.delete(sid);
    if (toDelete.length > 0) this._fire();
  }
}

function buildResult(text, images) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (images && images.length > 0) {
    for (const img of images) {
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) content.push({ type: 'image', data: m[2], mimeType: m[1] });
      else content.push({ type: 'image', data: img, mimeType: 'image/png' });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '(empty message)' });
  return { content };
}

const manager = new SessionManager();

function createMcpServer(sessionIdRef) {
  const server = new McpServer({ name: 'cursor-remote', version: '2.0.0' });
  server.tool(
    'wait_for_response',
    'Blocks until the user sends a message from the Cursor Web remote client. Returns the message text and any attached images. On timeout returns empty string -- call again immediately to keep the loop alive.',
    {},
    async () => manager.handleWait(sessionIdRef.id)
  );
  return server;
}

async function handleMcpPost(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const method = req.body?.method || 'unknown';

  try {
    if (sessionId && sessionId.length > 0) {
      const sess = manager.get(sessionId);
      if (sess && sess.transport) {
        sess.touch();
        await sess.transport.handleRequest(req, res, req.body);
        return;
      }
    }

    if ((!sessionId || sessionId.length === 0) && isInitializeRequest(req.body)) {
      log.info('MCP INIT', { active: manager.sessions.size });
      const ref = { id: 'pending-' + crypto.randomUUID() };

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          ref.id = sid;
          manager.create(sid, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId || ref.id;
        const sess = manager.get(sid);
        if (sess) log.info('TRANSPORT closed', { sid: sess.shortId });
      };

      const server = createMcpServer(ref);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID' },
      id: null,
    });
  } catch (err) {
    log.error('MCP POST error', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}

async function handleMcpGet(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const sess = sessionId ? manager.get(sessionId) : null;
  if (!sess || !sess.transport) return res.status(400).send('Invalid session');
  try {
    await sess.transport.handleRequest(req, res);
  } catch (err) {
    log.error('MCP GET error', { error: err.message });
    if (!res.headersSent) res.status(500).send('Error');
  }
}

async function handleMcpDelete(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const sess = sessionId ? manager.get(sessionId) : null;
  if (!sess || !sess.transport) return res.status(400).send('Invalid session');
  log.info('MCP DELETE', { sid: sess.shortId });
  try {
    await sess.transport.handleRequest(req, res);
  } catch (err) {
    log.error('MCP DELETE error', { error: err.message });
    if (!res.headersSent) res.status(500).send('Error');
  }
}

module.exports = {
  handleMcpPost,
  handleMcpGet,
  handleMcpDelete,
  resolvePendingWait: (text, images, msgId, targetChatKey) => manager.route(text, images, msgId, targetChatKey),
  setOnWaiterChange: (fn) => manager.setOnWaiterChange(fn),
  setActiveChatProvider: (fn) => manager.setActiveChatProvider(fn),
  bindSessionToChat: (sessionId, chatKey) => {
    const s = manager.get(sessionId);
    if (s) manager.bind(s, chatKey, 'external-bind');
  },
  autoBindUnboundSessions: (chatKey) => manager.autoBindUnbound(chatKey),
  isLoopedForChat: (ck) => manager.isLoopedForChat(ck),
  clearLoop: () => manager.clearLoop(),
  clearLoopForSession: (sid) => manager.clearLoopForSession(sid),
  getSessionInfo: () => manager.getSessionInfo(),
  getDebugDump: () => manager.getDebugDump(),
  getMessageStatus: (id) => manager.getMessageStatus(id),
  rebindStaleSessions: (oldWindowKey, newWindowKey) => manager.rebindStale(oldWindowKey, newWindowKey),
};
