# simu-api

Express + JWT 的用户 CRUD REST API 示例，零构建、按模块拆分。

## 目录结构

```
simu/
├── package.json
├── .env.example          # 复制成 .env
├── src/
│   ├── server.js         # 启动入口（含优雅退出）
│   ├── app.js            # 组装 express app（便于测试）
│   ├── config.js         # 环境变量集中管理
│   ├── logger.js         # 结构化日志器（JSON 行，可换 pino）
│   ├── store.js          # 内存用户存储（换成 DB 只改这个文件）
│   ├── middleware/
│   │   ├── auth.js       # JWT 认证 / 角色 / 本人-or-管理员
│   │   ├── requestLogger.js # 请求日志 + X-Request-Id
│   │   ├── rateLimit.js  # 按 IP 限流（固定窗口 + 内存计数）
│   │   └── errors.js     # HttpError、asyncHandler、404、统一错误处理
│   ├── routes/
│   │   ├── index.js      # /api 总路由：每个资源 use 一行
│   │   ├── auth/
│   │   │   ├── auth.routes.js      # 路由表 + 中间件（注册 / 登录 / me）
│   │   │   └── auth.controller.js  # 控制器：校验入参 → 调 store → 组装响应
│   │   └── users/
│   │       ├── users.routes.js     # 路由表 + 权限声明
│   │       └── users.controller.js # CRUD 处理逻辑
│   └── utils/
│       ├── password.js   # scrypt 哈希（无需编译 bcrypt）
│       └── validate.js   # 入参校验与分页解析
├── jest.config.mjs       # Jest 配置（ESM，test/jest 下的单元测试）
└── test/
    ├── api.test.mjs         # node:test 端到端测试（25 条）
    ├── middleware.test.mjs  # 日志/错误中间件测试（10 条）
    ├── rateLimit.test.mjs   # 限流测试（9 条）
    └── jest/                # Jest 单元测试（44 条）
        ├── helpers/         # mockStore（数据层 mock）、buildApp、env
        ├── users.routes.test.js
        ├── auth.routes.test.js
        ├── store.test.js
        └── password.test.js
```

## 快速开始

```bash
cd simu
npm install
cp .env.example .env      # 改掉 JWT_SECRET
npm start                 # http://localhost:3000
npm test                  # 44 条端到端测试（node:test）
npm run test:unit         # 44 条单元测试（Jest + supertest，mock 数据层）
npm run test:all          # 两套都跑
```

未配置 `.env` 时使用开发默认值：端口 3000、内置管理员 `admin@example.com` / `Admin@12345`、开发用 JWT 密钥（生产环境缺少 `JWT_SECRET` 会直接启动失败）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `LOG_LEVEL` | 开发 `debug` / 生产 `info` | 日志级别：`debug` / `info` / `warn` / `error` / `silent` |
| `JWT_SECRET` | 开发默认值 | 签名密钥，生产必须设置且 >= 16 字符 |
| `JWT_EXPIRES_IN` | `1h` | token 有效期，如 `15m` / `7d` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口（毫秒） |
| `RATE_LIMIT_MAX` | `100` | 窗口内每 IP 允许的请求数，`0` = 关闭限流 |
| `TRUST_PROXY` | 未设置（关闭） | 反向代理层数或 `true`；开启后 `req.ip` 取 `X-Forwarded-For` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / `Admin@12345` | 空库时创建的管理员 |

## 接口一览

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 健康检查 |
| POST | `/api/auth/register` | 公开 | 注册，固定 `user` 角色，返回 token |
| POST | `/api/auth/login` | 公开 | 登录，返回 token |
| GET | `/api/auth/me` | 登录 | 当前用户资料 |
| GET | `/api/users` | 管理员 | 列表，支持 `page` / `limit` / `q` / `role` |
| GET | `/api/users/:id` | 本人或管理员 | 详情 |
| POST | `/api/users` | 管理员 | 创建用户，可指定 `role` |
| PATCH | `/api/users/:id` | 本人或管理员 | 部分更新；`role` 仅管理员可改 |
| DELETE | `/api/users/:id` | 管理员 | 删除；不能删自己 |

响应约定：单条 `{ "data": {...} }`，列表 `{ "data": [...], "meta": {...} }`，错误 `{ "error": { "status", "message", "code?", "details?", "requestId" } }`。

## 调用示例

