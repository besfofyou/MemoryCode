import * as store from '../../store.js';
import { asyncHandler, HttpError } from '../../middleware/errors.js';
import {
  optionalEmail,
  optionalPassword,
  optionalRole,
  optionalString,
  parsePagination,
  pickFields,
  requiredEmail,
  requiredPassword,
  requiredString,
} from '../../utils/validate.js';

/**
 * 用户资源控制器：入参校验 + 数据层调用 + 响应组装。
 * 权限判断在路由层（authorize / selfOrAdmin），这里只管业务。
 */

/** GET /api/users?page=1&limit=20&q=&role= */
export const list = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const role = optionalRole(req.query.role, 'role');
  const q = optionalString(req.query.q, 'q', { max: 100 });

  const { items, total } = store.list({ page, limit, q, role });

  res.json({
    data: items.map(store.toPublicUser),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

/** GET /api/users/:id */
export const getOne = asyncHandler(async (req, res) => {
  const user = store.findById(req.params.id);
  if (!user) throw new HttpError(404, '用户不存在');
  res.json({ data: store.toPublicUser(user) });
});

/** POST /api/users —— 管理员直接创建用户（可指定角色） */
export const create = asyncHandler(async (req, res) => {
  const body = pickFields(req.body, ['name', 'email', 'password', 'role']);

  const user = await store.create({
    name: requiredString(body.name, 'name', { max: 80 }),
    email: requiredEmail(body.email),
    password: requiredPassword(body.password),
    role: optionalRole(body.role) ?? 'user',
  });

  res.status(201).json({ data: store.toPublicUser(user) });
});

/**
 * PATCH /api/users/:id —— 部分更新
 * 本人可改 name / email / password；role 只有管理员能改
 */
export const update = asyncHandler(async (req, res) => {
  const body = pickFields(req.body, ['name', 'email', 'password', 'role']);

  const patch = {
    name: optionalString(body.name, 'name', { max: 80 }),
    email: optionalEmail(body.email),
    password: optionalPassword(body.password),
    role: optionalRole(body.role),
  };

  if (patch.role !== undefined && req.user.role !== 'admin') {
    throw new HttpError(403, '只有管理员可以修改角色');
  }

  if (Object.values(patch).every((value) => value === undefined)) {
    throw new HttpError(400, '没有可更新的字段', {
      code: 'EMPTY_PATCH',
      details: { allowed: ['name', 'email', 'password', 'role'] },
    });
  }

  const updated = await store.update(req.params.id, patch);
  res.json({ data: store.toPublicUser(updated) });
});

/** DELETE /api/users/:id —— 仅管理员，且不能删除自己 */
export const remove = asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) {
    throw new HttpError(400, '不能删除自己的账号');
  }

  store.remove(req.params.id);
  res.status(204).end();
});
