FROM docker:29.9.2-cli AS docker-cli

FROM node:24.12.0-slim AS build
WORKDIR /lab
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY tsconfig.json vite.config.ts vite.inspection.config.ts index.html inspection.html ./
COPY shared/ ./shared/
COPY src/ ./src/
COPY server/ ./server/
COPY tests/ ./tests/
RUN npm run build && ./node_modules/.bin/vite build --config vite.inspection.config.ts

FROM node:24.12.0-slim AS runtime
WORKDIR /lab
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.cache
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --cache /tmp/npm-cache \
  && rm -rf /tmp/npm-cache /root/.npm
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY shared/ ./shared/
COPY src/physics/ ./src/physics/
COPY server/ ./server/
COPY --from=build /lab/dist/ ./dist/
COPY --from=build /lab/dist-inspection/ ./dist-inspection/
USER 10001:10001

FROM runtime AS worker
ENTRYPOINT ["node", "server/harness-worker.ts"]

FROM runtime AS renderer
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "server/render-gateway.ts"]

FROM runtime AS api
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "server/index.ts"]
