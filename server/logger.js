const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_COLORS = { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const minLevel = LEVELS[process.env.LOG_LEVEL || 'debug'] || 0;

function formatTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function formatContext(context) {
  if (!context || Object.keys(context).length === 0) return '';
  const ctx = Object.entries(context)
    .map(([k, v]) => {
      if (v === undefined || v === null) return null;
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k}=${val.length > 200 ? val.substring(0, 200) + '...' : val}`;
    })
    .filter(Boolean)
    .join(' ');
  return ctx ? ` ${DIM}{${ctx}}${RESET}` : '';
}

function formatMessage(level, module, message, context) {
  const ts = formatTimestamp();
  const color = LEVEL_COLORS[level] || '';
  const lvl = level.toUpperCase().padEnd(5);
  const mod = module ? `[${module}]` : '';
  return `${DIM}${ts}${RESET} ${color}${lvl}${RESET} ${mod} ${message}${formatContext(context)}`;
}

function emit(level, line) {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function createLogger(module) {
  const methods = {};

  for (const level of Object.keys(LEVELS)) {
    methods[level] = (message, context) => {
      if (LEVELS[level] < minLevel) return;
      emit(level, formatMessage(level, module, message, context));
    };
  }

  methods.timed = (label) => {
    const start = Date.now();
    return {
      end: (message, context) => {
        methods.info(message || label, { ...context, durationMs: Date.now() - start });
      },
      fail: (message, context) => {
        methods.error(message || `${label} failed`, { ...context, durationMs: Date.now() - start });
      },
    };
  };

  methods.child = (subModule) => createLogger(`${module}:${subModule}`);

  methods.withContext = (baseCtx) => {
    const wrapped = {};
    for (const level of Object.keys(LEVELS)) {
      wrapped[level] = (message, context) => {
        methods[level](message, { ...baseCtx, ...context });
      };
    }
    wrapped.timed = methods.timed;
    wrapped.child = methods.child;
    wrapped.withContext = (moreCtx) => methods.withContext({ ...baseCtx, ...moreCtx });
    return wrapped;
  };

  return methods;
}

module.exports = { createLogger };
