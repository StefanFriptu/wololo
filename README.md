# Wololo

Wololo is a self-hosted companion for Radarr, Sonarr and Plex. It rewrites imported media so every TV in the house can direct-play it.

- **Audio:** tracks your TV cannot decode (DTS, TrueHD, E-AC3, PCM by default) become AC3. Video, subtitles, chapters and compatible tracks are copied untouched.
- **Blu-ray:** decrypted BDMV folders and `.iso` images become one MKV with the disc's languages and chapters, imported through Radarr.
- **No manual steps:** Radarr/Sonarr call Wololo on import. Wololo converts, verifies, swaps the file atomically, then tells Radarr, Sonarr and Plex.
- **Safe by default:** it starts in dry-run mode, and an original is replaced only after the new file passes verification. Replaced originals sit in a recycle bin for 7 days.

It ships as one Docker image (amd64 and arm64) and is built to run on a Raspberry Pi 4.

## Contents

- [Install with Docker Compose](#install-with-docker-compose)
- [First start](#first-start)
- [Connect Radarr and Sonarr](#connect-radarr-and-sonarr)
- [Path mappings](#path-mappings)
- [Sign in to Plex](#sign-in-to-plex)
- [First run: dry run, then process](#first-run-dry-run-then-process)
- [Backup and restore](#backup-and-restore)
- [Updating](#updating)
- [API](#api)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Install with Docker Compose

Add Wololo to the compose file that already runs your *arr apps ([docker-compose.example.yml](docker-compose.example.yml) has the commented version):

```yaml
services:
  wololo:
    image: ghcr.io/OWNER/wololo:latest
    container_name: wololo
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Bucharest
      - UMASK=002
    volumes:
      - ./wololo/config:/config
      - /srv/data:/data
    ports:
      - 8585:8585
    restart: unless-stopped
    stop_grace_period: 30s
```

Replace `OWNER` with the GitHub account that publishes the image. Then run `docker compose up -d wololo`.

- **Image tags:** `latest` and `X.Y.Z` are releases. `main` follows the main branch. Until the first release is tagged, only `main` exists, so use `ghcr.io/OWNER/wololo:main`.
- **Keep `restart: unless-stopped`** (or `always`). The **Restart** button stops the process and relies on Docker to start it again. You need it to apply a restore or a port or URL base change. Without a restart policy, the container stays down.

**The one rule that matters: mount media exactly like Radarr and Sonarr do.** Use the same host folder at the same container path (`/data` in the [TRaSH guides](https://trash-guides.info/File-and-Folder-Structure/) layout). Wololo writes the new file next to the original and renames it into place. That rename is atomic only within one filesystem and one mount.

| Setting        | What it does                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `PUID`, `PGID` | User and group Wololo runs as. Use the same IDs as Radarr/Sonarr so converted files keep their owner. |
| `TZ`           | Time zone, e.g. `Europe/Bucharest`. Used for the processing window and backup names.                  |
| `UMASK`        | Permission mask for new files, e.g. `002` (group-writable) or `022`.                                  |
| `/config`      | Database, `config.json` (API key, port), logs and backups. Back this up.                              |
| `/data`        | Your media, same path as in Radarr/Sonarr.                                                            |
| `8585`         | Web UI, API and webhooks on one port.                                                                 |

Optional environment variables (they lock the matching setting in the UI):

| Variable                                                              | Default                        | Purpose                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `WOLOLO__PORT`                                                        | `8585`                         | Listen port                                                                                                                           |
| `WOLOLO__BIND_ADDRESS`                                                | `*`                            | `*` or one IP address                                                                                                                 |
| `WOLOLO__URL_BASE`                                                    | empty                          | e.g. `/wololo` behind a reverse proxy                                                                                                 |
| `WOLOLO__API_KEY`                                                     | generated                      | Fix the API key: 16-128 characters from `A-Z a-z 0-9 . _ ~ -`; any other value is ignored and a key is generated                      |
| `WOLOLO__LOG_LEVEL`                                                   | `info`                         | `trace`, `debug`, `info`, `warn`, `error`                                                                                             |
| `WOLOLO__INSTANCE_NAME`                                               | `Wololo`                       | Name shown in the UI                                                                                                                  |
| `WOLOLO__AUTHENTICATION`                                              | `disabled_for_local_addresses` | Who gets the API key in the web UI: local addresses only, `required` (always ask) or `disabled` (only behind an authenticating proxy) |
| `WOLOLO__FFMPEG`, `WOLOLO__FFPROBE`, `WOLOLO__MKVMERGE`, `WOLOLO__7Z` | from `PATH`                    | Tool paths, for custom builds                                                                                                         |

Image tags: `latest` (newest release), `X.Y.Z` and `X.Y` (releases), `main` (development builds), `sha-<commit>`.

The image bundles ffmpeg (with libbluray), MKVToolNix and 7-Zip. It drops root on start and runs as `PUID:PGID`, and Docker's health check calls `/health`.

## First start

1. Open `http://<host>:8585`.
2. From your home network the UI opens straight away. From anywhere else, it asks for the API key.
3. Find the API key under **Settings > General**, or in `/config/config.json`. Radarr and Sonarr need it for the webhook.
4. Add a library under **Settings > Media**: one entry per media folder, e.g. `/data/media/movies`, using the path inside the container.
5. Look at **System > Status**. It lists the bundled tools and any health warnings (missing tools, unreachable folders, low disk space).

## Connect Radarr and Sonarr

Wololo needs two links: it calls Radarr/Sonarr (rescans, lookups), and they call Wololo (webhooks).

**1. Add the instance in Wololo.** Go to **Settings > Connect**, add Radarr, and enter:

- URL: `http://radarr:7878` (service name on the same Docker network) or `http://<host-ip>:7878`.
- API key: from Radarr **Settings > General > Security**.

Press **Test**, then save. Repeat for Sonarr (`http://sonarr:8989`). Wololo then shows the webhook URL for that instance. It looks like this:

```
http://wololo:8585/api/v1/webhook/radarr?instance=1&apikey=<your Wololo API key>
```

**2. Add the webhook in Radarr.** Go to **Settings > Connect > + > Webhook** and enter:

| Field                 | Value                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Name                  | `Wololo`                                                                                                    |
| Notification Triggers | **On File Import** and **On File Upgrade** (older versions: _On Import_, _On Upgrade_). Leave the rest off. |
| Webhook URL           | the URL Wololo showed for this instance                                                                     |
| Method                | `POST`                                                                                                      |
| Username / Password   | empty                                                                                                       |

Press **Test**. Radarr reports success when Wololo answered. Save.

**3. Do the same in Sonarr.** Use **Settings > Connect > + > Webhook** with the Sonarr URL (`.../webhook/sonarr?instance=<id>&apikey=...`) and the same two triggers.

The flow after every import:

```
Radarr imports -> webhook -> Wololo checks the file -> (needs work) queue -> convert -> verify -> atomic swap
  -> Radarr/Sonarr rescan -> Plex partial scan of that folder
```

Radarr and Wololo on different Docker networks? Use the host IP in both URLs, or put both containers on one network ([docker-compose.example.yml](docker-compose.example.yml) shows how).

## Path mappings

Wololo stores local container paths. It needs a mapping when another app sees the same files under a different path.

- **No mapping needed** if Radarr, Sonarr and Wololo all mount the media at `/data`. This is the recommended layout.
- **Mapping needed** if Radarr reports `/movies/Film (2020)/film.mkv` while Wololo sees `/data/media/movies/Film (2020)/film.mkv`. Add one under **Settings > Connect > Path mappings**:
  - Scope: `radarr` (or `sonarr`, `plex`, `qbittorrent`). Instance: that one, or all.
  - Remote path: `/movies`. Local path: `/data/media/movies`.

Plex often uses different paths, e.g. `/tv`, `/movies` or a NAS share. Add a `plex` mapping, or Plex's partial scan will look in the wrong folder.

A webhook for a path outside every library root is logged as `unknown_path`. That usually means a missing mapping or library.

## Sign in to Plex

1. Go to **Settings > Plex > Sign in with Plex**.
2. Wololo shows a PIN. Approve it at [plex.tv/link](https://plex.tv/link), or in the window that opens.
3. Pick your server from the list. Wololo matches each library section by its folder paths, so add a `plex` path mapping if Plex sees the media elsewhere.
4. Press **Test**.

From then on, every changed file triggers a partial scan of its folder only. Optional: **auto-pause while Plex is streaming** (under **Settings > Plex**) and a processing window, e.g. 01:00-08:00 (under **Settings > Media**).

## First run: dry run, then process

Wololo starts with **processing off**. In this dry-run mode it checks files and reports, but never writes a media file. Keep it that way until you have seen the report.

1. Run a scan: **System > Tasks > Library scan > Run now**. The scheduled scan runs every 6 hours anyway.
2. Open the **dry-run report**. It lists files per failing codec, with estimated time and disk space for the conversion.
3. Check the device profile under **Profiles**. "Samsung Tizen" is the default; clone and edit it if your TVs decode more.
4. Try one file first. Open it in **Library**, check the planned changes, and queue it. Watch **Activity > Queue**, then play the result on the TV.
5. Turn processing on in **Settings > Media**. Then press **Process all needs-work** on the **Library > Dry run** page, or wait for the next scan.

The target on a Raspberry Pi 4 is under 20 minutes per 2-hour movie, so a big backlog takes days. One job at a time, at low CPU and disk priority, is the default. **Replaced originals stay in the recycle bin for 7 days** (`<root>/.wololo-recycle`). Restore one from the recycle bin under **Settings > Media** if a rule was wrong.

## Backup and restore

What a backup holds: a consistent snapshot of the database (libraries, profiles, history, connections) and `config.json`, which includes the API key. Media is not included.

- **Automatic:** weekly (task **Backup** under **System > Tasks**). The newest 8 are kept.
- **Manual:** **System > Backup > Backup now**. Manual backups are never deleted automatically.
- **Download:** every backup is a `.zip` under `/config/backups`, also downloadable from the UI.

To restore:

1. In **System > Backup**, press **Restore** on a backup, or upload a `.zip`.
2. Wololo checks the archive and saves a `pre_restore` backup of the current state. Then it stages the restore.
3. Press **Restart** (needs the container restart policy, see [Install](#install-with-docker-compose)), or run `docker restart wololo`. The restore is applied before the database opens.

Backups from a newer Wololo version are refused; update first. The API key and port come back with the backup, so update Radarr/Sonarr webhooks if they changed.

Manual backup without the UI: stop the container and copy the whole `/config` folder. To move Wololo to a new host, copy `/config`, keep the same `/data` layout, and start the container.

Before a database upgrade, Wololo also writes `pre-migration-<time>.db` to `/config/backups`. It is a plain database file, not a backup zip, so it is not in the backup list. To roll back a failed upgrade with it:

1. Stop the container: `docker compose stop wololo`.
2. In the config folder on the host, delete `wololo.db-wal` and `wololo.db-shm` if they exist.
3. Copy `backups/pre-migration-<time>.db` over `wololo.db`, owned by `PUID:PGID`.
4. Pin the previous image tag in the compose file (an older version cannot open the upgraded database), then `docker compose up -d wololo`.

## Updating

```sh
docker compose pull wololo && docker compose up -d wololo
```

Migrations run automatically on start, with a backup first. Running jobs stop cleanly and are re-queued after the restart. That is why the example sets `stop_grace_period: 30s`.

## API

- Interactive reference: `http://<host>:8585/api/v1/docs` (no key needed to read it).
- OpenAPI 3.1 document: `http://<host>:8585/api/v1/openapi.json?apikey=<key>`.
- Authentication: `X-Api-Key: <key>` header, `?apikey=<key>`, or `Authorization: Bearer <key>`.

## Troubleshooting

Start with **System > Status** (health warnings) and **System > Logs**. Log files are in `/config/logs`, and every job has its own log in `/config/logs/jobs/<id>.txt`.

| Symptom                                                                  | Cause and fix                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Permission denied` writing media, or files end up owned by another user | `PUID`/`PGID` differ from the owner of your media. Use the same IDs as Radarr/Sonarr (`id <user>` on the host). Check `UMASK`.                                                                                                           |
| Log says `could not chown /config`                                       | The config folder is on NFS/CIFS with root squash. Create it on the host with the right owner (`chown 1000:1000 ./wololo/config`).                                                                                                       |
| Webhook test fails with 401                                              | The `apikey=` in the webhook URL is wrong, or the key was regenerated. Copy the URL again from **Settings > Connect**.                                                                                                                   |
| Webhook test fails to connect                                            | Radarr cannot reach `wololo:8585`. Put both on one Docker network, or use the host IP.                                                                                                                                                   |
| Imports show up as `unknown_path`                                        | No library covers the path, or a path mapping is missing. See [Path mappings](#path-mappings).                                                                                                                                           |
| Job fails with `EXDEV` / cross-device                                    | Media is mounted as several separate volumes (e.g. `/movies` and `/downloads`), so the temp file and the original are on different mounts. Mount one parent folder (`/data`) instead.                                                    |
| Plex does not show the new audio                                         | Plex path mapping missing (partial scan looked in the wrong folder), or Plex sign-in expired. Run **Test** in **Settings > Plex**.                                                                                                       |
| "ffmpeg was built without libbluray" / missing `mkvmerge` or `7z`        | Only when running outside the image with your own tools. Install them, or point `WOLOLO__FFMPEG` etc. at a suitable build.                                                                                                               |
| Health: library root "not reachable"                                     | The `/data` volume is not mounted, or the path in the library does not exist inside the container.                                                                                                                                       |
| Uploading a backup fails for a very large database (zip over 128 MB)     | Copy the `.zip` into `/config/backups` on the host instead, then restore it from the list. Keep the original `wololo_backup_<kind>_<date>.zip` name (a renamed copy such as `... (1).zip` is not listed) and make it readable by `PUID`. |
| Nothing happens after import                                             | Processing is still off (dry run). See [First run](#first-run-dry-run-then-process). Also check the processing window and "pause while Plex is streaming".                                                                               |
| UI asks for an API key                                                   | You are not on a local address, or you are behind a reverse proxy. Enter the key from `/config/config.json` once; the browser remembers it.                                                                                              |

To report a bug, attach the status page, the relevant log lines and the job log, with API keys removed.

## Development

Requirements: [Bun](https://bun.sh) 1.4, ffmpeg/ffprobe for media tests. mkvmerge, 7-Zip and tsMuxeR are optional locally; tests that need them skip.

```sh
bun install --frozen-lockfile && (cd web && bun install --frozen-lockfile)
bun run build                      # web UI into web/build
WOLOLO_CONFIG_DIR=./config bun run dev   # backend with reload on http://localhost:8585
cd web && VITE_WOLOLO_API_KEY=<key> bun run dev   # optional: UI dev server, proxies /api
```

Checks (CI runs the same):

```sh
bun run format        # Biome, writes fixes
bun run lint
bun run typecheck
bun run fixtures      # pre-generates synthetic media fixtures into test/.cache (ffmpeg lavfi, no real media)
bun test              # unit, module and integration tests (test/integration boots a real server)
cd web && bun run check && bun run build
```

Docker image:

```sh
docker build -t wololo:dev .
docker/smoke-test.sh wololo:dev   # starts the image and checks health, PUID/PGID, tools, backup, restart, stop
```

Code map:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, routes and data flow.
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md): code conventions.
- [docs/SPEC.md](docs/SPEC.md): requirements.

Commits use Conventional Commits (`feat(jobs): ...`). Pull requests must pass CI. CI runs:

1. lint, typecheck and tests (with ffmpeg, MKVToolNix, 7-Zip and tsMuxeR).
2. the web build.
3. a native amd64 and arm64 image build with the smoke test (`ubuntu-24.04-arm` runners).
4. on `main` and `v*` tags only: the multi-arch push to `ghcr.io/<owner>/wololo`.

## License

GPL-3.0. See [LICENSE](LICENSE).
