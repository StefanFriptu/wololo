# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.4.4
ARG DEBIAN_RELEASE=trixie

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-slim AS web
WORKDIR /app
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --frozen-lockfile
COPY src/shared src/shared
COPY web web
RUN cd web && bun run build

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:${BUN_VERSION}-slim AS bun

FROM debian:${DEBIAN_RELEASE}-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="Wololo" \
      org.opencontainers.image.description="Self-hosted *arr companion that converts media so every TV direct-plays it" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg mkvtoolnix 7zip ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 wololo \
 && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin wololo \
 && mkdir -p /config /data

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json bun.lock ./
COPY drizzle drizzle
COPY src src
COPY --from=web /app/web/build web/build
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/healthcheck.ts /app/docker/healthcheck.ts

ENV WOLOLO_VERSION=${VERSION} \
    PUID=1000 \
    PGID=1000 \
    UMASK=002 \
    TZ=Etc/UTC \
    NODE_ENV=production \
    WOLOLO_DOCKER=1 \
    WOLOLO_CONFIG_DIR=/config \
    WOLOLO_WEB_DIR=/app/web/build

EXPOSE 8585
STOPSIGNAL SIGTERM
VOLUME ["/config"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --start-interval=5s --retries=3 CMD ["bun", "/app/docker/healthcheck.ts"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
