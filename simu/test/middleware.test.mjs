import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { createErrorHandler, HttpError } from '../src/middleware/errors.js';

/** 把日志写进数组，便于断言 */
function createTestLogger(level = 'debug') {
  const lines = [];
  const logger = createLogger({
    level,
    stream: {
      write(chunk) {
        lines.push(JSON.parse(chunk));
      },
    },
  });
  return { logger, lines };
}

function services(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('请求日志中间件', () => {
  let server;
  let baseUrl;
  let lines;

  before(async () => {
    const testLog = createTestLogger();
    lines = testLog.lines;
    server = await services(createApp({ logger: testLog.logger, skipRequestLog: [] }));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const findLog = (requestId) => lines.filter((l) => l.requestId === requestId);

  /** 日志在 res 'finish' 时写，可能与 fetch 返回存在毫秒级竞争，轮询等待 */
  async function waitForLog(requestId, predicate = () => true, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = findLog(requestId).find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  it('每个响应都带 X-Request-Id，并输出结构化日志', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);

    const requestId = res.headers.get('x-request-id');
    assert.match(requestId, /^[0-9a-f-]{36}$/);

    const entry = await waitForLog(requestId);
    assert.ok(entry, '应有一条日志');
    assert.equal(entry.level, 'info');
    assert.equal(entry.method, 'GET');
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, 'number');
    assert.equal(entry.path, '/health');
  });

  it('合法 X-Request-Id 会被透传', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { 'X-Request-Id': 'trace-abc.123' } });
    assert.equal(res.headers.get('x-request-id'), 'trace-abc.123');
    assert.ok(await waitForLog('trace-abc.123'), '应能按透传的 requestId 查到日志');
  });

  it('非法 X-Request-Id（含换行/过长）会被忽略', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { 'X-Request-Id': 'x'.repeat(200) },
    });
    const requestId = res.headers.get('x-request-id');
    assert.notEqual(requestId, 'x'.repeat(200));
    assert.match(requestId, /^[0-9a-f-]{36}$/);
  });

  it('4xx 记为 warn 级别，且错误体带 requestId', async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    assert.equal(res.status, 404);

    const requestId = res.headers.get('x-request-id');
    const body = await res.json();
    assert.equal(body.error.requestId, requestId);
    assert.equal(body.error.code, 'ROUTE_NOT_FOUND');

    const warnEntry = await waitForLog(requestId, (l) => l.level === 'warn');
    assert.ok(warnEntry);
    assert.equal(warnEntry.status, 404);
  });

  it('非法 JSON 返回 400 INVALID_JSON', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": "a@b.com", "password":',
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_JSON');
    assert.equal(body.error.details.type, 'entity.parse.failed');
  });

  it('请求体过大返回 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', padding: 'x'.repeat(200 * 1024) }),
    });

    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
  });
});

describe('统一错误处理中间件', () => {
  function fakeRes() {
    return {
      headersSent: false,
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  const req = { id: 'req-test-1', method: 'GET', originalUrl: '/boom' };

  it('未知异常统一 500，且不泄漏内部信息（生产模式）', () => {
    const { logger, lines } = createTestLogger();
    const handler = createErrorHandler({ logger, exposeStack: false });
    const res = fakeRes();

    handler(new Error('数据库连接串 postgres://user:pass@host'), req, res, () => {
      throw new Error('headersSent=false 时不应调用 next');
    });

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.message, '服务器内部错误');
    assert.equal(res.body.error.requestId, 'req-test-1');
    assert.equal(res.body.error.stack, undefined);

    const [entry] = lines;
    assert.equal(entry.level, 'error');
    assert.equal(entry.status, 500);
    assert.equal(entry.requestId, 'req-test-1');
    assert.match(entry.err.stack, /Error: 数据库连接串/);
  });

  it('开发模式下 5xx 带 stack 方便排查', () => {
    const handler = createErrorHandler({ logger: createTestLogger().logger, exposeStack: true });
    const res = fakeRes();

    handler(new Error('boom'), req, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error.stack, /boom/);
  });

  it('HttpError 的状态码/message/code/details 原样透出', () => {
    const handler = createErrorHandler({ logger: createTestLogger().logger });
    const res = fakeRes();

    handler(
      new HttpError(409, '该邮箱已注册', { code: 'EMAIL_TAKEN', details: { field: 'email' } }),
      req,
      res,
      () => {},
    );

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body.error, {
      status: 409,
      message: '该邮箱已注册',
      code: 'EMAIL_TAKEN',
      details: { field: 'email' },
      requestId: 'req-test-1',
    });
  });

  it('headersSent 时交给 Express 默认处理，避免二次写响应头', () => {
    const handler = createErrorHandler({ logger: createTestLogger().logger });
    const res = fakeRes();
    res.headersSent = true;

    let forwarded = null;
    handler(new Error('late error'), req, res, (err) => {
      forwarded = err;
    });

    assert.ok(forwarded instanceof Error);
    assert.equal(res.statusCode, 0, '不应再写响应');
  });
});
