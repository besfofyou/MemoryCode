import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTodo, loadTodos, saveTodos } from '../storage.js';

/** 全部 Todo 状态与操作都收敛在这里，组件只负责渲染 */
export function useTodos() {
  const [todos, setTodos] = useState(() => loadTodos());

  // 任何变更都落盘一次，简单可靠
  useEffect(() => {
    saveTodos(todos);
  }, [todos]);

  const add = useCallback((rawTitle) => {
    const title = rawTitle.trim();
    if (!title) return false;

    setTodos((prev) => [createTodo(title), ...prev]);
    return true;
  }, []);

  const toggle = useCallback((id) => {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }, []);

  const rename = useCallback((id, rawTitle) => {
    const title = rawTitle.trim();
    if (!title) return;

    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }, []);

  const remove = useCallback((id) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearCompleted = useCallback(() => {
    setTodos((prev) => prev.filter((t) => !t.done));
  }, []);

  const toggleAll = useCallback((done) => {
    setTodos((prev) => prev.map((t) => ({ ...t, done })));
  }, []);

  const stats = useMemo(() => {
    const total = todos.length;
    const done = todos.filter((t) => t.done).length;
    return { total, done, active: total - done };
  }, [todos]);

  return { todos, add, toggle, rename, remove, clearCompleted, toggleAll, stats };
}
