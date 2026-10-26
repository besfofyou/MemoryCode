import { beforeAll, describe, expect, it } from '@jest/globals';

import * as store from '../../src/store.js';
import { HttpError } from '../../src/middleware/errors.js';

/**
 * 这一组测试不打 mock：验证「数据层契约」本身（future pg.Pool 实现也要满足同样的语义）。
 * 内存存储的结论是可验证的，所以不做隔离，用唯一邮箱避免互相干扰。
 */
const created = [];

beforeAll(async () => {
  for (const name of ['Alice', 'Bob', 'Cara']) {
    created.push(
      await store.create({
        name,
        email: `${name.toLowerCase()}@store.test`,
        password: 'Passw0rd!',
      }),
    );
  }
});

describe('store 数据层', () => {
  it('create 落库后可按邮箱查到，且邮箱归一化为小写', async () => {
    const user = await store.create({
      name: 'Dave',
      email: '  Dave@Store.Test ',
      password: 'Passw0rd!',
    });

    expect(user.email).toBe('dave@store.test');
    expect(store.findById(user.id)).toMatchObject({ id: user.id });
    expect(store.findByEmail('DAVE@store.test')?.id).toBe(user.id);
  });

  it('toPublicUser 永远剔除 passwordHash', () => {
    const publicUser = store.toPublicUser(created[0]);

    expect(publicUser).not.toHaveProperty('passwordHash');
    expect(publicUser.email).toBe('alice@store.test');
    expect(store.toPublicUser(null)).toBeNull();
  });

  it('重复邮箱抛 409', async () => {
    await expect(
      store.create({ name: 'Alice2', email: 'alice@store.test', password: 'Passw0rd!' }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      store.create({ name: 'Alice2', email: 'alice@store.test', password: 'Passw0rd!' }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('update 改邮箱与他人冲突时抛 409', async () => {
    await expect(
      store.update(created[1].id, { email: 'alice@store.test' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('update / remove 不存在的用户抛 404', async () => {
    await expect(store.update('ghost', { name: 'Ghost' })).rejects.toMatchObject({ status: 404 });
    expect(() => store.remove('ghost')).toThrow(HttpError);
  });

  it('list 支持分页与关键字过滤', async () => {
    const page = store.list({ page: 1, limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.page).toBe(1);

    const filtered = store.list({ q: 'cara' });
    expect(filtered.items.map((user) => user.name)).toEqual(['Cara']);
  });

  it('checkPassword 校验真实 scrypt 哈希', async () => {
    expect(await store.checkPassword(created[0], 'Passw0rd!')).toBe(true);
    expect(await store.checkPassword(created[0], 'WrongPass1!')).toBe(false);
  });
});
