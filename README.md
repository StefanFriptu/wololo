# Wololo

Self-hosted *arr companion that rewrites imported media so every TV in the household can direct-play it: audio the device cannot decode is converted (DTS, TrueHD, E-AC3, PCM to AC3 by default), decrypted Blu-ray folders and ISOs become one MKV with languages and chapters, and Radarr, Sonarr and Plex are told about every change.

> Status: early development (M0 skeleton). The full README with setup instructions lands with the first release.

## Quick start (Docker)

```yaml
services:
  wololo:
    image: ghcr.io/OWNER/wololo:latest
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
    volumes:
      - ./wololo/config:/config
      - /path/to/data:/data
    ports:
      - 8585:8585
    restart: unless-stopped
```

Open http://localhost:8585. The API key is generated on first start and shown under Settings > General.

## Development

```sh
bun install && (cd web && bun install)
bun run build        # build the web UI
bun run dev          # backend on :8585 (config in ./config)
cd web && bun run dev  # optional: UI dev server with /api proxy
bun run lint && bun run typecheck && bun test
```

See [docs/SPEC.md](docs/SPEC.md) for requirements and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code map.

## License

GPL-3.0. See [LICENSE](LICENSE).
