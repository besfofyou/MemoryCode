const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '未完成' },
  { value: 'done', label: '已完成' },
];

export { FILTERS };

/** 过滤器切换；用 tablist 语义方便屏幕阅读器 */
export default function TodoFilters({ value, onChange, counts }) {
  return (
    <div className="todo-filters" role="tablist" aria-label="筛选待办">
      {FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          role="tab"
          aria-selected={value === filter.value}
          className={
            value === filter.value ? 'todo-filters__tab is-active' : 'todo-filters__tab'
          }
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
          {typeof counts?.[filter.value] === 'number' ? (
            <span className="todo-filters__count">{counts[filter.value]}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