```bash
# 登录拿 token
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"Admin@12345"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')

# 创建用户
curl -X POST localhost:3000/api/users \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Bob","email":"bob@example.com","password":"Passw0rd!"}'

# 分页列表
curl "localhost:3000/api/users?page=1&limit=10&q=bob" -H "Authorization: Bearer $TOKEN"

# 更新自己
curl -X PATCH localhost:3000/api/users/<id> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Bob Lee"}'

# 删除
curl -X DELETE localhost:3000/api/users/<id> -H "Authorization: Bearer $TOKEN"
```

## 请求日志与错误处理中间件

注册顺序（`src/app.js`）非常关键：

```js
app.use(requestLogger({ logger, skip: ['/health'] })); // 最前面：能盖住 body 解析失败、404、401
app.use(express.json({ limit: '100kb' }));
app.get('/health', ...);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use(notFoundHandler);                              // 404 兜底
app.use(createErrorHandler({ logger }));               // 最后一个，4 个参数
```

### requestLogger（`src/middleware/requestLogger.js`）

- 每个请求生成 `req.id`，并回写 `X-Request-Id` 响应头；传入合法的 `X-Request-Id` 头则透传（只接受 `[A-Za-z0-9._:-]{1,64}`，防日志注入）
- 请求结束（`finish`）或客户端断开（`close`）时输出一行 JSON 日志；`/health` 默认跳过，仍会带请求 ID
- 按状态码分级：`5xx=error`、`4xx=warn`、其余 `info`；耗时 >= 1000ms 追加 `slow: true`
- 派生 `req.log`，业务代码里 `req.log.info('xxx', { foo })` 自动带上 `requestId`

```json
{"time":"2026-10-26T12:17:33.241Z","level":"warn","msg":"GET /api/users 401","requestId":"c777d65e-...","method":"GET","path":"/api/users","status":401,"durationMs":3,"ip":"::ffff:127.0.0.1","userAgent":"node"}
```

### createErrorHandler（`src/middleware/errors.js`）

- 业务代码只管 `throw new HttpError(404, '用户不存在', { code: 'NOT_FOUND', details })`，由 `asyncHandler` 把 async 异常交给它
- body-parser 的错误翻译成稳定 code：非法 JSON → `400 INVALID_JSON`、超限 → `413 PAYLOAD_TOO_LARGE`、编码/字符集不支持 → `415`
- 非 `HttpError` 的 5xx 对外只返回「服务器内部错误」，堆栈只进日志；开发模式下错误体额外带 `stack`
- 响应体统一带 `requestId`，和日志一一对应
- 4xx 只记 `debug`（请求日志已记过 `warn`），5xx 记 `error` 并带完整堆栈
- 已发送响应头（`res.headersSent`）时交回 Express 默认处理，避免二次写 header 报错

```bash
curl -i localhost:3000/api/users
# HTTP/1.1 401 ...
# X-Request-Id: c777d65e-fd9f-498f-b3d2-d4b9b86063cc
# {"error":{"status":401,"message":"缺少访问令牌","code":"TOKEN_MISSING",
#   "details":{"header":"Authorization: Bearer <token>"},"requestId":"c777d65e-..."}}
```

`createApp({ logger })` 支持注入日志器，测试里传 `createApp({ logger: false })` 即静默；要接 pino 只需替换 `createLogger` 的实现。

## 认证中间件用法

```js
import { authenticate, authorize, selfOrAdmin, optionalAuth } from './middleware/auth.js';

router.get('/posts', optionalAuth, listPosts);                 // 有 token 就识别用户，没有也放行
router.post('/posts', authenticate, createPost);               // 必须登录
router.delete('/posts/:id', authenticate, authorize('admin')); // 需要角色
router.patch('/me', authenticate, selfOrAdmin((r) => r.user.id), updateMe);
```

- `signToken(user)` 只写入 `sub` / `email` / `role`，不放任何敏感字段。
- `authenticate` 校验签名、签发者和过期时间，并回查用户：用户被删除或改名后旧 token 立即失效。
- 401 区分 `TOKEN_MISSING` / `TOKEN_INVALID` / `TOKEN_EXPIRED`，便于前端决定是静默刷新还是跳登录页。

## 路由模块化（每个资源一个模块）

`src/routes/index.js` 是唯一的挂载点，`app.js` 只写一行 `app.use('/api', apiRouter)`：

