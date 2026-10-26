import { useState } from 'react';

/** 顶部输入框：Enter 或点「添加」都能新增 */
export default function TodoInput({ onAdd }) {
  const [value, setValue] = useState('');

  function submit(event) {
    event.preventDefault();
    if (onAdd(value)) setValue('');
  }

  return (
    <form className="todo-input" onSubmit={submit}>
      <input
        className="todo-input__field"
        type="text"
        value={value}
        placeholder="要做点什么？"
        aria-label="新的待办"
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="todo-input__submit" type="submit" disabled={!value.trim()}>
        添加
      </button>
    </form>
  );
}
