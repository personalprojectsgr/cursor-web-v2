const { createLogger } = require('./logger');
const {
  resolvePendingWait,
  setOnWaiterChange,
  setActiveWindowsProvider,
  getMessageStatus,
  clearLoop,
  bindSessionToWindow,
  getSessionInfo,
  autoBindUnboundSessions,
  getDebugDump,
} = require('./mcp-handler');
const log = createLogger('rooms');

class RoomManager {
  constructor() {
    this.extensionSockets = new Map();
    this.cachedStates = new Map();
    this.windowMeta = new Map();
    this.phoneSockets = new Map();
    this.stats = { stateUpdates: 0, commandsSent: 0, commandsCompleted: 0 };
    this.mcpWaiting = false;
    this.mcpLoopActive = false;
    this.mcpPerSession = {};

    setOnWaiterChange((status) => {
      this.mcpWaiting = status.waiting;
      this.mcpLoopActive = status.loopActive;
      this.mcpPerSession = status.perSession || {};
      log.info('MCP state changed', {
        waiting: status.waiting,
        loopActive: status.loopActive,
        sessionCount: Object.keys(this.mcpPerSession).length,
      });
      this.broadcastMcpStatus();
    });

    setActiveWindowsProvider(() => {
      const activeStatuses = ['thinking', 'generating', 'streaming', 'running_tool'];
      const result = [];
      for (const [key, state] of this.cachedStates) {
        if (state && activeStatuses.includes(state.agentStatus)) {
          result.push(key);
        }
      }
      return result;
    });
  }

  broadcastMcpStatus() {
    const payload = {
      waiting: this.mcpWaiting,
      loopActive: this.mcpLoopActive,
      perSession: this.mcpPerSession,
    };
    for (const [id, phoneSock] of this.phoneSockets) {
      phoneSock.emit('mcp:status', payload);
    }
  }

  registerExtension(socket) {
    const windowKey = socket.handshake.auth.windowKey || 'default';

    const existing = this.extensionSockets.get(windowKey);
    if (existing && existing.id !== socket.id) {
      log.warn('Replacing extension for window', { windowKey, oldId: existing.id, newId: socket.id });
      existing.disconnect(true);
    }

    this.extensionSockets.set(windowKey, socket);
    this.windowMeta.set(windowKey, { windowKey, title: windowKey.split('|')[0] || 'Cursor', connected: true });
    log.info('Extension registered', { socketId: socket.id, windowKey, totalExtensions: this.extensionSockets.size });

    socket.on('ext:state', (state) => {
      this.cachedStates.set(windowKey, state);
      this.stats.stateUpdates++;
      const msgCount = state?.messages?.length ?? 0;
      const status = state?.agentStatus ?? 'unknown';
      log.debug('State received from extension', { windowKey, msgCount, status, phones: this.phoneSockets.size });

      const title = state?.chatTitle || state?.statusBar?.workspaceName || windowKey.split('|')[0] || 'Cursor';
      const meta = this.windowMeta.get(windowKey);
      if (meta) meta.title = title;

      const activeStatuses = ['thinking', 'generating', 'streaming', 'running_tool'];
      if (activeStatuses.includes(status)) {
        autoBindUnboundSessions(windowKey);
      }

      this.broadcastMultiState();
    });

    socket.on('ext:command_result', (result) => {
      this.stats.commandsCompleted++;
      log.info('CDP RESULT from extension', {
        cmd: (result.commandId || '').substring(0, 8),
        ok: result.ok,
        error: result.error || undefined,
        window: windowKey.replace(/\\/g, '/').split('/').pop(),
        phones: this.phoneSockets.size,
      });

      for (const [id, phoneSock] of this.phoneSockets) {
        phoneSock.emit('command:result', result);
      }
    });

    socket.on('disconnect', (reason) => {
      const wkShort = windowKey.replace(/\\/g, '/').split('/').pop();
      log.warn('Extension DISCONNECTED', { window: wkShort, socketId: socket.id, reason });
      if (this.extensionSockets.get(windowKey)?.id === socket.id) {
        this.extensionSockets.delete(windowKey);
        this.cachedStates.delete(windowKey);
        this.windowMeta.delete(windowKey);
        log.info('Extension CLEANED UP', { window: wkShort, remainingExtensions: this.extensionSockets.size });
      }
      this.broadcastMultiState();
      this.broadcastStatus();
    });

    this.broadcastMultiState();
    this.broadcastStatus();
  }

