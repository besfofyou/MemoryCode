import express from 'express';
import { createErrorHandler, notFoundHandler } from '../../../src/middleware/errors.js';
import { silentLogger } from '../../../src/logger.js';

/**
 * 只挂被测路由的「最小 app」：单元测试不引入 server.js，也不启动真实监听端口，
 * supertest 直接拿 app 走请求/响应链路。
 */
export function buildApp({ authRouter, usersRouter } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  if (authRouter) app.use('/api/auth', authRouter);
  if (usersRouter) app.use('/api/users', usersRouter);

  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger: silentLogger, exposeStack: false }));

  return app;
}
