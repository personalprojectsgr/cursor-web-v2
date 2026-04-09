const { io: ioClient } = require('socket.io-client');
const { CDPClient, discoverTargets } = require('./server/cdp-client');
const { getExtractionScript } = require('./server/dom-extractor');
const { createLogger } = require('./server/logger');

const log = createLogger('relay');
const EXTRACTION_SCRIPT = getExtractionScript();

const RELAY_URL = process.env.RELAY_URL || 'https://cursorremote.up.railway.app';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin123';
const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const MACHINE_NAME = process.env.MACHINE_NAME || require('os').hostname() || 'This PC';
const MACHINE_KEY = `${CDP_HOST}:${CDP_PORT}`;

const windows = new Map();
const states = new Map();
const lastFingerprints = new Map();
let socket = null;
let discoveryTimer = null;
let connected = false;

function connectToRelay() {
  log.info('Connecting to relay', { url: RELAY_URL });

  socket = ioClient(RELAY_URL, {
    auth: { password: AUTH_PASSWORD, role: 'bridge' },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    connected = true;
    log.info('Relay connected', { socketId: socket.id });
    socket.emit('bridge:hello', { machineKey: MACHINE_KEY, machineName: MACHINE_NAME });
    broadcastFullState();
  });

  socket.on('disconnect', (reason) => {
    connected = false;
    log.warn('Relay disconnected', { reason });
  });

  socket.on('connect_error', (err) => {
    log.debug('Relay connect error', { error: err.message });
  });

  socket.on('bridge:command', async (payload, ack) => {
    const { windowKey, type, params, commandId } = payload;
    try {
      const result = await executeCommand(windowKey, type, params || {});
      if (typeof ack === 'function') ack(result);
      else socket.emit('bridge:command_result', { commandId, ...result });
    } catch (e) {
      const errResult = { ok: false, error: e.message };
      if (typeof ack === 'function') ack(errResult);
      else socket.emit('bridge:command_result', { commandId, ...errResult });
    }
  });
}

async function discoverAndConnect() {
  try {
    const targets = await discoverTargets(CDP_HOST, CDP_PORT);

    const currentTargetIds = new Set(targets.map(t => t.id));
    for (const [wKey, wInfo] of windows) {
      if (!currentTargetIds.has(wInfo.targetId)) {
        log.info('Window disappeared', { window: wKey.substring(0, 40) });
        wInfo.client.disconnect();
        windows.delete(wKey);
        states.delete(wKey);
        lastFingerprints.delete(wKey);
        if (wInfo.pollTimer) clearInterval(wInfo.pollTimer);
        broadcastFullState();
      }
    }

    for (const target of targets) {
      const windowKey = `${MACHINE_KEY}|${target.id}`;
      if (!windows.has(windowKey)) {
        await connectWindow(target, windowKey);
      }
    }
  } catch (e) {
    const hadWindows = windows.size > 0;
    for (const [wKey, wInfo] of windows) {
      wInfo.client.disconnect();
      if (wInfo.pollTimer) clearInterval(wInfo.pollTimer);
    }
    windows.clear();
    states.clear();
    lastFingerprints.clear();
    if (hadWindows) broadcastFullState();
  }
}

async function connectWindow(target, windowKey) {
  const client = new CDPClient(target.id, target.webSocketDebuggerUrl, target.title);
  client.onDisconnect = () => {
    log.info('CDP disconnected', { window: windowKey.substring(0, 40) });
    const wInfo = windows.get(windowKey);
    if (wInfo && wInfo.pollTimer) clearInterval(wInfo.pollTimer);
    windows.delete(windowKey);
    states.delete(windowKey);
    lastFingerprints.delete(windowKey);
    broadcastFullState();
  };

  try {
    await client.connect();
    const wInfo = { targetId: target.id, client, title: target.title, pollTimer: null };
    windows.set(windowKey, wInfo);
    log.info('Window connected', { window: windowKey.substring(0, 40), title: target.title });

    await installObserver(client);
    await extractState(windowKey);
    startPolling(windowKey);
    broadcastFullState();
  } catch (e) {
    log.warn('Failed to connect window', { error: e.message });
  }
}

