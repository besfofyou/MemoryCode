/**
 * 数据层：当前用 localStorage 持久化，纯前端即可跑。
 * 以后接 Express 时只改这一个文件（loadTodos / saveTodos 换成 fetch），
 * 组件和 hook 都不用动。
 */

const STORAGE_KEY = 'simu.todo.items';

function isTodo(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.done === 'boolean'
  );
}

export function loadTodos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // 脏数据（旧版本、手改 localStorage）直接丢弃，别让 UI 崩掉
    return parsed.filter(isTodo).map(({ id, title, done, createdAt }) => ({
      id,
      title,
      done,
      createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

export function saveTodos(todos) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  } catch {
    // 隐私模式 / 配额用满：静默降级成内存态，不影响交互
  }
}

export function createTodo(title) {
  return {
    id: createId(),
    title,
    done: false,
    createdAt: new Date().toISOString(),
  };
}

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
