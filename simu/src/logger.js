import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Error 实例默认 JSON.stringify 会丢掉 message/stack，这里补回来 */
function replacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, code: value.code };
  }
  return value;
}

/**
 * 极简结构化日志器：一行一个 JSON，便于被 Loki / ELK / CloudWatch 采集。
 * 需要更完整能力（脱敏、采样、多输出）时可直接替换成 pino。
 *
 * @param {{ level?: keyof typeof LEVELS, stream?: { write(chunk: string): void }, base?: object }} options
 */
export function createLogger({ level = config.logLevel, stream = process.stdout, base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;

    let line;
    try {
      line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...base, ...fields }, replacer);
    } catch {
      line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, logError: '序列化日志字段失败' });
    }

    stream.write(`${line}\n`);
  }

  return {
    level,
    isLevelEnabled: (lvl) => LEVELS[lvl] >= threshold,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    /** 派生带固定字段的子日志器，例如 logger.child({ requestId }) */
    child: (extra) => createLogger({ level, stream, base: { ...base, ...extra } }),
  };
}

/** 什么都不输出的日志器，供测试或关闭日志时使用 */
export const silentLogger = createLogger({ level: 'silent' });
