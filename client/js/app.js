(function () {
  'use strict';
  var CA = window.CursorApp;
  var AUTH_KEY = 'cursor-remote-pw';

  function init() {
    var saved = localStorage.getItem(AUTH_KEY);
    if (saved) connectWithPassword(saved);

    document.getElementById('auth-form').addEventListener('submit', function (e) {
      e.preventDefault();
      connectWithPassword(document.getElementById('auth-password').value);
    });
  }

  function connectWithPassword(pw) {
    var $err = document.getElementById('auth-error');
    var $btn = document.getElementById('auth-btn');
    $err.textContent = '';
    $btn.disabled = true;
    $btn.textContent = 'Connecting...';

    CursorSocket.connect(pw).then(function () {
      localStorage.setItem(AUTH_KEY, pw);
      showScreen('main');
      bootstrap();
    }).catch(function (err) {
      $err.textContent = err.message || 'Connection failed';
      localStorage.removeItem(AUTH_KEY);
    }).finally(function () {
      $btn.disabled = false;
      $btn.textContent = 'Connect';
    });
  }

  function showScreen(name) {
    document.getElementById('auth-screen').classList.toggle('hidden', name !== 'auth');
    document.getElementById('main-screen').classList.toggle('hidden', name !== 'main');
    if (name === 'main') document.getElementById('main-screen').classList.add('flex');
  }

  function bootstrap() {
    CursorSocket.on('multiUpdate', function (data) {
      CA.lastStateUpdateTime = Date.now();
      CA.applyMultiUpdate(data);
      renderAll();
    });

    CursorSocket.on('status', function (st) {
      if (st && !st.extensionConnected && st.extensionCount === 0) CA.state.connected = false;
      else if (st && (st.extensionConnected || st.extensionCount > 0)) CA.state.connected = true;
      renderAll();
    });

    CursorSocket.on('mcpStatus', function (s) {
      CA.mcpWaiting = s && s.waiting;
      CA.mcpLoopActive = s && s.loopActive;
      CA.mcpPerSession = (s && s.perSession) || {};
      renderAll();
    });

    CursorSocket.on('connect', function () { renderAll(); });
    CursorSocket.on('disconnect', function () { CA.markStaleOptimisticAsFailed(); renderAll(); });

    CursorSocket.on('commandResult', function (result) {
      if (result.mcpResolved && result.msgId) {
        CA.updateOptimisticStatus(result.msgId, result.mcpStatus || 'delivered');
        if (result.mcpStatus === 'delivered') CA.showToast('Reply delivered', 'success');
        renderAll();
        return;
      }
      if (result.ok && result.commandId) {
        CA.updateOptimisticStatusByCommandId(result.commandId, 'delivered');
        renderAll();
        return;
      }
      if (!result.ok) CA.showToast(result.error || 'Command failed', 'error');
    });

    var $messages = document.getElementById('messages');
    $messages.addEventListener('scroll', function () {
      CA.autoScrollJob++;
      CA.userScrolledUp = !CA.isNearBottom();
    });

    var $input = document.getElementById('message-input');
    var $btnSend = document.getElementById('btn-send');

    $input.addEventListener('input', function () {
      $input.style.height = 'auto';
      $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
      $btnSend.disabled = !$input.value.trim() && CA.pendingImages.length === 0;
    });

    $input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); CA.sendMessage(); }
    });

    $input.addEventListener('paste', CA.handleImagePaste);

    $btnSend.addEventListener('click', CA.sendMessage);
    document.getElementById('btn-stop').addEventListener('click', CA.handleStop);
    document.getElementById('btn-attach').addEventListener('click', CA.handleImageFilePick);

    document.getElementById('btn-approve').addEventListener('click', function () {
      var a = CA.state.pendingApprovals[0];
      if (!a) return;
      var act = a.actions.find(function (x) { return x.type === 'approve' || x.type === 'approve_all' || x.type === 'accept'; });
      if (!act) return;
      CursorSocket.sendCommand('click_action', { selectorPath: act.selectorPath });
      CA.showToast('Approved', 'success');
    });

    document.getElementById('btn-reject').addEventListener('click', function () {
      var a = CA.state.pendingApprovals[0];
      if (!a) return;
      var act = a.actions.find(function (x) { return x.type === 'reject'; });
      if (!act) return;
      CursorSocket.sendCommand('click_action', { selectorPath: act.selectorPath });
      CA.showToast('Rejected', 'success');
    });

    document.getElementById('btn-new-chat').addEventListener('click', function () {
      CursorSocket.sendCommand('new_chat');
      CA.showToast('Creating new chat...', 'success');
    });

    renderAll();
    setInterval(function () { CA.markStaleOptimisticAsFailed(); renderAll(); }, 15000);
  }

  function renderConnectionStatus() {
    var $dot = document.getElementById('connection-dot');
    var $text = document.getElementById('connection-text');
    if (!CursorSocket.isConnected()) {
      $dot.className = 'w-2 h-2 rounded-full bg-destructive dot-pulse';
      $text.textContent = CA.reconnecting ? 'Reconnecting...' : 'Disconnected';
      return;
    }
    var anyConnected = CA.connectedWindows.some(function (w) { return w.connected; });
    if (!anyConnected && !CA.state.connected) {
      $dot.className = 'w-2 h-2 rounded-full bg-yellow-500 dot-pulse';
      $text.textContent = 'Waiting for Cursor';
      return;
    }
    $dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
    $text.textContent = 'Connected';
  }

  function renderAgentStatus() {
    var labels = { idle: 'Idle', thinking: 'Thinking...', generating: 'Generating...', running_tool: 'Running tool...', waiting_approval: 'Needs approval', streaming: 'Generating...' };
    var s = CA.state.agentStatus || 'idle';
    var $container = document.getElementById('agent-status');
    var $text = document.getElementById('agent-status-text');

    var showLoop = CA.isWindowLooped();
    var showStatus = s !== 'idle' || showLoop;
    $container.classList.toggle('hidden', !showStatus);

    if (showLoop) {
      if (CA.isWindowWaiting()) {
        $text.textContent = 'Looped \u2014 waiting for reply';
        $text.className = 'text-emerald-400';
      } else {
        $text.textContent = 'Looped \u2014 processing...';
        $text.className = 'shimmer-text';
      }
    } else {
      $text.textContent = labels[s] || s;
      $text.className = (s === 'thinking' || s === 'generating' || s === 'streaming') ? 'shimmer-text' : '';
    }
  }

  function renderWindows() {
    var $bar = document.getElementById('window-bar');
    var $list = document.getElementById('window-list');
    if (CA.connectedWindows.length <= 1) { $bar.classList.add('hidden'); return; }
    $bar.classList.remove('hidden');
    $list.innerHTML = '';
    CA.connectedWindows.forEach(function (win) {
      var btn = document.createElement('button');
      var isActive = win.windowKey === CA.activeWindowKey;
      btn.className = 'px-3 py-1 rounded-md text-xs font-medium transition-colors ' +
        (isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50');
      btn.textContent = CA.windowDisplayName(win.windowKey);
      btn.addEventListener('click', function () {
        CA.switchWindow(win.windowKey);
        CA.showToast('Switched to ' + CA.windowDisplayName(win.windowKey), 'success');
        renderAll();
      });
      $list.appendChild(btn);
    });
  }

  function renderTabs() {
    var tabs = CA.state.chatTabs || [];
    var $bar = document.getElementById('tab-bar');
    var $list = document.getElementById('tab-list');
    if (tabs.length <= 1) { $bar.classList.add('hidden'); return; }
    $bar.classList.remove('hidden');
    $list.innerHTML = '';
    tabs.forEach(function (tab, i) {
      var btn = document.createElement('button');
      btn.className = 'px-2.5 py-1 rounded-md text-xs transition-colors truncate max-w-[120px] ' +
        (tab.isActive ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:bg-secondary/50');
      btn.textContent = tab.title || 'Chat ' + (i + 1);
      btn.addEventListener('click', function () {
        CursorSocket.sendCommand('switch_tab', { selectorPath: tab.selectorPath });
      });
      $list.appendChild(btn);
    });
  }

  function renderMessages() {
    var $messages = document.getElementById('messages');
    var $emptyState = document.getElementById('empty-state');
    var allMessages = CA.getMessagesWithOptimistic();

    if (allMessages.length === 0) {
      $emptyState.classList.remove('hidden');
      $messages.querySelectorAll('.chat-el').forEach(function (el) { el.remove(); });
      return;
    }

    $emptyState.classList.add('hidden');
    var existingEls = $messages.querySelectorAll('.chat-el');
    var existingMap = new Map();
    existingEls.forEach(function (el) { existingMap.set(el.dataset.id, el); });
    var newIds = new Set(allMessages.map(function (m) { return m.id; }));
    existingEls.forEach(function (el) { if (!newIds.has(el.dataset.id)) el.remove(); });

    allMessages.forEach(function (msg, index) {
      var el = existingMap.get(msg.id);
      if (!el) {
        el = CA.createElement(msg);
        if (msg.sendStatus) {
          var badge = document.createElement('div');
          badge.className = 'optimistic-badge' + (msg.sendStatus === 'failed' ? ' optimistic-badge-failed' : '');
          badge.textContent = msg.sendStatus === 'failed' ? 'Failed to send' : 'Sending...';
          var bubble = el.querySelector('.human-bubble');
          if (bubble) bubble.appendChild(badge);
        }
        var allEls = $messages.querySelectorAll('.chat-el');
        if (index < allEls.length) $messages.insertBefore(el, allEls[index]);
        else $messages.appendChild(el);
      } else {
        CA.updateElement(el, msg);
      }
    });

    if (!CA.userScrolledUp) CA.scheduleAutoScroll();
  }

  function renderApprovals() {
    var $bar = document.getElementById('approval-bar');
    var $desc = document.getElementById('approval-desc');
    if (CA.state.pendingApprovals.length > 0) {
      $bar.classList.remove('hidden');
      $bar.classList.add('flex');
      $desc.textContent = CA.state.pendingApprovals[0].description || 'Action needs approval';
    } else {
      $bar.classList.add('hidden');
      $bar.classList.remove('flex');
    }
  }

  function renderAll() {
    renderConnectionStatus();
    renderAgentStatus();
    renderWindows();
    renderTabs();
    renderMessages();
    renderApprovals();
    CA.renderInputState();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
