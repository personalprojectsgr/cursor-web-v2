const Redis = require('ioredis');
const { createLogger } = require('./logger');

const log = createLogger('redis');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || null;

const DEFERRED_TTL_S = 900;
const SESSION_TTL_S = 3600;

let redis = null;
let redisAvailable = false;

function createRedisClient(label) {
  if (!REDIS_URL) return null;
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 5000)),
    lazyConnect: false,
    enableReadyCheck: true,
  });
  client.on('connect', () => log.info(`${label} connected`));
  client.on('error', (err) => log.error(`${label} error`, { msg: err.message }));
  return client;
}

function init() {
  if (!REDIS_URL) {
    log.info('No REDIS_URL — running in-memory only');
    return false;
  }
  redis = createRedisClient('main');
  if (redis) {
    redisAvailable = true;
    redis.on('ready', () => { redisAvailable = true; });
    redis.on('error', () => { redisAvailable = false; });
  }
  return redisAvailable;
}

function isAvailable() {
  return redisAvailable && redis !== null;
}

function createSubscriber() {
  return createRedisClient('sub');
}

function deferredKey(chatKey) {
  return `mcp:deferred:${chatKey}`;
}

function inputChannel(chatKey) {
  return `mcp:input:${chatKey}`;
}

function machineDeferredKey(chatKey) {
  const parts = chatKey.split('|');
  if (parts.length < 3) return null;
  return `mcp:deferred:machine:${parts[0]}|*|${parts[2]}`;
}

async function storeDeferred(chatKey, result, id, t) {
  if (!isAvailable()) return false;
  try {
    const data = JSON.stringify({ result, id, t, chatKey, createdAt: Date.now() });
    await redis.set(deferredKey(chatKey), data, 'EX', DEFERRED_TTL_S);
    const mk = machineDeferredKey(chatKey);
    if (mk) await redis.set(mk, data, 'EX', DEFERRED_TTL_S);
    return true;
  } catch (e) {
    log.error('storeDeferred failed', { msg: e.message });
    return false;
  }
}

async function popDeferred(chatKey) {
  if (!isAvailable()) return null;
  try {
    let raw = await redis.get(deferredKey(chatKey));
    if (raw) {
      await redis.del(deferredKey(chatKey));
      const mk = machineDeferredKey(chatKey);
      if (mk) await redis.del(mk).catch(() => {});
    } else {
      const mk = machineDeferredKey(chatKey);
      if (mk) {
        raw = await redis.get(mk);
        if (raw) {
          await redis.del(mk);
          const d = JSON.parse(raw);
          if (d.chatKey) await redis.del(deferredKey(d.chatKey)).catch(() => {});
        }
      }
    }
    if (!raw) return null;
    const d = JSON.parse(raw);
    if ((Date.now() - d.createdAt) > DEFERRED_TTL_S * 1000) return null;
    return d;
  } catch (e) {
    log.error('popDeferred failed', { msg: e.message });
    return null;
  }
}

async function publishInput(chatKey) {
  if (!isAvailable()) return false;
  try {
    await redis.publish(inputChannel(chatKey), 'new_input');
    return true;
  } catch (e) {
    log.error('publishInput failed', { msg: e.message });
    return false;
  }
}

function subscribeInput(chatKey, onMessage) {
  const sub = createSubscriber();
  if (!sub) return null;
  const channel = inputChannel(chatKey);
  sub.subscribe(channel);
  sub.on('message', (ch) => {
    if (ch === channel) onMessage();
  });
  return sub;
}

function cleanupSubscriber(sub) {
  if (!sub) return;
  try {
    sub.unsubscribe();
    sub.quit();
  } catch (_) {}
}

async function saveSession(sessionId, data) {
  if (!isAvailable()) return;
  try {
    await redis.set(`mcp:session:${sessionId}`, JSON.stringify(data), 'EX', SESSION_TTL_S);
  } catch (_) {}
}

async function loadSession(sessionId) {
  if (!isAvailable()) return null;
  try {
    const raw = await redis.get(`mcp:session:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function deleteSession(sessionId) {
  if (!isAvailable()) return;
  try { await redis.del(`mcp:session:${sessionId}`); } catch (_) {}
}

module.exports = {
  init,
  isAvailable,
  storeDeferred,
  popDeferred,
  publishInput,
  subscribeInput,
  cleanupSubscriber,
  saveSession,
  loadSession,
  deleteSession,
  inputChannel,
};
