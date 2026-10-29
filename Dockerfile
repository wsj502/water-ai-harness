# ============================================================
# Water 一体化镜像：core + server + web 构建产物 + 插件
# 构建:  docker build -t water:0.1.0 .
# 运行:  docker run -p 3210:3210 -e ZHIPU_API_KEY=xxx water:0.1.0
# ============================================================

# ---- 阶段 1：构建 ----
FROM node:22-slim AS build
WORKDIR /app

# 先只拷 manifest，最大化利用 docker layer cache（源码变了不重装依赖）
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
RUN npm ci --ignore-scripts

# 再拷源码并构建（core/server 出 dist，web 出静态产物）
COPY packages/core packages/core
COPY apps apps
RUN npx tsc -b packages/core apps/server \
 && npm run build -w apps/web

# ---- 阶段 2：运行时（最小化） ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 只装生产依赖（manifest 层缓存同上）
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# 构建产物 + 插件
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY plugins plugins

# 工作区：Agent 读写的目录，用 volume 挂载真实项目
RUN mkdir -p /workspace
WORKDIR /workspace
ENV WATER_WEB_DIST=/app/apps/web/dist \
    WATER_PLUGIN_DIRS=/app/plugins \
    WATER_PORT=3210

EXPOSE 3210

# 健康检查：config 端点即存活探针（slim 镜像无 curl，用 node 自检）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WATER_PORT||3210)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 凭据经环境变量注入（docker run -e / compose environment / secrets），永不打进镜像
ENTRYPOINT ["node", "/app/apps/server/dist/index.js"]
