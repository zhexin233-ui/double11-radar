# 线报需求匹配与推送 —— 多阶段构建
#
# 同一镜像同时用于 web 与 worker：
#   web    : node_modules/.bin/next start -p 3000
#   worker : node_modules/.bin/tsx src/worker/main.ts
#
# worker 使用 tsx 直接运行 TypeScript 源码，因此运行时镜像保留完整
# node_modules（含 devDependencies）与 src/，避免额外的编译步骤出错。

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=1
# better-sqlite3 在没有预编译包时需要 python3/make/g++ 从源码构建；
# git 用于某些依赖的 git 源解析。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
