const crypto = require('node:crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { createLogger } = require('./logger');
const redis = require('./redis');

const log = createLogger('mcp');

const KEEPALIVE_MS = 240_000;
const KEEPALIVE_TEXT = '[keepalive] No user message received. Call wait_for_response again to continue waiting.';
const SSE_PING_INTERVAL_MS = 30_000;
const ROUTE_WAIT_MS = 30_000;
const ROUTE_POLL_MS = 500;
const DEFERRED_TTL_MS = 900_000;
const REAP_IDLE_MS = 600_000;
const CLEANUP_INTERVAL_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 120_000;
const MAX_DELIVERED = 200;

class Session {
  constructor(id) {
    this.id = id;
    this.shortId = id.substring(0, 8);
    this.chatKey = null;
    this.chatId = null;
    this.transport = null;
    this.sseRes = null;
    this.ssePingTimer = null;
    this.pendingWaiter = null;
    this._redisSub = null;
    this.state = 'unbound';
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.lastWaiterAt = 0;
    this.lastResolvedAt = 0;
    this.waiterCount = 0;
    this.delivered = 0;
  }

  get isAlive() { return this.state !== 'dead'; }
  get hasWaiter() { return this.pendingWaiter !== null; }
  get isLooping() {
    if (!this.isAlive || this.waiterCount === 0) return false;
    if (this.hasWaiter) return true;
    return (Date.now() - (this.lastResolvedAt || this.lastWaiterAt)) < KEEPALIVE_MS + 30_000;
  }

  get idleMs() {
    return Date.now() - (this.lastResolvedAt || this.lastWaiterAt || this.lastActivityAt);
  }

  touch() { this.lastActivityAt = Date.now(); }

  toDebug() {
    return {
      id: this.shortId, state: this.state, ck: this.chatKey, cid: this.chatId,
      w: this.hasWaiter, n: this.waiterCount, d: this.delivered,
      idle: Math.round(this.idleMs / 1000),
    };
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.deliveredLog = [];
    this.deferredRoutes = new Map();
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
    log.info('SESSION new', { sid: s.shortId });
    this._fire();
    return s;
  }

  get(id) { return this.sessions.get(id) || null; }

  bind(sess, chatKey, reason) {
    if (!chatKey || sess.chatKey === chatKey) return;
    sess.chatKey = chatKey;
    sess.state = 'bound';
    sess.touch();
    log.info('BIND', { sid: sess.shortId, ck: chatKey, cid: sess.chatId, reason });
    this._fire();
  }

  async handleWait(sessionId, chatId) {
    const sess = this.get(sessionId);
    if (!sess) {
      log.error('WAIT unknown', { sid: sessionId?.substring(0, 8) });
      return { content: [{ type: 'text', text: '' }] };
    }

    sess.waiterCount++;
    sess.lastWaiterAt = Date.now();
    sess.touch();

    if (chatId && !sess.chatId) {
      sess.chatId = chatId;
      log.info('WAIT chatId set', { sid: sess.shortId, chatId });
    }

    const wasBound = !!sess.chatKey;
    if (sess.chatId && !sess.chatKey) {
      this._bindByChatId(sess);
    }

    if (!wasBound && sess.chatKey) {
      log.info('WAIT late-bind ok', { sid: sess.shortId, ck: sess.chatKey });
    }

    if (sess.pendingWaiter) {
      this._clearWaiter(sess, '');
    }

    if (sess.chatKey) {
      const deferred = await this._popDeferred(sess.chatKey);
      if (deferred) {
        log.info('ROUTE deferred ok', { sid: sess.shortId, t: deferred.t, age: Math.round((Date.now() - deferred.createdAt) / 1000) + 's' });
        sess.delivered++;
        this._trackDelivered(deferred.id);
        sess.state = 'bound';
        sess.lastResolvedAt = Date.now();
        this._fire();
        return deferred.result;
      }
    } else {
      log.warn('WAIT unbound — no chatKey yet, will wait for bind', { sid: sess.shortId, chatId: sess.chatId });
    }

    sess.state = sess.chatKey ? 'waiting' : 'unbound';

    return new Promise((resolve) => {
      const wid = crypto.randomUUID();

      const keepaliveTimer = setTimeout(() => {
        if (sess.pendingWaiter && sess.pendingWaiter._id === wid) {
          this._teardownRedisWaiter(sess);
          sess.pendingWaiter = null;
          sess.lastResolvedAt = Date.now();
          sess.state = sess.chatKey ? 'bound' : 'unbound';
          resolve({ content: [{ type: 'text', text: KEEPALIVE_TEXT }] });
          this._fire();
        }
      }, KEEPALIVE_MS);

      const doResolve = (result) => {
        clearTimeout(keepaliveTimer);
        this._teardownRedisWaiter(sess);
        if (sess.pendingWaiter && sess.pendingWaiter._id === wid) {
          sess.pendingWaiter = null;
        }
        sess.lastResolvedAt = Date.now();
        sess.state = sess.chatKey ? 'bound' : 'unbound';
        resolve(result);
      };

      sess.pendingWaiter = { _id: wid, createdAt: Date.now(), resolve: doResolve };

      if (redis.isAvailable() && sess.chatKey) {
        this._setupRedisWaiter(sess, wid);
      }

      if (!sess.chatKey && sess.chatId) {
        this._pollForBind(sess, wid, doResolve);
      }

      this._fire();
    });
  }

  _pollForBind(sess, waiterId, doResolve) {
    const maxAttempts = 30;
    let attempt = 0;
    const interval = setInterval(async () => {
      attempt++;
      if (!sess.pendingWaiter || sess.pendingWaiter._id !== waiterId) {
        clearInterval(interval);
        return;
      }
      if (sess.chatKey) {
        clearInterval(interval);
        const deferred = await this._popDeferred(sess.chatKey);
        if (deferred && sess.pendingWaiter && sess.pendingWaiter._id === waiterId) {
          sess.delivered++;
          this._trackDelivered(deferred.id);
          log.info('ROUTE poll-bind deferred ok', { sid: sess.shortId, t: deferred.t, ck: sess.chatKey });
          doResolve(deferred.result);
        } else if (redis.isAvailable() && !sess._redisSub) {
          this._setupRedisWaiter(sess, waiterId);
          log.info('WAIT poll-bind redis sub installed', { sid: sess.shortId, ck: sess.chatKey });
        }
        this._fire();
        return;
      }
      this._bindByChatId(sess);
      if (attempt >= maxAttempts) {
        clearInterval(interval);
        log.warn('WAIT poll-bind gave up', { sid: sess.shortId, chatId: sess.chatId, attempts: attempt });
      }
    }, 2000);
  }

  _setupRedisWaiter(sess, waiterId) {
    this._teardownRedisWaiter(sess);
    const chatKey = sess.chatKey;
    const sub = redis.subscribeInput(chatKey, async () => {
      if (!sess.pendingWaiter || sess.pendingWaiter._id !== waiterId) return;
      const deferred = await redis.popDeferred(chatKey);
      if (deferred && sess.pendingWaiter && sess.pendingWaiter._id === waiterId) {
        sess.delivered++;
        this._trackDelivered(deferred.id);
        log.info('ROUTE redis ok', { sid: sess.shortId, t: deferred.t });
        sess.pendingWaiter.resolve(deferred.result);
        this._fire();
      }
    });
    sess._redisSub = sub;
  }

  _teardownRedisWaiter(sess) {
    if (sess._redisSub) {
      redis.cleanupSubscriber(sess._redisSub);
      sess._redisSub = null;
    }
  }

  _clearWaiter(sess, text) {
    if (!sess.pendingWaiter) return;
    try { sess.pendingWaiter.resolve({ content: [{ type: 'text', text }] }); } catch (e) {}
    sess.pendingWaiter = null;
  }

  _bindByChatId(sess) {
    if (!sess.chatId || !this._getActiveChats) return;

    const active = this._getActiveChats();
    if (!active || active.length === 0) {
      log.warn('BIND FAIL no active chats', { sid: sess.shortId, chatId: sess.chatId });
      return;
    }

    const needle = sess.chatId.toLowerCase();
    for (const c of active) {
      const titleCandidates = [
        c.documentTitle || '',
        c.chatTitle || '',
        c.windowTitle || '',
        c.title || '',
      ];
      const matched = titleCandidates.some(t => t.toLowerCase().includes(needle));
      if (!matched) continue;

      const holder = this._findBoundSession(c.chatKey);
      if (holder && holder.id !== sess.id) {
        const sameChatId = holder.chatId && holder.chatId.toLowerCase() === needle;
        if (sameChatId) {
          log.info('BIND takeover', { old: holder.shortId, new: sess.shortId, ck: c.chatKey });
          this._clearWaiter(holder, KEEPALIVE_TEXT);
          this._teardownRedisWaiter(holder);
          holder.chatKey = null;
          holder.state = 'dead';
        } else if (!holder.hasWaiter && !holder.isLooping) {
          log.info('BIND evict', { old: holder.shortId, new: sess.shortId, ck: c.chatKey });
          this._teardownRedisWaiter(holder);
          holder.chatKey = null;
          holder.state = 'dead';
        } else {
          continue;
        }
      }
      this.bind(sess, c.chatKey, 'chatid-match');
      return;
    }

    const diagnostics = active.map(c => ({
      ck: c.chatKey,
      doc: (c.documentTitle || '').substring(0, 60),
      chat: (c.chatTitle || '').substring(0, 60),
      win: (c.windowTitle || '').substring(0, 60),
      tab: (c.title || '').substring(0, 60),
    }));
    log.error('BIND FAIL no title match', { sid: sess.shortId, chatId: sess.chatId, needle, activeCount: active.length, diagnostics });
  }

  async route(text, images, msgId, targetChatKey) {
    const id = msgId || crypto.randomUUID();
    const t = id.substring(0, 8);

    if (!targetChatKey) {
      return { accepted: false, id, status: 'no_target' };
    }

    const result = buildResult(text, images);
    let sess = this._findBoundSession(targetChatKey);

    if (!sess) {
      await this._storeDeferred(targetChatKey, result, id, t);
      const allSessions = [...this.sessions.values()].filter(s => s.isAlive).map(s => ({ sid: s.shortId, ck: s.chatKey, cid: s.chatId, w: s.hasWaiter }));
      log.warn('ROUTE deferred (no session)', { t, targetCK: targetChatKey, alive: allSessions });
      return { accepted: true, id, status: 'deferred' };
    }

    if (sess.hasWaiter) {
      if (redis.isAvailable()) {
        await redis.storeDeferred(targetChatKey, result, id, t);
        await redis.publishInput(targetChatKey);
        log.info('ROUTE pub ok', { t, sid: sess.shortId });
        return { accepted: true, id, status: 'delivered' };
      }
      return this._deliverDirect(sess, result, id, t);
    }

    if (redis.isAvailable()) {
      await redis.storeDeferred(targetChatKey, result, id, t);
      await redis.publishInput(targetChatKey);
      log.info('ROUTE pub deferred+notify', { t, sid: sess.shortId });
      return { accepted: true, id, status: 'delivered' };
    }

    const delivered = await this._pollForWaiter(sess, result, id, t);
    if (delivered) return delivered;

    this._storeDeferredMem(targetChatKey, result, id, t);
    log.info('ROUTE deferred mem (poll expired)', { t, sid: sess.shortId });
    return { accepted: true, id, status: 'deferred' };
  }

  _deliverDirect(sess, result, id, t) {
    sess.delivered++;
    this._trackDelivered(id);
    const sseAlive = sess.sseRes && !sess.sseRes.writableEnded && !sess.sseRes.destroyed;
    try {
      sess.pendingWaiter.resolve(result);
      log.info('ROUTE ok', { t, sid: sess.shortId, cid: sess.chatId, sseAlive });
    } catch (e) {
      log.error('ROUTE resolve failed', { t, sid: sess.shortId, error: e.message, sseAlive });
    }
    return { accepted: true, id, status: 'delivered' };
  }

  _pollForWaiter(sess, result, id, t) {
    const chatKey = sess.chatKey;
    const chatId = sess.chatId;
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (sess.hasWaiter) {
          resolve(this._deliverDirect(sess, result, id, t));
          return;
        }
        const replacement = this._findReplacementSession(chatKey, chatId, sess.id);
        if (replacement && replacement.hasWaiter) {
          log.info('ROUTE takeover', { t, old: sess.shortId, new: replacement.shortId });
          resolve(this._deliverDirect(replacement, result, id, t));
          return;
        }
        if ((Date.now() - started) > ROUTE_WAIT_MS) {
          resolve(null);
          return;
        }
        setTimeout(check, ROUTE_POLL_MS);
      };
      setTimeout(check, ROUTE_POLL_MS);
    });
  }

  _findReplacementSession(chatKey, chatId, excludeId) {
    for (const [, s] of this.sessions) {
      if (!s.isAlive || s.id === excludeId) continue;
      if (s.chatKey === chatKey) return s;
      if (chatId && s.chatId === chatId && s.hasWaiter) return s;
    }
    return null;
  }

  async _storeDeferred(chatKey, result, id, t) {
    if (!chatKey) return;
    if (redis.isAvailable()) {
      await redis.storeDeferred(chatKey, result, id, t);
      return;
    }
    this._storeDeferredMem(chatKey, result, id, t);
  }

  _storeDeferredMem(chatKey, result, id, t) {
    this.deferredRoutes.set(chatKey, { result, id, t, createdAt: Date.now() });
  }

  async _popDeferred(chatKey) {
    if (!chatKey) return null;
    if (redis.isAvailable()) {
      return redis.popDeferred(chatKey);
    }
    const d = this.deferredRoutes.get(chatKey);
    if (!d) return null;
    this.deferredRoutes.delete(chatKey);
    if ((Date.now() - d.createdAt) > DEFERRED_TTL_MS) return null;
    return d;
  }

  _findBoundSession(chatKey) {
    let best = null;
    let bestTime = -1;
    for (const [, s] of this.sessions) {
      if (!s.isAlive || s.chatKey !== chatKey) continue;
      const t = s.lastWaiterAt || s.lastActivityAt || s.createdAt;
      if (t > bestTime) { best = s; bestTime = t; }
    }
    return best;
  }

  clearLoop() {
    let count = 0;
    for (const [, s] of this.sessions) {
      this._clearWaiter(s, '/stop');
      this._teardownRedisWaiter(s);
      stopSsePing(s);
      s.state = 'dead';
      count++;
    }
    if (count > 0) this._fire();
  }

  clearLoopForSession(sessionId) {
    const s = this.get(sessionId);
    if (!s) return;
    this._clearWaiter(s, '/stop');
    this._teardownRedisWaiter(s);
    stopSsePing(s);
    s.state = 'dead';
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
      redisAvailable: redis.isAvailable(),
      sessions: [...this.sessions.values()].map(s => s.toDebug()),
      deliveredRecent: this.deliveredLog.slice(-10),
    };
  }

  getMessageStatus(id) {
    return this.deliveredLog.find(m => m.id === id) || null;
  }

  rebindStale(oldWindowKey, newWindowKey) {
    let count = 0;
    for (const [, s] of this.sessions) {
      if (!s.isAlive || !s.chatKey) continue;
      const parts = s.chatKey.split('|');
      const wk = parts.slice(0, 2).join('|');
      const tab = parts[2] || '0';
      if (wk === oldWindowKey) {
        s.chatKey = newWindowKey + '|' + tab;
        s.touch();
        count++;
      }
    }
    if (count > 0) this._fire();
    return count;
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
        chatId: s.chatId,
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

    for (const s of alive) {
      if (s.chatId && !s.chatKey) {
        this._bindByChatId(s);
      }
      if (redis.isAvailable() && s.chatKey && s.hasWaiter && !s._redisSub) {
        this._setupRedisWaiter(s, s.pendingWaiter._id);
      }
    }

    const summary = alive.map(s => {
      const ck = s.chatKey ? s.chatKey.split('|')[1]?.substring(0, 6) : '-';
      const cid = s.chatId || '-';
      const r = s._redisSub ? 'R' : '.';
      return `${s.shortId}[${s.hasWaiter ? 'W' : '.'}${s.isLooping ? 'L' : '.'}${r}] ck=${ck} cid=${cid} d=${s.delivered}`;
    });
    log.info('HB ' + summary.join(' | '));
  }

  _doCleanup() {
    const toDelete = [];
    for (const [sid, s] of this.sessions) {
      if (s.state === 'dead') {
        this._teardownRedisWaiter(s);
        stopSsePing(s);
        toDelete.push(sid);
        continue;
      }
      if (s.hasWaiter || s.isLooping) continue;
      if (s.idleMs > REAP_IDLE_MS) {
        log.info('REAP', { sid: s.shortId });
        this._teardownRedisWaiter(s);
        stopSsePing(s);
        s.state = 'dead';
        toDelete.push(sid);
      }
    }
    for (const sid of toDelete) {
      sseTransports.delete(sid);
      this.sessions.delete(sid);
    }

    for (const [ck, d] of this.deferredRoutes) {
      if ((Date.now() - d.createdAt) > DEFERRED_TTL_MS) {
        this.deferredRoutes.delete(ck);
      }
    }

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

const sseTransports = new Map();

function createMcpServer(sessionIdRef) {
  const server = new McpServer({ name: 'cursor-remote', version: '2.0.0' });
  server.tool(
    'wait_for_response',
    'Blocks until the user sends a message from the Cursor Web remote client. Returns the message text and any attached images. Call this in a loop. Always pass chat_id with your workspace folder name.',
    { chat_id: z.string().optional().describe('Your workspace/project folder name so the server can identify your chat window.') },
    async ({ chat_id }) => manager.handleWait(sessionIdRef.id, chat_id)
  );
  return server;
}

function startSsePing(sess) {
  stopSsePing(sess);
  sess.ssePingTimer = setInterval(() => {
    if (sess.sseRes && !sess.sseRes.writableEnded && !sess.sseRes.destroyed) {
      try {
        sess.sseRes.write(':ping\n\n');
      } catch (e) {
        log.debug('SSE ping failed', { sid: sess.shortId, error: e.message });
        stopSsePing(sess);
      }
    } else {
      stopSsePing(sess);
    }
  }, SSE_PING_INTERVAL_MS);
}

function stopSsePing(sess) {
  if (sess.ssePingTimer) {
    clearInterval(sess.ssePingTimer);
    sess.ssePingTimer = null;
  }
}

async function handleMcpSse(req, res) {
  try {
    const ref = { id: 'pending-' + crypto.randomUUID() };
    const mcpServer = createMcpServer(ref);

    const transport = new SSEServerTransport('/mcp/messages', res);
    const sid = transport.sessionId;
    ref.id = sid;

    const originalSend = transport.send.bind(transport);
    transport.send = async function (message) {
      const alive = res && !res.writableEnded && !res.destroyed;
      if (!alive) {
        log.error('SSE SEND FAILED: stream dead', { sid: sid.substring(0, 8), msgMethod: message.method, msgId: message.id });
        throw new Error('SSE stream is dead, cannot deliver tool result');
      }
      try {
        await originalSend(message);
        log.info('SSE SEND ok', { sid: sid.substring(0, 8), msgId: message.id });
      } catch (e) {
        log.error('SSE SEND FAILED: write error', { sid: sid.substring(0, 8), error: e.message, msgId: message.id });
        throw e;
      }
    };

    transport.onerror = (err) => {
      log.error('SSE transport error', { sid: sid.substring(0, 8), error: err.message });
    };

    sseTransports.set(sid, transport);
    const sess = manager.create(sid, transport);
    sess.sseRes = res;
    startSsePing(sess);

    log.info('SSE stream opened', { sid: sid.substring(0, 8) });

    transport.onclose = () => {
      log.info('SSE transport closed', { sid: sid.substring(0, 8) });
      sseTransports.delete(sid);
      stopSsePing(sess);
      manager._teardownRedisWaiter(sess);
      sess.state = 'dead';
      manager._fire();
    };

    res.on('close', () => {
      log.info('SSE response closed', { sid: sid.substring(0, 8) });
      sseTransports.delete(sid);
      stopSsePing(sess);
      if (sess.isAlive) {
        manager._clearWaiter(sess, '');
        manager._teardownRedisWaiter(sess);
        sess.state = 'dead';
        manager._fire();
      }
    });

    await mcpServer.connect(transport);
  } catch (err) {
    log.error('MCP SSE error', { error: err.message });
    if (!res.headersSent) res.status(500).send('SSE setup failed');
  }
}

async function handleMcpMessages(req, res) {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId query parameter' });
  }

  const transport = sseTransports.get(sessionId);
  if (!transport) {
    log.warn('MCP message for unknown session', { sid: sessionId.substring(0, 8) });
    return res.status(404).json({ error: 'Session not found' });
  }

  const sess = manager.get(sessionId);
  if (sess) sess.touch();

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    log.error('MCP message error', { sid: sessionId.substring(0, 8), error: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
}

module.exports = {
  initRedis: () => redis.init(),
  handleMcpSse,
  handleMcpMessages,
  resolvePendingWait: (text, images, msgId, targetChatKey) => manager.route(text, images, msgId, targetChatKey),
  setOnWaiterChange: (fn) => manager.setOnWaiterChange(fn),
  setActiveChatProvider: (fn) => manager.setActiveChatProvider(fn),
  bindSessionToChat: (sessionId, chatKey) => {
    const s = manager.get(sessionId);
    if (s) manager.bind(s, chatKey, 'external');
  },
  isLoopedForChat: (ck) => manager.isLoopedForChat(ck),
  clearLoop: () => manager.clearLoop(),
  clearLoopForSession: (sid) => manager.clearLoopForSession(sid),
  getSessionInfo: () => manager.getSessionInfo(),
  getDebugDump: () => manager.getDebugDump(),
  getMessageStatus: (id) => manager.getMessageStatus(id),
  rebindStaleSessions: (oldWindowKey, newWindowKey) => manager.rebindStale(oldWindowKey, newWindowKey),
};