  registerPhone(socket) {
    this.phoneSockets.set(socket.id, socket);
    log.info('Phone registered', { socketId: socket.id, totalPhones: this.phoneSockets.size });

    this.sendMultiStateTo(socket);
    socket.emit('status:update', this.getStatus());
    socket.emit('mcp:status', {
      waiting: this.mcpWaiting,
      loopActive: this.mcpLoopActive,
      perSession: this.mcpPerSession,
    });

    socket.on('phone:command', async (payload) => {
      const targetKey = payload.targetWindowKey || null;
      const cmdId = (payload.commandId || '').substring(0, 8);
      const targetShort = targetKey ? targetKey.replace(/\\/g, '/').split('/').pop() : 'none';
      log.info('PHONE CMD', {
        type: payload.type,
        cmd: cmdId,
        target: targetShort,
        textLen: payload.text?.length || 0,
        images: payload.images?.length || 0,
      });

      if (payload.type === 'send_message') {
        const result = await resolvePendingWait(payload.text, payload.images, payload.msgId, targetKey);
        log.info('MCP ROUTE result', {
          status: result.status,
          accepted: result.accepted,
          reason: result.reason,
          cmd: cmdId,
          target: targetShort,
        });

        if (result.accepted) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: true,
            mcpResolved: true,
            mcpStatus: result.status,
            msgId: result.id,
          });
          return;
        }

        if (result.status === 'wait_exhausted') {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Agent waiter never came back after 30s',
          });
          return;
        }

        if (result.status !== 'not_looped') {
          log.warn('Unexpected route status, falling through to CDP', { status: result.status });
        }
        log.info('CDP path (target not looped)', { target: targetShort, cmd: cmdId });
      }

      var extSocket = null;
      var extWindowKey = null;
      if (targetKey) {
        extSocket = this.extensionSockets.get(targetKey);
        if (extSocket) extWindowKey = targetKey;
      }

      if (!extSocket) {
        if (this.extensionSockets.size === 1) {
          var firstEntry = this.extensionSockets.entries().next().value;
          extSocket = firstEntry[1];
          extWindowKey = firstEntry[0];
          log.info('CDP: single extension fallback', {
            window: extWindowKey.replace(/\\/g, '/').split('/').pop(),
            cmd: cmdId,
          });
        } else if (this.extensionSockets.size > 1) {
          var firstEntry2 = this.extensionSockets.entries().next().value;
          extSocket = firstEntry2[1];
          extWindowKey = firstEntry2[0];
          log.warn('CDP: multiple extensions, picking first', {
            picked: extWindowKey.replace(/\\/g, '/').split('/').pop(),
            available: Array.from(this.extensionSockets.keys()).map(k => k.replace(/\\/g, '/').split('/').pop()),
            cmd: cmdId,
          });
        }
      }

      if (!extSocket) {
        log.warn('CDP: no extension connected, rejecting', { cmd: cmdId, type: payload.type });
        socket.emit('command:result', {
          commandId: payload.commandId,
          ok: false,
          error: 'Extension not connected',
        });
        return;
      }

      this.stats.commandsSent++;
      log.info('CDP DISPATCH', {
        type: payload.type,
        cmd: cmdId,
        window: extWindowKey ? extWindowKey.replace(/\\/g, '/').split('/').pop() : 'unknown',
        socketId: extSocket.id.substring(0, 8),
        textLen: payload.text?.length || 0,
      });
      extSocket.emit('ext:command', payload);
    });

    socket.on('phone:bind_mcp_session', (payload) => {
      if (payload.sessionId && payload.windowKey) {
        bindSessionToWindow(payload.sessionId, payload.windowKey);
        socket.emit('mcp:session_bound', { sessionId: payload.sessionId, windowKey: payload.windowKey });
      }
    });

    socket.on('disconnect', (reason) => {
      this.phoneSockets.delete(socket.id);
      log.info('Phone disconnected', { socketId: socket.id, reason, totalPhones: this.phoneSockets.size });
    });
  }

  buildMultiPayload() {
    var windows = [];
    for (const [key, meta] of this.windowMeta) {
      windows.push({
        windowKey: meta.windowKey,
        title: meta.title,
        connected: meta.connected,
      });
    }
    var states = {};
    for (const [key, state] of this.cachedStates) {
      states[key] = state;
    }
    return { windows: windows, states: states };
  }

  sendMultiStateTo(socket) {
    socket.emit('state:multi_update', this.buildMultiPayload());
  }

  broadcastMultiState() {
    var payload = this.buildMultiPayload();
    for (const [id, phoneSock] of this.phoneSockets) {
      phoneSock.emit('state:multi_update', payload);
    }
  }

  getStatus() {
    return {
      extensionConnected: this.extensionSockets.size > 0,
      extensionCount: this.extensionSockets.size,
      phoneCount: this.phoneSockets.size,
      hasCachedState: this.cachedStates.size > 0,
      stats: { ...this.stats },
    };
  }

  broadcastStatus() {
    const status = this.getStatus();
    for (const [id, phoneSock] of this.phoneSockets) {
      phoneSock.emit('status:update', status);
    }
  }

  getStats() {
    return {
      ...this.stats,
      extensionCount: this.extensionSockets.size,
      extensionWindowKeys: Array.from(this.extensionSockets.keys()),
      phoneCount: this.phoneSockets.size,
      phoneSocketIds: Array.from(this.phoneSockets.keys()),
      cachedStateCount: this.cachedStates.size,
      mcpSessions: getSessionInfo(),
      mcpDebug: getDebugDump(),
    };
  }
}

module.exports = { RoomManager };
