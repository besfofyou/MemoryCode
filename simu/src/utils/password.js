import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const KEY_LENGTH = 64;
const PREFIX = 'scrypt';

/**
 * 使用 Node 内置 scrypt 做密码哈希，避免引入需要编译的 bcrypt 原生依赖。
 * 存储格式: scrypt$<saltHex>$<hashHex>
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;

  const [prefix, saltHex, hashHex] = stored.split('$');
  if (prefix !== PREFIX || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);

  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
