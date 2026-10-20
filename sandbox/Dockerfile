FROM node:24.12.0-slim

WORKDIR /lab
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.cache
RUN npm ci --omit=dev --ignore-scripts --cache /tmp/npm-cache \
  && rm -rf /tmp/npm-cache /root/.npm
COPY shared/*.ts ./shared/
COPY src/physics/*.ts ./src/physics/
COPY server/harness-worker.ts server/harness-review.ts server/scene-inspector.ts server/lab-resources.ts ./server/
COPY dist-inspection/ ./dist-inspection/

USER 10001:10001
ENTRYPOINT ["node", "server/harness-worker.ts"]
