const fs = require('fs');
const path = require('path');
const { CDPClient, discoverTargets } = require('./cdp-client');
const { getExtractionScript } = require('./dom-extractor');
const { createLogger } = require('./logger');

const log = createLogger('machines');
const CONFIG_PATH = path.join(__dirname, '..', 'machines.json');
const EXTRACTION_SCRIPT = getExtractionScript();

class MachineManager {
  constructor(io) {
    this.io = io;
    this.machines = new Map();
    this.windows = new Map();
    this.states = new Map();
    this.pollingTimers = new Map();
    this.discoveryTimers = new Map();
    this.lastFingerprints = new Map();
    this.onStateUpdate = null;
    this.bridges = new Map();
    this.bridgeWindows = new Map();

    this.ensureLocalhost();
    this.loadConfig();
    this.watchConfig();
  }

  safeDisconnect(wInfo) {
    if (wInfo && wInfo.client && typeof wInfo.client.disconnect === 'function') {
      wInfo.client.disconnect();
    }
  }

  ensureLocalhost() {
    if (!this.machines.has('localhost:9222')) {
      this.machines.set('localhost:9222', {
        name: 'This PC',
        host: 'localhost',
        port: 9222,
        addedAt: Date.now(),
      });
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (Array.isArray(data)) {
          data.forEach(m => {
            const key = `${m.host}:${m.port || 9222}`;
            if (!this.machines.has(key)) {
              this.machines.set(key, {
                name: m.name || key,
                host: m.host,
                port: m.port || 9222,
                addedAt: m.addedAt || Date.now(),
              });
            }
          });
        }
      }
    } catch (e) {
      log.warn('Failed to load machines config', { error: e.message });
    }
  }

  saveConfig() {
    const data = [];
    this.machines.forEach((m, key) => {
      if (key !== 'localhost:9222') {
        data.push({ name: m.name, host: m.host, port: m.port, addedAt: m.addedAt });
      }
    });
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
      log.warn('Failed to save machines config', { error: e.message });
    }
  }

  watchConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        fs.watchFile(CONFIG_PATH, { interval: 5000 }, () => {
          log.info('Machines config changed, reloading');
          this.loadConfig();
          this.startAllDiscovery();
        });
      }
    } catch (e) {}
  }

  addMachine(name, host, port = 9222) {
    const key = `${host}:${port}`;
    if (this.machines.has(key)) {
      const existing = this.machines.get(key);
      existing.name = name;
      this.saveConfig();
      return { status: 'updated', key, machine: existing };
    }
    const machine = { name, host, port, addedAt: Date.now() };
    this.machines.set(key, machine);
    this.saveConfig();
    this.startDiscoveryFor(key);
    log.info('Machine added', { key, name });
    return { status: 'added', key, machine };
  }

  removeMachine(key) {
    if (key === 'localhost:9222') return { status: 'error', message: 'Cannot remove localhost' };
    if (!this.machines.has(key)) return { status: 'error', message: 'Machine not found' };

    this.stopDiscoveryFor(key);
    for (const [wKey, wInfo] of this.windows) {
      if (wInfo.machineKey === key) {
        this.safeDisconnect(wInfo);
        this.windows.delete(wKey);
        this.states.delete(wKey);
        this.stopPollingFor(wKey);
      }
    }
    this.machines.delete(key);
    this.saveConfig();
    log.info('Machine removed', { key });
    return { status: 'removed', key };
  }

  listMachines() {
    const result = [];
    this.machines.forEach((m, key) => {
      const windowCount = Array.from(this.windows.values()).filter(w => w.machineKey === key).length;
      result.push({
        key,
        name: m.name,
        host: m.host,
        port: m.port,
        online: windowCount > 0,
        windowCount,
      });
    });
    return result;
  }

  startAllDiscovery() {
    for (const key of this.machines.keys()) {
      this.startDiscoveryFor(key);
    }
  }

  stopAllDiscovery() {
    for (const timer of this.discoveryTimers.values()) clearInterval(timer);
    this.discoveryTimers.clear();
    for (const timer of this.pollingTimers.values()) clearInterval(timer);
    this.pollingTimers.clear();
    for (const wInfo of this.windows.values()) this.safeDisconnect(wInfo);
    this.windows.clear();
  }

  startDiscoveryFor(machineKey) {
    if (this.discoveryTimers.has(machineKey)) return;

    const discover = async () => {
      const machine = this.machines.get(machineKey);
      if (!machine) return;
      try {
        const targets = await discoverTargets(machine.host, machine.port);
        for (const target of targets) {
          const windowKey = `${machineKey}|${target.id}`;
          if (!this.windows.has(windowKey)) {
            await this.connectWindow(machineKey, target);
          }
        }
        const currentTargetIds = new Set(targets.map(t => t.id));
        for (const [wKey, wInfo] of this.windows) {
          if (wInfo.machineKey === machineKey && !currentTargetIds.has(wInfo.targetId)) {
            log.info('Window disappeared', { window: wKey });
            this.safeDisconnect(wInfo);
            this.windows.delete(wKey);
            this.states.delete(wKey);
            this.lastFingerprints.delete(wKey);
            this.stopPollingFor(wKey);
            this.broadcastFullState();
          }
        }
      } catch (e) {
        const connectedForMachine = Array.from(this.windows.values()).filter(w => w.machineKey === machineKey);
        if (connectedForMachine.length > 0) {
          connectedForMachine.forEach(w => {
            const wKey = `${machineKey}|${w.targetId}`;
            this.safeDisconnect(w);
            this.windows.delete(wKey);
            this.states.delete(wKey);
            this.lastFingerprints.delete(wKey);
            this.stopPollingFor(wKey);
          });
          this.broadcastFullState();
        }
      }
    };

    discover();
    const timer = setInterval(discover, 3000);
    this.discoveryTimers.set(machineKey, timer);
  }

  stopDiscoveryFor(machineKey) {
    const timer = this.discoveryTimers.get(machineKey);
    if (timer) {
      clearInterval(timer);
      this.discoveryTimers.delete(machineKey);
    }
  }

  async connectWindow(machineKey, target) {
    const windowKey = `${machineKey}|${target.id}`;
    if (this.windows.has(windowKey)) return;

    const client = new CDPClient(target.id, target.webSocketDebuggerUrl, target.title);
    client.onDisconnect = () => {
      log.info('Window CDP disconnected', { window: windowKey.substring(0, 30) });
      this.windows.delete(windowKey);
      this.states.delete(windowKey);
      this.lastFingerprints.delete(windowKey);
      this.stopPollingFor(windowKey);
      this.broadcastFullState();
    };

    try {
      await client.connect();
      this.windows.set(windowKey, {
        machineKey,
        targetId: target.id,
        client,
        title: target.title,
        lastPollMs: 0,
      });
      log.info('Window connected', { window: windowKey.substring(0, 40), title: target.title });
      await this.extractState(windowKey);
      this.startPollingFor(windowKey);
      this.broadcastFullState();
    } catch (e) {
      log.warn('Failed to connect window', { window: windowKey.substring(0, 30), error: e.message });
    }
  }

  async startPollingFor(windowKey) {
    if (this.pollingTimers.has(windowKey)) return;

    const wInfo = this.windows.get(windowKey);
    if (!wInfo || !wInfo.client.connected) return;

    try {
      await wInfo.client.send('DOM.enable');
      await wInfo.client.send('Runtime.enable');

      const OBSERVER_SCRIPT = `(() => {
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
      })()`;
      await wInfo.client.evaluate(OBSERVER_SCRIPT);
    } catch (e) {
      log.debug('Could not install DOM observer', { window: windowKey.substring(0, 30), error: e.message });
    }

    let interval = 150;
    let idleCount = 0;

    const poll = async () => {
      const w = this.windows.get(windowKey);
      if (!w || !w.client.connected) {
        this.stopPollingFor(windowKey);
        return;
      }

      let hasChanges = true;
      try {
        const flagResult = await w.client.evaluate(`(() => {
          const f = window.__cwChangeFlag;
          window.__cwChangeFlag = false;
          return f;
        })()`);
        hasChanges = flagResult === true || flagResult === 'true' || flagResult === null;
      } catch (e) {
        hasChanges = true;
      }

      if (hasChanges || idleCount >= 10) {
        await this.extractState(windowKey);
        idleCount = 0;
      } else {
        idleCount++;
      }

      const state = this.states.get(windowKey);
      const isActive = state && state.agentStatus && state.agentStatus !== 'idle';
      const newInterval = isActive ? 150 : 1500;

      if (newInterval !== interval) {
        interval = newInterval;
        this.stopPollingFor(windowKey);
        const timer = setInterval(poll, interval);
        this.pollingTimers.set(windowKey, timer);
      }
    };

    const timer = setInterval(poll, interval);
    this.pollingTimers.set(windowKey, timer);
  }

  stopPollingFor(windowKey) {
    const timer = this.pollingTimers.get(windowKey);
    if (timer) {
      clearInterval(timer);
      this.pollingTimers.delete(windowKey);
    }
  }

  async extractState(windowKey) {
    const wInfo = this.windows.get(windowKey);
    if (!wInfo || !wInfo.client.connected) return;

    try {
      const state = await wInfo.client.evaluateJSON(EXTRACTION_SCRIPT);
      if (!state || state.error) return;

      const prevFingerprint = this.lastFingerprints.get(windowKey);
      if (state.fingerprint === prevFingerprint) return;
      this.lastFingerprints.set(windowKey, state.fingerprint);

      state.windowKey = windowKey;
      state.machineName = this.machines.get(wInfo.machineKey)?.name || wInfo.machineKey;
      state.machineKey = wInfo.machineKey;
      this.states.set(windowKey, state);

      if (wInfo.title !== state.documentTitle) {
        wInfo.title = state.documentTitle;
      }

      this.broadcastFullState();
    } catch (e) {
      log.debug('Extraction error', { window: windowKey.substring(0, 30), error: e.message });
    }
  }

  broadcastFullState() {
    const payload = this.buildFullPayload();
    if (this.io) {
      this.io.to('phones').emit('state:full_update', payload);
    }
    if (this.onStateUpdate) this.onStateUpdate(payload);
  }

  sendStateTo(socket) {
    socket.emit('state:full_update', this.buildFullPayload());
  }

  async executeCommand(windowKey, type, params = {}) {
    const wInfo = this.windows.get(windowKey);
    if (!wInfo) return { ok: false, error: 'Window not found' };
    if (wInfo.isBridge) return { ok: false, error: 'Bridge window - route via bridge socket' };
    if (!wInfo.client || !wInfo.client.connected) return { ok: false, error: 'Window not connected' };

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
            if (currentMode.toLowerCase() === ${JSON.stringify(mode.toLowerCase())}) {
              return JSON.stringify({ ok: true, already: true });
            }

            current.click();
            await new Promise(r => setTimeout(r, 300));

            const items = document.querySelectorAll('.composer-unified-context-menu-item');
            let clicked = false;
            for (const item of items) {
              const label = item.querySelector('.monaco-highlighted-label') || item;
              const text = label.textContent.trim().split(/\\s/)[0];
              if (text.toLowerCase() === ${JSON.stringify(mode.toLowerCase())}) {
                item.click();
                clicked = true;
                break;
              }
            }

            if (!clicked) {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return JSON.stringify({ ok: false, error: 'Mode "' + ${JSON.stringify(mode)} + '" not found in ' + items.length + ' items' });
            }

            await new Promise(r => setTimeout(r, 200));
            const verify = auxBar.querySelector('.composer-unified-dropdown');
            const newMode = verify ? (verify.getAttribute('data-mode') || verify.textContent.trim()) : '?';
            return JSON.stringify({ ok: true, previous: currentMode, current: newMode });
          })()`);
          return result || { ok: false, error: 'Evaluation failed' };
        }

        case 'set_model': {
          const model = params.model || 'Auto';

          const existingMenu = await client.evaluateJSON(`(() => {
            const items = document.querySelectorAll('.composer-unified-context-menu-item');
            if (items.length > 0) {
              items[0].closest('[class*="menu"], [class*="context"]')?.remove();
            }
            return JSON.stringify({ cleared: items.length });
          })()`);

          const result = await client.evaluateJSON(`(async () => {
            const auxBar = document.getElementById('workbench.parts.auxiliarybar');
            if (!auxBar) return JSON.stringify({ ok: false, error: 'No aux bar' });

            const trigger = auxBar.querySelector('.composer-unified-dropdown-model');
            if (!trigger) return JSON.stringify({ ok: false, error: 'Model trigger not found' });

            const currentModel = trigger.textContent.trim();
            if (currentModel.toLowerCase() === ${JSON.stringify(model.toLowerCase())}) {
              return JSON.stringify({ ok: true, already: true });
            }

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
              if (text.toLowerCase().includes(${JSON.stringify(model.toLowerCase())})) {
                item.click();
                clicked = true;
                break;
              }
            }

            if (!clicked) {
              trigger.click();
              await new Promise(r => setTimeout(r, 100));
              return JSON.stringify({ ok: false, error: 'Model "' + ${JSON.stringify(model)} + '" not found in ' + items.length + ' items', available: Array.from(items).map(i => i.textContent.trim().substring(0, 30)) });
            }

            await new Promise(r => setTimeout(r, 300));
            const verify = auxBar.querySelector('.composer-unified-dropdown-model');
            const newModel = verify ? verify.textContent.trim() : '?';
            return JSON.stringify({ ok: true, previous: currentModel, current: newModel });
          })()`);
          return result || { ok: false, error: 'Evaluation failed' };
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
          const existingMenu2 = await client.evaluateJSON(`(() => {
            const items = document.querySelectorAll('.composer-unified-context-menu-item');
            if (items.length > 0) {
              items[0].closest('[class*="menu"], [class*="context"]')?.remove();
            }
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
            for (const item of items) {
              const text = item.textContent.trim();
              if (text) results.push(text);
            }

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
          return { ok: true, journal: journal };
        }

        default:
          return { ok: false, error: 'Unknown command: ' + type };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  registerBridge(socketId, machineKey, machineName) {
    this.bridges.set(socketId, { machineKey, machineName, connectedAt: Date.now() });
    if (!this.machines.has(machineKey)) {
      this.machines.set(machineKey, {
        name: machineName,
        host: machineKey.split(':')[0],
        port: parseInt(machineKey.split(':')[1] || '9222', 10),
        addedAt: Date.now(),
      });
    } else {
      this.machines.get(machineKey).name = machineName;
    }
    log.info('Bridge registered', { socketId: socketId.substring(0, 10), machineKey, name: machineName });
  }

  removeBridge(socketId) {
    const bridge = this.bridges.get(socketId);
    if (!bridge) return;
    this.bridges.delete(socketId);

    const keysToRemove = [];
    for (const [wKey, bSocketId] of this.bridgeWindows) {
      if (bSocketId === socketId) {
        keysToRemove.push(wKey);
      }
    }
    for (const wKey of keysToRemove) {
      this.bridgeWindows.delete(wKey);
      this.windows.delete(wKey);
      this.states.delete(wKey);
      this.lastFingerprints.delete(wKey);
    }

    log.info('Bridge removed', { socketId: socketId.substring(0, 10), windowsCleared: keysToRemove.length });
    if (keysToRemove.length > 0) this.broadcastFullState();
  }

  handleBridgeState(socketId, payload) {
    const bridge = this.bridges.get(socketId);
    if (!bridge) return;

    if (payload.windows) {
      const incomingKeys = new Set(payload.windows.map(w => w.windowKey));

      for (const [wKey, bSocketId] of this.bridgeWindows) {
        if (bSocketId === socketId && !incomingKeys.has(wKey)) {
          this.bridgeWindows.delete(wKey);
          this.windows.delete(wKey);
          this.states.delete(wKey);
          this.lastFingerprints.delete(wKey);
        }
      }

      for (const win of payload.windows) {
        this.bridgeWindows.set(win.windowKey, socketId);
        this.windows.set(win.windowKey, {
          machineKey: bridge.machineKey,
          targetId: win.windowKey.split('|').pop(),
          client: { connected: win.connected },
          title: win.title,
          isBridge: true,
        });
      }
    }

    if (payload.states) {
      for (const [wKey, state] of Object.entries(payload.states)) {
        this.states.set(wKey, state);
      }
    }

    this.broadcastFullState();
  }

  getBridgeForWindow(windowKey) {
    return this.bridgeWindows.get(windowKey) || null;
  }

  buildFullPayload() {
    const machines = this.listMachines();
    const windows = [];
    const states = {};

    for (const [wKey, wInfo] of this.windows) {
      const state = this.states.get(wKey);
      windows.push({
        windowKey: wKey,
        machineKey: wInfo.machineKey,
        machineName: this.machines.get(wInfo.machineKey)?.name || wInfo.machineKey,
        title: state?.chatTitle || state?.documentTitle || wInfo.title || 'Cursor',
        connected: wInfo.isBridge ? wInfo.client.connected : (wInfo.client && wInfo.client.connected),
      });
      if (state) states[wKey] = state;
    }

    return { machines, windows, states };
  }
}

module.exports = { MachineManager };
