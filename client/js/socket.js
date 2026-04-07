(function () {
  'use strict';

  let socket = null;
  let _connected = false;
  const listeners = { state: [], status: [], connect: [], disconnect: [], commandResult: [], multiUpdate: [], mcpStatus: [] };
  const pendingResults = new Map();

  function connect(password) {
    return new Promise(function (resolve, reject) {
      if (socket) socket.disconnect();

      socket = io(window.location.origin, {
        auth: { password: password, role: 'phone' },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
        transports: ['websocket', 'polling'],
      });

      var onFirst = function () {
        cleanup();
        _connected = true;
        fire('connect');
        resolve();
      };

      var onFirstError = function (err) {
        cleanup();
        reject(err);
      };

      function cleanup() {
        socket.off('connect', onFirst);
        socket.off('connect_error', onFirstError);
      }

      socket.once('connect', onFirst);
      socket.once('connect_error', onFirstError);

      socket.on('disconnect', function () {
        _connected = false;
        fire('disconnect');
      });

      socket.on('connect', function () {
        _connected = true;
        if (window.CursorApp) window.CursorApp.reconnecting = false;
        fire('connect');
      });

      socket.io.on('reconnect_attempt', function () {
        if (window.CursorApp) window.CursorApp.reconnecting = true;
        fire('disconnect');
      });

      socket.io.on('reconnect', function () {
        if (window.CursorApp) window.CursorApp.reconnecting = false;
      });

      socket.on('state:update', function (s) { fire('state', s); });
      socket.on('state:multi_update', function (s) { fire('multiUpdate', s); });
      socket.on('status:update', function (s) { fire('status', s); });
      socket.on('mcp:status', function (s) { fire('mcpStatus', s); });

      socket.on('command:result', function (result) {
        var pending = pendingResults.get(result.commandId);
        if (pending) {
          pendingResults.delete(result.commandId);
          pending(result);
          return;
        }
        fire('commandResult', result);
      });
    });
  }

  function newCommandId() {
    var c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 8);
  }

  function sendCommand(type, extra) {
    if (!socket || !_connected) return null;
    var commandId = newCommandId();
    var CA = window.CursorApp;
    var payload = Object.assign({ commandId: commandId, type: type }, extra || {});
    if (CA && CA.activeWindowKey) payload.targetWindowKey = CA.activeWindowKey;
    socket.emit('phone:command', payload);
    return commandId;
  }

  function sendCommandAwaitResult(type, extra, timeoutMs) {
    if (!socket || !_connected) {
      return Promise.resolve({ commandId: '', ok: false, error: 'Not connected' });
    }
    var commandId = newCommandId();
    var CA = window.CursorApp;
    var payload = Object.assign({ commandId: commandId, type: type }, extra || {});
    if (CA && CA.activeWindowKey && !payload.targetWindowKey) payload.targetWindowKey = CA.activeWindowKey;

    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        pendingResults.delete(commandId);
        resolve({ commandId: commandId, ok: false, error: 'Command timed out' });
      }, timeoutMs || 12000);

      pendingResults.set(commandId, function (result) {
        clearTimeout(timer);
        resolve(result);
      });

      socket.emit('phone:command', payload);
    });
  }

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function fire(event) {
    var args = Array.prototype.slice.call(arguments, 1);
    (listeners[event] || []).forEach(function (fn) { try { fn.apply(null, args); } catch (e) { console.warn('[socket]', e); } });
  }

  function isConnected() { return _connected; }

  window.CursorSocket = {
    connect: connect,
    sendCommand: sendCommand,
    sendCommandAwaitResult: sendCommandAwaitResult,
    on: on,
    isConnected: isConnected,
    newCommandId: newCommandId,
  };
})();