async function installObserver(client) {
  try {
    await client.send('DOM.enable');
    await client.send('Runtime.enable');

    await client.evaluate(`(() => {
      if (window.__cwObserver) return 'already_installed';
      window.__cwChangeFlag = false;
      window.__cwJournal = window.__cwJournal || [];
      window.__cwObserver = new MutationObserver((mutations) => {
        window.__cwChangeFlag = true;
        mutations.forEach(m => {
          m.addedNodes.forEach(n => {
            if (!n.className || typeof n.className !== 'string') return;
            const cls = n.className;
            if (cls.includes('composer') || cls.includes('tool') || cls.includes('todo') || cls.includes('context') || cls.includes('code-block') || cls.includes('search') || cls.includes('explored') || cls.includes('loading') || cls.includes('shine') || cls.includes('active')) {
              window.__cwJournal.push({ t: Date.now(), op: '+', cls: cls.substring(0, 150), tag: n.tagName, txt: (n.textContent || '').trim().substring(0, 80) });
              if (window.__cwJournal.length > 500) window.__cwJournal = window.__cwJournal.slice(-300);
            }
          });
        });
      });
      const auxBar = document.getElementById('workbench.parts.auxiliarybar');
      if (auxBar) {
        window.__cwObserver.observe(auxBar, { childList: true, subtree: true, characterData: true, attributes: true });
        return 'installed';
      }
      window.__cwObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      return 'installed_body';
    })()`);
  } catch (e) {
    log.debug('Observer install failed', { error: e.message });
  }
}

function startPolling(windowKey) {
  let interval = 150;
  let idleCount = 0;

  const poll = async () => {
    const wInfo = windows.get(windowKey);
    if (!wInfo || !wInfo.client.connected) {
      if (wInfo && wInfo.pollTimer) clearInterval(wInfo.pollTimer);
      return;
    }

    let hasChanges = true;
    try {
      const flagResult = await wInfo.client.evaluate(`(() => {
        const f = window.__cwChangeFlag;
        window.__cwChangeFlag = false;
        return f;
      })()`);
      hasChanges = flagResult === true || flagResult === 'true' || flagResult === null;
    } catch (e) {
      hasChanges = true;
    }

    if (hasChanges || idleCount >= 10) {
      await extractState(windowKey);
      idleCount = 0;
    } else {
      idleCount++;
    }

    const state = states.get(windowKey);
    const isActive = state && state.agentStatus && state.agentStatus !== 'idle';
    const newInterval = isActive ? 150 : 1500;

    if (newInterval !== interval) {
      interval = newInterval;
      if (wInfo.pollTimer) clearInterval(wInfo.pollTimer);
      wInfo.pollTimer = setInterval(poll, interval);
    }
  };

  const wInfo = windows.get(windowKey);
  if (wInfo) {
    wInfo.pollTimer = setInterval(poll, interval);
  }
}

async function extractState(windowKey) {
  const wInfo = windows.get(windowKey);
  if (!wInfo || !wInfo.client.connected) return;

  try {
    const state = await wInfo.client.evaluateJSON(EXTRACTION_SCRIPT);
    if (!state || state.error) return;

    const prevFingerprint = lastFingerprints.get(windowKey);
    if (state.fingerprint === prevFingerprint) return;
    lastFingerprints.set(windowKey, state.fingerprint);

    state.windowKey = windowKey;
    state.machineName = MACHINE_NAME;
    state.machineKey = MACHINE_KEY;
    states.set(windowKey, state);

    broadcastFullState();
  } catch (e) {
    log.debug('Extraction error', { error: e.message });
  }
}

function buildFullPayload() {
  const machines = [{
    key: MACHINE_KEY,
    name: MACHINE_NAME,
    host: CDP_HOST,
    port: CDP_PORT,
    online: windows.size > 0,
    windowCount: windows.size,
  }];

  const windowList = [];
  const stateMap = {};

  for (const [wKey, wInfo] of windows) {
    const state = states.get(wKey);
    windowList.push({
      windowKey: wKey,
      machineKey: MACHINE_KEY,
      machineName: MACHINE_NAME,
      title: state?.chatTitle || state?.documentTitle || wInfo.title || 'Cursor',
      connected: wInfo.client.connected,
    });
    if (state) stateMap[wKey] = state;
  }

  return { machines, windows: windowList, states: stateMap };
}

function broadcastFullState() {
  if (!socket || !connected) return;
  socket.emit('bridge:state', buildFullPayload());
}

