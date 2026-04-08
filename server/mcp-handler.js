const crypto = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { createLogger } = require('./logger');

const log = createLogger('mcp');

const SSE_PING_MS = 30_000;
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
    this.mcpServer = null;
    this.pendingWaiter = null;
    this.pendingMessages = [];
    this.state = 'unbound';
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.lastWaiterAt = 0;
    this.lastResolvedAt = 0;
    this.waiterCount = 0;
    this.delivered = 0;
    this.ssePings = 0;
    this.lastResolvedMsgId = null;
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
      ssePings: this.ssePings,
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

  create(id, transport, mcpServer) {
    const s = new Session(id);
    s.transport = transport;
    s.mcpServer = mcpServer || null;
    this.sessions.set(id, s);
    s.state = 'unbound';
    log.info('SESSION new', { sid: s.shortId });
    this._fire();
    return s;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  bind(sess, chatKey, reason) {
    if (!chatKey || sess.chatKey === chatKey) return;
    sess.chatKey = chatKey;
    sess.state = 'bound';
    sess.touch();
    log.info('BIND', { sid: sess.shortId, ck: chatKey, reason });
    this._fire();
  }

  handleWait(sessionId, extra) {
    const sess = this.get(sessionId);
    if (!sess) {
      log.error('WAIT unknown session', { sid: sessionId?.substring(0, 8) });
      return Promise.resolve({ content: [{ type: 'text', text: '' }] });
    }

    sess.waiterCount++;
    sess.lastWaiterAt = Date.now();
    sess.touch();

    if (!sess.chatKey) this._tryAutoBind(sess);

    if (sess.pendingMessages.length > 0) {
      if (sess.lastResolvedMsgId && sess.pendingMessages[0]._msgId === sess.lastResolvedMsgId) {
        sess.pendingMessages.shift();
        sess.lastResolvedMsgId = null;
        log.info('WAIT dedup', { sid: sess.shortId, q: sess.pendingMessages.length });
      }
      if (sess.pendingMessages.length > 0) {
        const queued = sess.pendingMessages.shift();
        sess.delivered++;
        sess.lastResolvedAt = Date.now();
        sess.state = sess.chatKey ? 'bound' : 'unbound';
        log.info('WAIT drain', { sid: sess.shortId, ck: sess.chatKey, q: sess.pendingMessages.length });
        this._fire();
        return Promise.resolve(queued);
      }
      sess.lastResolvedMsgId = null;
    }

    if (sess.pendingWaiter) {
      log.warn('WAIT overwrite stale', { sid: sess.shortId });
      this._clearWaiter(sess, '');
    }

    sess.state = 'waiting';
    log.info('WAIT open', { sid: sess.shortId, ck: sess.chatKey, n: sess.waiterCount });

    return new Promise((resolve) => {
      const wid = crypto.randomUUID();

      const pingTimer = setInterval(() => {
        if (!sess.pendingWaiter || sess.pendingWaiter._id !== wid) {
          clearInterval(pingTimer);
          return;
        }
        sess.ssePings++;
        this._sendSsePing(sess, extra);
      }, SSE_PING_MS);

      sess.pendingWaiter = {
        _id: wid,
        createdAt: Date.now(),
        resolve: (result) => {
          clearInterval(pingTimer);
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

  _clearWaiter(sess, text) {
    if (!sess.pendingWaiter) return;
    try { sess.pendingWaiter.resolve({ content: [{ type: 'text', text }] }); } catch (e) {}
    sess.pendingWaiter = null;
    sess.lastResolvedMsgId = null;
  }

  _sendSsePing(sess, extra) {
    if (!extra || typeof extra.sendNotification !== 'function') return;
    try {
      const p = extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: 0, progress: 0, total: 1 },
      });
// #region agent log
      if (p && typeof p.catch === 'function') {
        p.catch((e) => { log.info('DBG PING-FAIL', { sid: sess?.shortId, err: e?.message, p: sess?.ssePings }); });
      }
// #endregion
    } catch (e) {
// #region agent log
      log.info('DBG PING-THROW', { sid: sess?.shortId, err: e?.message, p: sess?.ssePings });
// #endregion
    }
  }

  async route(text, images, msgId, targetChatKey) {
    const id = msgId || crypto.randomUUID();
    const t = id.substring(0, 8);

// #region agent log
const _dbgSessions = [...this.sessions.values()].map(s => ({sid:s.shortId,ck:s.chatKey,alive:s.isAlive,looping:s.isLooping,hasW:s.hasWaiter,wCnt:s.waiterCount,st:s.state}));
log.info('DBG ROUTE-ENTRY', { t, targetChatKey, sessions: JSON.stringify(_dbgSessions) });
// #endregion

    if (!targetChatKey) {
      log.warn('ROUTE no target', { t });
      return { accepted: false, id, status: 'no_target' };
    }

    let sess = this._findLooped(targetChatKey);

// #region agent log
log.info('DBG FIND-LOOPED', { t, found: !!sess, sid: sess?.shortId, ck: sess?.chatKey, hasW: sess?.hasWaiter, looping: sess?.isLooping });
// #endregion

    if (!sess) {
      const bound = this._findBound(targetChatKey);
// #region agent log
log.info('DBG FIND-BOUND', { t, found: !!bound, sid: bound?.shortId, ck: bound?.chatKey, qLen: bound?.pendingMessages?.length });
// #endregion
      if (bound && bound.pendingMessages.length < 10) {
        bound.pendingMessages.push(buildResult(text, images));
        this._trackDelivered(id);
        log.info('ROUTE queued(bound)', { t, sid: bound.shortId, q: bound.pendingMessages.length });
        return { accepted: true, id, status: 'queued' };
      }
      log.warn('ROUTE no session', { t, ck: targetChatKey });
      return { accepted: false, id, status: 'not_looped' };
    }

    if (sess.chatKey !== targetChatKey) {
      log.error('ROUTE isolation', { t, want: targetChatKey, got: sess.chatKey });
      return { accepted: false, id, status: 'isolation_mismatch' };
    }

    let target = sess.hasWaiter ? sess : null;

    if (!target) {
// #region agent log
log.info('DBG POLL-START', { t, sid: sess.shortId, hasW: sess.hasWaiter, maxMs: ROUTE_WAIT_MAX_MS });
// #endregion
      target = await this._pollForWaiter(targetChatKey, ROUTE_WAIT_MAX_MS);
    }

    if (target && target.chatKey !== targetChatKey) {
      log.error('ROUTE poll isolation', { t, want: targetChatKey, got: target.chatKey });
      return { accepted: false, id, status: 'isolation_breach' };
    }

    if (!target) {
// #region agent log
log.info('DBG POLL-EXHAUST', { t, sid: sess.shortId, qLen: sess.pendingMessages.length });
// #endregion
      if (sess.pendingMessages.length < 10) {
        sess.pendingMessages.push(buildResult(text, images));
        this._trackDelivered(id);
        log.info('ROUTE queued', { t, sid: sess.shortId, q: sess.pendingMessages.length });
        return { accepted: true, id, status: 'queued' };
      }
      log.warn('ROUTE full', { t, sid: sess.shortId });
      return { accepted: false, id, status: 'wait_exhausted' };
    }

    const result = buildResult(text, images);
    const waiterAge = target.pendingWaiter ? (Date.now() - target.pendingWaiter.createdAt) : 0;
    target.delivered++;
    this._trackDelivered(id);

// #region agent log
    log.info('DBG PRE-RESOLVE', { t, sid: target.shortId, hasW: target.hasWaiter, pings: target.ssePings, waiterAge });
// #endregion

    result._msgId = id;
    target.pendingMessages.push(result);
    target.lastResolvedMsgId = id;
    target.pendingWaiter.resolve(result);
    log.info('ROUTE ok', { t, sid: target.shortId, ck: target.chatKey, age: Math.round(waiterAge / 1000) });
    return { accepted: true, id, status: 'delivered' };
  }

  clearLoop() {
    let count = 0;
    for (const [, s] of this.sessions) {
      this._clearWaiter(s, '/stop');
      s.state = 'dead';
      count++;
    }
    log.info('CLEAR all', { count });
    this._fire();
  }

  clearLoopForSession(sessionId) {
    const s = this.get(sessionId);
    if (!s) return;
    this._clearWaiter(s, '/stop');
    s.state = 'dead';
    log.info('CLEAR session', { sid: s.shortId, ck: s.chatKey });
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
        log.info('REBIND', { sid: s.shortId, to: newChatKey });
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
    const alive = [...this.sessions.values()].filter(s => s.isAlive);
    if (alive.length === 0) return;
    const summary = alive.map(s => {
      const ck = s.chatKey ? s.chatKey.split('|').pop() + ':' + s.chatKey.split('|')[1]?.substring(0, 6) : '-';
      return `${s.shortId}[${s.state[0]}${s.hasWaiter ? 'W' : '.'}] ck=${ck} d=${s.delivered} q=${s.pendingMessages.length} p=${s.ssePings} ${Math.round(s.idleSinceMs / 1000)}s`;
    });
    log.info('HB ' + summary.join(' | '));
  }

  _doCleanup() {
    const toDelete = [];
    const GRACE_MS = 300_000;
    for (const [sid, s] of this.sessions) {
      if (s.state === 'dead') { toDelete.push(sid); continue; }
      if (s.hasWaiter || s.isLooping) continue;
      if (s.waiterCount > 0 && s.idleSinceMs < GRACE_MS) continue;
      if (s.idleSinceMs > REAP_IDLE_MS) {
        log.info('REAP', { sid: s.shortId });
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
    'Blocks until the user sends a message from the Cursor Web remote client. Returns the message text and any attached images. Call this in a loop -- it stays open until a message arrives.',
    {},
    async (_args, extra) => manager.handleWait(sessionIdRef.id, extra)
  );
  return server;
}

async function handleMcpPost(req, res) {
  const sessionId = req.headers['mcp-session-id'];

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
      const ref = { id: 'pending-' + crypto.randomUUID() };
      const mcpServer = createMcpServer(ref);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          ref.id = sid;
          manager.create(sid, transport, mcpServer);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId || ref.id;
        const sess = manager.get(sid);
// #region agent log
        log.info('DBG TRANSPORT-CLOSE', { sid: sess?.shortId, hadWaiter: sess?.hasWaiter, state: sess?.state, pings: sess?.ssePings });
// #endregion
        if (sess) log.info('TRANSPORT closed', { sid: sess.shortId });
      };

      await mcpServer.connect(transport);
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
