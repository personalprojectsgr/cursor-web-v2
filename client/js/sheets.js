(function () {
  'use strict';
  var CA = window.CursorApp;

  var FALLBACK_MODES = [
    { id: 'Agent', icon: '\u221E' },
    { id: 'Plan', icon: '\uD83D\uDCCB' },
    { id: 'Debug', icon: '\uD83D\uDD0D' },
    { id: 'Ask', icon: '\uD83D\uDCAC' },
  ];
  var FALLBACK_MODELS = ['Auto'];

  var MODE_ICON_MAP = {
    agent: '\u221E',
    plan: '\uD83D\uDCCB',
    debug: '\uD83D\uDD0D',
    ask: '\uD83D\uDCAC',
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && CA.activeSheet) CA.closeSheet();
  });

  CA.openSheet = function (type) {
    CA.closeSheet();
    CA.activeSheet = type;
    document.getElementById('sheet-overlay').classList.remove('hidden');
    if (type === 'mode') {
      document.getElementById('sheet-mode').classList.remove('hidden');
      renderModeSheet();
    } else if (type === 'model') {
      document.getElementById('sheet-model').classList.remove('hidden');
      renderModelSheet();
    }
  };

  CA.closeSheet = function () {
    document.getElementById('sheet-overlay').classList.add('hidden');
    document.getElementById('sheet-mode').classList.add('hidden');
    document.getElementById('sheet-model').classList.add('hidden');
    CA.activeSheet = null;
  };

  function fetchJSON(url) {
    return fetch(url)
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  function renderModeSheet() {
    var list = document.getElementById('sheet-mode-list');
    list.innerHTML = '<div class="sheet-loading">Loading modes\u2026</div>';

    var wKey = CA.activeWindowKey || '';
    fetchJSON('/api/mode-options?window=' + encodeURIComponent(wKey)).then(function (data) {
      list.innerHTML = '';
      var modes;
      if (data && data.ok && data.modes && data.modes.length > 0) {
        modes = data.modes.map(function (m) {
          return { id: m, icon: MODE_ICON_MAP[m.toLowerCase()] || '\u2699' };
        });
      } else {
        modes = FALLBACK_MODES;
      }

      var state = CA.getActiveState();
      var current = (data && data.current) || (state ? (state.mode || 'Agent') : 'Agent');

      modes.forEach(function (m) {
        var btn = document.createElement('button');
        var isSel = current.toLowerCase() === m.id.toLowerCase();
        btn.className = 'sheet-item' + (isSel ? ' selected' : '');
        btn.innerHTML =
          '<span class="sheet-item-icon">' + m.icon + '</span>' +
          '<span class="sheet-item-label">' + CA.escapeHtml(m.id) + '</span>' +
          (isSel ? '<span class="sheet-item-check">\u2713</span>' : '');
        btn.addEventListener('click', function () {
          CursorSocket.sendCommand('set_mode', { mode: m.id });
          CA.closeSheet();
          CA.showToast('Mode: ' + m.id, 'success');
        });
        list.appendChild(btn);
      });
    });
  }

  function renderModelSheet() {
    var list = document.getElementById('sheet-model-list');
    list.innerHTML = '<div class="sheet-loading">Loading models\u2026</div>';

    var wKey = CA.activeWindowKey || '';
    fetchJSON('/api/model-options?window=' + encodeURIComponent(wKey)).then(function (data) {
      list.innerHTML = '';
      var models;
      if (data && data.ok && data.models && data.models.length > 0) {
        models = data.models;
      } else {
        models = FALLBACK_MODELS;
      }

      var state = CA.getActiveState();
      var current = (data && data.current) || (state ? (state.model || 'Auto') : 'Auto');

      models.forEach(function (m) {
        var isSel = current.toLowerCase().includes(m.toLowerCase()) || m.toLowerCase().includes(current.toLowerCase());
        var btn = document.createElement('button');
        btn.className = 'sheet-item' + (isSel ? ' selected' : '');
        btn.innerHTML =
          '<span class="sheet-item-label">' + CA.escapeHtml(m) + '</span>' +
          (isSel ? '<span class="sheet-item-check">\u2713</span>' : '');
        btn.addEventListener('click', function () {
          CursorSocket.sendCommand('set_model', { model: m });
          CA.closeSheet();
          CA.showToast('Model: ' + m, 'success');
        });
        list.appendChild(btn);
      });
    });
  }
})();
