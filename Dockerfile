# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.4.4
ARG DEBIAN_RELEASE=trixie

# The web bundle and the production node_modules (pure JavaScript) are identical for every target architecture,
# so both stages run on the build machine's platform and are never emulated.
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
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg mkvtoolnix 7zip ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 wololo \
 && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin wololo \
 && mkdir -p /config /data

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Fails the build when a tool the jobs depend on is missing (ffmpeg must read Blu-ray structures through libbluray).
RUN bun --version \
 && ffmpeg -hide_banner -protocols 2>/dev/null | grep -Eq '^[[:space:]]*bluray$' \
 && ffprobe -hide_banner -version > /dev/null \
 && mkvmerge --version \
 && 7z i > /dev/null \
 && nice --version > /dev/null \
 && ionice --version \
 && setpriv --version

WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY drizzle drizzle
COPY src src
COPY --from=web /app/web/build web/build
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/healthcheck.ts /app/docker/healthcheck.ts

ENV PUID=1000 \
    PGID=1000 \
    UMASK=002 \
    TZ=Etc/UTC \
    NODE_ENV=production \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    WOLOLO_DOCKER=1 \
    WOLOLO_CONFIG_DIR=/config \
    WOLOLO_WEB_DIR=/app/web/build

# Last, so a new version only changes these metadata layers and every RUN layer above stays cached.
ARG VERSION=dev
ENV WOLOLO_VERSION=${VERSION}
LABEL org.opencontainers.image.title="Wololo" \
      org.opencontainers.image.description="Self-hosted *arr companion that converts media so every TV direct-plays it" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"

EXPOSE 8585
STOPSIGNAL SIGTERM
VOLUME ["/config"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --start-interval=5s --retries=3 CMD ["bun", "/app/docker/healthcheck.ts"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
