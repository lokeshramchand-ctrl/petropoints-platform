# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f apps/api/Dockerfile -t petropoints-api .

FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @petropoints/api...
RUN pnpm --filter @petropoints/rbac --filter @petropoints/contracts build \
 && pnpm --filter @petropoints/api build
# self-contained production tree (prod deps only, workspace packages included)
RUN pnpm --filter @petropoints/api deploy --prod /out \
 && cp -r apps/api/dist /out/dist && cp -r apps/api/migrations /out/migrations

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out ./
EXPOSE 3000
# Run as non-root, read-only rootfs friendly (no writes at runtime).
CMD ["dist/main.js"]
