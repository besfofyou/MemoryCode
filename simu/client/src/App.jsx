import { useMemo, useState } from 'react';
import TodoInput from './components/TodoInput.jsx';
import TodoFilters from './components/TodoFilters.jsx';
import TodoList from './components/TodoList.jsx';
import { useTodos } from './hooks/useTodos.js';

export default function App() {
  const { todos, add, toggle, rename, remove, clearCompleted, toggleAll, stats } = useTodos();
  const [filter, setFilter] = useState('all');

  const visible = useMemo(() => {
    if (filter === 'active') return todos.filter((t) => !t.done);
    if (filter === 'done') return todos.filter((t) => t.done);
    return todos;
  }, [todos, filter]);

  const allDone = stats.total > 0 && stats.active === 0;

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Todo</h1>
        <p className="app__subtitle">
          {stats.total === 0
            ? '添加第一条待办开始记录'
            : `${stats.active} 项未完成 / 共 ${stats.total} 项`}
        </p>
      </header>

      <TodoInput onAdd={add} />

      <div className="app__toolbar">
        <TodoFilters
          value={filter}
          onChange={setFilter}
          counts={{ all: stats.total, active: stats.active, done: stats.done }}
        />
        {stats.total > 0 ? (
          <button
            type="button"
            className="app__link"
            onClick={() => toggleAll(!allDone)}
          >
            {allDone ? '全部标为未完成' : '全部标为完成'}
          </button>
        ) : null}
      </div>

      <TodoList
        todos={visible}
        filter={filter}
        onToggle={toggle}
        onRename={rename}
        onRemove={remove}
      />

      {stats.done > 0 ? (
        <footer className="app__footer">
          <span>{stats.done} 项已完成</span>
          <button type="button" className="app__link" onClick={clearCompleted}>
            清除已完成
          </button>
        </footer>
      ) : null}
    </main>
  );
}
