const crypto = require('node:crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { createLogger } = require('./logger');

const log = createLogger('mcp');

const KEEPALIVE_MS = 240_000;
const KEEPALIVE_TEXT = '[keepalive] No user message received. Call wait_for_response again to continue waiting.';
const ROUTE_WAIT_MS = 30_000;
const ROUTE_POLL_MS = 500;
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
    this.pendingWaiter = null;
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

const DEFERRED_TTL_MS = 120_000;

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

  handleWait(sessionId, chatId) {
    const sess = this.get(sessionId);
    if (!sess) {
      log.error('WAIT unknown', { sid: sessionId?.substring(0, 8) });
      return Promise.resolve({ content: [{ type: 'text', text: '' }] });
    }

    sess.waiterCount++;
    sess.lastWaiterAt = Date.now();
    sess.touch();

    if (chatId) {
      if (!sess.chatId) {
        sess.chatId = chatId;
        log.info('WAIT chatId set', { sid: sess.shortId, chatId });
      }
      if (!sess.chatKey) {
        this._bindByChatId(sess);
      }
    }

    if (sess.pendingWaiter) {
      log.warn('WAIT overwrite', { sid: sess.shortId });
      this._clearWaiter(sess, '');
    }

    const deferred = sess.chatKey ? this._popDeferred(sess.chatKey) : null;
    if (deferred) {
      log.info('WAIT deferred delivery', { sid: sess.shortId, t: deferred.t, age: Math.round((Date.now() - deferred.createdAt) / 1000) + 's' });
      sess.delivered++;
      this._trackDelivered(deferred.id);
      sess.state = sess.chatKey ? 'bound' : 'unbound';
      sess.lastResolvedAt = Date.now();
      this._fire();
      return Promise.resolve(deferred.result);
    }

    sess.state = sess.chatKey ? 'waiting' : 'unbound';
    log.info('WAIT open', { sid: sess.shortId, ck: sess.chatKey, cid: sess.chatId, n: sess.waiterCount });

    return new Promise((resolve) => {
      const wid = crypto.randomUUID();

      const keepaliveTimer = setTimeout(() => {
        if (sess.pendingWaiter && sess.pendingWaiter._id === wid) {
          log.info('WAIT keepalive', { sid: sess.shortId, ck: sess.chatKey });
          sess.pendingWaiter = null;
          sess.lastResolvedAt = Date.now();
          sess.state = sess.chatKey ? 'bound' : 'unbound';
          resolve({ content: [{ type: 'text', text: KEEPALIVE_TEXT }] });
          this._fire();
        }
      }, KEEPALIVE_MS);

      sess.pendingWaiter = {
        _id: wid,
        createdAt: Date.now(),
        resolve: (result) => {
          clearTimeout(keepaliveTimer);
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
  }

  _bindByChatId(sess) {
    if (!sess.chatId || !this._getActiveChats) return;

    const active = this._getActiveChats();
    if (!active || active.length === 0) return;

    const needle = sess.chatId.toLowerCase();
    for (const c of active) {
      const dt = (c.documentTitle || '').toLowerCase();
      if (!dt.includes(needle)) continue;

      const holder = this._findBoundSession(c.chatKey);
      if (holder && holder.id !== sess.id) {
        const sameChatId = holder.chatId && holder.chatId.toLowerCase() === needle;
        if (sameChatId) {
          log.info('BIND takeover', { old: holder.shortId, new: sess.shortId, ck: c.chatKey, oldHadWaiter: holder.hasWaiter });
          this._clearWaiter(holder, KEEPALIVE_TEXT);
          holder.chatKey = null;
          holder.state = 'dead';
        } else if (!holder.hasWaiter && !holder.isLooping) {
          log.info('BIND evict stale', { old: holder.shortId, new: sess.shortId, ck: c.chatKey });
          holder.chatKey = null;
          holder.state = 'dead';
        } else {
          log.info('BIND blocked by different chat', { sid: sess.shortId, holder: holder.shortId, holderCid: holder.chatId, ck: c.chatKey });
          continue;
        }
      }
      this.bind(sess, c.chatKey, 'chatid-match');
      return;
    }

    log.info('BIND chatId no match', { sid: sess.shortId, chatId: sess.chatId,
      active: active.map(c => {
        const bound = this._findBoundSession(c.chatKey);
        return { dt: (c.documentTitle || '').substring(0, 50), bound: bound ? bound.shortId : null, boundCid: bound ? bound.chatId : null };
      })
    });
  }

  async route(text, images, msgId, targetChatKey) {
    const id = msgId || crypto.randomUUID();
    const t = id.substring(0, 8);

    if (!targetChatKey) {
      log.warn('ROUTE no target', { t });
      return { accepted: false, id, status: 'no_target' };
    }

    const result = buildResult(text, images);
    let sess = this._findBoundSession(targetChatKey);

    if (!sess) {
      log.info('ROUTE no bound session', { t, target: targetChatKey.split('|').slice(1).join('|').substring(0, 15) });
      this._storeDeferred(targetChatKey, result, id, t);
      return { accepted: true, id, status: 'deferred' };
    }

    log.info('ROUTE', { t, sid: sess.shortId, cid: sess.chatId, w: sess.hasWaiter, loop: sess.isLooping });

    if (sess.hasWaiter) {
      return this._deliver(sess, result, id, t);
    }

    log.info('ROUTE waiting for agent callback', { t, sid: sess.shortId });
    const delivered = await this._pollForWaiter(sess, result, id, t);
    if (delivered) return delivered;

    log.info('ROUTE deferred for next session', { t, sid: sess.shortId, idle: Math.round(sess.idleMs / 1000) + 's' });
    this._storeDeferred(targetChatKey, result, id, t);
    return { accepted: true, id, status: 'deferred' };
  }

  _deliver(sess, result, id, t) {
    sess.delivered++;
    this._trackDelivered(id);
    const age = Date.now() - sess.pendingWaiter.createdAt;
    sess.pendingWaiter.resolve(result);
    log.info('ROUTE ok', { t, sid: sess.shortId, cid: sess.chatId, age: Math.round(age / 1000) + 's' });
    return { accepted: true, id, status: 'delivered' };
  }

  _pollForWaiter(sess, result, id, t) {
    const chatKey = sess.chatKey;
    const chatId = sess.chatId;
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (sess.hasWaiter) {
          log.info('ROUTE agent returned', { t, sid: sess.shortId, waited: Math.round((Date.now() - started) / 1000) + 's' });
          resolve(this._deliver(sess, result, id, t));
          return;
        }

        const replacement = this._findReplacementSession(chatKey, chatId, sess.id);
        if (replacement && replacement.hasWaiter) {
          log.info('ROUTE new session took over', { t, old: sess.shortId, new: replacement.shortId, waited: Math.round((Date.now() - started) / 1000) + 's' });
          resolve(this._deliver(replacement, result, id, t));
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

  _storeDeferred(chatKey, result, id, t) {
    this.deferredRoutes.set(chatKey, { result, id, t, createdAt: Date.now() });
    log.info('DEFERRED stored', { t, ck: chatKey.split('|')[1]?.substring(0, 6) });
  }

  _popDeferred(chatKey) {
    const d = this.deferredRoutes.get(chatKey);
    if (!d) return null;
    this.deferredRoutes.delete(chatKey);
    if ((Date.now() - d.createdAt) > DEFERRED_TTL_MS) {
      log.warn('DEFERRED expired', { t: d.t, age: Math.round((Date.now() - d.createdAt) / 1000) + 's' });
      return null;
    }
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

  rebindStale(oldWindowKey, newWindowKey) {
    let count = 0;
    for (const [, s] of this.sessions) {
      if (!s.isAlive || !s.chatKey) continue;
      const parts = s.chatKey.split('|');
      const wk = parts.slice(0, 2).join('|');
      const tab = parts[2] || '0';
      if (wk === oldWindowKey) {
        const newCK = newWindowKey + '|' + tab;
        log.info('REBIND stale', { sid: s.shortId, from: s.chatKey.substring(0, 20), to: newCK.substring(0, 20) });
        s.chatKey = newCK;
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
    const summary = alive.map(s => {
      const ck = s.chatKey ? s.chatKey.split('|')[1]?.substring(0, 6) : '-';
      const cid = s.chatId ? s.chatId.substring(0, 15) : '-';
      const age = Math.round((Date.now() - s.createdAt) / 1000);
      return `${s.shortId}[${s.hasWaiter ? 'W' : '.'}${s.isLooping ? 'L' : '.'}] ck=${ck} cid=${cid} d=${s.delivered} idle=${Math.round(s.idleMs / 1000)}s age=${age}s`;
    });
    const deferredInfo = this.deferredRoutes.size > 0 ? ` [deferred=${this.deferredRoutes.size}]` : '';
    log.info('HB ' + summary.join(' | ') + deferredInfo);

    const cidMap = {};
    for (const s of alive) {
      if (!s.chatId) continue;
      if (!cidMap[s.chatId]) cidMap[s.chatId] = [];
      cidMap[s.chatId].push(s.shortId);
    }
    for (const [cid, sids] of Object.entries(cidMap)) {
      if (sids.length > 1) {
        log.warn('HB duplicate chatId', { chatId: cid, sessions: sids });
      }
    }
  }

  _doCleanup() {
    const toDelete = [];
    for (const [sid, s] of this.sessions) {
      if (s.state === 'dead') { toDelete.push(sid); continue; }
      if (s.hasWaiter || s.isLooping) continue;
      if (s.idleMs > REAP_IDLE_MS) {
        log.info('REAP', { sid: s.shortId, ck: s.chatKey, cid: s.chatId, idle: Math.round(s.idleMs / 1000) + 's', age: Math.round((Date.now() - s.createdAt) / 1000) + 's' });
        s.state = 'dead';
        toDelete.push(sid);
      }
    }
    for (const sid of toDelete) this.sessions.delete(sid);

    for (const [ck, d] of this.deferredRoutes) {
      if ((Date.now() - d.createdAt) > DEFERRED_TTL_MS) {
        log.warn('DEFERRED expired cleanup', { t: d.t, ck: ck.split('|')[1]?.substring(0, 6) });
        this.deferredRoutes.delete(ck);
      }
    }

    if (toDelete.length > 0) {
      log.info('CLEANUP', { deleted: toDelete.length, remaining: this.sessions.size, deferred: this.deferredRoutes.size });
      this._fire();
    }
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
    'Blocks until the user sends a message from the Cursor Web remote client. Returns the message text and any attached images. Call this in a loop -- it stays open until a message arrives or returns a keepalive after 4 minutes. IMPORTANT: Always pass chat_id with your workspace/project folder name so the server knows which chat window you are.',
    { chat_id: z.string().optional().describe('The workspace or project folder name (e.g. "my-project"). Pass this every time so the server can identify your chat window.') },
    async ({ chat_id }) => manager.handleWait(sessionIdRef.id, chat_id)
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
          manager.create(sid, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId || ref.id;
        const sess = manager.get(sid);
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
  isLoopedForChat: (ck) => manager.isLoopedForChat(ck),
  clearLoop: () => manager.clearLoop(),
  clearLoopForSession: (sid) => manager.clearLoopForSession(sid),
  getSessionInfo: () => manager.getSessionInfo(),
  getDebugDump: () => manager.getDebugDump(),
  getMessageStatus: (id) => manager.getMessageStatus(id),
  rebindStaleSessions: (oldWindowKey, newWindowKey) => manager.rebindStale(oldWindowKey, newWindowKey),
};
