# Todo 前端（Vite + React）

`simu` 的 Todo 单页应用。纯前端即可运行，数据存在 `localStorage`。

## 开发

```bash
cd simu/client
npm install
npm run dev            # http://localhost:5173
```

`/api` 开头的请求会代理到 `http://localhost:3000`（可用 `API_TARGET` 覆盖），方便以后接 Express。

## 构建

```bash
npm run build          # 产物在 simu/client/dist
npm run preview        # 本地预览构建结果
```

## 功能

- 新增待办（Enter 或点「添加」）
- 勾选切换完成状态
- **双击标题**编辑，Enter 保存 / Esc 取消 / 失焦保存
- 单个删除
- 过滤：全部 / 未完成 / 已完成（带计数）
- 全部标记完成 / 全部标记未完成
- 清除已完成
- 刷新页面数据不丢（`localStorage`，key：`simu.todo.items`）

## 目录

```
client/
├── index.html
├── vite.config.js
└── src/
    ├── main.jsx
    ├── App.jsx                    # 页面组装：过滤、统计、工具栏
    ├── styles.css                 # 全部样式（无 UI 库）
    ├── storage.js                 # 数据层：读写 localStorage
    ├── hooks/useTodos.js          # 状态与增删改操作
    └── components/
        ├── TodoInput.jsx
        ├── TodoFilters.jsx
        ├── TodoList.jsx
        └── TodoItem.jsx
```

## 接后端时要改的地方

只有一处：`src/storage.js`。把 `loadTodos()` / `saveTodos()` 换成对 `fetch('/api/todos')` 的调用
（`createTodo` 里的 id 也交给服务端生成），`useTodos` 与所有组件都不用动。

> 目前 `simu` 的 Express 只有 `/api/auth` 和 `/api/users`，还没有 `/api/todos`。
