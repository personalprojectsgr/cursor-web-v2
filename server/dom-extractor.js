function getExtractionScript() {
  return `(() => {
    const auxBar = document.getElementById('workbench.parts.auxiliarybar');
    if (!auxBar || auxBar.offsetWidth === 0) return JSON.stringify({ error: 'no_aux_bar' });

    function textOf(el) {
      return el ? (el.textContent || '').trim() : '';
    }

    function safeAttr(el, attr) {
      return el && el.getAttribute ? (el.getAttribute(attr) || '') : '';
    }

    function extractHtml(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script, style').forEach(s => s.remove());
      return clone.innerHTML;
    }

    // === CHAT TABS ===
    const tabEls = auxBar.querySelectorAll('.composite-bar-action-tab');
    const chatTabs = [];
    tabEls.forEach((tab, i) => {
      const anchor = tab.querySelector('a, [role="tab"]') || tab;
      const ariaLabel = safeAttr(anchor, 'aria-label');
      const knownPanels = ['Explorer', 'Search', 'Source Control', 'Run and Debug', 'Remote Explorer', 'Extensions', 'Accounts', 'Manage'];
      const isPanel = knownPanels.some(p => ariaLabel.startsWith(p));
      if (isPanel) return;
      const label = tab.querySelector('.composite-bar-action-tab-label');
      chatTabs.push({
        index: i,
        title: textOf(label) || ariaLabel || 'Chat ' + (chatTabs.length + 1),
        isActive: tab.classList.contains('checked'),
        badge: textOf(tab.querySelector('.badge')) || null,
        selectorPath: '.composite-bar-action-tab:nth-child(' + (i + 1) + ')',
      });
    });

    // === ACTIVE COMPOSER ===
    const composerEl = auxBar.querySelector('[data-composer-id]');
    const composerId = safeAttr(composerEl, 'data-composer-id');
    const composerStatus = safeAttr(composerEl, 'data-composer-status');

    // === CHAT TITLE ===
    const titleEl = auxBar.querySelector('.auxiliary-bar-chat-title') || auxBar.querySelector('.title-label h2');
    const chatTitle = textOf(titleEl);

    // === MESSAGES ===
    const messages = [];
    const renderedMsgs = auxBar.querySelectorAll('.composer-rendered-message');
    renderedMsgs.forEach(rm => {
      const msgId = safeAttr(rm, 'data-message-id');
      const role = safeAttr(rm, 'data-message-role');
      const kind = safeAttr(rm, 'data-message-kind');
      const index = safeAttr(rm, 'data-message-index');

      if (role === 'human' || kind === 'human') {
        const humanMsg = rm.querySelector('.composer-human-message');
        const readonlyEditor = rm.querySelector('.aislash-editor-input-readonly');
        let text = '';
        if (readonlyEditor) {
          text = textOf(readonlyEditor);
        } else if (humanMsg) {
          text = textOf(humanMsg);
        }

        const contextPills = [];
        rm.querySelectorAll('.context-pill').forEach(pill => {
          const isImage = pill.classList.contains('context-pill-image');
          const img = pill.querySelector('img');
          const label = pill.querySelector('.context-pill-label');
          contextPills.push({
            type: isImage ? 'image' : 'file',
            src: img ? img.src : null,
            alt: img ? img.alt : null,
            label: label ? textOf(label) : null,
            text: textOf(pill),
          });
        });

        messages.push({
          id: msgId || 'human-' + index,
          type: 'human',
          text: text,
          contextPills: contextPills.length > 0 ? contextPills : undefined,
          index: parseInt(index) || messages.length,
        });
      } else if (role === 'ai' || kind === 'assistant' || kind === 'tool') {
        const parts = [];

        function processNode(node) {
          if (!node || !node.classList) return;
          const cls = node.className || '';

          if (cls.includes('composer-human-message-container')) return;

          if (cls.includes('composer-tool-call-container')) {
            const isMcp = cls.includes('composer-mcp-tool-call-block');
            const isTerminal = cls.includes('composer-terminal-tool-call-block-container');
            const isActive = cls.includes('active');
            const topHeaderText = node.querySelector('.composer-terminal-top-header-text');
            const topHeaderDesc = node.querySelector('.composer-terminal-top-header-description');
            const bodyContent = node.querySelector('.composer-tool-call-body-content');
            const isShining = !!node.querySelector('.make-shine');
            const hasSpinner = !!node.querySelector('.codicon-loading');

            if (isMcp) {
              const verb = node.querySelector('.mcp-header-verb');
              const toolName = node.querySelector('.mcp-header-tool-name');
              const serverName = node.querySelector('.mcp-header-server-name');
              const verbText = textOf(verb);
              const toolText = textOf(toolName);
              const serverText = textOf(serverName);
              const fullDesc = (verbText ? verbText + ' ' : '') + toolText + (serverText ? ' in ' + serverText : '');
              const isExpandable = node.classList.contains('expandable');
              const bodyEl = node.querySelector('.composer-tool-call-body-content');
              const bodyText = bodyEl ? textOf(bodyEl) : '';
              parts.push({
                type: 'tool_call',
                subtype: 'mcp',
                description: fullDesc || textOf(node).substring(0, 120),
                isRunning: isActive || isShining,
                isExpandable: isExpandable,
                verb: verbText,
                toolName: toolText,
                serverName: serverText,
                output: bodyText || undefined,
              });
            } else if (isTerminal) {
              const output = node.querySelector('.composer-terminal-output');
              const description = textOf(topHeaderDesc) || textOf(topHeaderText);
              parts.push({
                type: 'tool_call',
                subtype: 'terminal',
                description: description,
                output: textOf(output || bodyContent),
                isRunning: isActive || isShining || hasSpinner,
              });
            } else {
              const simpleHeader = node.querySelector('.composer-tool-call-simple-layout-header-content');
              const simpleBody = node.querySelector('.composer-tool-call-simple-layout-body');
              parts.push({
                type: 'tool_call',
                subtype: 'generic',
                description: textOf(topHeaderText) || textOf(simpleHeader) || textOf(node).substring(0, 120),
                content: textOf(simpleBody || bodyContent),
                isRunning: isActive || isShining || hasSpinner,
              });
            }
            return;
          }

          if (cls.includes('todo-list-container')) {
            const items = [];
            node.querySelectorAll('.ui-todo-item').forEach(item => {
              let status = 'pending';
              if (item.classList.contains('ui-todo-item--completed')) status = 'completed';
              else if (item.classList.contains('ui-todo-item--dimmed')) status = 'in_progress';
              const content = textOf(item.querySelector('.ui-todo-item__content'));
              if (content) items.push({ status: status, content: content });
            });
            const headerEl = node.querySelector('.todo-list-header-left-title');
            const header = headerEl ? textOf(headerEl) : '';
            parts.push({ type: 'todo_list', header: header, items: items });
            return;
          }

          if (cls.includes('composer-code-block-container')) {
            const filename = textOf(node.querySelector('.composer-code-block-filename'));
            const status = textOf(node.querySelector('.composer-code-block-status'));
            const fileIcon = node.querySelector('.composer-primary-toolcall-icon .show-file-icons');
            const fileIconCls = fileIcon ? (fileIcon.firstElementChild ? fileIcon.firstElementChild.className : '') : '';

            const codeRender = node.querySelector('.slim-code-render');
            const diffRender = node.querySelector('.slim-diff-render');
            const diffLines = [];
            if (diffRender) {
              diffRender.querySelectorAll('.slim-diff-line').forEach(line => {
                let lineType = 'unchanged';
                if (line.classList.contains('slim-diff-line-added')) lineType = 'added';
                else if (line.classList.contains('slim-diff-line-removed')) lineType = 'removed';
                else if (line.classList.contains('slim-diff-line-collapsed')) lineType = 'collapsed';
                const content = textOf(line.querySelector('.slim-diff-line-content'));
                if (lineType !== 'collapsed' || content) {
                  diffLines.push({ type: lineType, content: content });
                }
              });
            }

            let codeContent = '';
            if (codeRender) {
              codeRender.querySelectorAll('.slim-code-line').forEach(line => {
                codeContent += textOf(line.querySelector('.slim-code-line-content')) + '\\n';
              });
            }

            parts.push({
              type: 'code_block',
              filename: filename,
              status: status,
              fileIconClass: fileIconCls,
              code: codeContent.trimEnd(),
              diff: diffLines.length > 0 ? diffLines : null,
              isNew: status.includes('new'),
            });
            return;
          }

          if (cls.includes('ui-tool-call-line')) {
            const action = textOf(node.querySelector('.ui-tool-call-line-action'));
            const details = textOf(node.querySelector('.ui-tool-call-line-details'));
            parts.push({
              type: 'tool_call_line',
              action: action,
              details: details,
              isClickable: node.classList.contains('ui-tool-call-line--clickable'),
            });
            return;
          }

          if (cls.includes('tool-summary-hover-target')) {
            parts.push({ type: 'tool_summary', content: textOf(node) });
            return;
          }

          if (cls.includes('composer-ask-question-tool-call-block')) {
            const questionText = textOf(node.querySelector('.user-questionnaire-question-text'));
            const answers = [];
            node.querySelectorAll('.user-questionnaire-answer-item').forEach(item => {
              answers.push(textOf(item.querySelector('.user-questionnaire-answer-text') || item));
            });
            parts.push({ type: 'question', question: questionText, answers: answers });
            return;
          }

          if (cls.includes('todo-summary-sticky-container')) {
            parts.push({ type: 'todo_summary', content: textOf(node) });
            return;
          }

          if (cls.includes('markdown-root')) {
            const html = extractHtml(node);
            const text = textOf(node);
            if (text.length > 0) {
              parts.push({ type: 'markdown', html: html, text: text.substring(0, 5000) });
            }
            return;
          }

          if (cls.includes('composer-tool-former-message')) {
            Array.from(node.children).forEach(child => processNode(child));
            return;
          }

          if (node.children && node.children.length > 0) {
            Array.from(node.children).forEach(child => processNode(child));
          }
        }

        Array.from(rm.children).forEach(child => {
          if (child.children) Array.from(child.children).forEach(processNode);
          else processNode(child);
        });

        if (parts.length === 0) {
          const fallbackText = textOf(rm);
          if (fallbackText.length > 0) {
            parts.push({ type: 'markdown', html: extractHtml(rm), text: fallbackText.substring(0, 5000) });
          }
        }

        messages.push({
          id: msgId || 'ai-' + index,
          type: 'assistant',
          parts: parts,
          index: parseInt(index) || messages.length,
        });
      }
    });

    // === LOADING STATE ===
    const loadingIndicator = auxBar.querySelector('.loading-indicator-v3');
    const isLoading = loadingIndicator && loadingIndicator.offsetWidth > 0;

    // === AGENT STATUS (comprehensive) ===
    let agentStatus = 'idle';
    if (composerStatus === 'generating') agentStatus = 'generating';
    else if (isLoading) agentStatus = 'generating';

    const stopBtn = auxBar.querySelector('.stop-button, .codicon-debug-stop');
    if (stopBtn && stopBtn.offsetWidth > 0 && agentStatus === 'idle') {
      agentStatus = 'generating';
    }

    const anyShining = !!auxBar.querySelector('.make-shine');
    const anyActiveToolCall = !!auxBar.querySelector('.composer-tool-call-container.active');
    const anyLoadingTool = !!auxBar.querySelector('[data-tool-status="loading"]');
    const anySpinner = !!auxBar.querySelector('.codicon-loading.codicon-modifier-spin');

    if (agentStatus === 'idle' && (anyShining || anyActiveToolCall || anyLoadingTool || anySpinner)) {
      agentStatus = 'generating';
    }

    const activeMcpCall = auxBar.querySelector('.composer-mcp-tool-call-block.active');
    const mcpToolName = activeMcpCall ? textOf(activeMcpCall.querySelector('.mcp-header-tool-name')) : null;
    const mcpServerName = activeMcpCall ? textOf(activeMcpCall.querySelector('.mcp-header-server-name')) : null;

    // === TOOLBAR ===
    const toolbarSection = auxBar.querySelector('#composer-toolbar-section');
    const toolbarButtons = [];
    if (toolbarSection) {
      toolbarSection.querySelectorAll('.anysphere-text-button, .anysphere-secondary-button').forEach(btn => {
        toolbarButtons.push({
          text: textOf(btn),
          cls: (btn.className || '').substring(0, 150),
        });
      });
    }

    // === INPUT AREA ===
    const inputEl = auxBar.querySelector('.aislash-editor-input');
    const inputBox = auxBar.querySelector('.ai-input-full-input-box');
    const placeholder = inputEl ? textOf(inputEl.querySelector('.aislash-editor-placeholder') || inputEl) : '';
    const isEmpty = inputEl ? (textOf(inputEl) === '' || textOf(inputEl) === placeholder) : true;

    // === MODE / MODEL ===
    const modeDropdown = auxBar.querySelector('.composer-unified-dropdown');
    let mode = modeDropdown ? (modeDropdown.getAttribute('data-mode') || textOf(modeDropdown)) : 'Agent';
    mode = mode.charAt(0).toUpperCase() + mode.slice(1);

    const modelTrigger = auxBar.querySelector('.composer-unified-dropdown-model');
    let model = modelTrigger ? textOf(modelTrigger) : 'Auto';

    // === DOCUMENT TITLE (for workspace identification) ===
    const docTitle = document.title;

    // === FINGERPRINT (comprehensive) ===
    let contentFp = '';
    const tail = messages.slice(-5);
    tail.forEach(m => {
      if (m.type === 'human') {
        contentFp += 'H' + m.text.length + (m.contextPills ? 'P' + m.contextPills.length : '') + '|';
      } else if (m.parts) {
        m.parts.forEach(p => {
          const len = (p.text || p.output || p.content || p.description || p.header || '').length;
          const running = p.isRunning ? 'R' : 'D';
          const items = p.items ? p.items.length : 0;
          contentFp += p.type[0] + running + len + (items ? 'i' + items : '') + '|';
        });
      }
    });
    const mcpFp = activeMcpCall ? 'mcp:' + mcpToolName : 'nomcp';
    const fingerprint = composerId + ':' + composerStatus + ':' + agentStatus + ':' + messages.length + ':' + mcpFp + ':' + contentFp;

    return JSON.stringify({
      composerId: composerId,
      composerStatus: composerStatus,
      agentStatus: agentStatus,
      chatTitle: chatTitle,
      chatTabs: chatTabs,
      messages: messages,
      isLoading: isLoading,
      toolbarButtons: toolbarButtons,
      input: {
        isEmpty: isEmpty,
        placeholder: placeholder,
      },
      mode: mode,
      model: model,
      activeMcp: activeMcpCall ? { toolName: mcpToolName, serverName: mcpServerName } : null,
      documentTitle: docTitle,
      fingerprint: fingerprint,
      extractedAt: Date.now(),
    });
  })()`;
}

module.exports = { getExtractionScript };
