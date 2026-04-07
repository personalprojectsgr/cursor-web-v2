(function () {
  'use strict';

  var socket = null;
  var listeners = {};
  var cmdId = 0;

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function emit(event, data) {
    (listeners[event] || []).forEach(function (fn) { fn(data); });
  }

  function connect(password) {
    return new Promise(function (resolve, reject) {
      socket = io(window.location.origin, {
        auth: { password: password, role: 'phone' },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
        transports: ['websocket', 'polling'],
      });

      socket.on('connect', function () {
        if (window.CursorApp) window.CursorApp.reconnecting = false;
        emit('connect');
        resolve();
      });

      socket.on('connect_error', function (err) {
        reject(err);
      });

      socket.on('disconnect', function () {
        if (window.CursorApp) window.CursorApp.reconnecting = true;
        emit('disconnect');
      });

      socket.on('reconnect_attempt', function () {
        if (window.CursorApp) window.CursorApp.reconnecting = true;
      });

      socket.on('state:full_update', function (data) {
        emit('fullUpdate', data);
      });

      socket.on('mcp:status', function (data) {
        emit('mcpStatus', data);
      });

      socket.on('command:result', function (data) {
        emit('commandResult', data);
      });
    });
  }

  function sendCommand(type, params) {
    if (!socket || !socket.connected) return false;
    var id = 'cmd-' + (++cmdId);
    var CA = window.CursorApp;
    var payload = Object.assign({}, params || {}, {
      type: type,
      commandId: id,
      targetWindowKey: CA ? CA.activeWindowKey : null,
      chatTabIndex: CA ? CA.getActiveTabIndex() : 0,
    });
    socket.emit('phone:command', payload);
    return id;
  }

  function isConnected() {
    return socket && socket.connected;
  }

  window.CursorSocket = {
    connect: connect,
    on: on,
    sendCommand: sendCommand,
    isConnected: isConnected,
  };
})();
