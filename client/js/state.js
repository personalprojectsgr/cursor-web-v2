(function () {
  'use strict';

  var defaultState = {
    connected: false,
    agentStatus: 'idle',
    messages: [],
    pendingApprovals: [],
    inputAvailable: false,
    chatTabs: [],
    mode: { current: 'agent' },
    model: { current: 'Auto' },
  };

  window.CursorApp = {
    state: Object.assign({}, defaultState),
    defaultState: defaultState,
    windowStates: {},
    connectedWindows: [],
    activeWindowKey: null,
    userScrolledUp: false,
    autoScrollJob: 0,
    pendingImages: [],
    mcpWaiting: false,
    mcpLoopActive: false,
    mcpPerSession: {},
    lastStateUpdateTime: 0,
    reconnecting: false,
    optimisticMessages: [],
  };

  var CA = window.CursorApp;

  CA.escapeHtml = function (str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  };

  CA.sanitizeHtml = function (html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('script, iframe, object, embed, form').forEach(function (el) { el.remove(); });
    tmp.querySelectorAll('*').forEach(function (el) {
      Array.from(el.attributes).forEach(function (attr) {
        if (attr.name.startsWith('on') || attr.name === 'srcdoc') el.removeAttribute(attr.name);
      });
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return tmp.innerHTML;
  };

  CA.isNearBottom = function () {
    var $m = document.getElementById('messages');
    return $m.scrollTop + $m.clientHeight >= $m.scrollHeight - 80;
  };

  CA.scheduleAutoScroll = function () {
    var $m = document.getElementById('messages');
    var jobId = ++CA.autoScrollJob;
    requestAnimationFrame(function () {
      if (jobId !== CA.autoScrollJob || CA.userScrolledUp) return;
      $m.scrollTop = $m.scrollHeight;
    });
  };

  CA.showToast = function (message, type) {
    var $c = document.getElementById('toast-container');
    var toast = document.createElement('div');
    toast.className = 'toast ' + (type || '');
    toast.textContent = message;
    $c.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(function () { toast.remove(); }, 300);
    }, 3000);
  };

  CA.getActiveState = function () {
    if (CA.activeWindowKey && CA.windowStates[CA.activeWindowKey]) {
      return CA.windowStates[CA.activeWindowKey];
    }
    return CA.defaultState;
  };

  CA.applyMultiUpdate = function (data) {
    CA.connectedWindows = data.windows || [];
    CA.windowStates = data.states || {};

    if (!CA.activeWindowKey || !CA.windowStates[CA.activeWindowKey]) {
      var best = null;
      var bestTime = 0;
      CA.connectedWindows.forEach(function (w) {
        var st = CA.windowStates[w.windowKey];
        var t = st && st.lastExtractedAt ? st.lastExtractedAt : 0;
        if (t > bestTime || !best) {
          best = w.windowKey;
          bestTime = t;
        }
      });
      if (best) CA.activeWindowKey = best;
    }

    CA.state = Object.assign({}, CA.defaultState, CA.getActiveState());
  };

  CA.switchWindow = function (windowKey) {
    CA.activeWindowKey = windowKey;
    CA.state = Object.assign({}, CA.defaultState, CA.getActiveState());
    CA.userScrolledUp = false;
  };

  CA.windowDisplayName = function (windowKey) {
    if (!windowKey) return 'Cursor';
    var parts = windowKey.split('|');
    var folder = parts[0] || '';
    var segments = folder.replace(/\\/g, '/').split('/');
    return segments[segments.length - 1] || folder || 'Cursor';
  };

  CA.isWindowLooped = function (windowKey) {
    var key = windowKey || CA.activeWindowKey;
    if (!key) return CA.mcpWaiting || CA.mcpLoopActive;
    var ps = CA.mcpPerSession || {};
    for (var sid in ps) {
      if (ps[sid].windowKey === key && (ps[sid].waiting || ps[sid].loopActive)) return true;
    }
    return CA.mcpWaiting || CA.mcpLoopActive;
  };

  CA.isWindowWaiting = function (windowKey) {
    var key = windowKey || CA.activeWindowKey;
    if (!key) return CA.mcpWaiting;
    var ps = CA.mcpPerSession || {};
    for (var sid in ps) {
      if (ps[sid].windowKey === key && ps[sid].waiting) return true;
    }
    return false;
  };

  CA.addOptimisticMessage = function (msgId, text, images, sendStatus) {
    CA.optimisticMessages.push({
      id: 'opt-' + msgId,
      msgId: msgId,
      type: 'human',
      text: text,
      images: images,
      timestamp: Date.now(),
      sendStatus: sendStatus || 'sending',
    });
    if (CA.optimisticMessages.length > 30) CA.optimisticMessages.shift();
  };

  CA.updateOptimisticStatus = function (msgId, status) {
    for (var i = 0; i < CA.optimisticMessages.length; i++) {
      if (CA.optimisticMessages[i].msgId === msgId) {
        CA.optimisticMessages[i].sendStatus = status;
        return;
      }
    }
  };

  CA.setOptimisticCommandId = function (msgId, commandId) {
    for (var i = 0; i < CA.optimisticMessages.length; i++) {
      if (CA.optimisticMessages[i].msgId === msgId) {
        CA.optimisticMessages[i].commandId = commandId;
        return;
      }
    }
  };

  CA.updateOptimisticStatusByCommandId = function (commandId, status) {
    for (var i = 0; i < CA.optimisticMessages.length; i++) {
      if (CA.optimisticMessages[i].commandId === commandId) {
        CA.optimisticMessages[i].sendStatus = status;
        return;
      }
    }
  };

  CA.pruneDeliveredOptimistic = function () {
    var serverMsgTexts = {};
    var now = Date.now();
    CA.state.messages.forEach(function (m) {
      if (m.type === 'human' && m.text) serverMsgTexts[m.text.trim().substring(0, 200)] = true;
    });
    CA.optimisticMessages = CA.optimisticMessages.filter(function (om) {
      var textKey = om.text.trim().substring(0, 200);
      if (serverMsgTexts[textKey]) return false;
      if (om.sendStatus === 'delivered' && (now - om.timestamp > 15000)) return false;
      if (now - om.timestamp > 300000) return false;
      return true;
    });
  };

  CA.getMessagesWithOptimistic = function () {
    CA.pruneDeliveredOptimistic();
    if (CA.optimisticMessages.length === 0) return CA.state.messages;
    var merged = CA.state.messages.slice();
    var serverTextKeys = {};
    merged.forEach(function (m) {
      if (m.type === 'human' && m.text) serverTextKeys[m.text.trim().substring(0, 200)] = true;
    });
    CA.optimisticMessages.forEach(function (om) {
      var textKey = om.text.trim().substring(0, 200);
      if (!serverTextKeys[textKey]) merged.push(om);
    });
    return merged;
  };

  CA.markStaleOptimisticAsFailed = function () {
    var now = Date.now();
    CA.optimisticMessages.forEach(function (om) {
      if ((om.sendStatus === 'sending' || om.sendStatus === 'sending_mcp') && (now - om.timestamp > 30000)) {
        om.sendStatus = 'failed';
      }
    });
  };

  CA.timeAgo = function (ts) {
    if (!ts) return '';
    var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 5) return 'now';
    if (diff < 60) return diff + 's ago';
    var mins = Math.floor(diff / 60);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  };
})();
