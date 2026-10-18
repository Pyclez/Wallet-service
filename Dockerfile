FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000
USER bun

HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD ["bun", "-e", "fetch('http://localhost:3000/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "src/main.ts"]
