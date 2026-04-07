(function () {
  'use strict';

  window.CursorApp = {
    machines: [],
    windows: [],
    windowStates: {},
    activeWindowKey: null,
    activeMachineKey: null,
    mcpWaiting: false,
    mcpLoopActive: false,
    mcpPerSession: {},
    pendingImages: [],
    lastUpdateTime: 0,
    userScrolledUp: false,
    autoScrollJob: 0,
    reconnecting: false,

    getActiveState: function () {
      if (this.activeWindowKey && this.windowStates[this.activeWindowKey]) {
        return this.windowStates[this.activeWindowKey];
      }
      return null;
    },

    applyFullUpdate: function (data) {
      this.machines = data.machines || [];
      this.windows = data.windows || [];
      this.windowStates = data.states || {};
      this.lastUpdateTime = Date.now();

      if (!this.activeWindowKey || !this.windowStates[this.activeWindowKey]) {
        var best = null;
        var bestTime = 0;
        for (var key in this.windowStates) {
          var st = this.windowStates[key];
          var t = st && st.extractedAt ? st.extractedAt : 0;
          if (t > bestTime || !best) {
            best = key;
            bestTime = t;
          }
        }
        if (best) {
          this.activeWindowKey = best;
          var wInfo = this.windows.find(function (w) { return w.windowKey === best; });
          if (wInfo) this.activeMachineKey = wInfo.machineKey;
        }
      }
    },

    switchWindow: function (windowKey) {
      this.activeWindowKey = windowKey;
      var wInfo = this.windows.find(function (w) { return w.windowKey === windowKey; });
      if (wInfo) this.activeMachineKey = wInfo.machineKey;
      this.userScrolledUp = false;
    },

    switchMachine: function (machineKey) {
      this.activeMachineKey = machineKey;
      var found = this.windows.find(function (w) {
        return w.machineKey === machineKey && w.connected;
      });
      if (found) {
        this.activeWindowKey = found.windowKey;
        this.userScrolledUp = false;
      }
    },

    getWindowsForMachine: function (machineKey) {
      return this.windows.filter(function (w) { return w.machineKey === machineKey; });
    },

    getTabsForActiveWindow: function () {
      var state = this.getActiveState();
      return state ? (state.chatTabs || []) : [];
    },

    getChatKey: function (windowKey, tabIndex) {
      var wk = windowKey || this.activeWindowKey;
      var ti = typeof tabIndex === 'number' ? tabIndex : this.getActiveTabIndex();
      return wk ? (wk + '|' + ti) : null;
    },

    getActiveTabIndex: function () {
      var tabs = this.getTabsForActiveWindow();
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].isActive) return i;
      }
      return 0;
    },

    isLoopedForChat: function (chatKey) {
      if (!chatKey || !this.mcpPerSession) return false;
      for (var sid in this.mcpPerSession) {
        var s = this.mcpPerSession[sid];
        if (s.chatKey === chatKey && s.loopActive) return true;
      }
      return false;
    },

    isWaitingForChat: function (chatKey) {
      if (!chatKey || !this.mcpPerSession) return false;
      for (var sid in this.mcpPerSession) {
        var s = this.mcpPerSession[sid];
        if (s.chatKey === chatKey && s.waiting) return true;
      }
      return false;
    },

    getLoopStateForChat: function (chatKey) {
      if (!chatKey || !this.mcpPerSession) return 'idle';
      for (var sid in this.mcpPerSession) {
        var s = this.mcpPerSession[sid];
        if (s.chatKey === chatKey) {
          if (s.waiting) return 'active';
          if (s.loopActive) return 'looped';
        }
      }
      return 'idle';
    },

    isNearBottom: function () {
      var el = document.getElementById('messages');
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
    },

    scheduleAutoScroll: function () {
      var el = document.getElementById('messages');
      var jobId = ++this.autoScrollJob;
      var self = this;
      requestAnimationFrame(function () {
        if (jobId !== self.autoScrollJob || self.userScrolledUp) return;
        el.scrollTop = el.scrollHeight;
      });
    },

    showToast: function (message, type) {
      var container = document.getElementById('toast-container');
      var toast = document.createElement('div');
      toast.className = 'toast' + (type ? ' ' + type : '');
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(function () {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(function () { toast.remove(); }, 300);
      }, 3000);
    },

    escapeHtml: function (str) {
      var d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    },

    sanitizeHtml: function (html) {
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
    },
  };
})();
