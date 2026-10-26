import { Router } from 'express';
import { authenticate, authorize, selfOrAdmin } from '../../middleware/auth.js';
import { create, getOne, list, remove, update } from './users.controller.js';

const router = Router();

// 本资源下所有路由都要求已登录；权限细化写在每条路由上，一眼能看出谁能访问
router.use(authenticate);

const idFromParams = (req) => req.params.id;

// 列表仅管理员可见（如需对普通用户开放，把 authorize 换成 authorize()）
router.get('/', authorize('admin'), list);

router.get('/:id', selfOrAdmin(idFromParams), getOne);

router.post('/', authorize('admin'), create);

router.patch('/:id', selfOrAdmin(idFromParams), update);

router.delete('/:id', authorize('admin'), remove);

export default router;