```js
// src/routes/index.js
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
```

每个资源一个目录，分两层：

| 文件 | 职责 | 对应改动场景 |
| --- | --- | --- |
| `<资源>.routes.js` | 只写「路径 + 中间件 + 权限」 | 改 URL、加权限、换限流 |
| `<资源>.controller.js` | 校验入参 → 调 `store` → 组装响应 | 改业务逻辑、改响应体 |

这样打开 `users.routes.js` 就能一眼看完 `/api/users` 的整个权限模型：

```js
router.use(authenticate);            // 整个资源都要求登录
router.get('/', authorize('admin'), list);
router.get('/:id', selfOrAdmin(idFromParams), getOne);
router.delete('/:id', authorize('admin'), remove);
```

### 新增一个资源（例如 orders）

1. 建 `src/routes/orders/orders.controller.js`：导出 `list` / `getOne` / `create` …
2. 建 `src/routes/orders/orders.routes.js`：用 `Router()` 声明路径与中间件
3. 在 `src/routes/index.js` 加一行：`apiRouter.use('/orders', ordersRouter);`

不用动 `app.js`，也不用改其他地方。资源内部要给登录用户用，就在 routes 里 `router.use(authenticate)`；要常量级操作，直接 `authorize('admin')`。

路由层不碰 `passwordHash`，统一走 `store.toPublicUser()`；错误一律 `throw new HttpError(status, message, { code, details })`，由统一错误处理中间件输出。

## 限流（每个 IP 100 次/分钟）

`src/middleware/rateLimit.js`，零依赖，挂在所有路由之前、body 解析之前：

```js
app.use(rateLimit({ windowMs: 60_000, max: 100, skip: ['/health'] }));
```

- 固定窗口计数，key 默认是 `req.ip`：`::ffff:127.0.0.1` 折叠成 IPv4，纯 IPv6 按 /64 归并（防轮换地址绕过）
- 每个响应都带 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`
- 超限不直接写响应，而是 `next(new HttpError(429, ..., { code: 'RATE_LIMITED' }))`，所以 429 也带 `X-Request-Id`、结构化日志（warn）和统一错误体：

```bash
for i in $(seq 1 101); do curl -s -o /dev/null localhost:3000/api/auth/me; done
curl -i localhost:3000/api/auth/me
# HTTP/1.1 429 Too Many Requests
# RateLimit-Limit: 100
# RateLimit-Remaining: 0
# RateLimit-Reset: 42
# Retry-After: 42
# {"error":{"status":429,"message":"请求过于频繁，请稍后再试","code":"RATE_LIMITED",
#   "details":{"limit":100,"windowMs":60000,"retryAfter":42},"requestId":"..."}}
```

- `/health` 默认跳过，避免探针把配额吃光；`RATE_LIMIT_MAX=0` 直接关闭限流
- **反向代理后面必须开 `TRUST_PROXY=1`**，否则 `req.ip` 全是代理地址，等于全局限流
- 登录这类敏感接口可以再叠一层更严的：`router.post('/login', rateLimit({ max: 10, skip: [] }), handler)`
- 计数在进程内存里：单实例够用；多实例换成 Redis（`INCR` + `PEXPIRE`）实现，中间件签名保持不变
- 进程退出时定时清理器已 `unref`，不会拖住 `server.close()`；手动清理用 `store.cleanup()` / `store.resetAll()`

## 测试

两套测试互不干扰：

| 命令 | 框架 | 覆盖 | 特点 |
| --- | --- | --- | --- |
| `npm test` | node:test + 真实 HTTP | 44 条 | 端到端，验证真实链路 |
| `npm run test:unit` | Jest + supertest | 44 条 | 起不了真实端口，数据层全部 mock |
| `npm run test:all` | - | - | 两套都跑 |

### 单元测试怎么 mock 数据库连接

`src/store.js` 就是数据层（数据库连接的边界），单元测试用 Jest 的 ESM API 整体替换成 `jest.fn()`：

```js
// test/jest/helpers/mockStore.js
export const dbMock = {
  list: jest.fn(), findById: jest.fn(), findByEmail: jest.fn(),
  create: jest.fn(), update: jest.fn(), remove: jest.fn(), checkPassword: jest.fn(),
};

