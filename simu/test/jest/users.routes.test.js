import { beforeEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';

import { buildApp } from './helpers/buildApp.js';
import { dbMock, installStoreMock, resetDbMock } from './helpers/mockStore.js';

// 先 mock 数据层（数据库连接），再动态 import 用到它的路由
await installStoreMock();

const { default: usersRouter } = await import('../../src/routes/users/users.routes.js');
const { signToken } = await import('../../src/middleware/auth.js');
const { HttpError } = await import('../../src/middleware/errors.js');

const app = buildApp({ usersRouter });

const admin = {
  id: 'u-admin',
  name: 'Admin',
  email: 'admin@example.com',
  role: 'admin',
  passwordHash: 'stub-hash',
};
const alice = {
  id: 'u-alice',
  name: 'Alice',
  email: 'alice@example.com',
  role: 'user',
  passwordHash: 'stub-hash',
};

const auth = (user) => ({ Authorization: `Bearer ${signToken(user)}` });

beforeEach(() => {
  resetDbMock();
  // authenticate 会回查用户，这里让 mock 数据库返回固定两个人
  dbMock.findById.mockImplementation(
    (id) => [admin, alice].find((user) => user.id === id) ?? null,
  );
});

describe('GET /api/users', () => {
  it('管理员可按分页参数查询，并返回 meta', async () => {
    dbMock.list.mockReturnValue({ items: [alice], total: 3, page: 2, limit: 1 });

    const res = await request(app).get('/api/users?page=2&limit=1').set(auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).not.toHaveProperty('passwordHash');
    expect(res.body.meta).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
    expect(dbMock.list).toHaveBeenCalledWith({
      page: 2,
      limit: 1,
      q: undefined,
      role: undefined,
    });
  });

  it('未携带 token 时返回 401，且不查询数据库', async () => {
    const res = await request(app).get('/api/users');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_MISSING');
    expect(dbMock.list).not.toHaveBeenCalled();
  });

  it('普通用户访问列表返回 403，且不查询数据库', async () => {
    const res = await request(app).get('/api/users').set(auth(alice));

    expect(res.status).toBe(403);
    expect(dbMock.list).not.toHaveBeenCalled();
  });

  it('非法分页参数返回 400，且不查询数据库', async () => {
    const res = await request(app).get('/api/users?limit=999').set(auth(admin));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.field).toBe('limit');
    expect(dbMock.list).not.toHaveBeenCalled();
  });
});

describe('GET /api/users/:id', () => {
  it('本人可以读取自己的资料，响应不含 passwordHash', async () => {
    const res = await request(app).get(`/api/users/${alice.id}`).set(auth(alice));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: alice.id, email: alice.email });
    expect(res.body.data).not.toHaveProperty('passwordHash');
  });

  it('普通用户读取他人资料返回 403', async () => {
    const res = await request(app).get(`/api/users/${admin.id}`).set(auth(alice));

    expect(res.status).toBe(403);
  });

  it('管理员可以读取任意用户', async () => {
    const res = await request(app).get(`/api/users/${alice.id}`).set(auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(alice.id);
  });

  it('用户不存在时返回 404', async () => {
    const res = await request(app).get('/api/users/not-exist').set(auth(admin));

    expect(res.status).toBe(404);
    expect(dbMock.findById).toHaveBeenCalledWith('not-exist');
  });
});

describe('POST /api/users', () => {
  it('管理员创建用户，默认角色为 user，密码只以 hash 形式进入数据层', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(admin))
      .send({ name: 'Bob', email: 'bob@example.com', password: 'Passw0rd!' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Bob', email: 'bob@example.com', role: 'user' });
    expect(res.body.data).not.toHaveProperty('passwordHash');

    expect(dbMock.create).toHaveBeenCalledTimes(1);
    expect(dbMock.create).toHaveBeenCalledWith({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Passw0rd!',
      role: 'user',
    });
  });

  it('普通用户创建用户返回 403，且不写库', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(alice))
      .send({ name: 'Bob', email: 'bob@example.com', password: 'Passw0rd!' });

    expect(res.status).toBe(403);
    expect(dbMock.create).not.toHaveBeenCalled();
  });

  it('参数非法返回 400，且不写库', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(admin))
      .send({ name: 'Bob', email: 'not-an-email', password: 'Passw0rd!' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe('email');
    expect(dbMock.create).not.toHaveBeenCalled();
  });

  it('数据层报唯一键冲突时返回 409', async () => {
    dbMock.create.mockImplementation(async () => {
      throw new HttpError(409, '该邮箱已注册', { code: 'EMAIL_TAKEN', details: { field: 'email' } });
    });

    const res = await request(app)
      .post('/api/users')
      .set(auth(admin))
      .send({ name: 'Bob', email: 'bob@example.com', password: 'Passw0rd!' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });
});

describe('PATCH /api/users/:id', () => {
  it('本人只能改自己的基本字段，role/password 透传为 undefined', async () => {
    const res = await request(app)
      .patch(`/api/users/${alice.id}`)
      .set(auth(alice))
      .send({ name: 'Alice Cooper' });

    expect(res.status).toBe(200);
    expect(dbMock.update).toHaveBeenCalledWith(alice.id, {
      name: 'Alice Cooper',
      email: undefined,
      password: undefined,
      role: undefined,
    });
  });

  it('本人提权返回 403，且不写库', async () => {
    const res = await request(app)
      .patch(`/api/users/${alice.id}`)
      .set(auth(alice))
      .send({ role: 'admin' });

    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('普通用户修改他人返回 403', async () => {
    const res = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set(auth(alice))
      .send({ name: 'Hacked' });

    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('空 patch 返回 400', async () => {
    const res = await request(app)
      .patch(`/api/users/${alice.id}`)
      .set(auth(alice))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMPTY_PATCH');
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('数据层返回 404 时原样透出', async () => {
    dbMock.update.mockImplementation(async () => {
      throw new HttpError(404, '用户不存在');
    });

    const res = await request(app)
      .patch('/api/users/ghost')
      .set(auth(admin))
      .send({ name: 'Ghost' });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('用户不存在');
  });
});

describe('DELETE /api/users/:id', () => {
  it('管理员删除他人返回 204，并调用数据层删除', async () => {
    const res = await request(app).delete(`/api/users/${alice.id}`).set(auth(admin));

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(dbMock.remove).toHaveBeenCalledWith(alice.id);
  });

  it('管理员不能删除自己，且不写库', async () => {
    const res = await request(app).delete(`/api/users/${admin.id}`).set(auth(admin));

    expect(res.status).toBe(400);
    expect(dbMock.remove).not.toHaveBeenCalled();
  });

  it('普通用户删除返回 403，且不写库', async () => {
    const res = await request(app).delete(`/api/users/${admin.id}`).set(auth(alice));

    expect(res.status).toBe(403);
    expect(dbMock.remove).not.toHaveBeenCalled();
  });
});

describe('数据库异常', () => {
  it('连接失败时返回 500，且不泄漏内部错误信息', async () => {
    // store.list 是同步 API（真实实现返回对象，不是 Promise），mock 保持同样的签名
    dbMock.list.mockImplementation(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    });

    const res = await request(app).get('/api/users').set(auth(admin));

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('服务器内部错误');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(res.body.error.stack).toBeUndefined();
  });
});
