(function () {
  'use strict';
  var CA = window.CursorApp;
  var AUTH_KEY = 'cursor-web-pw';

  function init() {
    var saved = localStorage.getItem(AUTH_KEY);
    if (saved) connectWithPassword(saved);

    document.getElementById('auth-form').addEventListener('submit', function (e) {
      e.preventDefault();
      connectWithPassword(document.getElementById('auth-password').value);
    });
  }

  function connectWithPassword(pw) {
    var errEl = document.getElementById('auth-error');
    var btn = document.getElementById('auth-btn');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Connecting...';

    CursorSocket.connect(pw).then(function () {
      localStorage.setItem(AUTH_KEY, pw);
      showScreen('main');
      bootstrap();
    }).catch(function (err) {
      errEl.textContent = err.message || 'Connection failed';
      localStorage.removeItem(AUTH_KEY);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Connect';
    });
  }

  function showScreen(name) {
    document.getElementById('auth-screen').classList.toggle('hidden', name !== 'auth');
    document.getElementById('main-screen').classList.toggle('hidden', name !== 'main');
  }

  function bootstrap() {
    CursorSocket.on('fullUpdate', function (data) {
      CA.applyFullUpdate(data);
      renderAll();
    });

    CursorSocket.on('mcpStatus', function (data) {
      CA.mcpWaiting = data && data.waiting;
      CA.mcpLoopActive = data && data.loopActive;
      CA.mcpPerSession = (data && data.perSession) || {};
      renderAll();
    });

    CursorSocket.on('commandResult', function (result) {
      if (result.mcpResolved) {
        CA.showToast('Reply delivered', 'success');
        return;
      }
      if (!result.ok) {
        CA.showToast(result.error || 'Command failed', 'error');
      }
    });

    CursorSocket.on('connect', function () { renderAll(); });
    CursorSocket.on('disconnect', function () { renderAll(); });

    var messagesEl = document.getElementById('messages');
    messagesEl.addEventListener('scroll', function () {
      CA.autoScrollJob++;
      CA.userScrolledUp = !CA.isNearBottom();
    });

    var editor = document.getElementById('input-editor');
    editor.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        CA.sendMessage();
      }
    });
    editor.addEventListener('paste', function (e) {
      CA.handleImagePaste(e);
    });

    document.getElementById('btn-send').addEventListener('click', CA.sendMessage);
    document.getElementById('btn-stop').addEventListener('click', CA.handleStop);

    var btnAttach = document.getElementById('btn-attach');
    if (btnAttach) btnAttach.addEventListener('click', CA.handleImageFilePick);

    document.getElementById('input-editor').addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      var hasImage = false;
      for (var i = 0; i < files.length; i++) {
        if (files[i].type.indexOf('image') === 0) {
          hasImage = true;
          break;
        }
      }
      if (!hasImage) return;
      e.preventDefault();
      for (var j = 0; j < files.length; j++) {
        if (files[j].type.indexOf('image') === 0) {
          CA.handleDroppedFile(files[j]);
        }
      }
    });

    document.getElementById('pill-mode').addEventListener('click', function () { CA.openSheet('mode'); });
    document.getElementById('pill-model').addEventListener('click', function () { CA.openSheet('model'); });
    document.getElementById('sheet-overlay').addEventListener('click', CA.closeSheet);

    document.getElementById('btn-new-chat').addEventListener('click', function () {
      CursorSocket.sendCommand('new_chat');
      CA.showToast('Creating new chat...', 'success');
    });

    var sidebarNewChat = document.getElementById('sidebar-new-chat');
    if (sidebarNewChat) {
      sidebarNewChat.addEventListener('click', function () {
        CursorSocket.sendCommand('new_chat');
        CA.showToast('Creating new chat...', 'success');
      });
    }

    var toolbarStop = document.getElementById('toolbar-stop');
    if (toolbarStop) {
      toolbarStop.addEventListener('click', CA.handleStop);
    }

    var toolbarAccept = document.getElementById('toolbar-accept');
    if (toolbarAccept) {
      toolbarAccept.addEventListener('click', function () {
        CursorSocket.sendCommand('accept_all');
        CA.showToast('Accepting all...', 'success');
      });
    }

    var toolbarReject = document.getElementById('toolbar-reject');
    if (toolbarReject) {
      toolbarReject.addEventListener('click', function () {
        CursorSocket.sendCommand('reject_all');
        CA.showToast('Rejecting all...', 'success');
      });
    }

    CA.initMachineModal();
    CA.initSetupGuide();
    renderAll();

    setInterval(function () {
      renderConnection();
    }, 10000);
  }

  CA.onFullRender = renderAll;

  function renderAll() {
    renderConnection();
    renderHeader();
    CA.renderMachines();
    CA.renderTabs();
    CA.renderSidebar();
    renderMessages();
    CA.renderInputState();
    CA.renderModeModel();
    renderToolbar();
  }

  function renderConnection() {
    var dot = document.getElementById('connection-dot');
    if (!CursorSocket.isConnected()) {
      dot.className = 'connection-dot ' + (CA.reconnecting ? 'reconnecting' : 'disconnected');
      return;
    }
    var hasWindows = CA.windows.some(function (w) { return w.connected; });
    if (!hasWindows) {
      dot.className = 'connection-dot reconnecting';
      return;
    }
    var stale = CA.lastUpdateTime && (Date.now() - CA.lastUpdateTime > 10000);
    dot.className = 'connection-dot ' + (stale ? 'stale' : 'connected');
    dot.title = 'Last update: ' + (CA.lastUpdateTime ? new Date(CA.lastUpdateTime).toLocaleTimeString() : 'never');
  }

  function renderHeader() {
    var state = CA.getActiveState();
    var titleEl = document.getElementById('chat-title');
    var statusEl = document.getElementById('agent-status');
    var fileEl = document.getElementById('active-file');

    if (state) {
      titleEl.textContent = state.chatTitle || state.documentTitle || 'Cursor';
      if (fileEl) {
        if (state.activeFile) {
          fileEl.textContent = state.activeFile;
          fileEl.classList.remove('hidden');
        } else {
          fileEl.classList.add('hidden');
        }
      }
      var agentStatus = state.agentStatus || 'idle';
      var labels = {
        idle: '',
        generating: 'Generating...',
        thinking: 'Thinking...',
        streaming: 'Streaming...',
        running_tool: 'Running tool...',
      };

      var activeMcp = state.activeMcp;
      var activeChatKey = CA.getChatKey();
      var chatLoopState = CA.getLoopStateForChat(activeChatKey);

      var isWaitForResponse = activeMcp && activeMcp.toolName && /wait.for.response/i.test(activeMcp.toolName);

      if (isWaitForResponse || chatLoopState === 'active') {
        statusEl.textContent = 'Looped \u2013 waiting';
        statusEl.className = 'agent-status looped';
      } else if (chatLoopState === 'looped') {
        statusEl.textContent = 'Looped \u2013 processing';
        statusEl.className = 'agent-status looped';
      } else if (activeMcp && activeMcp.toolName) {
        statusEl.textContent = 'Running ' + activeMcp.toolName + (activeMcp.serverName ? ' in ' + activeMcp.serverName : '');
        statusEl.className = 'agent-status generating generating-shimmer';
      } else if (agentStatus !== 'idle') {
        statusEl.textContent = labels[agentStatus] || agentStatus;
        statusEl.className = 'agent-status generating generating-shimmer';
      } else {
        statusEl.textContent = '';
        statusEl.className = 'agent-status';
      }
    } else {
      titleEl.textContent = 'Cursor Web';
      statusEl.textContent = CursorSocket.isConnected() ? 'Waiting for IDE...' : '';
      statusEl.className = 'agent-status';
    }
  }

  function renderMessages() {
    var state = CA.getActiveState();
    var simpleEmpty = document.getElementById('empty-state-simple');
    var setupGuide = document.getElementById('setup-guide');
    var setupDot = document.getElementById('setup-status-dot');
    var setupLabel = document.getElementById('setup-status-label');

    if (!state) {
      CA.renderMessageList([]);
      var connected = CursorSocket.isConnected();
      var hasWindows = CA.windows && CA.windows.length > 0;

      if (!connected) {
        if (simpleEmpty) simpleEmpty.classList.remove('hidden');
        if (setupGuide) setupGuide.classList.add('hidden');
        var emptyText = document.getElementById('empty-state-text');
        if (emptyText) emptyText.textContent = 'Connecting to server...';
      } else if (!hasWindows) {
        if (simpleEmpty) simpleEmpty.classList.add('hidden');
        if (setupGuide) setupGuide.classList.remove('hidden');
        if (setupDot) setupDot.className = 'setup-status-dot waiting';
        if (setupLabel) setupLabel.textContent = 'Server connected \u2014 waiting for Cursor IDE...';
      } else {
        if (simpleEmpty) simpleEmpty.classList.add('hidden');
        if (setupGuide) setupGuide.classList.remove('hidden');
        if (setupDot) setupDot.className = 'setup-status-dot connected';
        if (setupLabel) setupLabel.textContent = 'Cursor IDE connected \u2014 no messages yet';
      }
      return;
    }

    if (simpleEmpty) simpleEmpty.classList.add('hidden');
    if (setupGuide) setupGuide.classList.add('hidden');
    CA.renderMessageList(state.messages || []);
    CA.renderLoadingIndicator(state.isLoading || (state.agentStatus === 'generating'));
  }

  function renderToolbar() {
    var toolbar = document.getElementById('toolbar-area');
    var state = CA.getActiveState();
    if (!state) {
      toolbar.classList.add('hidden');
      return;
    }

    var isActive = state.agentStatus && state.agentStatus !== 'idle';
    var fileCount = state.toolbarFileCount || 0;
    var hasFiles = fileCount > 0;

    var hasToolbarButtons = state.toolbarButtons && state.toolbarButtons.length > 0;
    var hasStop = false;
    var hasReview = false;
    var hasAccept = false;
    var hasReject = false;
    if (hasToolbarButtons) {
      state.toolbarButtons.forEach(function (btn) {
        var t = (btn.text || '').toLowerCase();
        if (t === 'stop') hasStop = true;
        if (t === 'review') hasReview = true;
        if (t.indexOf('accept') >= 0) hasAccept = true;
        if (t.indexOf('reject') >= 0) hasReject = true;
      });
    }

    var chatKey = CA.getChatKey();
    var loopState = CA.getLoopStateForChat(chatKey);
    var isWaiting = loopState === 'active';
    if (!isWaiting && state.activeMcp && state.activeMcp.toolName) {
      isWaiting = /wait.for.response/i.test(state.activeMcp.toolName);
    }

    var showToolbarActive = isActive && !isWaiting;

    if (!showToolbarActive && !hasFiles) {
      toolbar.classList.add('hidden');
      return;
    }

    toolbar.classList.remove('hidden');

    var filesEl = document.getElementById('toolbar-files');
    var stopBtn = document.getElementById('toolbar-stop');
    var reviewBtn = document.getElementById('toolbar-review');
    var acceptBtn = document.getElementById('toolbar-accept');
    var rejectBtn = document.getElementById('toolbar-reject');

    if (hasFiles) {
      filesEl.innerHTML = '<span class="codicon codicon-chevron-right"></span> ' + fileCount + ' File' + (fileCount !== 1 ? 's' : '');
      filesEl.style.display = '';
    } else {
      filesEl.style.display = 'none';
    }

    stopBtn.classList.toggle('hidden', !showToolbarActive || !hasStop);
    reviewBtn.classList.toggle('hidden', !hasReview);
    if (acceptBtn) acceptBtn.classList.toggle('hidden', !hasAccept);
    if (rejectBtn) rejectBtn.classList.toggle('hidden', !hasReject);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
