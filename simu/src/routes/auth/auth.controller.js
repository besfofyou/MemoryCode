import * as store from '../../store.js';
import { signToken } from '../../middleware/auth.js';
import { asyncHandler, HttpError } from '../../middleware/errors.js';
import {
  pickFields,
  requiredEmail,
  requiredPassword,
  requiredString,
} from '../../utils/validate.js';

/**
 * 认证资源控制器：只负责「解析入参 → 调数据层 → 组装响应」，
 * 路由表（路径 + 中间件）在 auth.routes.js 里。
 */

/** POST /api/auth/register —— 公开注册（固定为 user 角色） */
export const register = asyncHandler(async (req, res) => {
  const body = pickFields(req.body, ['name', 'email', 'password']);

  const name = requiredString(body.name, 'name', { min: 1, max: 80 });
  const email = requiredEmail(body.email);
  const password = requiredPassword(body.password);

  const user = await store.create({ name, email, password, role: 'user' });

  res.status(201).json({
    data: {
      user: store.toPublicUser(user),
      token: signToken(user),
    },
  });
});

/** POST /api/auth/login */
export const login = asyncHandler(async (req, res) => {
  const body = pickFields(req.body, ['email', 'password']);
  const email = requiredEmail(body.email);
  const password = requiredPassword(body.password);

  const user = store.findByEmail(email);

  // 用户不存在与密码错误返回同一提示，避免邮箱枚举
  if (!user || !(await store.checkPassword(user, password))) {
    throw new HttpError(401, '邮箱或密码不正确');
  }

  res.json({
    data: {
      user: store.toPublicUser(user),
      token: signToken(user),
    },
  });
});

/** GET /api/auth/me —— 用当前 token 换取自己的资料 */
export function me(req, res) {
  res.json({ data: { user: store.toPublicUser(req.user) } });
}
