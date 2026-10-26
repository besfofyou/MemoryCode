import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { seedAdmin } from '../src/store.js';
import { config } from '../src/config.js';

/** 启动真实 HTTP 服务（随机端口），用 fetch 走完整链路 */
let server;
let baseUrl;

before(async () => {
  await seedAdmin();

  const app = createApp({ logger: false });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email, password) {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return res.body?.data?.token;
}

describe('health & 认证中间件', () => {
  it('GET /health 返回 ok', async () => {
    const res = await api('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('无 token 访问 /api/users 返回 401', async () => {
    const res = await api('/api/users');
    assert.equal(res.status, 401);
    assert.match(res.body.error.message, /令牌/);
  });

  it('错误 token 返回 401', async () => {
    const res = await api('/api/auth/me', { token: 'not-a-jwt' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'TOKEN_INVALID');
  });

  it('非 Bearer 格式返回 401', async () => {
    const res = await api('/api/auth/me', { token: 'Basic abc' });
    assert.equal(res.status, 401);
  });
});

describe('注册与登录', () => {
  let alice;

  it('非法邮箱返回 400', async () => {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Alice', email: 'bad-email', password: 'Passw0rd!' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details.field, 'email');
  });

  it('密码太短返回 400', async () => {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Alice', email: 'alice@example.com', password: '123' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details.field, 'password');
  });

  it('注册成功返回 201 且不泄漏 passwordHash', async () => {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Alice', email: 'alice@example.com', password: 'Passw0rd!' },
    });

    assert.equal(res.status, 201);
    alice = res.body.data.user;
    assert.ok(res.body.data.token);
    assert.equal(alice.role, 'user');
    assert.equal(alice.passwordHash, undefined);
  });

  it('重复邮箱返回 409', async () => {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Alice2', email: 'alice@example.com', password: 'Passw0rd!' },
    });
    assert.equal(res.status, 409);
  });

  it('密码错误返回 401 且不区分「用户不存在」', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'alice@example.com', password: 'WrongPass1!' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, '邮箱或密码不正确');
  });

  it('登录成功并能用 token 访问 /api/auth/me', async () => {
    const token = await login('alice@example.com', 'Passw0rd!');
    assert.ok(token);

    const res = await api('/api/auth/me', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.email, 'alice@example.com');
  });
});

describe('用户 CRUD 与权限', () => {
  let adminToken;
  let userToken;
  let aliceId;
  let bobId;

  before(async () => {
    adminToken = await login(config.seedAdmin.email, config.seedAdmin.password);
    userToken = await login('alice@example.com', 'Passw0rd!');

    const me = await api('/api/auth/me', { token: userToken });
    aliceId = me.body.data.user.id;
  });

  it('普通用户列表请求被拒绝 403', async () => {
    const res = await api('/api/users', { token: userToken });
    assert.equal(res.status, 403);
  });

  it('管理员可分页列出用户', async () => {
    const res = await api('/api/users?page=1&limit=5', { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.meta.page, 1);
    assert.equal(res.body.meta.limit, 5);
    assert.ok(res.body.data.every((u) => u.passwordHash === undefined));
  });

  it('非法分页参数返回 400', async () => {
    const res = await api('/api/users?limit=999', { token: adminToken });
    assert.equal(res.status, 400);
  });

  it('本人可读自己的资料', async () => {
    const res = await api(`/api/users/${aliceId}`, { token: userToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, aliceId);
  });

  it('不能读取他人资料 403', async () => {
    const me = await api('/api/auth/me', { token: adminToken });
    const res = await api(`/api/users/${me.body.data.user.id}`, { token: userToken });
    assert.equal(res.status, 403);
  });

  it('不存在的用户返回 404', async () => {
    const res = await api('/api/users/does-not-exist', { token: adminToken });
    assert.equal(res.status, 404);
  });

  it('管理员创建用户可以指定角色', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Bob', email: 'bob@example.com', password: 'Passw0rd!', role: 'user' },
    });
    assert.equal(res.status, 201);
    bobId = res.body.data.id;
    assert.equal(res.body.data.email, 'bob@example.com');
  });

  it('本人可更新自己的姓名', async () => {
    const res = await api(`/api/users/${aliceId}`, {
      method: 'PATCH',
      token: userToken,
      body: { name: 'Alice Cooper' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Alice Cooper');
  });

  it('本人不能给自己提权 403', async () => {
    const res = await api(`/api/users/${aliceId}`, {
      method: 'PATCH',
      token: userToken,
      body: { role: 'admin' },
    });
    assert.equal(res.status, 403);
  });

  it('空 patch 返回 400', async () => {
    const res = await api(`/api/users/${aliceId}`, {
      method: 'PATCH',
      token: userToken,
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('管理员可以修改角色', async () => {
    const res = await api(`/api/users/${bobId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'admin' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.role, 'admin');
  });

  it('普通用户不能删除用户 403', async () => {
    const res = await api(`/api/users/${bobId}`, { method: 'DELETE', token: userToken });
    assert.equal(res.status, 403);
  });

  it('管理员不能删除自己 400', async () => {
    const me = await api('/api/auth/me', { token: adminToken });
    const res = await api(`/api/users/${me.body.data.user.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(res.status, 400);
  });

  it('管理员删除用户返回 204，之后 404', async () => {
    const del = await api(`/api/users/${bobId}`, { method: 'DELETE', token: adminToken });
    assert.equal(del.status, 204);

    const res = await api(`/api/users/${bobId}`, { token: adminToken });
    assert.equal(res.status, 404);
  });

  it('未匹配路由返回 404 JSON', async () => {
    const res = await api('/api/unknown');
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /路由不存在/);
  });
});
