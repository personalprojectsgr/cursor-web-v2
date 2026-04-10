const vscode = require('vscode');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let relayProcess = null;
let statusBarItem = null;
let outputChannel = null;
let restartCount = 0;
let autoRestartTimer = null;

const RELAY_SCRIPT = path.join(__dirname, 'relay-agent.js');
const RELAY_URL = process.env.CURSOR_WEB_RELAY_URL || 'https://cursorremote.up.railway.app';
const AUTH_PASSWORD = process.env.CURSOR_WEB_AUTH_PASSWORD || 'admin123';
const CDP_PORT = '9222';

function findNodeBinary() {
  const candidates = ['node', 'node.exe'];
  if (process.env.NVM_BIN) candidates.unshift(path.join(process.env.NVM_BIN, 'node'));
  if (process.env.NVM_SYMLINK) candidates.unshift(path.join(process.env.NVM_SYMLINK, 'node.exe'));

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    for (const name of ['node.exe', 'node']) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && !full.includes('Cursor')) return full;
      } catch (e) {}
    }
  }

  try {
    const which = execSync('where node', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0].trim();
    if (which && !which.includes('Cursor')) return which;
  } catch (e) {}

  return 'node';
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Cursor Web Relay');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'cursorWebRelay.restart';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorWebRelay.start', () => startRelay()),
    vscode.commands.registerCommand('cursorWebRelay.stop', () => stopRelay()),
    vscode.commands.registerCommand('cursorWebRelay.restart', () => { stopRelay(); setTimeout(startRelay, 500); })
  );

  waitForCdpThenStart();
}

function waitForCdpThenStart() {
  setStatus('waiting', 'Waiting for CDP...');
  let attempts = 0;

  const check = () => {
    attempts++;
    const req = http.get(`http://localhost:${CDP_PORT}/json/version`, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        outputChannel.appendLine(`CDP available on port ${CDP_PORT} after ${attempts} attempt(s)`);
        startRelay();
      });
    });
    req.on('error', (err) => {
      if (attempts === 1 || attempts % 10 === 0) {
        outputChannel.appendLine(`CDP not available on port ${CDP_PORT} (attempt ${attempts}): ${err.code || err.message}`);
        if (attempts === 1) {
          outputChannel.appendLine('Start Cursor with: cursor --remote-debugging-port=9222 --remote-allow-origins=*');
          outputChannel.appendLine('Or place {"remote-debugging-port":9222,"remote-allow-origins":"*"} in %APPDATA%\\Cursor\\argv.json and restart Cursor');
        }
      }
      setTimeout(check, 3000);
    });
    req.on('timeout', () => {
      req.destroy();
      setTimeout(check, 3000);
    });
  };

  check();
}

function startRelay() {
  if (relayProcess && !relayProcess.killed) return;

  try {
    const nodeBin = findNodeBinary();
    outputChannel.appendLine('Using node: ' + nodeBin);
    relayProcess = spawn(nodeBin, [RELAY_SCRIPT], {
      env: {
        ...process.env,
        RELAY_URL: RELAY_URL,
        AUTH_PASSWORD: AUTH_PASSWORD,
        CDP_HOST: 'localhost',
        CDP_PORT: CDP_PORT,
        MACHINE_NAME: 'This PC',
      },
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    setStatus('connecting', 'Connecting...');

    relayProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) outputChannel.appendLine(text);
      if (text.includes('Relay connected')) {
        setStatus('connected', 'Connected');
        restartCount = 0;
      }
      if (text.includes('Relay disconnected') || text.includes('connect error')) {
        setStatus('reconnecting', 'Reconnecting...');
      }
    });

    relayProcess.stderr.on('data', (data) => {
      outputChannel.appendLine('[ERR] ' + data.toString().trim());
    });

    relayProcess.on('exit', (code) => {
      outputChannel.appendLine(`Relay process exited with code ${code}`);
      relayProcess = null;

      if (code !== 0 && code !== null) {
        restartCount++;
        const delay = Math.min(2000 * Math.pow(2, restartCount - 1), 30000);
        setStatus('error', `Exited (${code}), restarting in ${delay / 1000}s...`);
        autoRestartTimer = setTimeout(() => waitForCdpThenStart(), delay);
      } else {
        setStatus('stopped', 'Stopped');
      }
    });

    relayProcess.on('error', (err) => {
      outputChannel.appendLine('[ERR] Failed to start: ' + err.message);
      setStatus('error', 'Failed to start');
      relayProcess = null;
    });

  } catch (e) {
    outputChannel.appendLine('[ERR] Spawn error: ' + e.message);
    setStatus('error', 'Spawn error');
  }
}

function stopRelay() {
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }
  if (relayProcess && !relayProcess.killed) {
    relayProcess.kill('SIGTERM');
    setTimeout(() => {
      if (relayProcess && !relayProcess.killed) {
        relayProcess.kill('SIGKILL');
      }
    }, 3000);
  }
  relayProcess = null;
  setStatus('stopped', 'Stopped');
}

function setStatus(state, text) {
  if (!statusBarItem) return;
  const icons = {
    waiting: '$(loading~spin)',
    connecting: '$(loading~spin)',
    connected: '$(check)',
    reconnecting: '$(sync~spin)',
    error: '$(error)',
    stopped: '$(circle-slash)',
  };
  statusBarItem.text = `${icons[state] || '$(circle)'} CW: ${text}`;
  statusBarItem.tooltip = `Cursor Web Relay - ${text}\nClick to restart`;
  statusBarItem.show();
}

function deactivate() {
  stopRelay();
  if (outputChannel) outputChannel.dispose();
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
