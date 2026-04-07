(function () {
  'use strict';
  var CA = window.CursorApp;

  CA.createElement = function (msg) {
    var el;
    switch (msg.type) {
      case 'human': el = createHumanEl(msg); break;
      case 'assistant': el = createAssistantEl(msg); break;
      case 'terminal': case 'edit': case 'mcp_tool': case 'tool_line': el = createToolEl(msg); break;
      case 'thought': el = createThoughtEl(msg); break;
      case 'loading': el = createLoadingEl(msg); break;
      default: el = createFallbackEl(msg); break;
    }
    el.dataset.msgType = msg.type;
    return el;
  };

  CA.updateElement = function (el, msg) {
    switch (msg.type) {
      case 'human': updateHumanEl(el, msg); break;
      case 'assistant': updateAssistantEl(el, msg); break;
      case 'terminal': case 'edit': case 'mcp_tool': case 'tool_line': updateToolEl(el, msg); break;
      case 'thought': updateThoughtEl(el, msg); break;
      default: break;
    }
  };

  function createHumanEl(msg) {
    var el = document.createElement('div');
    el.className = 'chat-el msg-human';
    el.dataset.id = msg.id;
    var bubble = document.createElement('div');
    bubble.className = 'human-bubble';
    var text = document.createElement('div');
    text.textContent = msg.text;
    bubble.appendChild(text);
    if (msg.images && msg.images.length > 0) {
      var imgRow = document.createElement('div');
      imgRow.className = 'flex gap-1 mt-1';
      msg.images.forEach(function (src) {
        var img = document.createElement('img');
        img.src = src;
        img.className = 'h-16 rounded-md cursor-pointer';
        imgRow.appendChild(img);
      });
      bubble.appendChild(imgRow);
    }
    el.appendChild(bubble);
    return el;
  }

  function updateHumanEl(el, msg) {
    var t = el.querySelector('.human-bubble > div');
    if (t) t.textContent = msg.text;
  }

  function createAssistantEl(msg) {
    var el = document.createElement('div');
    el.className = 'chat-el msg-assistant';
    el.dataset.id = msg.id;
    var bubble = document.createElement('div');
    bubble.className = 'assistant-bubble';
    var content = document.createElement('div');
    if (msg.html) {
      content.innerHTML = CA.sanitizeHtml(msg.html);
    } else {
      content.textContent = msg.text;
    }
    bubble.appendChild(content);
    el.appendChild(bubble);
    return el;
  }

  function updateAssistantEl(el, msg) {
    var content = el.querySelector('.assistant-bubble > div');
    if (!content) return;
    if (msg.html) {
      content.innerHTML = CA.sanitizeHtml(msg.html);
    } else {
      content.textContent = msg.text;
    }
  }

  function mapToolStatus(msg) {
    if (msg.type === 'terminal') return msg.isRunning ? 'loading' : 'completed';
    if (msg.type === 'edit') return 'completed';
    if (msg.type === 'mcp_tool') return msg.isRunning ? 'loading' : 'completed';
    return 'completed';
  }

  function createToolEl(msg) {
    var el = document.createElement('div');
    el.className = 'chat-el msg-tool';
    el.dataset.id = msg.id;
    var status = mapToolStatus(msg);
    var icon = document.createElement('span');
    icon.className = status === 'completed' ? 'tool-icon-done' : 'tool-icon-running';
    icon.textContent = status === 'completed' ? '\u2713' : '\u25CF';
    el.appendChild(icon);
    var label = document.createElement('span');
    label.textContent = msg.description || msg.name || msg.details || msg.filename || msg.type;
    el.appendChild(label);
    return el;
  }

  function updateToolEl(el, msg) {
    var fresh = createToolEl(msg);
    el.innerHTML = fresh.innerHTML;
  }

  function createThoughtEl(msg) {
    var el = document.createElement('div');
    el.className = 'chat-el msg-thought';
    el.dataset.id = msg.id;
    el.textContent = msg.duration ? 'Thought for ' + msg.duration : (msg.action || 'Thinking\u2026');
    return el;
  }

  function updateThoughtEl(el, msg) {
    el.textContent = msg.duration ? 'Thought for ' + msg.duration : (msg.action || 'Thinking\u2026');
  }

  function createLoadingEl(msg) {
    var el = document.createElement('div');
    el.className = 'chat-el msg-loading';
    el.dataset.id = msg.id;
    for (var i = 0; i < 3; i++) { var d = document.createElement('span'); el.appendChild(d); }
    return el;
  }

  function createFallbackEl(msg) {
    var el = document.createElement('div');
    el.className = 'chat-el text-xs text-muted-foreground';
    el.dataset.id = msg.id;
    el.textContent = msg.text || msg.type || '...';
    return el;
  }
})();
