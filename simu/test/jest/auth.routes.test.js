import { beforeEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { buildApp } from './helpers/buildApp.js';
import { dbMock, installStoreMock, resetDbMock } from './helpers/mockStore.js';

await installStoreMock();

const { default: authRouter } = await import('../../src/routes/auth/auth.routes.js');
const { config } = await import('../../src/config.js');
const { HttpError } = await import('../../src/middleware/errors.js');

const app = buildApp({ authRouter });

const alice = {
  id: 'u-alice',
  name: 'Alice',
  email: 'alice@example.com',
  role: 'user',
  passwordHash: 'stub-hash',
};

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

function signExpiredToken(sub = alice.id) {
  return jwt.sign({ sub }, config.jwt.secret, {
    issuer: config.jwt.issuer,
    expiresIn: '-10s',
  });
}

beforeEach(() => {
  resetDbMock();
});

describe('POST /api/auth/login', () => {
  it('邮箱密码正确时返回 token 和用户信息，不含 passwordHash', async () => {
    dbMock.findByEmail.mockReturnValue(alice);
    dbMock.checkPassword.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'Alice@Example.com', password: 'Passw0rd!' });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({ id: alice.id, email: alice.email });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');

    // 数据库按归一化后的小写邮箱查询
    expect(dbMock.findByEmail).toHaveBeenCalledWith('alice@example.com');
    expect(dbMock.checkPassword).toHaveBeenCalledWith(alice, 'Passw0rd!');

    const payload = jwt.verify(res.body.data.token, config.jwt.secret, {
      issuer: config.jwt.issuer,
    });
    expect(payload.sub).toBe(alice.id);
    expect(payload).not.toHaveProperty('passwordHash');
  });

  it('密码错误返回 401，且不签发 token', async () => {
    dbMock.findByEmail.mockReturnValue(alice);
    dbMock.checkPassword.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: alice.email, password: 'WrongPass1!' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('邮箱或密码不正确');
    expect(res.body.data).toBeUndefined();
  });

  it('邮箱不存在返回与密码错误相同的提示，且不查密码', async () => {
    dbMock.findByEmail.mockReturnValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'Passw0rd!' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('邮箱或密码不正确');
    expect(dbMock.checkPassword).not.toHaveBeenCalled();
  });

  it('缺少字段时返回 400，且不查库', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: alice.email });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(dbMock.findByEmail).not.toHaveBeenCalled();
  });

  it('数据库连接异常返回 500，且信息被脱敏', async () => {
    dbMock.findByEmail.mockImplementation(() => {
      throw new Error('read ECONNRESET');
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: alice.email, password: 'Passw0rd!' });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('服务器内部错误');
    expect(JSON.stringify(res.body)).not.toContain('ECONNRESET');
  });
});

describe('POST /api/auth/register', () => {
  it('注册成功返回 201，强制 role=user 并返回 token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Bob', email: 'Bob@Example.com', password: 'Passw0rd!', role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user.role).toBe('user');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');

    // 客户端传的 role 不会被采纳
    expect(dbMock.create).toHaveBeenCalledWith({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Passw0rd!',
      role: 'user',
    });
  });

  it('邮箱已存在时返回 409', async () => {
    dbMock.create.mockImplementation(async () => {
      throw new HttpError(409, '该邮箱已注册');
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Bob', email: 'bob@example.com', password: 'Passw0rd!' });

    expect(res.status).toBe(409);
  });

  it('密码过短返回 400，且不写库', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Bob', email: 'bob@example.com', password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe('password');
    expect(dbMock.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/me', () => {
  it('有效 token 返回当前用户', async () => {
    dbMock.findById.mockReturnValue(alice);
    const token = jwt.sign({ sub: alice.id }, config.jwt.secret, {
      issuer: config.jwt.issuer,
      expiresIn: '1h',
    });

    const res = await request(app).get('/api/auth/me').set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: alice.id, email: alice.email });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(dbMock.findById).toHaveBeenCalledWith(alice.id);
  });

  it('过期 token 返回 401 TOKEN_EXPIRED', async () => {
    dbMock.findById.mockReturnValue(alice);

    const res = await request(app).get('/api/auth/me').set(bearer(signExpiredToken()));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('用户已被删除时旧 token 立即失效', async () => {
    dbMock.findById.mockReturnValue(null);
    const token = jwt.sign({ sub: 'u-deleted' }, config.jwt.secret, {
      issuer: config.jwt.issuer,
      expiresIn: '1h',
    });

    const res = await request(app).get('/api/auth/me').set(bearer(token));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('缺少 token 返回 401 TOKEN_MISSING', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_MISSING');
    expect(dbMock.findById).not.toHaveBeenCalled();
  });
});
