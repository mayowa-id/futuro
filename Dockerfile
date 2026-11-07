FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN npm run typecheck && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    MODEL_URL=http://127.0.0.1:8001 \
    MODEL_PORT=8001 \
    PYTHON_EXECUTABLE=python3 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_PATH=/app/data/futuro.sqlite \
    ARTIFACT_DIRECTORY=/app/data/artifacts \
    AUTOMATION_ENABLED=false
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node model/scoring.py model/server.py model/trainer.py ./model/
COPY --chown=node:node docker ./docker
RUN mkdir -p /app/data/artifacts && chown -R node:node /app/data
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','10000')+'/health/ready',timeout=4)"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "docker/entrypoint.py"]
