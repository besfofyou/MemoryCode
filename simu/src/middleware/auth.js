import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import * as store from '../store.js';
import { HttpError } from './errors.js';

/** 签发访问令牌；payload 只放非敏感标识，绝不放密码或 passwordHash */
export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    issuer: config.jwt.issuer,
  });
}

/** 从 `Authorization: Bearer <token>` 中取出 token */
function extractToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;

  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (!/^bearer$/i.test(scheme)) return null;

  const token = rest.join('');
  return token || null;
}

/**
 * JWT 认证中间件：校验签名与有效期，并把当前用户挂到 req.user。
 * 每次请求都回查用户，确保「用户被删除/降权」后旧 token 立即失效。
 */
export function authenticate(req, _res, next) {
  const token = extractToken(req);

  if (!token) {
    return next(
      new HttpError(401, '缺少访问令牌', {
        code: 'TOKEN_MISSING',
        details: { header: 'Authorization: Bearer <token>' },
      }),
    );
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, { issuer: config.jwt.issuer });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new HttpError(401, '令牌已过期，请重新登录', { code: 'TOKEN_EXPIRED' }));
    }
    return next(new HttpError(401, '令牌无效', { code: 'TOKEN_INVALID' }));
  }

  const user = store.findById(payload.sub);
  if (!user) {
    return next(new HttpError(401, '令牌对应的用户不存在', { code: 'TOKEN_INVALID' }));
  }

  req.auth = payload;
  req.user = user;
  next();
}

/** 可选认证：有 token 就解析，没有也放行（用于公开但可个性化的接口） */
export function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return authenticate(req, res, next);
}

/** 角色校验，必须放在 authenticate 之后 */
export function authorize(...roles) {
  return function roleGuard(req, _res, next) {
    if (!req.user) return next(new HttpError(401, '未认证'));

    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return next(new HttpError(403, '权限不足，需要角色: ' + roles.join(', ')));
    }

    next();
  };
}

/**
 * 只允许「本人」或管理员继续访问。
 * @param {(req: import('express').Request) => string} getId 从请求中取目标用户 id
 */
export function selfOrAdmin(getId) {
  return function selfGuard(req, _res, next) {
    if (!req.user) return next(new HttpError(401, '未认证'));

    const targetId = getId(req);
    if (req.user.role === 'admin' || req.user.id === targetId) return next();

    next(new HttpError(403, '只能操作自己的账号'));
  };
}