async function executeCommand(windowKey, type, params) {
  const wInfo = windows.get(windowKey);
  if (!wInfo || !wInfo.client.connected) {
    return { ok: false, error: 'Window not connected' };
  }

  const client = wInfo.client;

  try {
    switch (type) {
      case 'send_message': {
        const text = params.text || '';
        const result = await client.evaluateJSON(`(() => {
          const input = document.querySelector('.aislash-editor-input');
          if (!input) return JSON.stringify({ ok: false, error: 'Input not found' });
          input.focus();
          input.innerHTML = '<p>' + ${JSON.stringify(text)}.replace(/\\n/g, '</p><p>') + '</p>';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(() => {
            const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
            input.dispatchEvent(enterEvent);
          }, 100);
          return JSON.stringify({ ok: true });
        })()`);
        return result || { ok: true };
      }

      case 'stop_generation': {
        const result = await client.evaluateJSON(`(() => {
          const stop = document.querySelector('.stop-button') || document.querySelector('.codicon-debug-stop');
          if (!stop) return JSON.stringify({ ok: false, error: 'Stop button not found' });
          stop.click();
          return JSON.stringify({ ok: true });
        })()`);
        return result || { ok: true };
      }

      case 'new_chat': {
        const result = await client.evaluateJSON(`(() => {
          const btn = document.querySelector('.codicon-add-two');
          if (btn) { btn.closest('a, button, [role="button"]')?.click() || btn.click(); return JSON.stringify({ ok: true }); }
          return JSON.stringify({ ok: false, error: 'New chat button not found' });
        })()`);
        return result || { ok: true };
      }

      case 'set_mode': {
        const mode = params.mode || 'Agent';
        const result = await client.evaluateJSON(`(async () => {
          const auxBar = document.getElementById('workbench.parts.auxiliarybar');
          if (!auxBar) return JSON.stringify({ ok: false, error: 'No aux bar' });
          const current = auxBar.querySelector('.composer-unified-dropdown');
          if (!current) return JSON.stringify({ ok: false, error: 'Mode dropdown not found' });
          const currentMode = current.getAttribute('data-mode') || current.textContent.trim();
          if (currentMode.toLowerCase() === ${JSON.stringify(mode.toLowerCase())}) return JSON.stringify({ ok: true, already: true });
          current.click();
          await new Promise(r => setTimeout(r, 300));
          const items = document.querySelectorAll('.composer-unified-context-menu-item');
          let clicked = false;
          for (const item of items) {
            const label = item.querySelector('.monaco-highlighted-label') || item;
            const text = label.textContent.trim().split(/\\s/)[0];
            if (text.toLowerCase() === ${JSON.stringify(mode.toLowerCase())}) { item.click(); clicked = true; break; }
          }
          if (!clicked) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return JSON.stringify({ ok: false, error: 'Mode not found' });
          }
          return JSON.stringify({ ok: true });
        })()`);
        return result || { ok: false, error: 'Evaluation failed' };
      }

      case 'set_model': {
        const model = params.model || 'Auto';
        await client.evaluateJSON(`(() => {
          const items = document.querySelectorAll('.composer-unified-context-menu-item');
          if (items.length > 0) items[0].closest('[class*="menu"], [class*="context"]')?.remove();
          return JSON.stringify({ cleared: items.length });
        })()`);
        const result = await client.evaluateJSON(`(async () => {
          const auxBar = document.getElementById('workbench.parts.auxiliarybar');
          if (!auxBar) return JSON.stringify({ ok: false, error: 'No aux bar' });
          const trigger = auxBar.querySelector('.composer-unified-dropdown-model');
          if (!trigger) return JSON.stringify({ ok: false, error: 'Model trigger not found' });
          const currentModel = trigger.textContent.trim();
          if (currentModel.toLowerCase() === ${JSON.stringify(model.toLowerCase())}) return JSON.stringify({ ok: true, already: true });
          trigger.click();
          let items = [];
          for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise(r => setTimeout(r, 200));
            items = document.querySelectorAll('.composer-unified-context-menu-item');
            if (items.length > 3) break;
          }
          let clicked = false;
          for (const item of items) {
            const text = item.textContent.trim();
            if (text.toLowerCase().includes(${JSON.stringify(model.toLowerCase())})) { item.click(); clicked = true; break; }
          }
          if (!clicked) { trigger.click(); return JSON.stringify({ ok: false, error: 'Model not found' }); }
          return JSON.stringify({ ok: true });
        })()`);
        return result || { ok: false, error: 'Evaluation failed' };
      }

      case 'click_action': {
        const selectorPath = params.selectorPath;
        if (!selectorPath) return { ok: false, error: 'No selector' };
        const result = await client.evaluateJSON(`(() => {
          const el = document.querySelector(${JSON.stringify(selectorPath)});
          if (!el) return JSON.stringify({ ok: false, error: 'Element not found' });
          el.click();
          return JSON.stringify({ ok: true });
        })()`);
        return result || { ok: true };
      }

      case 'switch_tab': {
        const selectorPath = params.selectorPath;
        if (!selectorPath) return { ok: false, error: 'No selector' };
        const result = await client.evaluateJSON(`(() => {
          const auxBar = document.getElementById('workbench.parts.auxiliarybar');
          if (!auxBar) return JSON.stringify({ ok: false, error: 'No aux bar' });
          const tab = auxBar.querySelector(${JSON.stringify(selectorPath)});
          if (!tab) return JSON.stringify({ ok: false, error: 'Tab not found' });
          tab.click();
          return JSON.stringify({ ok: true });
        })()`);
        return result || { ok: true };
      }

      case 'get_mode_options': {
        const modes = await client.evaluateJSON(`(async () => {
          const auxBar = document.getElementById('workbench.parts.auxiliarybar');
          if (!auxBar) return JSON.stringify({ ok: false, error: 'No aux bar' });
          const trigger = auxBar.querySelector('.composer-unified-dropdown');
          if (!trigger) return JSON.stringify({ ok: false, error: 'Mode dropdown not found' });
          const currentMode = trigger.getAttribute('data-mode') || trigger.textContent.trim();
          trigger.click();
          await new Promise(r => setTimeout(r, 400));
          const items = document.querySelectorAll('.composer-unified-context-menu-item');
          const results = [];
          for (const item of items) {
            const label = item.querySelector('.monaco-highlighted-label') || item;
            const text = label.textContent.trim().split(/\\s/)[0];
            if (text) results.push(text);
          }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await new Promise(r => setTimeout(r, 100));
          return JSON.stringify({ ok: true, current: currentMode, modes: results });
        })()`);
        return modes || { ok: false, error: 'Evaluation failed' };
      }

      case 'get_model_options': {
        await client.evaluateJSON(`(() => {
          const items = document.querySelectorAll('.composer-unified-context-menu-item');
          if (items.length > 0) items[0].closest('[class*="menu"], [class*="context"]')?.remove();
          return JSON.stringify({ cleared: items.length });
        })()`);
        const models = await client.evaluateJSON(`(async () => {
          const auxBar = document.getElementById('workbench.parts.auxiliarybar');
          if (!auxBar) return JSON.stringify({ ok: false, error: 'No aux bar' });
          const trigger = auxBar.querySelector('.composer-unified-dropdown-model');
          if (!trigger) return JSON.stringify({ ok: false, error: 'Model trigger not found' });
          const currentModel = trigger.textContent.trim();
          trigger.click();
          let items = [];
          for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise(r => setTimeout(r, 200));
            items = document.querySelectorAll('.composer-unified-context-menu-item');
            if (items.length > 3) break;
          }
          const results = [];
          for (const item of items) { const text = item.textContent.trim(); if (text) results.push(text); }
          trigger.click();
          await new Promise(r => setTimeout(r, 100));
          return JSON.stringify({ ok: true, current: currentModel, models: results });
        })()`);
        return models || { ok: false, error: 'Evaluation failed' };
      }

      case 'get_mutation_journal': {
        const journal = await client.evaluateJSON(`(() => {
          const j = window.__cwJournal || [];
          const unique = {};
          j.forEach(e => {
            const key = e.cls.substring(0, 60);
            if (!unique[key]) unique[key] = { count: 0, lastText: e.txt, tag: e.tag, firstSeen: e.t, lastSeen: e.t };
            unique[key].count++;
            unique[key].lastSeen = e.t;
            unique[key].lastText = e.txt;
          });
          return JSON.stringify({ total: j.length, unique: unique, recentRaw: j.slice(-50) });
        })()`);
        return { ok: true, journal };
      }

      default:
        return { ok: false, error: 'Unknown command: ' + type };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function start() {
  log.info('Relay agent starting', { relay: RELAY_URL, cdp: `${CDP_HOST}:${CDP_PORT}`, machine: MACHINE_NAME });
  connectToRelay();
  discoveryTimer = setInterval(discoverAndConnect, 3000);
  discoverAndConnect();
}

function stop() {
  log.info('Relay agent stopping');
  if (discoveryTimer) clearInterval(discoveryTimer);
  for (const [wKey, wInfo] of windows) {
    if (wInfo.pollTimer) clearInterval(wInfo.pollTimer);
    wInfo.client.disconnect();
  }
  windows.clear();
  states.clear();
  if (socket) socket.disconnect();
}

process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('uncaughtException', (err) => { log.error('Uncaught exception', { error: err.message, stack: err.stack }); });
process.on('unhandledRejection', (reason) => { log.error('Unhandled rejection', { reason: String(reason) }); });

start();
