import { createApp } from './app.js';
import { config } from './config.js';
import { seedAdmin } from './store.js';

async function main() {
  await seedAdmin();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[simu-api] ${config.env} 环境启动: http://localhost:${config.port}`);
  });

  const shutdown = (signal) => {
    console.log(`\n[simu-api] 收到 ${signal}，正在关闭...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[simu-api] 启动失败', err);
  process.exit(1);
});
