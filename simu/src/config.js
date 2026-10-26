import 'dotenv/config';
import { fileURLToPath } from 'node:url';

const isProd = process.env.NODE_ENV === 'production';

function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) return secret;

  if (isProd) {
    throw new Error('JWT_SECRET 未配置（生产环境必须设置长度 >= 16 的密钥）');
  }

  console.warn('[config] 未设置 JWT_SECRET，使用开发用默认值，请勿用于生产环境');
  return 'dev-only-insecure-secret-change-me';
}

/** TRUST_PROXY=true|1|loopback 等，未配置则关闭（默认不信任任何代理） */
function parseTrustProxy(value) {
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const hops = Number(value);
  return Number.isFinite(hops) ? hops : value;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd,
  port: Number(process.env.PORT ?? 3000),
  // 日志级别: debug | info | warn | error | silent
  logLevel: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    // 0 表示不限流
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
  },
  // 反向代理后面需要开启，否则 req.ip 全是代理地址
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  jwt: {
    secret: resolveJwtSecret(),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    issuer: 'simu-api',
  },
  // 前端构建产物目录（Docker 里是 /app/public）；不存在时 app.js 自动跳过静态托管
  publicDir: process.env.PUBLIC_DIR ?? fileURLToPath(new URL('../public', import.meta.url)),
  seedAdmin: {
    email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
    password: process.env.ADMIN_PASSWORD ?? 'Admin@12345',
  },
};
