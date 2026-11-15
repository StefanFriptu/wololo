# Wololo architecture

Wololo is one Bun process: a Hono HTTP server, a SQLite database (bun:sqlite + Drizzle), an in-process job worker and scheduler, and a static SvelteKit SPA, all on one port (default 8585). Requirements live in [SPEC.md](SPEC.md), code conventions in [CONVENTIONS.md](CONVENTIONS.md); this file is the map every implementation agent works from. Where CONVENTIONS.md and a frozen contract disagree, the contract wins until changed through a contract change request. Where this file narrows SPEC.md, the decision is listed under [v1 scope decisions](#v1-scope-decisions).

## Golden rules for parallel work

1. **One git worktree per agent.** The orchestrator creates it before fan-out and passes the absolute path in the brief: `git -C /Users/stefan/project-wololo worktree add -b mod/<module-key> ~/git-worktrees/project-wololo/<module-key> main`, then `bun install --frozen-lockfile` in it (and in `web/` for web-ui). Work, test and commit only inside your worktree; the integrator merges the `mod/*` branches. Never run commands against another agent's tree.
2. **Only edit files inside your owned paths** (table below). Everything else is read-only for you. Owned paths are disjoint, so merges are clean.
3. **If a contract is wrong or missing something, do not edit it.** Record the change in `docs/contract-changes/<your-module-key>.md` (what, why, proposed signature). Work around it locally until the integrator applies it.
4. **Never edit** root `package.json`, `bun.lock`, `web/package.json`, `web/bun.lock`, `src/db/schema.ts`, `drizzle/`, `src/shared/*`, `src/contracts/*`, `src/core/*`, `src/app/*`, `src/api/*`, `test/helpers/*`. Every dependency you plausibly need is already installed: do not run plain `bun install` (it may rewrite a lockfile); use `bun install --frozen-lockfile`.
5. **Cross-module calls go through `ctx.services.<name>`** (typed by `src/contracts/*`). Never import another module's files.
6. **Production code writes a table only through its owner** (table ownership below). Reading any table is fine. Tests may seed any table directly with `test/helpers/seed.ts`.
7. **Checks before you hand back**, run inside your worktree: `bun run lint`, `bun run typecheck`, `bun test`. Only web-ui (and the integrator) also run `cd web && bun run check && bun run build`. For a manual server run set `WOLOLO_CONFIG_DIR=<scratch dir>` and a unique `WOLOLO__PORT` (integration tests use `createRuntime({ port: 0 })`).

## Directory map

```
src/
  index.ts                 entry: createRuntime().start(), SIGINT/SIGTERM -> graceful stop
  app/
    bootstrap.ts           config -> logs -> staged restore -> db + migrations -> context -> HTTP; start/stop order
    context.ts             AppContext + Services (the dependency container) and createAppContext()
    server.ts              Hono app: API-key auth on /api/*, module routes, SPA fallback, URL base
  api/
    http.ts                route() typed handler helper (+ schema registry), registerNotImplemented(), parse helpers (zod)
    middleware.ts          API key auth (X-Api-Key | ?apikey= | Bearer), error handler, JSON 404
    static.ts              SPA serving, URL base rewrite, window.__WOLOLO__ injection (key per auth mode)
    core-routes.ts         /health, SSE /api/v1/events, settings, logs
    router.ts              calls each module's register*Routes()
  core/                    config (config.json + WOLOLO__* env), logger (ring buffer + rotating file),
                           events (typed bus), settings (typed KV store), process (spawn + nice/ionice), errors
  db/
    schema.ts              THE complete v1 schema (Drizzle)
    client.ts              openDatabase() (WAL, FKs), runMigrations()
  shared/                  imported by backend AND web (no runtime deps):
    domain.ts              domain model (streams, profiles, plans, jobs, ...)
    settings.ts            GeneralConfig, Settings, DEFAULT_SETTINGS
    events.ts              EventMap (bus + SSE), EVENT_NAMES
    api-types.ts           ApiRoutes: every REST route with params/query/body/response types
    api-routes.ts          API_ROUTE_META: owner module, auth, response type, summary per route
    language.ts            normalizeLanguage / sameLanguage (ISO 639-2/B)
  contracts/               service interfaces + pure function signatures per module
  modules/
    probe/ scan/ scheduler/          probe-scan
    profiles/ rules/ ffmpeg/         rules-ffmpeg
    jobs/ recycle-bin/               jobs
    integrations/                    integrations
    bdmv/                            bdmv
    system/                          platform
drizzle/                   generated SQL migrations (applied at startup)
web/                       SvelteKit 3 (Svelte 5) SPA, adapter-static, fallback index.html
test/
  helpers/                 context, seed, probe, run-context, stubs, fixtures (ffmpeg lavfi generator), binaries
  core/ api/ db/ shared/   tests of the skeleton
docs/contract-changes/     one change-request file per module
docker/                    entrypoint.sh (PUID/PGID/UMASK/TZ), healthcheck.ts
.github/workflows/ci.yml   lint, typecheck, tests, web build, multi-arch image -> GHCR
```

## Module ownership

Every module also owns `docs/contract-changes/<module-key>.md`.

| Module key                  | Owned paths                                                                                                                                                                                                                                                           | Implements                                                                                                                                                                                           | Pure functions to table-test                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `probe-scan`                | `src/modules/probe/**`, `src/modules/scan/**`, `src/modules/scheduler/**`                                                                                                                                                                                             | `contracts/probe-scan.ts`: ProbeService, LibraryService, MediaService, ScanService, DryRunService, SchedulerService; routes in `scan/routes.ts` (`registerProbeScanRoutes`)                          | `parseFfprobeOutput` (probe/parse.ts), `needsRecheck`, `classifyEntry` (scan/change-detection.ts)                                                                                                                                                            |
| `rules-ffmpeg`              | `src/modules/profiles/**`, `src/modules/rules/**`, `src/modules/ffmpeg/**`                                                                                                                                                                                            | `contracts/rules-ffmpeg.ts`: ProfileService, RulesService, FfmpegService; routes in `profiles/routes.ts` (`registerRulesFfmpegRoutes`)                                                               | `planConversion`, `resolveEffectiveProfile`, `computeRulesKey`, `codecAllowed` (rules/engine.ts), `buildAudioConversionArgs`, `selectBitrate` (ffmpeg/args.ts), `createProgressParser` (ffmpeg/progress.ts), `samsungTizenDefinition` (profiles/defaults.ts) |
| `jobs`                      | `src/modules/jobs/**`, `src/modules/recycle-bin/**`                                                                                                                                                                                                                   | `contracts/jobs.ts`: JobsService (queue, worker, audio executor, verification, link-then-rename replace, crash recovery, gates), RecycleBinService; routes in `jobs/routes.ts`                       | processing-window check, verification comparisons, temp/recycle path naming, recovery decision (job step + which files exist -> action)                                                                                                                      |
| `integrations`              | `src/modules/integrations/**`                                                                                                                                                                                                                                         | `contracts/integrations.ts`: ArrService, WebhookService, PlexService, DownloadClientService, PathMappingService, NotifierService; routes in `integrations/routes.ts`                                 | `mapPath` (integrations/path-map.ts), webhook payload -> path, webhook instance resolution, movie match score                                                                                                                                                |
| `bdmv`                      | `src/modules/bdmv/**`, `test/fixtures/bdmv/**`                                                                                                                                                                                                                        | `contracts/bdmv.ts`: BdmvService (incl. `execute` job executor), IsoReader (7z); routes in `bdmv/routes.ts`                                                                                          | `parseMpls`, `parseClpi` (bdmv/mpls.ts), `parseMkvmergeIdentify`, `buildMkvmergeArgs`, `buildOutputPaths` (bdmv/mkvmerge.ts), `dedupePlaylists`, `pickMainTitle`, `detectEncryption`, `cleanDiscName`, `countForcedPgsCompositions` (bdmv/titles.ts)         |
| `web-ui`                    | `web/**` except `web/package.json` and `web/bun.lock`                                                                                                                                                                                                                 | every page in the sidebar against `ApiRoutes` + SSE, the API key prompt (see Web UI)                                                                                                                 | formatting helpers: pure `.ts` next to the code (`web/src/lib/**/*.test.ts`), importing only pure modules                                                                                                                                                    |
| `platform`                  | `src/modules/system/**`, `Dockerfile`, `docker/**`, `docker-compose.example.yml`, `.dockerignore`, `.github/**`, `README.md`, `test/integration/**`                                                                                                                   | `contracts/platform.ts`: SystemService (status, tools, health, backups, restore staging + `applyPendingRestore` in `system/restore.ts`, OpenAPI, restart, log cleanup); routes in `system/routes.ts` | OpenAPI generation from `API_ROUTE_META` + `routeSchemas()`                                                                                                                                                                                                  |
| `core` (integrator, frozen) | everything else: `src/core`, `src/db`, `drizzle`, `src/shared`, `src/contracts`, `src/app`, `src/api`, `src/index.ts`, `test/helpers`, `test/core`, `test/api`, `test/db`, `test/shared`, root configs, lockfiles, `docs/` except `docs/contract-changes/<module>.md` | config, logger, events, settings, auth, SSE, static + URL base, settings + logs routes, language normalisation, migrations                                                                           | `normalizeLanguage`, `sameLanguage` (src/shared/language.ts), `applyUrlBase`, `isLocalAddress`, `shouldExposeApiKey` (src/api/static.ts), `mergeGeneral` (src/core/config.ts)                                                                                |

Every backend module may import `src/shared`, `src/contracts`, `src/core`, `src/db`, `src/api/http.ts` and `src/app/context.ts` (type only). web-ui imports only `web/src/lib/shared.ts` (re-exports `src/shared/*`) from outside `web/`.

Module tests are co-located: `src/modules/<dir>/<name>.test.ts`. Web unit tests are `web/src/**/*.test.ts`, run by the root `bun test` and type-checked by the root `bun run typecheck` (excluded from svelte-check); they must not import `$app/*`, `.svelte` files or code that reads `import.meta.env`. Cross-module end-to-end tests belong to `platform` under `test/integration/`.

Shared test helpers (`test/helpers/`): `context.ts` (`createTestContext`: temp config + migrated db + full AppContext, `request()` with the key, `restarts()`), `seed.ts` (`insertLibrary`, `insertMediaFile`, `insertJob`, `insertProfile`, `insertArrInstance`), `probe.ts` (`videoStream`, `audioStream`, `subtitleStream`, `probeResult` builders), `run-context.ts` (`createFakeRunContext`, `fakeJob`), `stubs.ts` (`stubService<T>(name, partial)`, throws on unstubbed methods), `fixtures.ts` (`ensureFixture`, `ensureFixtureCopy` for tests that move or replace files), `binaries.ts` (`hasBinary`).

### Table ownership (writes)

| Table                                                                              | Writer                |
| ---------------------------------------------------------------------------------- | --------------------- |
| `settings`                                                                         | core (`ctx.settings`) |
| `libraries`, `library_roots`, `library_profiles`, `media_files`, `scheduled_tasks` | probe-scan            |
| `device_profiles`                                                                  | rules-ffmpeg          |
| `jobs`, `job_history`, `recycle_bin`                                               | jobs                  |
| `arr_instances`, `plex_connection`, `download_client`, `path_mappings`             | integrations          |
| `bdmv_decisions`                                                                   | bdmv                  |

Other modules change these rows only through the owner's service (e.g. jobs calls `media.setStatus` / `media.recordJobResult`; profiles calls `media.invalidateRules`).

## Data flow

Import (webhook):

```
Radarr/Sonarr "On Import/On Upgrade" -> POST /api/v1/webhook/{radarr|sonarr}?instance=<arr id>&apikey=
  -> webhooks.handle*(payload, instanceId) -> instance: ?instance, else only enabled one, else instanceName/applicationUrl
  -> pathMappings.toLocal(kind, path, instanceId)
  -> media.checkPath(localPath, { trigger: 'webhook', arr, originalLanguage: normalizeLanguage(name) })
```

media.checkPath (single entry point for webhooks, scans, retries):

```
libraries.findRootForPath (none -> 'unknown_path') -> upsert media_files row (kind file|bdmv|iso, size, mtime)
  -> arr ref + original language: refs, else cached on the row, else arr.findByPath(path) (cached on the row)
  -> kind bdmv|iso: bdmv.evaluate(row.id)            (decisions, BdmvJobPlan, "converted" discs stay compatible)
     else: probe.probe() -> rules.effectiveProfileForLibrary -> rules.plan()
  -> status compatible | needs_work | failed | ignored (kept) ...   (writes nothing to the media file)
  -> settings.processing.enabled && needs_work ? jobs.enqueue({ type, mediaFileId, trigger }) : 'dry_run'
```

Catch-all scan: `scheduler (library_scan, 6 h) -> scan.start() -> walk roots -> needsRecheck(path+size+mtime+rulesKey) -> media.checkPath()`; missing paths delete their row; with processing enabled, unchanged `needs_work` rows without an active job are enqueued without a re-probe.

Dry run -> first write: processing stays off (dry-run) until the owner reviews the report. Then the owner turns processing on and starts the backlog with "Process all needs-work" (`POST /api/v1/jobs` with `{ filter: { libraryId, status: 'needs_work' } }`); the next scan would also pick it up.

Job (audio):

```
worker picks queued job (concurrency, processing window, Plex auto-pause gates)
  -> media.setStatus(processing) -> re-probe source -> rules.plan() -> ffmpeg.buildAudioConversionArgs()
  -> ensureFreeSpace(dir, estimate * 1.05) -> setTempPath("<stem>.wololo-tmp.mkv") -> run ffmpeg (nice/ionice)
  -> progress events (ffmpeg.createProgressParser)
  -> verify (duration +-100 ms, stream count, video streamhash md5, full audio decode, chapters, languages)
  -> step 'replacing': recycleBin.recycleForReplace(original) (hard link into the bin, original stays in place)
     -> rename(temp, original) (atomic swap; uid/gid/mode copied first) -> setTempPath(null)
  -> media.recordJobResult(compatible, fresh probe) -> jobs.addHistory(completed, HistoryData { lostFeatures, ... })
  -> notifier.fileChanged(replaced) -> arr.rescan(ref | arr.findByPath) -> plex.refreshPath(folder)
```

Crash recovery (`jobs.recover()` at startup, before the worker starts): jobs left `running` in step `replacing` are resolved from which of temp file, original and bin entry exist (finish the rename, keep the original, or restore from the bin; see `contracts/jobs.ts`); only then are other jobs' `temp_path` files/directories deleted and the jobs re-queued.

Job (bdmv), `bdmv.execute(runCtx)`:

```
preparing: re-analyze disc -> setTempPath("<radarr root>/.wololo-tmp-<jobId>/")
  -> ensureFreeSpace(root, extractBytes + estimatedOutputBytes)
  -> .iso: IsoReader.extractForMux (7z) of the playlist + its clips into the temp dir
  -> forced-PGS scan when a language has several subtitle tracks (countForcedPgsCompositions)
encoding: ffmpeg -playlist N -i bluray:<disc> encodes only failing audio tracks to .mka side files
muxing: mkvmerge -J <playlist> (parseMkvmergeIdentify: PID -> track id) -> buildMkvmergeArgs -> mkvmerge (one write)
verifying: duration, stream count, video packet count, chapters, languages, audio decode
  -> rename into "<root>/Title (Year)/Title (Year).mkv" -> setTempPath(null), delete the temp dir
importing: arr.addMovie when Radarr does not know the movie -> arr.importMovieFolder
  -> media.recordJobResult(disc row: compatible, "converted to <output>", path unchanged) -> notifier (created: Plex only)
```

Track identity across tools: ffprobe on `bluray:` gives each stream's PID (`MediaStream.streamId`), the MPLS stream table gives the same PIDs in disc order, `mkvmerge -J` maps PID -> mkvmerge track id. The rules engine plans on the `bluray:` probe, so every planned stream maps to an mkvmerge track. Audio side files carry `delayMs` (audio start - video start) and are muxed with `--sync`.

The source disc is never modified. When its torrent meets the seeding goal and `settings.bdmv.deleteSourceWhenSeeded` is on, `downloadClient.checkSeedingGoals` asks `bdmv.offerSourceDeletion`, which creates a `delete_source` decision; only a confirmed decision deletes the source (`bdmv.deleteSource`).

Recycle-bin restore ("undo for a bad rule"): moves the original back, sets the row to `ignored` ("restored from recycle bin") so the next scan does not convert it again, notifies Radarr/Sonarr/Plex and writes a `restored` history entry.

Startup (`src/app/bootstrap.ts`): resolve config dir -> `applyPendingRestore(configDir)` -> config (repairs config.json, collects warnings) -> logger (logs the warnings) -> open db -> migrations (pre-migration backup, foreign keys off during migrate, `foreign_key_check`) -> context -> `profiles.ensureDefaults()` -> `jobs.recover()` -> `jobs.start()` -> `scheduler.start()` -> HTTP listen. Shutdown reverses: abort `ctx.shutdownSignal` -> `scheduler.stop()` -> `jobs.stop()` -> HTTP stop -> flush logs -> close db (15 s cap; the compose example sets `stop_grace_period: 30s`). `ctx.requestRestart()` runs the same stop, then exits 0. `src/index.ts` logs unhandled rejections and stops cleanly on uncaught exceptions.

## Dependency container

`createAppContext()` builds one `AppContext` with `config`, `logs`, `log`, `db`, `dbHandle`, `events`, `settings`, `shutdownSignal` and `services`. Each module exports factories (`createXService(ctx)`) from its `index.ts`; the signatures are fixed by `src/app/context.ts`.

- Factories **must not call other services while constructing** (they are wired in one pass). Resolve them at call time: `ctx.services.rules.plan(...)`.
- Create a module logger once: `const log = ctx.logs.logger('jobs')`.
- Keep state inside the factory closure or a class instance returned by it; no module-level singletons.
- Lifecycle methods (`start`, `stop`, `recover`, `ensureDefaults`) must stay safe to call before your module is complete (stubs are no-ops).
- Tests replace services with `createTestContext({ overrides: { plex: stubService<PlexService>('plex', { sessions }) } })`.
- `ctx.requestRestart()` stops gracefully and exits 0 (the container restarts Wololo); tests record calls (`t.restarts()`).

## REST API

Base path `/api/v1` under the optional URL base. Auth: `X-Api-Key` header, `?apikey=` query (Radarr/Sonarr webhooks and EventSource) or `Authorization: Bearer`. Successful writes with nothing to return answer `204` (`NoContent`, `responseType: 'empty'`; handlers return `undefined`). Errors are `ApiErrorBody { error, message, details? }` with codes `not_found` 404, `validation` 400, `unprocessable` 422, `conflict` 409, `unauthorized` 401, `precondition_failed` 412, `upstream` 502, `not_implemented` 501, `internal` 500. Lists use `PageQuery { page, pageSize, sortDir }` -> `Paginated<T>`. Types are in `src/shared/api-types.ts` (`ApiRoutes`); owner, auth and response type in `src/shared/api-routes.ts` (`API_ROUTE_META`). Every route is registered at M0 (501 until implemented); `test/api/routes.test.ts` fails if a route goes missing. `POST /api/v1/jobs` takes `mediaFileIds` or a `filter` ("Process all needs-work").

Implementing a route (backend):

```ts
export function registerJobsRoutes(app: ApiApp, ctx: AppContext): void {
  route(app, 'GET /api/v1/jobs/:id', (c) => ctx.services.jobs.get(parseId(c)));
  route(app, 'POST /api/v1/jobs', async (c) => ctx.services.jobs.enqueueMany(await parseBody(c, enqueueSchema)));
  registerNotImplemented(
    app,
    routesOf('jobs').filter((key) => !DONE.has(key)),
  );
}
```

`route()` type-checks the return value against `ApiRoutes[key]['response']`. Register real handlers before the 501 stubs (first match wins) and static segments before `:param` ones (`/media/stats` before `/media/:id`). Text/blob routes return a `Response`.

Calling a route (web): `api('GET /api/v1/jobs/:id', { params: { id } })` from `web/src/lib/api/client.ts`.

| Route                                       | Module       | Auth   | Params / query / body                             | Response                           |
| ------------------------------------------- | ------------ | ------ | ------------------------------------------------- | ---------------------------------- |
| `GET /health`                               | core         | none   | -                                                 | `HealthResponse`                   |
| `GET /api/v1/events`                        | core         | apikey | -                                                 | sse                                |
| `GET /api/v1/system/status`                 | platform     | apikey | -                                                 | `SystemStatus`                     |
| `GET /api/v1/system/health`                 | platform     | apikey | -                                                 | `HealthCheck[]`                    |
| `GET /api/v1/system/tasks`                  | probe-scan   | apikey | -                                                 | `ScheduledTaskInfo[]`              |
| `PUT /api/v1/system/tasks/:name`            | probe-scan   | apikey | params `{ name: TaskName }`, body `TaskUpdate`    | `ScheduledTaskInfo`                |
| `POST /api/v1/system/tasks/:name/run`       | probe-scan   | apikey | params `{ name: TaskName }`                       | `ScheduledTaskInfo`                |
| `GET /api/v1/system/logs`                   | core         | apikey | query `LogQuery`                                  | `LogEntry[]`                       |
| `GET /api/v1/system/logs/files`             | core         | apikey | -                                                 | `LogFileInfo[]`                    |
| `GET /api/v1/system/logs/files/:name`       | core         | apikey | params `{ name: string }`                         | text                               |
| `GET /api/v1/system/backups`                | platform     | apikey | -                                                 | `BackupInfo[]`                     |
| `POST /api/v1/system/backups`               | platform     | apikey | -                                                 | `BackupInfo`                       |
| `GET /api/v1/system/backups/:name`          | platform     | apikey | params `{ name: string }`                         | blob                               |
| `DELETE /api/v1/system/backups/:name`       | platform     | apikey | params `{ name: string }`                         | 204 No Content                     |
| `POST /api/v1/system/backups/:name/restore` | platform     | apikey | params `{ name: string }`                         | `RestoreResult`                    |
| `POST /api/v1/system/backups/restore`       | platform     | apikey | body `FormData`                                   | `RestoreResult`                    |
| `POST /api/v1/system/restart`               | platform     | apikey | -                                                 | 204 No Content                     |
| `GET /api/v1/openapi.json`                  | platform     | apikey | -                                                 | `Record<string, unknown>`          |
| `GET /api/v1/docs`                          | platform     | none   | -                                                 | html                               |
| `GET /api/v1/settings`                      | core         | apikey | -                                                 | `Settings`                         |
| `PUT /api/v1/settings`                      | core         | apikey | body `SettingsUpdate`                             | `Settings`                         |
| `GET /api/v1/settings/general`              | core         | apikey | -                                                 | `GeneralConfigView`                |
| `PUT /api/v1/settings/general`              | core         | apikey | body `GeneralConfigUpdate`                        | `GeneralConfigView`                |
| `POST /api/v1/settings/general/apikey`      | core         | apikey | -                                                 | `GeneralConfigView`                |
| `GET /api/v1/libraries`                     | probe-scan   | apikey | -                                                 | `Library[]`                        |
| `POST /api/v1/libraries`                    | probe-scan   | apikey | body `LibraryInput`                               | `Library`                          |
| `GET /api/v1/libraries/:id`                 | probe-scan   | apikey | params `IdParams`                                 | `Library`                          |
| `PUT /api/v1/libraries/:id`                 | probe-scan   | apikey | params `IdParams`, body `LibraryInput`            | `Library`                          |
| `DELETE /api/v1/libraries/:id`              | probe-scan   | apikey | params `IdParams`                                 | 204 No Content                     |
| `GET /api/v1/filesystem`                    | probe-scan   | apikey | query `FilesystemQuery`                           | `FilesystemListing`                |
| `GET /api/v1/media`                         | probe-scan   | apikey | query `MediaQuery`                                | `Paginated<MediaFileSummary>`      |
| `GET /api/v1/media/stats`                   | probe-scan   | apikey | query `{ libraryId?: number }`                    | `MediaStats`                       |
| `GET /api/v1/media/:id`                     | probe-scan   | apikey | params `IdParams`                                 | `MediaFileDetail`                  |
| `POST /api/v1/media/:id/probe`              | probe-scan   | apikey | params `IdParams`                                 | `MediaFileDetail`                  |
| `GET /api/v1/media/:id/plan`                | probe-scan   | apikey | params `IdParams`                                 | `ConversionPlan`                   |
| `PUT /api/v1/media/:id/ignore`              | probe-scan   | apikey | params `IdParams`, body `MediaIgnoreBody`         | `MediaFileSummary`                 |
| `POST /api/v1/scans`                        | probe-scan   | apikey | body `ScanRequest`                                | `ScanStatus`                       |
| `GET /api/v1/scans/current`                 | probe-scan   | apikey | -                                                 | `ScanStatus \| null`               |
| `DELETE /api/v1/scans/current`              | probe-scan   | apikey | -                                                 | 204 No Content                     |
| `GET /api/v1/dryrun`                        | probe-scan   | apikey | query `DryRunQuery`                               | `DryRunReport`                     |
| `GET /api/v1/profiles`                      | rules-ffmpeg | apikey | -                                                 | `ProfileWithUsage[]`               |
| `POST /api/v1/profiles`                     | rules-ffmpeg | apikey | body `ProfileInput`                               | `ProfileWithUsage`                 |
| `GET /api/v1/profiles/codecs`               | rules-ffmpeg | apikey | -                                                 | `CodecCatalog`                     |
| `GET /api/v1/profiles/:id`                  | rules-ffmpeg | apikey | params `IdParams`                                 | `ProfileWithUsage`                 |
| `PUT /api/v1/profiles/:id`                  | rules-ffmpeg | apikey | params `IdParams`, body `ProfileInput`            | `ProfileWithUsage`                 |
| `DELETE /api/v1/profiles/:id`               | rules-ffmpeg | apikey | params `IdParams`                                 | 204 No Content                     |
| `POST /api/v1/profiles/:id/clone`           | rules-ffmpeg | apikey | params `IdParams`, body `ProfileCloneBody`        | `ProfileWithUsage`                 |
| `GET /api/v1/queue`                         | jobs         | apikey | -                                                 | `QueueResponse`                    |
| `POST /api/v1/queue/pause`                  | jobs         | apikey | -                                                 | `QueueState`                       |
| `POST /api/v1/queue/resume`                 | jobs         | apikey | -                                                 | `QueueState`                       |
| `GET /api/v1/jobs`                          | jobs         | apikey | query `JobQuery`                                  | `Paginated<JobSummary>`            |
| `POST /api/v1/jobs`                         | jobs         | apikey | body `EnqueueRequest`                             | `EnqueueResponse`                  |
| `GET /api/v1/jobs/:id`                      | jobs         | apikey | params `IdParams`                                 | `JobDetail`                        |
| `GET /api/v1/jobs/:id/log`                  | jobs         | apikey | params `IdParams`                                 | text                               |
| `POST /api/v1/jobs/:id/cancel`              | jobs         | apikey | params `IdParams`                                 | `JobSummary`                       |
| `POST /api/v1/jobs/:id/retry`               | jobs         | apikey | params `IdParams`                                 | `JobSummary`                       |
| `DELETE /api/v1/jobs/:id`                   | jobs         | apikey | params `IdParams`                                 | 204 No Content                     |
| `GET /api/v1/history`                       | jobs         | apikey | query `HistoryQuery`                              | `Paginated<HistoryEntry>`          |
| `GET /api/v1/recyclebin`                    | jobs         | apikey | query `PageQuery`                                 | `Paginated<RecycleBinEntry>`       |
| `POST /api/v1/recyclebin/:id/restore`       | jobs         | apikey | params `IdParams`                                 | `RecycleBinEntry`                  |
| `DELETE /api/v1/recyclebin/:id`             | jobs         | apikey | params `IdParams`                                 | 204 No Content                     |
| `POST /api/v1/recyclebin/purge`             | jobs         | apikey | body `RecycleBinPurgeRequest`                     | `RecycleBinPurgeResult`            |
| `GET /api/v1/arr`                           | integrations | apikey | -                                                 | `ArrInstance[]`                    |
| `POST /api/v1/arr`                          | integrations | apikey | body `ArrInstanceInput`                           | `ArrInstance`                      |
| `POST /api/v1/arr/test`                     | integrations | apikey | body `ArrTestRequest`                             | `ConnectionTestResult`             |
| `GET /api/v1/arr/:id`                       | integrations | apikey | params `IdParams`                                 | `ArrInstance`                      |
| `PUT /api/v1/arr/:id`                       | integrations | apikey | params `IdParams`, body `ArrInstanceInput`        | `ArrInstance`                      |
| `DELETE /api/v1/arr/:id`                    | integrations | apikey | params `IdParams`                                 | 204 No Content                     |
| `GET /api/v1/arr/:id/rootfolders`           | integrations | apikey | params `IdParams`                                 | `ArrRootFolder[]`                  |
| `GET /api/v1/arr/:id/qualityprofiles`       | integrations | apikey | params `IdParams`                                 | `ArrQualityProfile[]`              |
| `GET /api/v1/arr/:id/lookup`                | integrations | apikey | params `IdParams`, query `ArrLookupQuery`         | `MovieMatchCandidate[]`            |
| `POST /api/v1/webhook/radarr`               | integrations | apikey | query `WebhookQuery`, body `RadarrWebhookPayload` | `WebhookResponse`                  |
| `POST /api/v1/webhook/sonarr`               | integrations | apikey | query `WebhookQuery`, body `SonarrWebhookPayload` | `WebhookResponse`                  |
| `GET /api/v1/plex`                          | integrations | apikey | -                                                 | `PlexConnection`                   |
| `PUT /api/v1/plex`                          | integrations | apikey | body `PlexConnectionUpdate`                       | `PlexConnection`                   |
| `DELETE /api/v1/plex`                       | integrations | apikey | -                                                 | `PlexConnection`                   |
| `POST /api/v1/plex/pin`                     | integrations | apikey | -                                                 | `PlexPin`                          |
| `GET /api/v1/plex/pin/:id`                  | integrations | apikey | params `IdParams`                                 | `PlexPinStatus`                    |
| `GET /api/v1/plex/servers`                  | integrations | apikey | -                                                 | `PlexServer[]`                     |
| `GET /api/v1/plex/sections`                 | integrations | apikey | -                                                 | `PlexSection[]`                    |
| `POST /api/v1/plex/test`                    | integrations | apikey | -                                                 | `ConnectionTestResult`             |
| `GET /api/v1/plex/sessions`                 | integrations | apikey | -                                                 | `PlexSessions`                     |
| `GET /api/v1/downloadclient`                | integrations | apikey | -                                                 | `DownloadClientConnection \| null` |
| `PUT /api/v1/downloadclient`                | integrations | apikey | body `DownloadClientInput`                        | `DownloadClientConnection`         |
| `DELETE /api/v1/downloadclient`             | integrations | apikey | -                                                 | 204 No Content                     |
| `POST /api/v1/downloadclient/test`          | integrations | apikey | body `DownloadClientInput`                        | `ConnectionTestResult`             |
| `GET /api/v1/pathmappings`                  | integrations | apikey | -                                                 | `PathMapping[]`                    |
| `POST /api/v1/pathmappings`                 | integrations | apikey | body `PathMappingInput`                           | `PathMapping`                      |
| `PUT /api/v1/pathmappings/:id`              | integrations | apikey | params `IdParams`, body `PathMappingInput`        | `PathMapping`                      |
| `DELETE /api/v1/pathmappings/:id`           | integrations | apikey | params `IdParams`                                 | 204 No Content                     |
| `GET /api/v1/bdmv/decisions`                | bdmv         | apikey | query `BdmvDecisionQuery`                         | `BdmvDecision[]`                   |
| `GET /api/v1/bdmv/decisions/:id`            | bdmv         | apikey | params `IdParams`                                 | `BdmvDecision`                     |
| `POST /api/v1/bdmv/decisions/:id/resolve`   | bdmv         | apikey | params `IdParams`, body `BdmvDecisionChoice`      | `BdmvDecision`                     |
| `POST /api/v1/bdmv/decisions/:id/dismiss`   | bdmv         | apikey | params `IdParams`                                 | `BdmvDecision`                     |
| `GET /api/v1/bdmv/discs/:id`                | bdmv         | apikey | params `IdParams`                                 | `BdmvDiscInfo`                     |

## Events (bus + SSE)

Publish with `ctx.events.emit(name, payload)`; subscribe with `ctx.events.on(name, fn)`. The SSE endpoint `GET /api/v1/events?apikey=&events=a,b` forwards every event as `event: <name>` / `data: <json>`, starts with `event: hello`, sends `: ping` every 25 s, and only includes `log.entry` when it is requested explicitly. Web: `subscribeEvents(handler, names?)` in `web/src/lib/api/events.ts`.

| Event              | Payload                                                                                  | Emitted by                                         |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `job.queued`       | `{ job: JobSummary }`                                                                    | jobs                                               |
| `job.started`      | `{ job: JobSummary }`                                                                    | jobs                                               |
| `job.progress`     | `{ jobId, step, progress 0..1, speed, etaSec, outTimeSec }` (throttle to <= 2/s per job) | jobs (bdmv through `JobRunContext.reportProgress`) |
| `job.step`         | `{ jobId, step, message }`                                                               | jobs                                               |
| `job.finished`     | `{ job: JobSummary, state: completed\|failed\|cancelled }`                               | jobs                                               |
| `job.removed`      | `{ jobId }`                                                                              | jobs                                               |
| `queue.state`      | `QueueState`                                                                             | jobs                                               |
| `media.updated`    | `{ mediaFileId, status, path }`                                                          | probe-scan                                         |
| `media.removed`    | `{ mediaFileId }`                                                                        | probe-scan                                         |
| `scan.started`     | `{ scanId, libraryId }`                                                                  | probe-scan                                         |
| `scan.progress`    | `{ scanId, stats: ScanStats, currentPath }` (throttled)                                  | probe-scan                                         |
| `scan.finished`    | `{ scanId, stats, error }`                                                               | probe-scan                                         |
| `task.started`     | `{ name: TaskName }`                                                                     | probe-scan (scheduler)                             |
| `task.finished`    | `{ task: ScheduledTaskInfo }`                                                            | probe-scan (scheduler)                             |
| `bdmv.decision`    | `{ decisionId, mediaFileId }`                                                            | bdmv                                               |
| `settings.changed` | `{ sections: string[] }`                                                                 | core                                               |
| `log.entry`        | `LogEntry`                                                                               | core                                               |

## Scheduled tasks

Defined by `TaskName` (`src/shared/domain.ts`) with defaults in `DEFAULT_TASK_INTERVALS` (`src/contracts/probe-scan.ts`). The scheduler (probe-scan) owns the table and dispatches through services:

| Task                | Default | Handler                              |
| ------------------- | ------- | ------------------------------------ |
| `library_scan`      | 360 min | `scan.start({})`                     |
| `recycle_bin_purge` | 60 min  | `recycleBin.purge({})`               |
| `seeding_check`     | 30 min  | `downloadClient.checkSeedingGoals()` |
| `backup`            | 7 days  | `system.createBackup('scheduled')`   |
| `housekeeping`      | 1 day   | `jobs.housekeeping()`                |
| `log_cleanup`       | 1 day   | `system.cleanupLogs()`               |

## Conventions

**Configuration.** Bootstrap values (port, bind address, URL base, API key, log level, instance name, authentication) live in `<config>/config.json` and can be forced with `WOLOLO__PORT`, `WOLOLO__BIND_ADDRESS`, `WOLOLO__URL_BASE`, `WOLOLO__API_KEY`, `WOLOLO__LOG_LEVEL`, `WOLOLO__INSTANCE_NAME`, `WOLOLO__AUTHENTICATION`. Empty env values count as unset; invalid ones are ignored with a logged warning. A missing, partial, invalid or corrupt config.json is repaired on start (the corrupt original is kept as `config.json.bad`), so the API key never changes between boots. Bind address is `*` or an IP; URL base is `""` or `/segment[/segment]`. `resolveBootSettings()` is the read-only view of port/bind/URL base that `docker/healthcheck.ts` also uses. Tool paths: `WOLOLO__FFMPEG`, `WOLOLO__FFPROBE`, `WOLOLO__MKVMERGE`, `WOLOLO__7Z`. Config dir: `WOLOLO_CONFIG_DIR` (default `/config` when writable, else `./config`). Version: `WOLOLO_VERSION` (set in the image from the git tag), else package.json. Runtime settings (`Settings`) live in the `settings` table and are read with `ctx.settings.section('processing')`; read them at use time, not at construction, so changes apply live.

**Authentication.** The API always requires the key (`X-Api-Key`, `?apikey=`, Bearer). `GeneralConfig.authentication` only decides whether the SPA receives it in `window.__WOLOLO__`: `disabled_for_local_addresses` (default: loopback/private client addresses without proxy headers), `required` (never; the UI asks for the key) or `disabled` (always; only behind an authenticating reverse proxy).

**Languages.** Every language value from outside (ffprobe, MPLS/CLPI, mkvmerge, Radarr/Sonarr names, user input) goes through `normalizeLanguage` (`src/shared/language.ts`) and is stored as ISO 639-2/B (`ger`, not `deu`/`de`/`German`); comparisons use `sameLanguage`.

**Errors.** Services throw `AppError(code, message, details?)` (`src/core/errors.ts`); unimplemented code calls `notImplemented('name')` (501). Unknown errors answer a fixed `internal error` (the real error is logged). Per-file problems during scans, webhooks and jobs are recorded (status, history, log) and never crash the process or the scan. Never swallow errors silently: log them with context.

**Logging.** `const log = ctx.logs.logger('module')`, then `log.info('message', { path, jobId })`. Logging never throws (cyclic data, bigint and error causes are serialised safely). No `console.*` outside the logger. Log entries go to the ring buffer (`/api/v1/system/logs`), `<config>/logs/wololo.txt` (1 MB x 5 rotation) and stdout. Per-job logs: `<config>/logs/jobs/<jobId>.txt`, written through `JobRunContext.log`.

**History.** `HistoryEntry.data` is `HistoryData` (`src/shared/domain.ts`); add keys there, not ad hoc.

**Child processes.** Use `runProcess` from `src/core/process.ts`. Jobs pass `lowPriority: { niceLevel, ioniceClass }` from settings (done for you by `JobRunContext.run`). Always pass an `AbortSignal`.

**Files.** Audio temp output next to the source: `<stem>.wololo-tmp.<ext>`; BDMV temp directory `<radarr root>/.wololo-tmp-<jobId>/` (`TEMP_FILE_MARKER`). Register it with `JobRunContext.setTempPath` before writing. Never write across filesystems for a replace; recycle bin defaults to `<root>/.wololo-recycle`. Paths stored in the DB are absolute local container paths; translation to Radarr/Sonarr/Plex/qBittorrent paths happens only in integrations.

**Time.** ISO 8601 UTC strings in the DB and API.

**Database and migrations.** Schema changes go through the integrator: propose them in `docs/contract-changes/<module>.md`. The integrator edits `src/db/schema.ts`, runs `bun run db:generate` (writes `drizzle/NNNN_*.sql`) and commits both; `runMigrations()` applies them at startup with foreign keys off (checked with `foreign_key_check` afterwards) and a `pre-migration-<ts>.db` backup in `<config>/backups` when an existing database has pending migrations. JSON columns are typed with `$type<T>()`.

**OpenAPI.** Pass the zod schemas a handler parses with as the 4th argument of `route(app, key, handler, { params, query, body })`; `system.openApiDocument()` turns them into JSON Schema. Responses are described by type name.

**Tests.** `bun test`. Pure functions get table tests (`test.each`). Use `createTestContext()` from `test/helpers/context.ts` for a migrated temp DB and full AppContext, `ctx.request()` for authenticated HTTP calls, the seed/probe/run-context/stubs helpers listed above. `test/api/routes.test.ts` checks that every `API_ROUTE_META` key is registered (via `app.routes`, without calling handlers). Media fixtures: `ensureFixture(FIXTURES.dts51)` (or your own `FixtureSpec`) from `test/helpers/fixtures.ts`, guarded by `describe.skipIf(!ffmpegAvailable())`; use `ensureFixtureCopy(spec, dir)` whenever the test moves, replaces or deletes the file. Tools that may be missing locally (`mkvmerge`, `7z`, `tsMuxeR`): `describe.skipIf(!hasBinary('mkvmerge'))`. Fixtures are generated with lavfi `testsrc2` + `aevalsrc` and the ac3, eac3, dca, truehd (`-strict -2`), flac, aac, pcm_s24le and libopus encoders, cached in `test/.cache/fixtures` (gitignored); `bun run fixtures` pre-generates the shared catalogue. ffmpeg's ac3/eac3/dca/truehd encoders cap at 5.1, so 7.1 fixtures use flac, pcm_s24le, aac or opus. Never commit media files.

**Style.** Biome (`bun run lint`, `bun run format`), 2 spaces, single quotes, 120 columns. Self-documenting code, comments only for non-obvious reasons. Small pure functions for anything the spec calls a rule or a command builder.

**Resources (Pi 4).** Idle RSS under 150 MB: no large in-memory caches, paginate DB reads, stream file reads, keep `ffprobe` JSON per file (not per library) in memory.

## Web UI

SvelteKit 3 (config lives in `web/vite.config.ts`), Svelte 5 runes, plain CSS with custom properties (`web/src/lib/styles/app.css`; light/dark via `prefers-color-scheme` and `data-theme`). Imports use subpath imports: `#lib/...` with explicit extensions. The backend injects `window.__WOLOLO__ = { apiKey, urlBase, version, instanceName }` into `index.html`; `apiKey` is `""` when the authentication mode withholds it: the SPA then shows a one-field API key prompt, keeps the key in `localStorage` and shows the prompt again on any 401. Under a URL base the backend rewrites the built `index.html` (asset URLs and SvelteKit's `base`), so use `$app/paths` `base` for links and `goto`, and `urlBase` for API calls. Settings > Connect shows the webhook URL per arr instance: `<origin><urlBase>/api/v1/webhook/<kind>?instance=<id>&apikey=<key>`. In `vite dev` set `VITE_WOLOLO_API_KEY`; the dev server proxies `/api` to `WOLOLO_BACKEND` (default `http://localhost:8585`). Shared types: `import type { JobSummary } from '#lib/shared.ts'`.

## Docker and CI

`Dockerfile`: web + production deps built on the build platform, runtime `debian:trixie-slim` with apt `ffmpeg` (built with libbluray), `mkvtoolnix` and `7zip` (Blu-ray .iso reading), Bun copied from `oven/bun`, `WOLOLO_VERSION` from the `VERSION` build arg, `STOPSIGNAL SIGTERM`, HEALTHCHECK via `docker/healthcheck.ts` (same boot settings as the app). `docker/entrypoint.sh` validates numeric `PUID`/`PGID`, remaps the `wololo` user (home `/nonexistent`, `HOME=/config` for children), applies `UMASK` and `TZ`, chowns `/config` only when its owner differs (a failing chown on NFS/CIFS only warns) and drops privileges with `setpriv`. CI (`.github/workflows/ci.yml`): lint, typecheck, fixtures, tests, web check + build; then an amd64 smoke test (health, 401 without key, PID 1 runs as PUID/PGID, ffmpeg bluray protocol, mkvmerge, 7z, Docker health `healthy`), an arm64 run of the image under QEMU (bun, ffmpeg, mkvmerge, 7z, setpriv), and a multi-arch (amd64 + arm64) push to `ghcr.io/<owner>/wololo` on `main` (tag `main`) and `v*` tags (`X.Y.Z`, `X.Y`, `latest`). tsMuxeR for the BDMV fixture is added to CI by the platform module.

## v1 scope decisions

Decisions that narrow or settle SPEC.md for v1:

- **Dolby Vision (BDMV):** only `drop_hdr10` (keep the HDR10 base layer, drop the profile 7 enhancement layer). "Keep" and "convert to 8.1" need dovi_tool and are v1.1. Audio jobs copy video untouched, Dolby Vision included.
- **Video re-encode:** not in v1. Video codecs outside a profile make the plan `blocked`; the opt-in VC-1/MPEG-2 -> H.264 rule is v1.1.
- **qBittorrent:** read-only seeding checks, removal of replaced files' torrents (opt-in `removeWhenGoalMet`) and the BDMV delete-source offer ship in v1 as optional integrations (SPEC lists qBittorrent both as v1.1 and as part of Feature 2).
- **ISO input:** listed and extracted with 7z (UDF 2.50); ffprobe/ffmpeg read it through libbluray.
- **Forced subtitles (BDMV):** detected by scanning PGS compositions only where a language has several subtitle tracks.
- **Dry run per profile:** totals and groups use each library's effective (strictest) profile; `byProfile` re-evaluates stored probes per assigned profile.
- **UI authentication:** API key, no username/password login in v1; the key is only handed to local clients by default.
- **URL base:** supported for the API and the UI.
- **OpenAPI:** request schemas from registered zod schemas, responses by type name.
