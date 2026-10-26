import { describe, expect, it } from '@jest/globals';

import { hashPassword, verifyPassword } from '../../src/utils/password.js';

describe('password 工具', () => {
  it('哈希格式为 scrypt$salt$hash，且不含明文', async () => {
    const hashed = await hashPassword('Passw0rd!');
    const [prefix, salt, hash] = hashed.split('$');

    expect(prefix).toBe('scrypt');
    expect(salt).toHaveLength(32); // 16 字节 salt 的 hex
    expect(hash).toHaveLength(128); // 64 字节 hash 的 hex
    expect(hashed).not.toContain('Passw0rd!');
  });

  it('相同密码每次哈希都不同（随机盐）', async () => {
    const [a, b] = await Promise.all([hashPassword('Passw0rd!'), hashPassword('Passw0rd!')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('Passw0rd!', a)).toBe(true);
    expect(await verifyPassword('Passw0rd!', b)).toBe(true);
  });

  it('密码错误返回 false', async () => {
    const hashed = await hashPassword('Passw0rd!');
    expect(await verifyPassword('passw0rd!', hashed)).toBe(false);
  });

  it('存储值格式异常时返回 false，不抛异常', async () => {
    expect(await verifyPassword('Passw0rd!', 'bcrypt$abc$def')).toBe(false);
    expect(await verifyPassword('Passw0rd!', 'garbage')).toBe(false);
    expect(await verifyPassword('Passw0rd!', null)).toBe(false);
    expect(await verifyPassword('Passw0rd!', undefined)).toBe(false);
  });
});
