import { randomUUID } from 'node:crypto';
import { HttpError } from './middleware/errors.js';
import { hashPassword, verifyPassword } from './utils/password.js';
import { config } from './config.js';

/**
 * 演示用的内存存储。换成数据库时只需按同样签名重写本文件里的方法。
 * Map<id, UserRecord>
 */
const users = new Map();

/** 只暴露给客户端的字段，绝不返回 passwordHash */
export function toPublicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

export function findById(id) {
  return users.get(id) ?? null;
}

export function findByEmail(email) {
  const target = String(email ?? '').trim().toLowerCase();
  for (const user of users.values()) {
    if (user.email === target) return user;
  }
  return null;
}

export function list({ page = 1, limit = 20, q, role } = {}) {
  let rows = [...users.values()];

  if (role) {
    rows = rows.filter((u) => u.role === role);
  }

  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (u) => u.email.includes(needle) || u.name.toLowerCase().includes(needle),
    );
  }

  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const total = rows.length;
  const start = (page - 1) * limit;

  return { items: rows.slice(start, start + limit), total, page, limit };
}

export async function create({ name, email, password, role = 'user' }) {
  const normalizedEmail = String(email).trim().toLowerCase();

  if (findByEmail(normalizedEmail)) {
    throw new HttpError(409, '该邮箱已注册', { details: { field: 'email' } });
  }

  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    name: String(name).trim(),
    email: normalizedEmail,
    role,
    passwordHash: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  };

  users.set(user.id, user);
  return user;
}

export async function update(id, patch) {
  const user = users.get(id);
  if (!user) throw new HttpError(404, '用户不存在');

  if (patch.email !== undefined) {
    const normalizedEmail = String(patch.email).trim().toLowerCase();
    const existing = findByEmail(normalizedEmail);
    if (existing && existing.id !== id) {
      throw new HttpError(409, '该邮箱已被占用', { details: { field: 'email' } });
    }
    user.email = normalizedEmail;
  }

  if (patch.name !== undefined) user.name = String(patch.name).trim();
  if (patch.role !== undefined) user.role = patch.role;
  if (patch.password !== undefined) user.passwordHash = await hashPassword(patch.password);

  user.updatedAt = new Date().toISOString();
  return user;
}

export function remove(id) {
  if (!users.delete(id)) throw new HttpError(404, '用户不存在');
}

export async function checkPassword(user, password) {
  return verifyPassword(password, user.passwordHash);
}

export function count() {
  return users.size;
}

/** 首次启动时确保有一个管理员账号，便于登录获取 token */
export async function seedAdmin() {
  if (count() > 0) return;
  const admin = await create({
    name: 'Admin',
    email: config.seedAdmin.email,
    password: config.seedAdmin.password,
    role: 'admin',
  });
  console.log(`[store] 已创建初始管理员: ${admin.email}`);
}
