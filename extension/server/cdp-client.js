const WebSocket = require('ws');
const http = require('http');
const { createLogger } = require('./logger');

const log = createLogger('cdp');

class CDPClient {
  constructor(targetId, wsUrl, windowTitle) {
    this.targetId = targetId;
    this.wsUrl = wsUrl;
    this.windowTitle = windowTitle || '';
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    this.connected = false;
    this.onDisconnect = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      const timeout = setTimeout(() => {
        reject(new Error('CDP connection timeout'));
        this.ws.terminate();
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.connected = true;
        log.info('CDP connected', { target: this.targetId.substring(0, 8), title: this.windowTitle });
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej, timer } = this.pending.get(msg.id);
            clearTimeout(timer);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
            else res(msg.result);
          }
        } catch (e) {}
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.pending.forEach(({ reject: rej, timer }) => {
          clearTimeout(timer);
          rej(new Error('CDP connection closed'));
        });
        this.pending.clear();
        if (this.onDisconnect) this.onDisconnect(this.targetId);
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.connected) reject(err);
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) return reject(new Error('Not connected'));
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result && result.result) {
      if (result.result.type === 'string') return result.result.value;
      if (result.result.value !== undefined) return result.result.value;
    }
    return null;
  }

  async evaluateJSON(expression) {
    const isAsync = /^\s*\(?\s*async\b/.test(expression);
    const raw = await this.evaluate(expression, isAsync);
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return raw;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

function discoverTargets(host, port) {
  return new Promise((resolve, reject) => {
    const url = `http://${host}:${port}/json/list`;
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
          resolve(pages);
        } catch (e) {
          reject(new Error('Invalid CDP response'));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Discovery timeout')); });
  });
}

module.exports = { CDPClient, discoverTargets };