export function installStoreMock() {
  return jest.unstable_mockModule(STORE_PATH, () => dbMock); // STORE_PATH 必须是绝对路径
}
```

```js
// test/jest/users.routes.test.js
await installStoreMock();                                            // 1. 先注册 mock
const { default: usersRouter } = await import('../../src/routes/users.js'); // 2. 再加载被测模块
const app = buildApp({ usersRouter });                               // 3. 最小 app，不监听端口

await request(app).get('/api/users').set(auth(admin)).expect(200);
```

几个踩过的坑（已体现在代码里）：

- 项目是 ESM，普通 `jest.mock()` 不生效，要用 `jest.unstable_mockModule()` + **动态 `import()`**，运行时加 `--experimental-vm-modules`
- mock 路径写**绝对路径**，否则和 `src/routes/users.js` 里的 `'../store.js'` 解析不到同一个模块
- 保持数据层的**同步/异步签名**：`store.list` 是同步的，mock 就不能返回 Promise，否则路由里解构出的 `items` 是 `undefined`，报错信息会非常容易误解
- 除了断言状态码，还要断言「没有写库」：`expect(dbMock.create).not.toHaveBeenCalled()`，这才是权限校验的真实验证
- 要 mock 真实驱动时只需换 helper，路由测试不用改：

```js
jest.unstable_mockModule('pg', () => ({
  default: { Pool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })) },
}));
```

## Docker（Express + React 单镜像）

`Dockerfile` 是三阶段构建，构建上下文是 `simu/`：

1. `client` 阶段：`npm ci` + `vite build`，产出 `client/dist`
2. `deps` 阶段：只装生产依赖（`npm ci --omit=dev`）
3. `runtime` 阶段：`node:20-alpine` + 源码 + 生产依赖，前端产物拷到 `/app/public`

Express 侧对应地在 `app.js` 里挂了静态托管（见 `src/app.js`）：只要 `public/index.html` 存在，就
`express.static` 提供资源，并用 SPA 兜底把非 `/api` 的 GET/HEAD 回 `index.html`；目录不存在时整段跳过，
所以纯 API 部署和现有 88 条测试都不受影响。

```bash
# 构建（在仓库根目录执行）
docker build -t simu-api:latest simu

# 运行：生产环境必须提供 JWT_SECRET，否则启动即失败
docker run --rm -p 3000:3000 \
  -e JWT_SECRET=please-change-this-to-32chars \
  -e ADMIN_PASSWORD='ChangeMe@12345' \
  simu-api:latest

# 前端和 API 同一个端口
curl -s localhost:3000/ | head -5        # React 首页
curl -s localhost:3000/health            # {"status":"ok",...}
curl -s localhost:3000/any/spa/route     # SPA 兜底，返回 index.html
curl -s localhost:3000/api/unknown       # 仍走统一 404 JSON
```

镜像要点：

| 项 | 说明 |
| --- | --- |
| 运行用户 | `USER node`（非 root） |
| 健康检查 | `wget --spider /health`，30s 一次 |
| 信号 | `CMD ["node", ...]` exec 形式，SIGTERM 直达 `server.js` 的优雅退出 |
| 缓存 | `package*.json` 先 COPY 再装依赖，改业务代码不重装 |
| 排除 | `.dockerignore` 屏蔽 `node_modules`、`test`、`.env`、`client/dist` |
| 体积 | 只含生产依赖 + 构建产物 + `src`（约 60 MB 级别） |

想换成 Nginx 托管前端、Express 只做 API 的话，把 `client` 阶段的 `dist` 拷进 `nginx:alpine` 即可，
Express 侧把 `publicDir: false` 传进去就能关掉静态托管。

## 生产化改造清单

1. `store.js` 换成真实数据库（Postgres/MySQL/Mongo），保留同样的函数签名，`test/jest` 里把 `mockStore` 换成 mock `pg` 即可。
2. 内存态多实例部署不可用 → 用户、角色必须落库；如需主动踢下线，加 token 版本号或黑名单。
3. 加 `helmet`、`cors`；登录接口叠一层更严的 `rateLimit({ max: 10 })` 防爆破。
4. 密码策略、邮箱验证、找回密码、refresh token（短期 access + 长期 refresh）。
5. 日志换成 `pino`（保留 `requestLogger` 字段约定），接入 traceId 串联上游调用，敏感字段脱敏。
6. 限流计数改为 Redis 存储（多实例共享配额），并考虑按用户 ID + IP 双维度限流。