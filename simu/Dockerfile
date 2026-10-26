# syntax=docker/dockerfile:1

# 构建上下文 = simu/ 目录：
#   docker build -t simu-api:latest simu

# ---------- 阶段 1：构建 React 前端 ----------
FROM node:20-alpine AS client

WORKDIR /build/client

# 先只拷依赖清单，业务代码改动时这一层仍能复用缓存
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY client/ ./
RUN npm run build


# ---------- 阶段 2：安装后端生产依赖 ----------
FROM node:20-alpine AS deps

WORKDIR /build/api

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund


# ---------- 阶段 3：运行时 ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# 只带必要文件：源码 + 生产依赖 + 前端构建产物（挂到 /app/public）
COPY --from=deps /build/api/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=client /build/client/dist ./public

# 用镜像内置的非 root 用户运行
USER node

EXPOSE 3000

# alpine 自带 busybox wget，不必额外装 curl
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PORT}/health" || exit 1

# exec 形式：node 作为 PID 1 直接收到 SIGTERM，交给 server.js 的优雅退出
CMD ["node", "src/server.js"]
