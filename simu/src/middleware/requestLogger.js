import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';

/** 只接受形如 uuid / 自定义短串的请求 ID，避免把任意头内容写进日志（日志注入） */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function resolveRequestId(req) {
  const incoming = req.get('x-request-id');
  if (incoming && SAFE_REQUEST_ID.test(incoming)) return incoming;
  return randomUUID();
}

/**
 * 请求日志中间件。
 * - 为每个请求生成 req.id，并回写 `X-Request-Id` 响应头，便于前后端对齐排查
 * - 请求结束（finish）或连接中断（close）时输出一行结构化日志
 * - 按状态码自动分级：5xx=error、4xx=warn、其余=info；耗时超过 slowMs 追加 slow 标记
 *
 * @param {{ logger?: ReturnType<typeof createLogger>, skip?: string[], slowMs?: number }} options
 */
export function requestLogger({ logger = createLogger(), skip = ['/health'], slowMs = 1000 } = {}) {
  const skipPaths = new Set(skip);

  return function requestLogMiddleware(req, res, next) {
    const requestId = resolveRequestId(req);
    const startedAt = process.hrtime.bigint();

    // 派生带 requestId 的子日志器，业务代码里 req.log.info(...) 即可自动带上请求 ID
    const log = logger.child ? logger.child({ requestId }) : logger;
    req.id = requestId;
    req.log = log;
    res.setHeader('X-Request-Id', requestId);

    if (skipPaths.has(req.path)) return next();

    let logged = false;

    const done = (event) => {
      if (logged) return;
      logged = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = res.statusCode;
      const aborted = event === 'aborted';

      const fields = {
        method: req.method,
        path: req.originalUrl,
        status,
        durationMs: Math.round(durationMs * 10) / 10,
        ip: req.ip,
        userAgent: req.get('user-agent')?.slice(0, 120),
      };

      if (req.user?.id) fields.userId = req.user.id;
      if (aborted) fields.aborted = true;
      if (durationMs >= slowMs) fields.slow = true;

      const message = `${req.method} ${req.originalUrl} ${aborted ? 'aborted' : status}`;

      if (aborted) {
        log.warn(message, fields);
      } else if (status >= 500) {
        log.error(message, fields);
      } else if (status >= 400) {
        log.warn(message, fields);
      } else {
        log.info(message, fields);
      }
    };

    res.on('finish', () => done('finish'));
    // 客户端提前断开时不会触发 finish，这里补一条，避免请求"凭空消失"
    res.on('close', () => {
      if (!res.writableEnded) done('aborted');
    });

    next();
  };
}
