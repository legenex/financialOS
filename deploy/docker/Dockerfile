# FinancialOS application image: one image for the API server, the worker, and one-shot CLI tasks.
#
#   deploy/scripts/build-image.sh            (preferred: low priority, memory check, privacy scan, tags)
#   docker build -f deploy/docker/Dockerfile -t financialos:<tag> .
#
# Native on linux/arm64; also builds on linux/amd64. No secrets, configuration, or financial data are baked in:
# configuration and secrets are mounted at runtime (see deploy/compose/prod.compose.yml).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------------------------------------------
# deps: install the locked dependency tree once (dev dependencies are needed to build).
# ---------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
ENV CI=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    npm_config_maxsockets=4 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NO_COLOR=1 \
    NODE_OPTIONS=--max-old-space-size=2048
COPY package.json package-lock.json .npmrc ./
COPY --parents packages/*/package.json apps/*/package.json ./
# Heavy steps run under nice and a bounded Node heap; the host shares CPU and memory with other workloads.
# Install scripts are skipped: the only packages that declare one (esbuild) work without it.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    nice -n 10 npm ci --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------------------------------------------------------
# build: web SPA, API and worker bundles, extension package, runtime dependency set.
# ---------------------------------------------------------------------------------------------------------------
FROM deps AS build
# FOS_PARTIAL_BUILD=1 tolerates a missing worker or extension bundle. Only for early integration testing;
# build-image.sh never sets it.
ARG FOS_PARTIAL_BUILD=0
COPY . .
RUN set -eu; \
    nice -n 10 npm run build -w apps/web; \
    for ws in apps/api apps/worker; do \
      if [ -f "$ws/build.mjs" ]; then nice -n 10 npm run build -w "$ws"; \
      elif [ "$FOS_PARTIAL_BUILD" = 1 ]; then echo "partial build: $ws/build.mjs is missing, skipped"; \
      else echo "$ws/build.mjs is missing" >&2; exit 1; fi; \
    done; \
    mkdir -p /out/extension; \
    if [ -f apps/extension/build.mjs ]; then \
      nice -n 10 npm run package -w apps/extension; \
      set -- apps/extension/release/*.zip; \
      if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then echo "expected exactly one extension package in apps/extension/release" >&2; exit 1; fi; \
      cp "$1" /out/extension/financialos-extension.zip; \
      (cd /out/extension && sha256sum financialos-extension.zip > financialos-extension.zip.sha256); \
    elif [ "$FOS_PARTIAL_BUILD" = 1 ]; then echo "partial build: extension package skipped"; \
    else echo "apps/extension/build.mjs is missing" >&2; exit 1; fi; \
    for required in apps/web/dist/index.html apps/api/dist/main.mjs apps/api/dist/cli.mjs \
                    apps/worker/dist/main.mjs apps/worker/dist/cli.mjs; do \
      if [ ! -f "$required" ]; then \
        if [ "$FOS_PARTIAL_BUILD" = 1 ]; then echo "partial build: $required missing"; \
        else echo "build artifact missing: $required" >&2; exit 1; fi; \
      fi; \
    done; \
    mkdir -p /out/app/apps/api /out/app/apps/worker /out/app/apps/web /out/app/migrations; \
    cp -a apps/web/dist /out/app/apps/web/dist; \
    for ws in apps/api apps/worker; do \
      if [ -d "$ws/dist" ]; then cp -a "$ws/dist" "/out/app/$ws/dist"; fi; \
    done; \
    if [ -d packages/db/migrations ]; then cp -a packages/db/migrations/. /out/app/migrations/; fi; \
    dists=""; \
    for ws in apps/api apps/worker; do if [ -d "$ws/dist" ]; then dists="$dists $ws/dist"; fi; done; \
    if [ -n "$dists" ]; then \
      node deploy/docker/copy-externals.mjs --root /src --out /out/app $dists; \
    fi; \
    find /out/app -name '*.map' -delete; \
    chmod -R a+rX,go-w /out

# ---------------------------------------------------------------------------------------------------------------
# runtime: minimal Node.js + PostgreSQL 17 client (backups and restore verification), non-root.
# ---------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG NODE_IMAGE
ARG FOS_VERSION=0.0.0
ARG FOS_REVISION=unknown
ARG FOS_CREATED=unknown
ARG FOS_SOURCE_URL=
# PGDG archive signing key (fingerprint B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8).
# The runtime never installs packages after this stage, so npm, npx, corepack and yarn are removed below.
ARG PGDG_ARCHIVE_ASC_SHA256=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76

LABEL org.opencontainers.image.title="FinancialOS" \
      org.opencontainers.image.description="Self-hosted personal and business finance command centre (API server and worker)" \
      org.opencontainers.image.version="${FOS_VERSION}" \
      org.opencontainers.image.revision="${FOS_REVISION}" \
      org.opencontainers.image.created="${FOS_CREATED}" \
      org.opencontainers.image.source="${FOS_SOURCE_URL}" \
      org.opencontainers.image.base.name="${NODE_IMAGE}"

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tini; \
    rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:${PGDG_ARCHIVE_ASC_SHA256} https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/keyrings/pgdg-archive.asc

RUN set -eu; \
    chmod 0644 /usr/share/keyrings/pgdg-archive.asc; \
    printf '%s\n' \
      'Types: deb' \
      'URIs: https://apt.postgresql.org/pub/repos/apt' \
      'Suites: bookworm-pgdg' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/pgdg-archive.asc' > /etc/apt/sources.list.d/pgdg.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-17; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb; \
    /usr/lib/postgresql/17/bin/pg_dump --version; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg; \
    groupadd --system --gid 10001 fos; \
    useradd --system --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin fos; \
    mkdir -p /data/documents /data/backups /data/scratch /run/fos; \
    chown 10001:10001 /data/documents /data/backups /data/scratch; \
    chmod 0750 /data/documents; \
    chmod 0700 /data/scratch; \
    chmod 2770 /data/backups

ENV NODE_ENV=production \
    FOS_PORT=3000 \
    FOS_CONFIG_FILE=/run/fos/config/app-config.json \
    FOS_DOCUMENTS_DIR=/data/documents \
    FOS_BACKUP_DIR=/data/backups \
    FOS_MIGRATIONS_DIR=/app/migrations \
    FOS_EXTENSION_PACKAGE=/app/extension/financialos-extension.zip \
    PATH=/usr/lib/postgresql/17/bin:$PATH \
    TINI_SUBREAPER=1

WORKDIR /app
COPY --from=build --chown=root:root /out/app/ /app/
COPY --from=build --chown=root:root /out/extension/ /app/extension/

USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.mjs"]
