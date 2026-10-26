import TodoItem from './TodoItem.jsx';

const EMPTY_TEXT = {
  all: '还没有待办，先添加一条吧。',
  active: '没有未完成的待办。',
  done: '还没有已完成的待办。',
};

export default function TodoList({ todos, filter, onToggle, onRename, onRemove }) {
  if (todos.length === 0) {
    return <p className="todo-empty">{EMPTY_TEXT[filter] ?? EMPTY_TEXT.all}</p>;
  }

  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <TodoItem
          key={todo.id}
          todo={todo}
          onToggle={onToggle}
          onRename={onRename}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}
