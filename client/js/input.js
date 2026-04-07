(function () {
  'use strict';
  var CA = window.CursorApp;

  CA.sendMessage = function () {
    var editor = document.getElementById('input-editor');
    var text = editor.innerText.trim();
    if (!text && CA.pendingImages.length === 0) return;

    var payload = { text: text };
    if (CA.pendingImages.length > 0) {
      payload.images = CA.pendingImages.slice();
      CA.pendingImages = [];
      CA.renderImagePreview();
    }

    var commandId = CursorSocket.sendCommand('send_message', payload);
    if (!commandId) {
      CA.showToast('Not connected', 'error');
      return;
    }

    editor.innerHTML = '';
    editor.focus();
  };

  CA.handleImageFilePick = function () {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.addEventListener('change', function () {
      if (!input.files) return;
      for (var i = 0; i < input.files.length; i++) addImageFile(input.files[i]);
    });
    input.click();
  };

  CA.handleImagePaste = function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') === 0) {
        e.preventDefault();
        var file = items[i].getAsFile();
        if (file) addImageFile(file);
        return;
      }
    }
  };

  CA.handleDroppedFile = function (file) {
    addImageFile(file);
  };

  function addImageFile(file) {
    if (CA.pendingImages.length >= 5) { CA.showToast('Max 5 images', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      CA.pendingImages.push(reader.result);
      CA.renderImagePreview();
    };
    reader.readAsDataURL(file);
  }

  CA.renderImagePreview = function () {
    var strip = document.getElementById('image-preview-strip');
    if (!strip) return;
    strip.innerHTML = '';
    if (CA.pendingImages.length === 0) { strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    CA.pendingImages.forEach(function (dataUrl, idx) {
      var thumb = document.createElement('div');
      thumb.className = 'image-preview-thumb';
      var img = document.createElement('img');
      img.src = dataUrl;
      thumb.appendChild(img);
      var removeBtn = document.createElement('button');
      removeBtn.className = 'image-preview-remove';
      removeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
      removeBtn.addEventListener('click', function () {
        CA.pendingImages.splice(idx, 1);
        CA.renderImagePreview();
      });
      thumb.appendChild(removeBtn);
      strip.appendChild(thumb);
    });
  };

  CA.handleStop = function () {
    var id = CursorSocket.sendCommand('stop_generation');
    if (id) CA.showToast('Stopping...', 'success');
  };

  CA.renderInputState = function () {
    var state = CA.getActiveState();
    var btnSend = document.getElementById('btn-send');
    var btnStop = document.getElementById('btn-stop');
    var isActive = state && state.agentStatus && state.agentStatus !== 'idle';

    btnSend.classList.toggle('hidden', isActive);
    btnStop.classList.toggle('hidden', !isActive);
  };

  CA.renderModeModel = function () {
    var state = CA.getActiveState();
    document.getElementById('pill-mode-text').textContent = state ? (state.mode || 'Agent') : 'Agent';
    document.getElementById('pill-model-text').textContent = state ? (state.model || 'Auto') : 'Auto';
  };

  CA.renderMachines = function () {
    var bar = document.getElementById('machine-bar');
    var list = document.getElementById('machine-list');

    var onlineMachines = CA.machines.filter(function (m) { return m.online; });
    if (CA.machines.length <= 1 && onlineMachines.length <= 1) {
      bar.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');
    var existing = list.querySelectorAll('.machine-pill');
    var map = new Map();
    existing.forEach(function (el) { map.set(el.dataset.key, el); });

    var keys = new Set(CA.machines.map(function (m) { return m.key; }));
    existing.forEach(function (el) { if (!keys.has(el.dataset.key)) el.remove(); });

    CA.machines.forEach(function (machine) {
      var pill = map.get(machine.key);
      if (!pill) {
        pill = document.createElement('button');
        pill.className = 'machine-pill';
        pill.dataset.key = machine.key;
        pill.addEventListener('click', function () {
          CA.switchMachine(machine.key);
          CA.showToast('Switched to ' + machine.name, 'success');
          CA.onFullRender();
        });
        list.appendChild(pill);
      }
      var isActive = machine.key === CA.activeMachineKey;
      pill.className = 'machine-pill' + (isActive ? ' active' : '') + (!machine.online ? ' offline' : '');
      pill.innerHTML = '<span class="machine-dot"></span> ' + CA.escapeHtml(machine.name);
    });
  };

  CA.renderTabs = function () {
    var tabs = CA.getTabsForActiveWindow();
    var bar = document.getElementById('tab-bar');
    var list = document.getElementById('tab-list');

    if (tabs.length <= 1) {
      bar.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');
    var existing = list.querySelectorAll('.tab-item');
    var existMap = new Map();
    existing.forEach(function (el) { existMap.set(el.dataset.idx, el); });

    var idxSet = new Set(tabs.map(function (t, i) { return String(i); }));
    existing.forEach(function (el) { if (!idxSet.has(el.dataset.idx)) el.remove(); });

    tabs.forEach(function (tab, i) {
      var btn = existMap.get(String(i));
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'tab-item';
        btn.dataset.idx = String(i);
        btn.addEventListener('click', function () {
          if (tab.selectorPath) {
            CursorSocket.sendCommand('switch_tab', { selectorPath: tab.selectorPath });
          }
        });
        list.appendChild(btn);
      }
      btn.className = 'tab-item' + (tab.isActive ? ' active' : '');
      var mChatKey = CA.getChatKey(CA.activeWindowKey, i);
      var mLoopState = CA.getLoopStateForChat(mChatKey);
      var dotCls;
      if (mLoopState === 'active') dotCls = 'active';
      else if (mLoopState === 'looped') dotCls = 'looped';
      else if (tab.isActive && CA.getActiveState()?.agentStatus !== 'idle') dotCls = 'active';
      else dotCls = 'idle';
      var title = tab.title || 'Chat ' + (i + 1);
      btn.innerHTML = '<span class="tab-dot ' + dotCls + '"></span><span class="tab-title">' + CA.escapeHtml(title) + '</span>';
      if (tab.badge) {
        btn.innerHTML += '<span class="tab-badge">' + CA.escapeHtml(tab.badge) + '</span>';
      }
    });
  };

  CA.renderSidebar = function () {
    var sections = document.getElementById('sidebar-window-sections');
    if (!sections) return;

    if (CA.machines.length === 0 && CA.windows.length === 0) {
      sections.innerHTML = '<div class="sidebar-empty">Waiting for Cursor IDE...</div>';
      return;
    }

    var html = '';
    CA.machines.forEach(function (machine) {
      var isActiveMachine = machine.key === CA.activeMachineKey;
      var machineWindows = CA.getWindowsForMachine(machine.key);
      var sectionClass = 'sidebar-section' + (isActiveMachine ? ' active' : '') + (!machine.online ? ' disconnected' : '');

      html += '<div class="' + sectionClass + '">';
      html += '<button class="sidebar-section-header" data-machine-key="' + CA.escapeHtml(machine.key) + '">';
      html += '<span class="sidebar-chevron codicon codicon-chevron-right"></span>';
      html += '<span class="sidebar-dot ' + (machine.online ? 'connected' : 'disconnected') + '"></span>';
      html += '<span class="sidebar-section-label">' + CA.escapeHtml(machine.name) + '</span>';
      if (machineWindows.length > 0) {
        html += '<span class="sidebar-section-count">' + machineWindows.length + ' window' + (machineWindows.length !== 1 ? 's' : '') + '</span>';
      }
      html += '</button>';

      html += '<div class="sidebar-tab-list">';
      if (machineWindows.length === 0) {
        html += '<div class="sidebar-tab-empty">No windows</div>';
      } else {
        machineWindows.forEach(function (win) {
          var state = CA.windowStates[win.windowKey];
          var tabs = state ? (state.chatTabs || []) : [];
          var isActiveWin = win.windowKey === CA.activeWindowKey;

          var windowTitle = win.title || 'Cursor';
          var parts = windowTitle.split(' - ');
          var workspaceName = parts.length > 1 ? parts[parts.length - 2] : parts[0];
          workspaceName = workspaceName.replace(/\s*-\s*Cursor$/, '').trim() || 'Cursor';

          var winDotClass = 'sidebar-win-dot';
          if (state && state.agentStatus && state.agentStatus !== 'idle') {
            winDotClass += ' active';
          } else if (win.connected) {
            winDotClass += ' connected';
          } else {
            winDotClass += ' disconnected';
          }

          html += '<div class="sidebar-window-group' + (isActiveWin ? ' active-window' : '') + '">';
          html += '<button class="sidebar-window-header" data-window-key="' + CA.escapeHtml(win.windowKey) + '">';
          html += '<span class="' + winDotClass + '"></span>';
          html += '<span class="sidebar-window-label">' + CA.escapeHtml(workspaceName) + '</span>';
          if (tabs.length > 1) {
            html += '<span class="sidebar-window-count">' + tabs.length + '</span>';
          }
          html += '</button>';

          if (tabs.length > 1) {
            tabs.forEach(function (tab, ti) {
              var chatKey = win.windowKey + '|' + ti;
              var loopState = CA.getLoopStateForChat(chatKey);
              var tabDotClass = 'sidebar-tab-dot';
              if (loopState === 'active') {
                tabDotClass += ' active';
              } else if (loopState === 'looped') {
                tabDotClass += ' looped';
              } else if (tab.isActive && isActiveWin && state && state.agentStatus && state.agentStatus !== 'idle') {
                tabDotClass += ' active';
              } else if (tab.isActive) {
                tabDotClass += ' current';
              } else {
                tabDotClass += ' idle';
              }
              var isThisActive = isActiveWin && tab.isActive;
              html += '<button class="sidebar-tab-item' + (isThisActive ? ' active' : '') + '" data-window-key="' + CA.escapeHtml(win.windowKey) + '" data-tab-idx="' + ti + '">';
              html += '<span class="' + tabDotClass + '"></span>';
              html += '<span class="sidebar-tab-title">' + CA.escapeHtml(tab.title || 'Chat ' + (ti + 1)) + '</span>';
              html += '</button>';
            });
          } else if (tabs.length === 1) {
            var singleTab = tabs[0];
            var singleTitle = singleTab.title || state?.chatTitle || 'Chat';
            if (singleTitle !== workspaceName) {
              html += '<div class="sidebar-tab-subtitle">' + CA.escapeHtml(singleTitle) + '</div>';
            }
          }

          html += '</div>';
        });
      }
      html += '</div></div>';
    });

    sections.innerHTML = html;

    sections.querySelectorAll('.sidebar-section-header').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mk = btn.dataset.machineKey;
        if (mk) {
          CA.switchMachine(mk);
          CA.onFullRender();
        }
      });
    });

    sections.querySelectorAll('.sidebar-window-header').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var wk = btn.dataset.windowKey;
        if (wk) {
          CA.switchWindow(wk);
          CA.onFullRender();
        }
      });
    });

    sections.querySelectorAll('.sidebar-tab-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var wk = btn.dataset.windowKey;
        if (wk) {
          CA.switchWindow(wk);
          var tabIdx = btn.dataset.tabIdx;
          if (tabIdx !== undefined) {
            var tabs = CA.getTabsForActiveWindow();
            var tab = tabs[parseInt(tabIdx)];
            if (tab && tab.selectorPath) {
              CursorSocket.sendCommand('switch_tab', { selectorPath: tab.selectorPath });
            }
          }
          CA.onFullRender();
        }
      });
    });
  };

  CA.initMachineModal = function () {
    var modal = document.getElementById('machine-modal');
    var form = document.getElementById('machine-form');
    var closeBtn = document.getElementById('machine-modal-close');
    var testBtn = document.getElementById('machine-test');
    var addBtn = document.getElementById('btn-add-machine');
    var testResult = document.getElementById('machine-test-result');

    if (addBtn) {
      addBtn.addEventListener('click', function () {
        modal.classList.remove('hidden');
      });
    }

    closeBtn.addEventListener('click', function () {
      modal.classList.add('hidden');
    });

    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.classList.add('hidden');
    });

    testBtn.addEventListener('click', async function () {
      var host = document.getElementById('machine-host').value.trim();
      var port = document.getElementById('machine-port').value || 9222;
      if (!host) return;
      testResult.textContent = 'Testing...';
      testResult.className = 'test-result';
      try {
        var res = await fetch('/api/machines/' + encodeURIComponent(host + ':' + port) + '/test', { method: 'POST' });
        var data = await res.json();
        if (data.ok) {
          testResult.textContent = 'Connected! Found ' + data.targets + ' window(s)';
          testResult.className = 'test-result success';
        } else {
          testResult.textContent = 'Failed: ' + (data.error || 'Unknown error');
          testResult.className = 'test-result error';
        }
      } catch (e) {
        testResult.textContent = 'Error: ' + e.message;
        testResult.className = 'test-result error';
      }
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var name = document.getElementById('machine-name').value.trim();
      var host = document.getElementById('machine-host').value.trim();
      var port = parseInt(document.getElementById('machine-port').value) || 9222;
      if (!host) return;

      try {
        var res = await fetch('/api/machines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name || host, host: host, port: port }),
        });
        var data = await res.json();
        CA.showToast('Machine ' + data.status + ': ' + (name || host), 'success');
        modal.classList.add('hidden');
        form.reset();
        document.getElementById('machine-port').value = '9222';
        testResult.textContent = '';
      } catch (e) {
        CA.showToast('Failed to add machine', 'error');
      }
    });
  };
})();
