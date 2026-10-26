import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import apiRouter from './routes/index.js';
import { createErrorHandler, notFoundHandler } from './middleware/errors.js';
import { requestLogger } from './middleware/requestLogger.js';
import { rateLimit } from './middleware/rateLimit.js';
import { createLogger, silentLogger } from './logger.js';
import { config } from './config.js';

/**
 * 组装应用。拆成工厂函数，测试里可注入静默/假日志器，也可关掉限流。
 *
 * @param {{
 *   logger?: object | false,
 *   skipRequestLog?: string[],
 *   rateLimit?: false | { windowMs?: number, max?: number, skip?: string[] },
 *   publicDir?: string | false,
 * }} options
 */
export function createApp({
  logger,
  skipRequestLog = ['/health'],
  rateLimit: rateLimitOptions,
  publicDir = config.publicDir,
} = {}) {
  const log = logger === false ? silentLogger : (logger ?? createLogger());

  const app = express();

  app.disable('x-powered-by');

  // 代理后面要让 req.ip 取到真实客户端 IP，限流才有意义
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // 请求日志必须放在最前面，才能覆盖 body 解析失败、404、429 等所有请求
  app.use(requestLogger({ logger: log, skip: skipRequestLog }));

  // 限流放在 body 解析之前：被限流的请求不必再花成本读请求体
  if (rateLimitOptions !== false && config.rateLimit.max > 0) {
    app.use(
      rateLimit({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.max,
        ...(typeof rateLimitOptions === 'object' ? rateLimitOptions : {}),
      }),
    );
  }

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.use('/api', apiRouter);

  // 前端静态产物（可选）：只有构建产物存在时才挂，纯 API 部署与单元测试不受影响
  // sendFile 只接受绝对路径，所以统一 resolve 一次
  const assetsDir = publicDir ? path.resolve(publicDir) : null;
  const indexFile = assetsDir ? path.join(assetsDir, 'index.html') : null;

  if (indexFile && fs.existsSync(indexFile)) {
    app.use(express.static(assetsDir, { index: false, maxAge: '1h' }));

    // SPA 兜底：非 /api 的 GET/HEAD 回 index.html，刷新前端路由不会 404
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api')) return next();

      res.sendFile(indexFile, (err) => {
        if (err) next(err);
      });
    });
  }

  // 404 与统一错误处理必须放在最后
  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger: log }));

  return app;
}
