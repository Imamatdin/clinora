# syntax=docker/dockerfile:1
# Clinora web + API image. Runs on any container host given DATABASE_URL and the env in docs/DEPLOY.md.
# Base images are pinned by digest; bump deliberately (docs/DEPLOY.md, "Updating base images").

FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854 AS build
WORKDIR /app
ENV CI=true
RUN npm install --global npm@11.12.1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854 AS prod-deps
WORKDIR /app
RUN npm install --global npm@11.12.1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Distroless: no shell, no package manager; runs as uid 65532 (nonroot).
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
# migrate() and /readyz read the shipped migrations relative to WORKDIR.
COPY --chown=root:root db/migrations ./db/migrations
USER nonroot
EXPOSE 8080
# Default: web server. Migration job: args ["dist/server/server/migrate-cli.js"].
# Staging-only synthetic seed: args ["dist/server/server/demo-seed.js"] (refuses APP_ENV=production).
CMD ["dist/server/server/main.js"]
