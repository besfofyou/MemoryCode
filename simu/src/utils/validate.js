import { HttpError } from '../middleware/errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const ROLES = ['user', 'admin'];

const invalid = (field, message) =>
  new HttpError(400, '参数校验失败', { code: 'VALIDATION_ERROR', details: { field, message } });

export function requiredString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw invalid(field, `${field} 必须是字符串`);

  const trimmed = value.trim();
  if (trimmed.length < min) throw invalid(field, `${field} 长度不能小于 ${min}`);
  if (trimmed.length > max) throw invalid(field, `${field} 长度不能超过 ${max}`);

  return trimmed;
}

export function optionalString(value, field, opts) {
  return value === undefined ? undefined : requiredString(value, field, opts);
}

export function requiredEmail(value, field = 'email') {
  const email = requiredString(value, field, { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw invalid(field, '邮箱格式不正确');
  return email;
}

export function optionalEmail(value, field = 'email') {
  return value === undefined ? undefined : requiredEmail(value, field);
}

export function requiredPassword(value, field = 'password') {
  if (typeof value !== 'string') throw invalid(field, `${field} 必须是字符串`);
  if (value.length < 8) throw invalid(field, '密码长度至少 8 位');
  if (value.length > 128) throw invalid(field, '密码长度不能超过 128 位');
  return value;
}

export function optionalPassword(value, field = 'password') {
  return value === undefined ? undefined : requiredPassword(value, field);
}

export function optionalRole(value, field = 'role') {
  if (value === undefined) return undefined;
  if (!ROLES.includes(value)) throw invalid(field, `role 只能是 ${ROLES.join(' / ')}`);
  return value;
}

export function parsePagination(query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const limit = Number.parseInt(query.limit ?? '20', 10);

  if (!Number.isFinite(page) || page < 1) throw invalid('page', 'page 必须是 >= 1 的整数');
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw invalid('limit', 'limit 必须是 1-100 的整数');
  }

  return { page, limit };
}

/** 只允许白名单字段进入 handler，避免 body 里多出的字段被顺手写库 */
export function pickFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象', {
      code: 'INVALID_BODY',
      details: { header: 'Content-Type: application/json' },
    });
  }

  const picked = {};
  for (const key of allowed) {
    if (body[key] !== undefined) picked[key] = body[key];
  }
  return picked;
}
