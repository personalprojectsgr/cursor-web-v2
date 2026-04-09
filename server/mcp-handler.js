const crypto = require('node:crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { createLogger } = require('./logger');

const log = createLogger('mcp');

const KEEPALIVE_MS = 240_000;
const KEEPALIVE_TEXT = '[keepalive] No user message received. Call wait_for_response again to continue waiting.';
const REBIND_INTERVAL_MS = 10_000;
const REAP_UNBOUND_MS = 600_000;
const REAP_IDLE_MS = 1_800_000;
const CLEANUP_INTERVAL_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 120_000;
const STALE_WAITER_MS = 300_000;
const MAX_QUEUE = 10;
const MAX_DELIVERED = 200;

class Session {
  constructor(id) {
    this.id = id;
    this.shortId = id.substring(0, 8);
    this.chatKey = null;
    this.chatId = null;
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
  }

  get isAlive() { return this.state !== 'dead'; }
  get isLooping() { return this.waiterCount > 0 && this.isAlive; }
  get hasWaiter() { return this.pendingWaiter !== null; }

  get idleSinceMs() {
    return Date.now() - (this.lastResolvedAt || this.lastWaiterAt || this.lastActivityAt);
  }

  touch() { this.lastActivityAt = Date.now(); }

  toDebug() {
    return {
      id: this.shortId, state: this.state, chatKey: this.chatKey, chatId: this.chatId,
      hasWaiter: this.hasWaiter, waiterCount: this.waiterCount,
      delivered: this.delivered, queued: this.pendingMessages.length,
      idleSinceMs: this.idleSinceMs, ageMs: Date.now() - this.createdAt,
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
    this._rebinder = setInterval(() => this._doRebindUnbound(), REBIND_INTERVAL_MS);
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
    log.info('BIND', { sid: sess.shortId, ck: chatKey, reason });
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

    if (chatId && !sess.chatId) {
      sess.chatId = chatId;
      log.info('WAIT chatId set', { sid: sess.shortId, chatId });
    }

    if (!sess.chatKey) this._tryAutoBind(sess);

    if (sess.pendingMessages.length > 0) {
      const queued = sess.pendingMessages.shift();
      sess.delivered++;
      sess.lastResolvedAt = Date.now();
      sess.state = sess.chatKey ? 'bound' : 'unbound';
      log.info('WAIT drain', { sid: sess.shortId, ck: sess.chatKey, q: sess.pendingMessages.length });
      this._fire();
      return Promise.resolve(queued);
    }

    if (sess.pendingWaiter) {
      log.warn('WAIT overwrite', { sid: sess.shortId });
      this._clearWaiter(sess, '');
    }

    sess.state = 'waiting';
    log.info('WAIT open', { sid: sess.shortId, ck: sess.chatKey, n: sess.waiterCount });

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

  route(text, images, msgId, targetChatKey) {
    const id = msgId || crypto.randomUUID();
    const t = id.substring(0, 8);

    if (!targetChatKey) {
      log.warn('ROUTE no target', { t });
      return { accepted: false, id, status: 'no_target' };
    }

    const allAlive = [...this.sessions.values()].filter(s => s.isAlive);
    log.info('ROUTE pipeline', {
      t,
      target: targetChatKey.split('|').slice(1).join('|').substring(0, 15),
      sessions: allAlive.map(s => ({
        sid: s.shortId,
        ck: s.chatKey ? s.chatKey.split('|').slice(1).join('|').substring(0, 12) : '-',
        w: s.hasWaiter,
        d: s.delivered,
      })),
    });

    let sess = this._findSession(targetChatKey);
    if (!sess) {
      sess = this._findUnbound();
      if (sess) {
        log.info('ROUTE late-bind', { t, sid: sess.shortId, target: targetChatKey.split('|').slice(1).join('|').substring(0, 15) });
        this.bind(sess, targetChatKey, 'late-bind-route');
      } else {
        log.warn('ROUTE no session', { t, ck: targetChatKey });
        return { accepted: false, id, status: 'no_session' };
      }
    }

    if (sess.chatKey !== targetChatKey) {
      log.error('ROUTE isolation', { t, want: targetChatKey, got: sess.chatKey });
      return { accepted: false, id, status: 'isolation_mismatch' };
    }

    const result = buildResult(text, images);

    if (sess.hasWaiter) {
      sess.delivered++;
      this._trackDelivered(id);
      const age = Date.now() - sess.pendingWaiter.createdAt;
      sess.pendingWaiter.resolve(result);
      log.info('ROUTE ok', { t, sid: sess.shortId, ck: sess.chatKey, age: Math.round(age / 1000) });
      return { accepted: true, id, status: 'delivered' };
    }

    if (sess.pendingMessages.length >= MAX_QUEUE) {
      log.warn('ROUTE full', { t, sid: sess.shortId });
      return { accepted: false, id, status: 'queue_full' };
    }

    sess.pendingMessages.push(result);
    this._trackDelivered(id);
    log.info('ROUTE queued', { t, sid: sess.shortId, q: sess.pendingMessages.length });
    return { accepted: true, id, status: 'queued' };
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

  _findSession(chatKey) {
    let best = null;
    let bestTime = -1;
    for (const [, s] of this.sessions) {
      if (!s.isAlive || s.chatKey !== chatKey) continue;
      const t = s.lastWaiterAt || s.lastActivityAt || s.createdAt;
      if (t > bestTime) { best = s; bestTime = t; }
    }
    return best;
  }

  _findUnbound() {
    let bestWaiter = null;
    let bestOther = null;
    for (const [, s] of this.sessions) {
      if (!s.isAlive || s.chatKey) continue;
      if (s.hasWaiter || s.waiterCount > 0) {
        if (!bestWaiter || (s.lastWaiterAt > bestWaiter.lastWaiterAt)) bestWaiter = s;
      } else {
        if (!bestOther || (s.createdAt > bestOther.createdAt)) bestOther = s;
      }
    }
    return bestWaiter || bestOther;
  }

  _matchChatIdToWindow(chatId, activeChats, taken) {
    if (!chatId) return null;
    const needle = chatId.toLowerCase();
    for (const c of activeChats) {
      if (taken.has(c.chatKey)) continue;
      const dt = (c.documentTitle || '').toLowerCase();
      if (dt.includes(needle)) return c;
    }
    return null;
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

    const isMcpActive = (c) =>
      c.activeMcp && c.activeMcp.toolName && /wait.for.response/i.test(c.activeMcp.toolName);

    const cdpSummary = active.map(c => ({
      ck: c.chatKey.split('|').slice(1).join('|').substring(0, 12),
      title: (c.title || '').substring(0, 30),
      docTitle: (c.documentTitle || '').substring(0, 40),
      mcp: c.activeMcp ? c.activeMcp.toolName + '@' + c.activeMcp.serverName : 'none',
      taken: taken.has(c.chatKey),
    }));
    log.info('AUTOBIND attempt', { sid: sess.shortId, chatId: sess.chatId, chats: cdpSummary });

    if (sess.chatId) {
      const chatIdMatch = this._matchChatIdToWindow(sess.chatId, active, taken);
      if (chatIdMatch) {
        this.bind(sess, chatIdMatch.chatKey, 'auto-bind-chatid');
        return;
      }
      log.info('AUTOBIND chatId no match', { sid: sess.shortId, chatId: sess.chatId });
    }

    const mcpMatch = active.find(c => !taken.has(c.chatKey) && isMcpActive(c));
    if (mcpMatch) {
      this.bind(sess, mcpMatch.chatKey, 'auto-bind-mcp');
      return;
    }

    const available = active.filter(c => !taken.has(c.chatKey));
    if (available.length === 1) {
      this.bind(sess, available[0].chatKey, 'auto-bind-only');
    } else {
      log.info('AUTOBIND deferred', { sid: sess.shortId, available: available.length, reason: 'ambiguous-no-cdp' });
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

  _doRebindUnbound() {
    if (!this._getActiveChats) return;

    const active = this._getActiveChats();
    if (!active || active.length === 0) return;

    const isMcpActive = (c) =>
      c.activeMcp && c.activeMcp.toolName && /wait.for.response/i.test(c.activeMcp.toolName);

    const aliveSessions = [...this.sessions.values()].filter(s => s.isAlive);
    const unbound = aliveSessions.filter(s => !s.chatKey);

    const mcpWindows = active.filter(isMcpActive);

    const unboundWithChatId = unbound.filter(s => s.chatId);
    const needsWork = unbound.length > 0 || mcpWindows.some(c => {
      const boundSess = aliveSessions.find(s => s.chatKey === c.chatKey);
      return !boundSess;
    });

    if (needsWork) {
      log.info('REBIND scan', {
        unbound: unbound.map(s => ({ sid: s.shortId, chatId: s.chatId })),
        alive: aliveSessions.length,
        mcpWindows: mcpWindows.map(c => ({
          ck: c.chatKey.split('|').slice(1).join('|').substring(0, 12),
          docTitle: (c.documentTitle || '').substring(0, 40),
        })),
        boundTo: aliveSessions.filter(s => s.chatKey).map(s => ({
          sid: s.shortId,
          chatId: s.chatId,
          ck: s.chatKey.split('|').slice(1).join('|').substring(0, 12),
        })),
      });
    }

    if (unbound.length === 0 && unboundWithChatId.length === 0 && !needsWork) return;

    const taken = new Set();
    for (const s of aliveSessions) {
      if (s.chatKey) taken.add(s.chatKey);
    }

    for (const s of aliveSessions) {
      if (s.chatKey) continue;
      if (!s.chatId) continue;
      const match = this._matchChatIdToWindow(s.chatId, active, taken);
      if (match) {
        this.bind(s, match.chatKey, 'rebind-chatid');
        taken.add(match.chatKey);
        const idx = unbound.indexOf(s);
        if (idx >= 0) unbound.splice(idx, 1);
      }
    }

    const sessionByChatKey = new Map();
    for (const s of aliveSessions) {
      if (s.chatKey) sessionByChatKey.set(s.chatKey, s);
    }

    for (const s of aliveSessions) {
      if (!s.chatKey || !s.chatId) continue;
      const dt = (active.find(c => c.chatKey === s.chatKey)?.documentTitle || '').toLowerCase();
      if (dt && !dt.includes(s.chatId.toLowerCase())) {
        const correctChat = this._matchChatIdToWindow(s.chatId, active, taken);
        if (correctChat) {
          log.warn('REBIND chatId mismatch', {
            sid: s.shortId,
            chatId: s.chatId,
            wasBound: s.chatKey.split('|').slice(1).join('|').substring(0, 12),
            shouldBe: correctChat.chatKey.split('|').slice(1).join('|').substring(0, 12),
          });
          taken.delete(s.chatKey);
          sessionByChatKey.delete(s.chatKey);
          s.chatKey = null;
          s.state = 'unbound';
          this.bind(s, correctChat.chatKey, 'rebind-chatid-fix');
          taken.add(correctChat.chatKey);
        }
      }
    }

    const mcpChatKeys = new Set(mcpWindows.map(c => c.chatKey));

    for (const s of aliveSessions) {
      if (!s.chatKey) continue;
      if (mcpChatKeys.has(s.chatKey)) continue;

      const hasUnboundWithMcp = unbound.length > 0 && mcpWindows.some(c => !taken.has(c.chatKey));
      if (!hasUnboundWithMcp) continue;

      const correctChat = mcpWindows.find(c => !taken.has(c.chatKey));
      if (correctChat) {
        log.warn('REBIND mcp mismatch', {
          sid: s.shortId,
          wasBound: s.chatKey.split('|').slice(1).join('|').substring(0, 12),
          shouldBe: correctChat.chatKey.split('|').slice(1).join('|').substring(0, 12),
        });
        taken.delete(s.chatKey);
        sessionByChatKey.delete(s.chatKey);
        s.chatKey = null;
        s.state = 'unbound';
        unbound.push(s);
      }
    }

    for (const chat of mcpWindows) {
      if (taken.has(chat.chatKey)) continue;
      const waiterIdx = unbound.findIndex(s => s.hasWaiter || s.waiterCount > 0);
      const idx = waiterIdx >= 0 ? waiterIdx : 0;
      if (idx >= unbound.length) break;
      const sess = unbound.splice(idx, 1)[0];
      this.bind(sess, chat.chatKey, 'rebind-cdp');
      taken.add(chat.chatKey);
    }
  }

  _doHeartbeat() {
    const alive = [...this.sessions.values()].filter(s => s.isAlive);
    if (alive.length === 0) return;
    const now = Date.now();
    const summary = alive.map(s => {
      const ck = s.chatKey ? s.chatKey.split('|').pop() + ':' + s.chatKey.split('|')[1]?.substring(0, 6) : '-';
      const cid = s.chatId ? s.chatId.substring(0, 15) : '-';
      return `${s.shortId}[${s.state[0]}${s.hasWaiter ? 'W' : '.'}] ck=${ck} cid=${cid} d=${s.delivered} q=${s.pendingMessages.length} ${Math.round(s.idleSinceMs / 1000)}s`;
    });
    log.info('HB ' + summary.join(' | '));

    for (const s of alive) {
      if (!s.chatKey || s.hasWaiter) continue;
      const sinceLast = now - (s.lastResolvedAt || s.lastWaiterAt || s.createdAt);
      if (sinceLast > STALE_WAITER_MS && s.waiterCount > 0) {
        log.warn('STALE agent loop dead', {
          sid: s.shortId,
          chatId: s.chatId,
          ck: s.chatKey.split('|').slice(1).join('|').substring(0, 12),
          lastWait: Math.round(sinceLast / 1000) + 's ago',
          queued: s.pendingMessages.length,
        });
      }
    }
  }

  _doCleanup() {
    const toDelete = [];
    for (const [sid, s] of this.sessions) {
      if (s.state === 'dead') { toDelete.push(sid); continue; }
      if (s.hasWaiter || s.isLooping) continue;
      if (!s.chatKey && s.idleSinceMs > REAP_UNBOUND_MS) {
        log.info('REAP unbound', { sid: s.shortId });
        s.state = 'dead';
        toDelete.push(sid);
        continue;
      }
      if (s.idleSinceMs > REAP_IDLE_MS) {
        log.info('REAP idle', { sid: s.shortId, ck: s.chatKey });
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
  autoBindUnboundSessions: (chatKey) => manager.autoBindUnbound(chatKey),
  isLoopedForChat: (ck) => manager.isLoopedForChat(ck),
  clearLoop: () => manager.clearLoop(),
  clearLoopForSession: (sid) => manager.clearLoopForSession(sid),
  getSessionInfo: () => manager.getSessionInfo(),
  getDebugDump: () => manager.getDebugDump(),
  getMessageStatus: (id) => manager.getMessageStatus(id),
  rebindStaleSessions: (oldWindowKey, newWindowKey) => manager.rebindStale(oldWindowKey, newWindowKey),
};
