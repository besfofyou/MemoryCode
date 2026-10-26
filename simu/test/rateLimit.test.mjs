import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { MemoryStore, normalizeIp, rateLimit } from '../src/middleware/rateLimit.js';

/** 起一个真实监听端口的 app，测试结束后关闭 */
async function startApp(options) {
  const app = createApp(options);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  return {
    app,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('限流中间件（100 次/分钟/IP）', () => {
  let instance;

  before(async () => {
    instance = await startApp({ logger: false });
  });

  after(() => instance.close());

  it('前 100 次正常放行，第 101 次返回 429 RATE_LIMITED', async () => {
    const { baseUrl } = instance;

    const first = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(first.status, 401); // 未登录，但计入限流
    assert.equal(first.headers.get('ratelimit-limit'), '100');
    assert.equal(first.headers.get('ratelimit-remaining'), '99');

    // 已经用掉 1 次，再打 99 次
    for (let i = 0; i < 99; i += 1) {
      const res = await fetch(`${baseUrl}/api/auth/me`);
      assert.equal(res.status, 401, `第 ${i + 2} 次请求不应被限流`);
    }

    const limited = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('ratelimit-remaining'), '0');

    const retryAfter = Number(limited.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After 应为 1-60 秒, 实际 ${retryAfter}`);

    const body = await limited.json();
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(body.error.message, '请求过于频繁，请稍后再试');
    assert.deepEqual(body.error.details, { limit: 100, windowMs: 60000, retryAfter });

    // 超限后继续请求仍然 429，不会放行
    const again = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(again.status, 429);
  });
});

describe('按 IP 隔离与窗口恢复', () => {
  it('不同 IP 各自计数，互不影响', async () => {
    const instance = await startApp({ logger: false, rateLimit: { max: 2 } });
    instance.app.set('trust proxy', true); // 让 req.ip 取自 X-Forwarded-For

    try {
      const hit = (ip) =>
        fetch(`${instance.baseUrl}/api/auth/me`, { headers: { 'X-Forwarded-For': ip } });

      assert.equal((await hit('1.1.1.1')).status, 401);
      assert.equal((await hit('1.1.1.1')).status, 401);
      assert.equal((await hit('1.1.1.1')).status, 429);

      // 另一个 IP 仍有自己的 2 次配额
      assert.equal((await hit('2.2.2.2')).status, 401);
      assert.equal((await hit('2.2.2.2')).status, 401);
      assert.equal((await hit('2.2.2.2')).status, 429);
    } finally {
      await instance.close();
    }
  });

  it('窗口过期后配额自动恢复', async () => {
    const instance = await startApp({ logger: false, rateLimit: { windowMs: 80, max: 1 } });

    try {
      const hit = () => fetch(`${instance.baseUrl}/api/auth/me`);

      assert.equal((await hit()).status, 401);
      assert.equal((await hit()).status, 429);

      await sleep(120);

      assert.equal((await hit()).status, 401, '窗口过期后应重新放行');
    } finally {
      await instance.close();
    }
  });

  it('/health 默认不计数，不会被限流打挂', async () => {
    const instance = await startApp({ logger: false, rateLimit: { max: 1 } });

    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${instance.baseUrl}/health`);
        assert.equal(res.status, 200);
      }
    } finally {
      await instance.close();
    }
  });

  it('429 会走统一错误处理与请求日志（warn 级别）', async () => {
    const lines = [];
    const logger = createLogger({
      level: 'debug',
      stream: { write: (chunk) => lines.push(JSON.parse(chunk)) },
    });

    const instance = await startApp({ logger, rateLimit: { max: 1 } });

    try {
      await fetch(`${instance.baseUrl}/api/auth/me`);
      const limited = await fetch(`${instance.baseUrl}/api/auth/me`);
      assert.equal(limited.status, 429);

      const requestId = limited.headers.get('x-request-id');
      const body = await limited.json();
      assert.equal(body.error.requestId, requestId);
      assert.equal(body.error.code, 'RATE_LIMITED');

      // 请求日志的 msg 形如 `GET /api/auth/me 429`，区别于错误处理器的 `请求被拒绝` debug 日志
      const isRequestLog = (line) => line.msg === 'GET /api/auth/me 429';

      const deadline = Date.now() + 1000;
      let entry;
      while (Date.now() < deadline && !entry) {
        entry = lines.find((line) => line.requestId === requestId && isRequestLog(line));
        if (!entry) await sleep(10);
      }

      assert.ok(entry, '应有一条 429 的请求日志');
      assert.equal(entry.level, 'warn');
      assert.equal(entry.status, 429);
      assert.equal(typeof entry.durationMs, 'number');
    } finally {
      await instance.close();
    }
  });
});

describe('限流底层实现', () => {
  it('MemoryStore 固定窗口：计数、超限、过期重开', () => {
    const store = new MemoryStore();
    try {
      const first = store.hit('1.2.3.4', 0, 1000, 2);
      assert.deepEqual(first, { allowed: true, remaining: 1, resetAt: 1000, count: 1 });

      const second = store.hit('1.2.3.4', 10, 1000, 2);
      assert.equal(second.allowed, true);
      assert.equal(second.remaining, 0);

      const third = store.hit('1.2.3.4', 20, 1000, 2);
      assert.equal(third.allowed, false);
      assert.equal(third.remaining, 0);

      // 窗口到期后重新开窗
      const afterWindow = store.hit('1.2.3.4', 1000, 1000, 2);
      assert.equal(afterWindow.allowed, true);
      assert.equal(afterWindow.count, 1);

      assert.equal(store.size, 1);
      store.cleanup(5000);
      assert.equal(store.size, 0);
    } finally {
      store.close();
    }
  });

  it('IP 归一化：IPv4-mapped 折叠、IPv6 按 /64 归并', () => {
    assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIp('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(normalizeIp('2001:db8:1:2:ffff::1'), '2001:db8:1:2::/64');
    assert.equal(normalizeIp(undefined), 'unknown');
  });

  it('支持自定义 keyGenerator（例如按用户 ID 限流）', async () => {
    const app = createApp({
      logger: false,
      rateLimit: { max: 1, keyGenerator: (req) => req.get('x-api-key') ?? 'anonymous' },
    });

    const instance = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve({ server }));
    });

    try {
      const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
      const hit = (key) => fetch(`${baseUrl}/api/auth/me`, { headers: { 'x-api-key': key } });

      assert.equal((await hit('key-a')).status, 401);
      assert.equal((await hit('key-a')).status, 429);
      assert.equal((await hit('key-b')).status, 401, '不同 key 应有独立配额');
    } finally {
      await new Promise((resolve) => instance.server.close(resolve));
    }
  });

  it('rateLimit 可直接复用在单个路由上（更严格的登录限流）', async () => {
    const express = (await import('express')).default;
    const { createErrorHandler } = await import('../src/middleware/errors.js');

    const app = express();
    app.use(express.json());
    app.post('/login', rateLimit({ max: 2, windowMs: 60_000, skip: [] }), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(createErrorHandler({ logger: createLogger({ level: 'silent' }) }));

    const server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const hit = () => fetch(`${baseUrl}/login`, { method: 'POST' });

      assert.equal((await hit()).status, 200);
      assert.equal((await hit()).status, 200);
      assert.equal((await hit()).status, 429);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
