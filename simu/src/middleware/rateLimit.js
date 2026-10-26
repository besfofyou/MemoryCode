import { HttpError } from './errors.js';

/**
 * 固定窗口计数器。单进程内存实现，够 demo 用；
 * 多实例部署请换成 Redis 版本（INCR + PEXPIRE），接口保持不变即可。
 */
export class MemoryStore {
  constructor({ cleanupIntervalMs = 60_000, maxKeys = 50_000 } = {}) {
    this.buckets = new Map();
    this.maxKeys = maxKeys;

    // 定期清理过期桶，避免长期运行内存只涨不降；unref 保证不拖住进程退出
    this.cleanupTimer = setInterval(() => this.cleanup(Date.now()), cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  /**
   * 记一次命中。
   * @returns {{ allowed: boolean, remaining: number, resetAt: number, count: number }}
   */
  hit(key, at, windowMs, max) {
    let bucket = this.buckets.get(key);

    // 首次访问，或窗口已过期 → 重新开窗
    if (!bucket || at >= bucket.resetAt) {
      bucket = { count: 0, resetAt: at + windowMs };
      this.buckets.set(key, bucket);
      if (this.buckets.size > this.maxKeys) this.cleanup(at);
    }

    bucket.count += 1;

    return {
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      resetAt: bucket.resetAt,
      count: bucket.count,
    };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  resetAll() {
    this.buckets.clear();
  }

  cleanup(at = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= at) this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

/**
 * IP 归一化：
 * - IPv4-mapped IPv6（::ffff:127.0.0.1）折叠成 IPv4，否则同一客户端会有两个桶
 * - 纯 IPv6 按 /64 归并，避免客户端轮换地址绕过限流
 */
export function normalizeIp(ip) {
  if (!ip) return 'unknown';

  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mappedV4) return mappedV4[1];

  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;

  return ip;
}

/**
 * 每个 IP 的固定窗口限流。
 *
 * - 超限不再放行，交给统一错误处理中间件输出 429（code: RATE_LIMITED）
 * - 响应头带 RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset，超限额外带 Retry-After
 * - 默认跳过 /health，避免健康检查把配额吃光
 *
 * 注意：反向代理后面必须设置 trust proxy（`app.set('trust proxy', 1)`），否则所有请求
 * 都会被识别成代理的 IP，等于全局限流。
 *
 * @param {{
 *   windowMs?: number, max?: number, skip?: string[],
 *   keyGenerator?: (req: import('express').Request) => string,
 *   message?: string, store?: MemoryStore, now?: () => number,
 * }} options
 */
export function rateLimit({
  windowMs = 60_000,
  max = 100,
  skip = ['/health'],
  keyGenerator = (req) => normalizeIp(req.ip ?? req.socket?.remoteAddress),
  message = '请求过于频繁，请稍后再试',
  store = new MemoryStore(),
  now = Date.now,
} = {}) {
  const skipPaths = new Set(skip);

  return function rateLimitMiddleware(req, res, next) {
    if (skipPaths.has(req.path)) return next();

    const key = keyGenerator(req);
    const at = now();
    const { allowed, remaining, resetAt } = store.hit(key, at, windowMs, max);
    const resetInSeconds = Math.max(0, Math.ceil((resetAt - at) / 1000));

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetInSeconds));

    if (!allowed) {
      res.setHeader('Retry-After', String(resetInSeconds));
      return next(
        new HttpError(429, message, {
          code: 'RATE_LIMITED',
          details: { limit: max, windowMs, retryAfter: resetInSeconds },
        }),
      );
    }

    next();
  };
}
