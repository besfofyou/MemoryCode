import { useEffect, useRef, useState } from 'react';

/**
 * 单条待办。
 * - 勾选：切换完成状态
 * - 双击标题：进入编辑（Enter 保存 / Esc 取消 / 失焦保存）
 * - 右侧按钮：删除
 */
export default function TodoItem({ todo, onToggle, onRename, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);
  const inputRef = useRef(null);
  // Esc 取消时输入框会卸载，某些浏览器仍会触发 blur；用标记跳过那次提交
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function startEdit() {
    skipBlurRef.current = false;
    setDraft(todo.title);
    setEditing(true);
  }

  function commit() {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    onRename(todo.id, draft);
    setEditing(false);
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      skipBlurRef.current = true;
      setDraft(todo.title);
      setEditing(false);
    }
  }

  return (
    <li className={todo.done ? 'todo-item is-done' : 'todo-item'}>
      <input
        className="todo-item__checkbox"
        type="checkbox"
        checked={todo.done}
        onChange={() => onToggle(todo.id)}
        aria-label={todo.done ? `标记「${todo.title}」为未完成` : `标记「${todo.title}」为已完成`}
      />

      {editing ? (
        <input
          ref={inputRef}
          className="todo-item__edit"
          type="text"
          value={draft}
          maxLength={200}
          aria-label="编辑待办"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
        />
      ) : (
        <span
          className="todo-item__title"
          title="双击编辑"
          onDoubleClick={startEdit}
        >
          {todo.title}
        </span>
      )}

      <button
        type="button"
        className="todo-item__delete"
        onClick={() => onRemove(todo.id)}
        aria-label={`删除「${todo.title}」`}
        title="删除"
      >
        ×
      </button>
    </li>
  );
}
