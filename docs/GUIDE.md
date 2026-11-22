# Wololo guide

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
- [Safety model](#safety-model)
- [Recycle bin](#recycle-bin)
- [Backup and restore](#backup-and-restore)
- [Updating](#updating)
- [Configuration reference](#configuration-reference)
- [API](#api)
- [Troubleshooting](#troubleshooting)
- [Known limitations and roadmap](#known-limitations-and-roadmap)
- [Development](#development)
- [CI and image publishing](#ci-and-image-publishing)

## Install with Docker Compose

Add Wololo to the compose file that already runs your *arr apps ([docker-compose.example.yml](../docker-compose.example.yml) has the commented version):

```yaml
services:
  wololo:
    image: ghcr.io/stefanfriptu/wololo:latest
    container_name: wololo
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - UMASK=002
    volumes:
      - ./wololo/config:/config
      - /srv/data:/data
    ports:
      - 8585:8585
    restart: unless-stopped
    stop_grace_period: 30s
```

Then run `docker compose up -d wololo`.

- **Image tags:** `latest` (newest release), `X.Y.Z` and `X.Y` (releases), `main` (follows the main branch), `sha-<commit>`. Until the first release is tagged, only `main` exists, so use `ghcr.io/stefanfriptu/wololo:main`. Image names are lowercase.
- **Keep `restart: unless-stopped`** (or `always`). The **Restart** button stops the process and relies on Docker to start it again. You need it to apply a restore or a URL base change. Without a restart policy, the container stays down.
- **In Docker, keep Port `8585` and Bind address `*`** in **Settings > General**. To use another host port, change the left side of `ports:` instead. A different port or a host IP makes the UI unreachable after the restart.

**The one rule that matters: mount media exactly like Radarr and Sonarr do.** Use the same host folder at the same container path (`/data` in the [TRaSH guides](https://trash-guides.info/File-and-Folder-Structure/) layout). Wololo writes the new file next to the original and renames it into place. That rename is atomic only within one filesystem and one mount.

| Setting        | What it does                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `PUID`, `PGID` | User and group Wololo runs as. Use the same IDs as Radarr/Sonarr so converted files keep their owner. |
| `TZ`           | Time zone, e.g. `America/New_York`. Used for the processing window and backup names.                  |
| `UMASK`        | Permission mask for new files, e.g. `002` (group-writable) or `022`.                                  |
| `/config`      | Database, `config.json` (API key, port), logs and backups. Back this up.                              |
| `/data`        | Your media, same path as in Radarr/Sonarr.                                                            |
| `8585`         | Web UI, API and webhooks on one port.                                                                 |

Every other setting is optional; see [Configuration reference](#configuration-reference).

The image bundles ffmpeg (with libbluray), MKVToolNix and 7-Zip. It drops root on start and runs as `PUID:PGID`, and Docker's health check calls `/health`.

## First start

1. Open `http://<host>:8585`.
2. From your home network the UI opens straight away. From anywhere else, it asks for the API key.
3. A fresh install opens the **guided setup**: Welcome, Players, Media folders, Sonarr/Radarr, Plex (optional), qBittorrent (optional), New imports, Check everything. Each step tests itself before you move on, and progress is saved, so closing the tab loses nothing.
   - The Sonarr/Radarr step adds a webhook named "Wololo" in their **Settings > Connect** for you (untick the box to add it by hand), checks a real file is visible through the path mappings (and offers the missing mapping), and makes Sonarr/Radarr send their test event to prove they can reach Wololo.
   - **Check everything** re-runs every test. Anything red has a plain explanation and a **Fix** button that opens the step.
   - Existing installs get a **Run setup** banner instead; **System > Status > Run setup again** opens it any time.

The steps below are what the setup does, for doing them by hand.

4. Find the API key under **Settings > General**, or in `/config/config.json`. Radarr and Sonarr need it for the webhook.
5. Add a library under **Settings > Media**: one entry per media folder, e.g. `/data/media/movies`, using the path inside the container.
   - To find Blu-ray downloads, add the download folder (e.g. `/data/torrents/movies`) as its own library and tick **Only convert discs**. Wololo then indexes only disc folders and `.iso` images there, so the files your torrents are seeding are never touched.
6. Look at **System > Status**. It lists the bundled tools and any health warnings (missing tools, unreachable folders, low disk space).

## Connect Radarr and Sonarr

Wololo needs two links: it calls Radarr/Sonarr (rescans, lookups), and they call Wololo (webhooks).

**1. Add the instance in Wololo.** Go to **Settings > Connect**, add Radarr, and enter:

- URL: `http://radarr:7878` (service name on the same Docker network) or `http://<host-ip>:7878`.
- API key: from Radarr **Settings > General > Security**.

Press **Test**, then save. Repeat for Sonarr (`http://sonarr:8989`). Wololo then shows the webhook URL for that instance. The host part comes from the **Address Radarr/Sonarr use to reach Wololo** field above the list. It starts as the address your browser used to open Wololo, so set it to one Radarr can reach (it is remembered in this browser). It looks like this when you open Wololo as `http://wololo:8585`:

```
http://wololo:8585/api/v1/webhook/radarr?instance=1&apikey=<your Wololo API key>
```

**2. Add the webhook in Radarr.** Go to **Settings > Connect > + > Webhook** and enter:

| Field                 | Value                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                  | `Wololo`                                                                                                                                     |
| Notification Triggers | **On File Import** and **On File Upgrade** (older versions: _On Import_, _On Upgrade_). Leave the rest off.                                  |
| Webhook URL           | the URL Wololo showed, with the host replaced by one Radarr can reach (`wololo:8585` on a shared Docker network, otherwise `<host-ip>:8585`) |
| Method                | `POST`                                                                                                                                       |
| Username / Password   | empty                                                                                                                                        |

Press **Test**. Radarr reports success when Wololo answered. Save.

**3. Do the same in Sonarr.** Use **Settings > Connect > + > Webhook** with the Sonarr URL (`.../webhook/sonarr?instance=<id>&apikey=...`) and the same two triggers.

The flow after every import:

```
Radarr imports -> webhook -> Wololo checks the file -> (needs work) queue -> convert -> verify -> atomic swap
  -> Radarr/Sonarr rescan -> Plex partial scan of that folder
```

Radarr and Wololo on different Docker networks? Use the host IP in both URLs, or put both containers on one network ([docker-compose.example.yml](../docker-compose.example.yml) shows how).

## Path mappings

Wololo stores local container paths. It needs a mapping when another app sees the same files under a different path.

- **No mapping needed** if Radarr, Sonarr and Wololo all mount the media at `/data`. This is the recommended layout.
- **Mapping needed** if Radarr reports `/movies/Film (2020)/film.mkv` while Wololo sees `/data/media/movies/Film (2020)/film.mkv`. Add one under **Settings > Connect > Path mappings**:
  - Application: Radarr (or Sonarr, Plex, qBittorrent). Instance: that one, or all.
  - Remote path: `/movies`. Local path: `/data/media/movies`.

Plex often uses different paths, e.g. `/tv`, `/movies` or a NAS share. Add a `plex` mapping, or Plex's partial scan will look in the wrong folder.

A webhook for a path outside every library root is logged as `unknown_path`. That usually means a missing mapping or library.

## Sign in to Plex

1. Go to **Settings > Plex > Sign in with Plex**.
2. Wololo shows a sign-in code. Press **Open plex.tv**, sign in there and approve Wololo. The page picks up the approval by itself.
3. Pick your server from the list. Wololo matches each library section by its folder paths, so add a `plex` path mapping if Plex sees the media elsewhere.
4. Press **Test**.

From then on, every changed file triggers a partial scan of its folder only. Optional: **Pause new jobs while someone is streaming** (under **Settings > Plex**) and a processing window, e.g. 01:00-08:00 (under **Settings > Media**).

## First run: dry run, then process

Wololo starts with **processing off** and **no player profile**. In this dry-run mode it checks files and reports, but never writes a media file. Keep it that way until you have seen the report.

1. Add your players under **Profiles** (top of the sidebar). Name each TV or box you watch on and pick the closest template: **Basic** (AC3, AAC, MP3), **Dolby** (+ E-AC3, TrueHD), **Lossless** (+ FLAC, ALAC, PCM), **Everything** (an AV receiver decodes all audio) or **Blank**. Check your TV's manual or spec sheet for its audio formats, then adjust the codecs on the profile page. Assign the profiles to your libraries under **Settings > Media**; a library without a profile shows "No profile" and scans skip it.
2. Run a scan: **System > Tasks > Library scan > Run now**. The scheduled scan runs every 6 hours anyway.
3. Open the dry-run report under **Library > Dry run**. It lists files per failing codec, with estimated time and disk space for the conversion. Files marked **Blocked** need work Wololo cannot do (for example a video codec your TVs cannot play); they are never queued.
   **Library > Files** shows one chip per player on every file: green plays as is, red names the codec that player cannot decode. A file's page marks each track per player.
4. Tick **Convert files** in **Settings > Media**. Jobs can only be queued from then on.
5. Try one file first. Open it in **Library > Files**, check the planned changes, and press **Process now**. When the library has more than one player, Wololo asks which one to convert for; the strictest combination (every player plays the result) is preselected. Watch **Activity > Queue**, then play the result on the TV.
6. Press **Process all needs-work** on the **Library > Dry run** page.
7. Choose what new imports do under **Settings > Media > On new imports**: **Check only** (the default: check and show the chips, convert nothing), **Always convert for the strictest profile**, or **Always convert for** one player. The same setting decides whether scheduled scans queue the files that need work.

The target on a Raspberry Pi 4 is under 20 minutes per 2-hour movie, so a big backlog takes days. One job at a time, at low CPU and disk priority, is the default (**Settings > Media**: Jobs at once, CPU priority, Disk priority).

## Safety model

Wololo touches your library only when you let it, and never leaves you without a playable file.

```
check free space -> write temp file next to the original -> verify -> link original into the recycle bin
  -> atomic rename of the temp file over the original -> tell Radarr/Sonarr/Plex
```

- **Dry run first.** With **Convert files** off, scans and webhooks only report. The API refuses to queue jobs.
- **Copy, don't re-encode.** Only failing audio tracks are converted. Video, subtitles and chapters are copied bit for bit.
- **Verify before replacing.** The new file must match the original's duration within 100 ms, have the expected streams, the same video stream hash, the same chapters and languages, and its audio must decode end to end. On any failure the temp file is deleted, the original stays as it was, and the job is marked failed.
- **Atomic swap.** The temp file (`<name>.wololo-tmp-<job id>.mkv`) sits in the same folder, so the final rename is atomic. Owner and permissions are copied first.
- **Undo.** The original is hard-linked into the [recycle bin](#recycle-bin) before the swap.
- **Crash safe.** After a crash or power cut, Wololo looks at which files exist on start, finishes or rolls back the swap, deletes leftover temp files and re-queues the job.
- **Disk space.** Before writing, a job checks for room for the output plus a 5% margin. If it is short, the queue holds for 15 minutes and retries.
- **Blu-ray sources** are never deleted on their own. With qBittorrent connected and **Offer to delete a converted disc once its torrent met its seeding goal** on (**Settings > Media**), Wololo asks under **Library > Decisions**, and deletes only after you accept.

## Recycle bin

- **Where:** `<library folder>/.wololo-recycle/<time>/...`, on the same disk as the library. A custom absolute folder can be set in **Settings > Media > Recycle bin**. Keep it on the same filesystem: each job first proves it can link or move a file there, and fails before encoding if it cannot.
- **How long:** 7 days by default (**Keep for (days)**). An hourly task purges expired entries.
- **Restore:** **Activity > Recycle bin > Restore** puts the original back, marks the file **Ignored** so scans leave it alone, and tells Radarr, Sonarr and Plex.
- **Turned off:** replaced originals are gone for good. Keep it on until you trust your profile.

## Backup and restore

What a backup holds: a consistent snapshot of the database (libraries, profiles, history, connections) and `config.json`, which includes the API key. Media is not included.

- **Automatic:** weekly (task **Backup** under **System > Tasks**). The newest 8 are kept.
- **Manual:** **System > Backup > Back up now**. Manual backups are never deleted automatically.
- **Download:** every backup is a `.zip` under `/config/backups`, also downloadable from the UI.

To restore:

1. In **System > Backup**, press **Restore** on a backup, or upload a `.zip`.
2. Wololo checks the archive and saves a `pre_restore` backup of the current state. Then it stages the restore.
3. Press **Restart now** (needs the container restart policy, see [Install](#install-with-docker-compose)), or run `docker restart wololo`. The restore is applied before the database opens.

Backups from a newer Wololo version are refused; update first. The API key and port come back with the backup, so update Radarr/Sonarr webhooks if they changed.

Manual backup without the UI: stop the container and copy the whole `/config` folder. To move Wololo to a new host, copy `/config`, keep the same `/data` layout, and start the container.

Before a database upgrade, Wololo also writes `pre-migration-<time>.db` to `/config/backups`. It is a plain database file, not a backup zip, so it is not in the backup list. Wololo keeps the newest two and deletes older ones after a successful upgrade. To roll back a failed upgrade with it:

1. Stop the container: `docker compose stop wololo`.
2. In the config folder on the host, delete `wololo.db-wal` and `wololo.db-shm` if they exist.
3. Copy `backups/pre-migration-<time>.db` over `wololo.db`, owned by `PUID:PGID`.
4. Pin the previous image tag in the compose file (an older version cannot open the upgraded database), then `docker compose up -d wololo`.

## Updating

```sh
docker compose pull wololo && docker compose up -d wololo
```

Migrations run automatically on start, with a backup first. Running jobs stop cleanly and are re-queued after the restart. That is why the example sets `stop_grace_period: 30s`.

## Configuration reference

Most settings live in the UI and the database. The few needed before the database opens live in `/config/config.json`. Each of those can be fixed with an environment variable, which then locks it in the UI.

| Variable                 | `config.json` key | Default                        | Purpose                                                                                                                                         |
| ------------------------ | ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `WOLOLO__PORT`           | `port`            | `8585`                         | Listen port. In Docker keep `8585` and change the host side of `ports:` instead                                                                 |
| `WOLOLO__BIND_ADDRESS`   | `bindAddress`     | `*`                            | `*` or one IP address of this machine. In Docker keep `*`                                                                                       |
| `WOLOLO__URL_BASE`       | `urlBase`         | empty                          | e.g. `/wololo` behind a reverse proxy                                                                                                           |
| `WOLOLO__API_KEY`        | `apiKey`          | generated on first start       | Fix the API key: 16-128 characters from `A-Z a-z 0-9 . _ ~ -`. Any other value is ignored with a warning                                        |
| `WOLOLO__LOG_LEVEL`      | `logLevel`        | `info`                         | `trace`, `debug`, `info`, `warn`, `error`                                                                                                       |
| `WOLOLO__INSTANCE_NAME`  | `instanceName`    | `Wololo`                       | Name shown in the UI                                                                                                                            |
| `WOLOLO__AUTHENTICATION` | `authentication`  | `disabled_for_local_addresses` | Who gets the API key in the web UI: local addresses only (default), `required` (always ask) or `disabled` (only behind an authenticating proxy) |

Other variables:

| Variable                                                              | Default                                    | Purpose                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `PUID`, `PGID`, `UMASK`, `TZ`                                         | `1000`, `1000`, `002`, `Etc/UTC`           | Image only, see [Install](#install-with-docker-compose)                          |
| `WOLOLO__FFMPEG`, `WOLOLO__FFPROBE`, `WOLOLO__MKVMERGE`, `WOLOLO__7Z` | from `PATH`                                | Tool paths, for custom builds                                                    |
| `WOLOLO_CONFIG_DIR`                                                   | `/config` in the image, else `./config`    | Folder for the database, `config.json`, logs and backups                         |
| `WOLOLO_WEB_DIR`                                                      | `/app/web/build` in the image, `web/build` | Built web UI to serve                                                            |
| `NODE_EXTRA_CA_CERTS`                                                 | unset                                      | PEM file of extra CAs for HTTPS connections to Radarr, Sonarr, qBittorrent, Plex |

The image also sets `WOLOLO_DOCKER=1` and `WOLOLO_VERSION` (from the release tag); leave them alone.

## API

- Interactive reference: `http://<host>:8585/api/v1/docs` (no key needed to read it).
- OpenAPI 3.1 document: `http://<host>:8585/api/v1/openapi.json?apikey=<key>`.
- Authentication: `X-Api-Key: <key>` header, `?apikey=<key>`, or `Authorization: Bearer <key>`.

## Troubleshooting

Start with **System > Status** (health warnings) and **System > Logs**. Log files are in `/config/logs`, and every job has its own log in `/config/logs/jobs/<id>.txt`.

| Symptom                                                                  | Cause and fix                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Permission denied` writing media, or files end up owned by another user | `PUID`/`PGID` differ from the owner of your media. Use the same IDs as Radarr/Sonarr (`id <user>` on the host). Check `UMASK`.                                                                                                                            |
| Log says `could not chown /config` or `/config is not writable`          | The config folder is on NFS/CIFS with root squash, or owned by another user. Create it on the host with the right owner (`chown 1000:1000 ./wololo/config`), or set `PUID`/`PGID` to its owner.                                                           |
| UI unreachable after a Port or Bind address change in Docker             | Inside the container Wololo must listen on `8585` and `*`. Stop it, set `"port": 8585` and `"bindAddress": "*"` in `/config/config.json`, then start it, or set `WOLOLO__PORT` and `WOLOLO__BIND_ADDRESS` in `environment:`.                              |
| Webhook test fails with 401                                              | The `apikey=` in the webhook URL is wrong, or the key was regenerated. Copy the URL again from **Settings > Connect**.                                                                                                                                    |
| Webhook test fails to connect                                            | Radarr cannot reach the host in the webhook URL. The URL uses the address you opened Wololo with (`localhost` or a proxy name often fails from inside Radarr's container). Replace it with `wololo:8585` on a shared Docker network, or `<host-ip>:8585`. |
| Imports show up as `unknown_path`                                        | No library covers the path, or a path mapping is missing. See [Path mappings](#path-mappings).                                                                                                                                                            |
| Job fails with `EXDEV` / cross-device                                    | Media is mounted as several separate volumes (e.g. `/movies` and `/downloads`), so the temp file and the original are on different mounts. Mount one parent folder (`/data`) instead.                                                                     |
| Test says `unreachable (self signed certificate)`                        | Radarr, Sonarr, qBittorrent or Plex uses HTTPS with its own certificate. Save the CA (or the self-signed cert) as PEM in `/config/ca.pem` and set `NODE_EXTRA_CA_CERTS=/config/ca.pem` in `environment:`. Verification stays on.                          |
| Plex does not show the new audio                                         | Plex path mapping missing (partial scan looked in the wrong folder), or Plex sign-in expired. Run **Test** in **Settings > Plex**.                                                                                                                        |
| "ffmpeg was built without libbluray" / missing `mkvmerge` or `7z`        | Only when running outside the image with your own tools. Install them, or point `WOLOLO__FFMPEG` etc. at a suitable build.                                                                                                                                |
| Health: library root "not reachable"                                     | The `/data` volume is not mounted, or the path in the library does not exist inside the container.                                                                                                                                                        |
| Uploading a backup fails for a very large database (zip over 128 MB)     | Copy the `.zip` into `/config/backups` on the host instead, then restore it from the list. Keep the original `wololo_backup_<kind>_<date>.zip` name (a renamed copy such as `... (1).zip` is not listed) and make it readable by `PUID`.                  |
| Nothing happens after import                                             | Processing is still off (dry run). See [First run](#first-run-dry-run-then-process). Also check the processing window and "pause while Plex is streaming".                                                                                                |
| UI asks for an API key                                                   | You are off the LAN, opened Wololo by a custom domain, or are behind a reverse proxy. Enter the key from `/config/config.json` once; the browser remembers it.                                                                                            |

To report a bug, attach the status page, the relevant log lines and the job log, with API keys removed.

## Known limitations and roadmap

Limits of v1:

- **No video re-encoding.** A file whose video codec the profile rejects is shown as **Blocked** and never queued.
- **Decrypted discs only.** Blu-ray input must be a decrypted BDMV folder or `.iso`; Wololo does not remove AACS/BD+.
- **Dolby Vision on Blu-ray:** the profile 7 enhancement layer is dropped and the HDR10 base layer kept. Audio jobs copy any video untouched, Dolby Vision included.
- **Blu-ray verification is looser than for audio jobs:** duration within 0.5 s and the same video packet count, because mkvmerge repackages the video stream.
- **Plex only** as media server. One machine, no GPU or remote workers.
- **API key only:** no user accounts or login page.
- **Pausing the queue** stops a running job and re-queues it from the start; it does not suspend ffmpeg.
- **One ffmpeg pass per failing track**, so a file with several failing tracks takes longer.
- **IPv4 only:** bind address `*` listens on all IPv4 addresses.

Planned for v1.1:

- PGS/VobSub subtitles to SRT with OCR (Tesseract), keeping the picture track as a fallback.
- Plex playback insights: list the files Plex transcoded, and why, and queue them first.
- Container normalisation (MP4, AVI, TS, M2TS to MKV) for files that need no audio work, and timestamp fixes.
- Integrity check: a full decode test, and on failure ask Radarr/Sonarr to blocklist and search again.
- Dolby Vision profile 5 alert (no HDR10 fallback) with a new search.
- Opt-in VC-1/MPEG-2 to H.264 rule, and keeping or converting Dolby Vision (profile 8.1) on Blu-ray.
- Notifications (ntfy, Discord, Telegram) on failure or as a daily summary.
- Real pause of running jobs, and one ffmpeg pass for all failing tracks.

Later: Jellyfin support and remote workers.

## Development

Requirements: [Bun](https://bun.sh) 1.4, ffmpeg/ffprobe for media tests. mkvmerge, 7-Zip and tsMuxeR are optional locally; tests that need them skip.

```sh
bun install --frozen-lockfile && (cd web && bun install --frozen-lockfile)
bun run build                      # web UI into web/build
WOLOLO_CONFIG_DIR=./config bun run dev   # backend with reload on http://localhost:8585
cd web && VITE_WOLOLO_API_KEY=<key> bun run dev   # optional: UI dev server, proxies /api
```

The UI dev server proxies `/api` to `http://localhost:8585`; set `WOLOLO_BACKEND=<url>` for another backend.

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

- [docs/ARCHITECTURE.md](ARCHITECTURE.md): modules, routes and data flow.
- [docs/CONVENTIONS.md](CONVENTIONS.md): code conventions.
- [docs/SPEC.md](SPEC.md): requirements.

Commits use Conventional Commits (`feat(jobs): ...`). Pull requests must pass CI.

## CI and image publishing

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pull requests (drafts skipped), pushes to `main`, `v*` tags and by hand:

1. **commit hygiene** (pull requests): fails on `fixup!`, `squash!` or `amend!` commits.
2. **lint, typecheck, tests** with ffmpeg, MKVToolNix, 7-Zip and a pinned, checksummed tsMuxeR. `WOLOLO_REQUIRE_BDMV_E2E=1` and `WOLOLO_REQUIRE_WEB_BUILD=1` make the Blu-ray end-to-end and real web build tests fail instead of skip.
3. **web check and build** (`svelte-check`, `vite build`).
4. **image** (amd64 on `ubuntu-24.04`, arm64 on `ubuntu-24.04-arm`, native, no emulation): build, then `docker/smoke-test.sh`.
5. On pushes to `main` and `v*` tags only: each architecture is pushed by digest, then **publish multi-arch image** writes the manifest list to `ghcr.io/<owner>/wololo` with the tags `main`, `X.Y.Z`, `X.Y`, `latest` and `sha-<commit>`.

To release: push a tag `vX.Y.Z` on `main`. The image reports `X.Y.Z` as its version; branch builds report `<branch>-<sha>`. Publishing uses the workflow's `GITHUB_TOKEN`; no secret is needed. A new GHCR package usually starts private: make it public in its package settings so `docker pull` works without a login.

[`.github/workflows/supply-chain.yml`](../.github/workflows/supply-chain.yml) checks registry signatures (`npm audit signatures`) and known high or critical vulnerabilities (`bun audit`) for both lockfiles. A pull request that adds `trustedDependencies` (packages allowed to run install scripts) fails until it carries the `dependencies-reviewed` label.

## License

GPL-3.0. See [LICENSE](../LICENSE).
