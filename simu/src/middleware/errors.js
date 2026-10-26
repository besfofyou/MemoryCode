import { config } from '../config.js';
import { createLogger } from '../logger.js';

/**
 * 统一的 HTTP 错误类型。
 * 业务代码里 `throw new HttpError(404, '用户不存在')`，由 errorHandler 统一输出。
 *
 * @param {number} status HTTP 状态码
 * @param {string} message 面向客户端的提示
 * @param {{ code?: string, details?: unknown }} [options] code 便于客户端分支处理，details 是补充信息
 */
export class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code;
    this.details = options.details;
  }
}

/** 包装 async 路由，避免每个 handler 里写 try/catch(next) */
export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** 404 兜底：没有匹配到任何路由 */
export function notFoundHandler(req, res, next) {
  next(
    new HttpError(404, `路由不存在: ${req.method} ${req.originalUrl}`, { code: 'ROUTE_NOT_FOUND' }),
  );
}

/** body-parser 抛出的错误只有 type 字段，这里翻译成稳定的状态码与业务 code */
const BODY_PARSER_ERRORS = {
  'entity.parse.failed': [400, 'INVALID_JSON', '请求体不是合法的 JSON'],
  'entity.too.large': [413, 'PAYLOAD_TOO_LARGE', '请求体过大'],
  'encoding.unsupported': [415, 'UNSUPPORTED_ENCODING', '不支持的请求体编码'],
  'charset.unsupported': [415, 'UNSUPPORTED_CHARSET', '不支持的字符集'],
  'request.aborted': [400, 'REQUEST_ABORTED', '请求被中断'],
  'parameters.too.many': [413, 'TOO_MANY_PARAMETERS', '参数过多'],
};

/** 把任意异常归一化成 { status, code, message, details } */
function normalizeError(err) {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      details: err.details,
    };
  }

  const mapped = BODY_PARSER_ERRORS[err?.type];
  if (mapped) {
    const [status, code, message] = mapped;
    return { status, code, message, details: { type: err.type } };
  }

  const status = Number(err?.status ?? err?.statusCode) || 500;

  return {
    status,
    code: typeof err?.code === 'string' ? err.code : undefined,
    // 非预期异常不把内部信息暴露给客户端
    message: status >= 500 ? '服务器内部错误' : (err?.message ?? '请求处理失败'),
    details: undefined,
  };
}

/**
 * 统一错误处理中间件（工厂）。
 * 必须注册在所有路由之后，且是 4 个参数：
 *   app.use(createErrorHandler({ logger }))
 *
 * - 4xx：debug 级记录原因（请求日志中间件已按 warn 记录一次）
 * - 5xx：error 级记录完整堆栈，响应体只回「服务器内部错误」
 * - 响应体统一带 requestId，方便按请求 ID 查日志
 * - headersSent 时交回 Express 默认处理（避免二次写 header 崩溃）
 */
export function createErrorHandler({ logger = createLogger(), exposeStack = !config.isProd } = {}) {
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    const { status, code, message, details } = normalizeError(err);
    const requestId = req.id;

    const logFields = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status,
      code,
    };
    if (req.user?.id) logFields.userId = req.user.id;

    if (status >= 500) {
      logger.error('未处理的请求异常', { ...logFields, err });
    } else {
      logger.debug('请求被拒绝', { ...logFields, reason: err?.message, details });
    }

    const body = { error: { status, message } };
    if (code) body.error.code = code;
    if (details !== undefined) body.error.details = details;
    if (requestId) body.error.requestId = requestId;
    if (exposeStack && status >= 500 && err?.stack) body.error.stack = err.stack;

    res.status(status).json(body);
  };
}

/** 默认实例，方便直接 app.use(errorHandler) */
export const errorHandler = createErrorHandler();
