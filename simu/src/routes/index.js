import { Router } from 'express';
import authRouter from './auth/auth.routes.js';
import usersRouter from './users/users.routes.js';

/**
 * API 总路由：每个资源一个模块（<resource>/<resource>.routes.js + controller）。
 * 新增资源只需要两步：
 *   1. 建 src/routes/<resource>/ 目录（routes + controller）
 *   2. 在下面 use 一行，路径前缀即资源名
 */
const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);

// 未匹配的 /api/* 交给 app.js 里的 notFoundHandler（统一 404 + ROUTE_NOT_FOUND）

export default apiRouter;
