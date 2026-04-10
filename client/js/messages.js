(function () {
  'use strict';
  var CA = window.CursorApp;

  CA.renderMessageList = function (messages) {
    var container = document.getElementById('messages');
    var emptyState = document.getElementById('empty-state');

    if (!messages || messages.length === 0) {
      emptyState.style.display = '';
      container.querySelectorAll('.chat-msg').forEach(function (el) { el.remove(); });
      return;
    }

    emptyState.style.display = 'none';

    var existingMap = new Map();
    container.querySelectorAll('.chat-msg').forEach(function (el) {
      existingMap.set(el.dataset.msgId, el);
    });

    var currentIds = new Set(messages.map(function (m) { return m.id; }));
    existingMap.forEach(function (el, id) {
      if (!currentIds.has(id)) el.remove();
    });

    messages.forEach(function (msg, idx) {
      var existing = existingMap.get(msg.id);
      if (existing) {
        updateMessage(existing, msg);
      } else {
        var el = createMessage(msg);
        var allEls = container.querySelectorAll('.chat-msg');
        if (idx < allEls.length) container.insertBefore(el, allEls[idx]);
        else container.appendChild(el);
      }
    });

    if (!CA.userScrolledUp) CA.scheduleAutoScroll();
  };

  function createMessage(msg) {
    var el = document.createElement('div');
    el.className = 'chat-msg';
    el.dataset.msgId = msg.id;
    el.dataset.type = msg.type;

    if (msg.type === 'human') {
      el.classList.add('msg-human');
      if (msg.contextPills && msg.contextPills.length > 0) {
        var pillsContainer = document.createElement('div');
        pillsContainer.className = 'context-pills';
        msg.contextPills.forEach(function (pill) {
          var pillEl = document.createElement('div');
          pillEl.className = 'context-pill' + (pill.type === 'image' ? ' context-pill-image' : '');
          if (pill.type === 'image' && pill.src) {
            var img = document.createElement('img');
            img.className = 'context-pill-img';
            img.alt = pill.alt || 'Attached image';
            img.src = pill.src;
            pillEl.appendChild(img);
          } else {
            var label = document.createElement('span');
            label.className = 'context-pill-label';
            label.textContent = pill.label || pill.text || '';
            pillEl.appendChild(label);
          }
          pillsContainer.appendChild(pillEl);
        });
        el.appendChild(pillsContainer);
      }
      var bubble = document.createElement('div');
      bubble.className = 'human-bubble';
      var inner = document.createElement('div');
      inner.className = 'human-bubble-inner';
      inner.textContent = msg.text || '';
      bubble.appendChild(inner);
      el.appendChild(bubble);
    } else if (msg.type === 'assistant') {
      el.classList.add('msg-assistant');
      renderAssistantParts(el, msg.parts || []);
    }

    return el;
  }

  function updateMessage(el, msg) {
    if (msg.type === 'human') {
      var inner = el.querySelector('.human-bubble-inner');
      if (inner) inner.textContent = msg.text || '';
    } else if (msg.type === 'assistant') {
      var parts = msg.parts || [];
      var existingParts = el.querySelectorAll('[data-part-idx]');
      var needsFullRebuild = existingParts.length !== parts.length;

      if (!needsFullRebuild) {
        for (var i = 0; i < parts.length; i++) {
          var partEl = existingParts[i];
          var part = parts[i];
          if (part.type === 'markdown' && partEl.classList.contains('md-content')) {
            var currentLen = (partEl.textContent || '').length;
            var newLen = (part.text || '').length;
            if (currentLen !== newLen) { needsFullRebuild = true; break; }
          } else if (part.type === 'tool_call') {
            var wasRunning = partEl.classList.contains('running');
            var nowRunning = !!part.isRunning;
            if (wasRunning !== nowRunning) { needsFullRebuild = true; break; }
            var oldDesc = (partEl.querySelector('.tool-call-desc') || {}).textContent || '';
            var newDesc = part.description || '';
            if (oldDesc.length !== newDesc.length) { needsFullRebuild = true; break; }
            var oldOutput = (partEl.querySelector('.tool-call-body-content') || {}).textContent || '';
            var newOutput = (part.output || part.content || '');
            if (oldOutput.length !== newOutput.length) { needsFullRebuild = true; break; }
          } else if (part.type === 'code_block') {
            var oldDiffCount = partEl.querySelectorAll('.diff-line').length;
            var newDiffCount = part.diff ? part.diff.length : 0;
            var codeEl = partEl.querySelector('pre code');
            var oldCodeLen = codeEl ? (codeEl.textContent || '').length : 0;
            var newCodeLen = (part.code || '').length;
            var oldFilename = (partEl.querySelector('.code-block-filename') || {}).textContent || '';
            var newFilename = part.filename || '';
            var wasStreaming = partEl.classList.contains('streaming');
            var nowStreaming = !!part.isStreaming;
            if (oldDiffCount !== newDiffCount || oldCodeLen !== newCodeLen || oldFilename !== newFilename || wasStreaming !== nowStreaming) {
              needsFullRebuild = true; break;
            }
          } else if (part.type === 'todo_list') {
            var oldItems = partEl.querySelectorAll('.todo-item').length;
            var newItems = (part.items || []).length;
            if (oldItems !== newItems) { needsFullRebuild = true; break; }
          } else if (part.type !== partEl.className.split(' ')[0].replace(/-/g, '_')) {
            needsFullRebuild = true; break;
          }
        }
      }

      if (needsFullRebuild) {
        el.innerHTML = '';
        renderAssistantParts(el, parts);
      }
    }
  }

  function renderAssistantParts(container, parts) {
    parts.forEach(function (part, idx) {
      var partEl = document.createElement('div');
      partEl.dataset.partIdx = idx;

      switch (part.type) {
        case 'markdown':
          renderMarkdown(partEl, part);
          break;
        case 'tool_call':
          renderToolCall(partEl, part);
          break;
        case 'code_block':
          renderCodeBlock(partEl, part);
          break;
        case 'question':
          renderQuestion(partEl, part);
          break;
        case 'todo_summary':
          renderTodo(partEl, part);
          break;
        case 'todo_list':
          renderTodoList(partEl, part);
          break;
        case 'tool_call_line':
          renderToolCallLine(partEl, part);
          break;
        case 'tool_summary':
          renderToolSummary(partEl, part);
          break;
        default:
          partEl.className = 'md-content';
          partEl.textContent = part.text || part.content || '';
      }

      container.appendChild(partEl);
    });
  }

  function renderMarkdown(el, part) {
    el.className = 'md-content';
    if (part.html) {
      el.innerHTML = CA.sanitizeHtml(part.html);
      el.querySelectorAll('pre code').forEach(function (code) {
        if (typeof Prism !== 'undefined') Prism.highlightElement(code);
      });
    } else {
      el.textContent = part.text || '';
    }
  }

  function renderToolCall(el, part) {
    var isMcp = part.subtype === 'mcp';
    var isTerminal = part.subtype === 'terminal';
    var isRunning = part.isRunning;
    var defaultExpanded = isRunning || isMcp;
    el.className = 'tool-call-block' + (defaultExpanded ? ' expanded' : '') + (isRunning ? ' running' : '');

    var header = document.createElement('div');
    header.className = 'tool-call-header';

    var left = document.createElement('div');
    left.className = 'tool-call-header-left';

    if (isRunning) {
      var spinner = document.createElement('span');
      spinner.className = 'tool-call-icon codicon codicon-loading codicon-modifier-spin';
      left.appendChild(spinner);
    }

    var icon = document.createElement('span');
    if (isMcp) {
      icon.className = 'tool-call-icon codicon codicon-cube-nodes';
    } else if (isTerminal) {
      icon.className = 'tool-call-icon codicon codicon-terminal';
    } else {
      icon.className = 'tool-call-icon codicon codicon-tools';
    }
    left.appendChild(icon);

    var chevron = document.createElement('span');
    chevron.className = 'tool-call-chevron codicon codicon-chevron-right';
    left.appendChild(chevron);

    var desc = document.createElement('span');
    desc.className = 'tool-call-desc' + (isRunning ? ' make-shine' : '');
    if (isMcp) {
      var verb = part.verb || 'Running';
      var toolName = part.toolName || '';
      var serverName = part.serverName || '';
      desc.innerHTML = '<span class="tool-call-verb">' + CA.escapeHtml(verb) + '</span> ' +
        '<strong>' + CA.escapeHtml(toolName) + '</strong>' +
        (serverName ? ' <span class="tool-call-server">in ' + CA.escapeHtml(serverName) + '</span>' : '');
    } else {
      desc.textContent = part.description || 'Tool call';
    }
    left.appendChild(desc);
    header.appendChild(left);

    var actions = document.createElement('div');
    actions.className = 'tool-call-actions';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'btn-icon';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<span class="codicon codicon-copy"></span>';
    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(part.output || part.content || part.description || '');
      CA.showToast('Copied', 'success');
    });
    actions.appendChild(copyBtn);
    header.appendChild(actions);

    header.addEventListener('click', function () {
      el.classList.toggle('expanded');
    });

    el.appendChild(header);

    if (part.output || part.content) {
      var body = document.createElement('div');
      body.className = 'tool-call-body';
      var content = document.createElement('div');
      content.className = 'tool-call-body-content';
      var rawText = part.output || part.content || '';
      if (isMcp) {
        content.innerHTML = formatMcpBody(rawText);
      } else {
        content.textContent = rawText;
      }
      body.appendChild(content);
      el.appendChild(body);
    }
  }

  function formatMcpBody(text) {
    if (!text) return '';
    var jsonStart = text.indexOf('{');
    var params = '';
    var result = '';
    if (jsonStart > 0) {
      params = text.substring(0, jsonStart);
      result = text.substring(jsonStart);
    } else if (jsonStart === 0) {
      result = text;
    } else {
      params = text;
    }
    var html = '';
    if (params) {
      var pairs = params.match(/[a-z_][a-z_0-9]*[^a-z_0-9{]/gi);
      if (pairs && pairs.length > 0) {
        html += '<div class="mcp-params">';
        var remaining = params;
        for (var i = 0; i < pairs.length; i++) {
          var key = pairs[i].replace(/[^a-z_0-9]/gi, '');
          var nextKey = i + 1 < pairs.length ? pairs[i + 1].replace(/[^a-z_0-9]/gi, '') : null;
          var keyIdx = remaining.indexOf(key);
          var valueStart = keyIdx + key.length;
          var valueEnd = nextKey ? remaining.indexOf(nextKey, valueStart) : remaining.length;
          var value = remaining.substring(valueStart, valueEnd).trim();
          html += '<div class="mcp-param"><span class="mcp-param-key">' +
            CA.escapeHtml(key) + '</span><span class="mcp-param-value">' +
            CA.escapeHtml(value) + '</span></div>';
        }
        html += '</div>';
      } else {
        html += '<div class="mcp-params"><div class="mcp-param"><span class="mcp-param-value">' + CA.escapeHtml(params) + '</span></div></div>';
      }
    }
    if (result) {
      try {
        var parsed = JSON.parse(result);
        html += '<pre class="mcp-result"><code>' + CA.escapeHtml(JSON.stringify(parsed, null, 2)) + '</code></pre>';
      } catch (e) {
        html += '<pre class="mcp-result"><code>' + CA.escapeHtml(result) + '</code></pre>';
      }
    }
    return html || CA.escapeHtml(text);
  }

  function renderCodeBlock(el, part) {
    el.className = 'code-block' + (part.isStreaming ? ' expanded streaming' : '') + (part.diff ? ' expanded' : '');

    var header = document.createElement('div');
    header.className = 'code-block-header';

    var fileInfo = document.createElement('div');
    fileInfo.className = 'code-block-file-info';

    if (part.fileIconClass) {
      var fileIcon = document.createElement('span');
      fileIcon.className = part.fileIconClass;
      fileInfo.appendChild(fileIcon);
    }

    if (part.isStreaming) {
      var spinner = document.createElement('span');
      spinner.className = 'code-block-spinner codicon codicon-loading codicon-modifier-spin';
      fileInfo.appendChild(spinner);
    }

    var filename = document.createElement('span');
    filename.className = 'code-block-filename' + (part.isStreaming ? ' make-shine' : '');
    filename.textContent = part.filename || 'file';
    if (part.isNew) filename.textContent += ' (new)';
    fileInfo.appendChild(filename);

    if (part.status) {
      var status = document.createElement('span');
      status.className = 'code-block-status' + (part.status.startsWith('-') ? ' removed' : '');
      status.textContent = part.status;
      fileInfo.appendChild(status);
    }

    header.appendChild(fileInfo);

    var chevron = document.createElement('span');
    chevron.className = 'tool-call-chevron codicon codicon-chevron-right';
    header.appendChild(chevron);

    header.addEventListener('click', function () {
      el.classList.toggle('expanded');
    });

    el.appendChild(header);

    var codeContent = document.createElement('div');
    codeContent.className = 'code-block-content';

    if (part.diff && part.diff.length > 0) {
      var diffContainer = document.createElement('div');
      diffContainer.className = 'diff-container';
      part.diff.forEach(function (line) {
        var lineEl = document.createElement('div');
        lineEl.className = 'diff-line ' + line.type;
        var indicator = document.createElement('div');
        indicator.className = 'diff-indicator';
        lineEl.appendChild(indicator);
        var lineContent = document.createElement('div');
        lineContent.className = 'diff-line-content';
        lineContent.textContent = line.content || '';
        lineEl.appendChild(lineContent);
        diffContainer.appendChild(lineEl);
      });
      codeContent.appendChild(diffContainer);
    } else if (part.code) {
      var pre = document.createElement('pre');
      var code = document.createElement('code');
      var lang = guessLanguage(part.filename || '');
      if (lang) code.className = 'language-' + lang;
      code.textContent = part.code;
      pre.appendChild(code);
      codeContent.appendChild(pre);
      if (!part.isStreaming && typeof Prism !== 'undefined') Prism.highlightElement(code);
    }

    el.appendChild(codeContent);
  }

  function renderQuestion(el, part) {
    el.className = 'question-block';
    var qText = document.createElement('div');
    qText.className = 'question-text';
    qText.textContent = part.question || '';
    el.appendChild(qText);

    if (part.answers && part.answers.length > 0) {
      var answers = document.createElement('div');
      answers.className = 'question-answers';
      part.answers.forEach(function (a) {
        var item = document.createElement('div');
        item.className = 'question-answer';
        item.textContent = a;
        answers.appendChild(item);
      });
      el.appendChild(answers);
    }
  }

  function renderTodo(el, part) {
    el.className = 'todo-summary';
    el.textContent = part.content || '';
  }

  function renderTodoList(el, part) {
    el.className = 'todo-list-block';

    var header = document.createElement('div');
    header.className = 'todo-list-header';
    var icon = document.createElement('span');
    icon.className = 'codicon codicon-checklist';
    header.appendChild(icon);
    var title = document.createElement('span');
    title.className = 'todo-list-title';
    title.textContent = part.header || 'To-dos';
    header.appendChild(title);
    el.appendChild(header);

    if (part.items && part.items.length > 0) {
      var list = document.createElement('div');
      list.className = 'todo-items';
      part.items.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'todo-item todo-item--' + (item.status || 'pending');
        var indicator = document.createElement('span');
        indicator.className = 'todo-item-indicator';
        if (item.status === 'completed') {
          indicator.innerHTML = '<span class="codicon codicon-pass-filled"></span>';
        } else if (item.status === 'in_progress') {
          indicator.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin"></span>';
        } else {
          indicator.innerHTML = '<span class="todo-item-circle"></span>';
        }
        row.appendChild(indicator);
        var content = document.createElement('span');
        content.className = 'todo-item-content';
        content.textContent = item.content || '';
        row.appendChild(content);
        list.appendChild(row);
      });
      el.appendChild(list);
    }
  }

  var TOOL_LINE_ICONS = {
    read: 'codicon-file',
    grepped: 'codicon-search',
    searched: 'codicon-search',
    grep: 'codicon-search',
    waited: 'codicon-clock',
    'ran mcp': 'codicon-cube-nodes',
    'run mcp': 'codicon-cube-nodes',
    commit: 'codicon-git-commit',
    committed: 'codicon-git-commit',
    shell: 'codicon-terminal',
    ran: 'codicon-terminal',
    wrote: 'codicon-edit',
    edited: 'codicon-edit',
    created: 'codicon-new-file',
    deleted: 'codicon-trash',
    listed: 'codicon-list-flat',
    fetched: 'codicon-cloud-download',
  };

  function getToolLineIcon(action) {
    var key = (action || '').toLowerCase().trim();
    if (TOOL_LINE_ICONS[key]) return TOOL_LINE_ICONS[key];
    for (var k in TOOL_LINE_ICONS) {
      if (key.indexOf(k) === 0) return TOOL_LINE_ICONS[k];
    }
    return 'codicon-circle-small-filled';
  }

  function renderToolCallLine(el, part) {
    el.className = 'tool-call-line' + (part.isClickable ? ' clickable' : '');
    var icon = document.createElement('span');
    icon.className = 'tool-call-line-icon codicon ' + getToolLineIcon(part.action);
    el.appendChild(icon);
    var actionEl = document.createElement('span');
    actionEl.className = 'tool-call-line-action';
    actionEl.textContent = part.action || '';
    el.appendChild(actionEl);
    var detailsEl = document.createElement('span');
    detailsEl.className = 'tool-call-line-details';
    detailsEl.textContent = part.details || '';
    el.appendChild(detailsEl);
  }

  function renderToolSummary(el, part) {
    el.className = 'tool-summary-line';
    el.textContent = part.content || '';
  }

  function guessLanguage(filename) {
    var ext = filename.split('.').pop().toLowerCase();
    var map = {
      js: 'javascript', ts: 'typescript', jsx: 'jsx', tsx: 'tsx',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
      java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp',
      c: 'c', h: 'c', hpp: 'cpp', css: 'css', scss: 'scss',
      html: 'html', xml: 'xml', json: 'json', yaml: 'yaml',
      yml: 'yaml', md: 'markdown', sql: 'sql', sh: 'bash',
      bash: 'bash', zsh: 'bash', ps1: 'powershell', dockerfile: 'docker',
      toml: 'toml', ini: 'ini', lua: 'lua', r: 'r', swift: 'swift',
    };
    return map[ext] || null;
  }

  CA.renderLoadingIndicator = function (isLoading) {
    var container = document.getElementById('messages');
    var existing = container.querySelector('.loading-indicator');
    if (isLoading && !existing) {
      var el = document.createElement('div');
      el.className = 'loading-indicator';
      el.innerHTML = '<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>';
      container.appendChild(el);
      if (!CA.userScrolledUp) CA.scheduleAutoScroll();
    } else if (!isLoading && existing) {
      existing.remove();
    }
  };
})();
