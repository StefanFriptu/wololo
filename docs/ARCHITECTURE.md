# Wololo architecture

Wololo is one Bun process: a Hono HTTP server, a SQLite database (bun:sqlite + Drizzle), an in-process job worker and scheduler, and a static SvelteKit SPA, all on one port (default 8585). Requirements live in [SPEC.md](SPEC.md), code conventions in [CONVENTIONS.md](CONVENTIONS.md); this file is the map every implementation agent works from. Where CONVENTIONS.md and a frozen contract disagree, the contract wins until changed through CONTRACT-CHANGES.md.

## Golden rules for parallel work

1. **Only edit files inside your owned paths** (table below). Everything else is read-only for you.
2. **If a contract is wrong or missing something, do not edit it.** Record the change you need in [CONTRACT-CHANGES.md](CONTRACT-CHANGES.md) under your module heading (what, why, proposed signature). Work around it locally until the integrator applies it.
3. **Never edit** root `package.json`, `bun.lock`, `web/package.json`, `web/bun.lock`, `src/db/schema.ts`, `drizzle/`, `src/shared/*`, `src/contracts/*`, `src/core/*`, `src/app/*`, `src/api/*`. Every dependency you plausibly need is already installed.
4. **Cross-module calls go through `ctx.services.<name>`** (typed by `src/contracts/*`). Never import another module's files.
5. **Writes to a table only by its owner** (table ownership below). Reading any table is fine.
6. Keep `bun run lint`, `bun run typecheck`, `bun test` and `cd web && bun run check && bun run build` green.

## Directory map

```
src/
  index.ts                 entry: createRuntime().start(), SIGINT/SIGTERM -> graceful stop
  app/
    bootstrap.ts           config -> logs -> staged restore -> db + migrations -> context -> HTTP; start/stop order
    context.ts             AppContext + Services (the dependency container) and createAppContext()
    server.ts              Hono app: API-key auth on /api/*, module routes, SPA fallback, URL base
  api/
    http.ts                route() typed handler helper, registerNotImplemented(), parse helpers (zod)
    middleware.ts          API key auth (X-Api-Key | ?apikey= | Bearer), error handler, JSON 404
    static.ts              SPA serving + window.__WOLOLO__ injection
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
  helpers/                 fixtures.ts (ffmpeg lavfi generator), context.ts (temp db + AppContext), binaries.ts
  core/ api/ db/           tests of the skeleton
docker/                    entrypoint.sh (PUID/PGID/UMASK/TZ), healthcheck.ts
.github/workflows/ci.yml   lint, typecheck, tests, web build, multi-arch image -> GHCR
```

## Module ownership

| Module key                  | Owned paths                                                                                                                                                                                                 | Implements                                                                                                                                                                  | Pure functions to table-test                                                                                                                                                                                                                                 | May import                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `probe-scan`                | `src/modules/probe/**`, `src/modules/scan/**`, `src/modules/scheduler/**`                                                                                                                                   | `contracts/probe-scan.ts`: ProbeService, LibraryService, MediaService, ScanService, DryRunService, SchedulerService; routes in `scan/routes.ts` (`registerProbeScanRoutes`) | `parseFfprobeOutput` (probe/parse.ts), `needsRecheck`, `classifyEntry` (scan/change-detection.ts)                                                                                                                                                            | shared, contracts, core, db, api/http.ts, app/context.ts (type)                  |
| `rules-ffmpeg`              | `src/modules/profiles/**`, `src/modules/rules/**`, `src/modules/ffmpeg/**`                                                                                                                                  | `contracts/rules-ffmpeg.ts`: ProfileService, RulesService, FfmpegService; routes in `profiles/routes.ts` (`registerRulesFfmpegRoutes`)                                      | `planConversion`, `resolveEffectiveProfile`, `computeRulesKey`, `codecAllowed` (rules/engine.ts), `buildAudioConversionArgs`, `selectBitrate` (ffmpeg/args.ts), `createProgressParser` (ffmpeg/progress.ts), `samsungTizenDefinition` (profiles/defaults.ts) | same                                                                             |
| `jobs`                      | `src/modules/jobs/**`, `src/modules/recycle-bin/**`                                                                                                                                                         | `contracts/jobs.ts`: JobsService (queue, worker, audio executor, verification, atomic replace, crash recovery, gates), RecycleBinService; routes in `jobs/routes.ts`        | processing-window check, verification comparisons, temp/recycle path naming                                                                                                                                                                                  | same                                                                             |
| `integrations`              | `src/modules/integrations/**`                                                                                                                                                                               | `contracts/integrations.ts`: ArrService, WebhookService, PlexService, DownloadClientService, PathMappingService, NotifierService; routes in `integrations/routes.ts`        | `mapPath` (integrations/path-map.ts), webhook payload -> path, movie match score                                                                                                                                                                             | same                                                                             |
| `bdmv`                      | `src/modules/bdmv/**`, `test/fixtures/bdmv/**`                                                                                                                                                              | `contracts/bdmv.ts`: BdmvService (incl. `execute` job executor, IsoReader); routes in `bdmv/routes.ts`                                                                      | `parseMpls`, `parseClpi` (bdmv/mpls.ts), `dedupePlaylists`, `pickMainTitle`, `detectEncryption` (bdmv/titles.ts), `buildMkvmergeArgs`, `buildOutputPaths` (bdmv/mkvmerge.ts)                                                                                 | same                                                                             |
| `web-ui`                    | `web/**` except `web/package.json` and `web/bun.lock`                                                                                                                                                       | every page in the sidebar against `ApiRoutes` + SSE                                                                                                                         | formatting helpers                                                                                                                                                                                                                                           | `web/src/lib/shared.ts` (re-exports `src/shared/*`), nothing else outside `web/` |
| `platform`                  | `src/modules/system/**`, `Dockerfile`, `docker/**`, `docker-compose.example.yml`, `.dockerignore`, `.github/**`, `README.md`, `test/integration/**`                                                         | `contracts/platform.ts`: SystemService (status, health, backups, restore staging via `system/restore.ts`, OpenAPI, restart, log cleanup); routes in `system/routes.ts`      | OpenAPI generation from `API_ROUTE_META`                                                                                                                                                                                                                     | same                                                                             |
| `core` (integrator, frozen) | everything else: `src/core`, `src/db`, `drizzle`, `src/shared`, `src/contracts`, `src/app`, `src/api`, `src/index.ts`, `test/helpers`, `test/core`, `test/api`, `test/db`, root configs, lockfiles, `docs/` | config, logger, events, settings, auth, SSE, static, settings + logs routes                                                                                                 |                                                                                                                                                                                                                                                              |                                                                                  |

Module tests are co-located: `src/modules/<dir>/<name>.test.ts`. Cross-module end-to-end tests belong to `platform` under `test/integration/`.

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
Radarr/Sonarr "On Import/On Upgrade" -> POST /api/v1/webhook/{radarr|sonarr}?apikey=
  -> webhooks.handle*() -> pathMappings.toLocal('radarr', movieFile.path)
  -> media.checkPath(localPath, { trigger: 'webhook', arr, originalLanguage })
       -> libraries.findRootForPath -> upsert media_files row
       -> probe.probe() (or bdmv.evaluate() for discs) -> rules.effectiveProfileForLibrary -> rules.plan()
       -> status compatible | needs_work | ...  (writes nothing to the media file)
       -> settings.processing.enabled ? jobs.enqueue({ type, mediaFileId, trigger }) : 'dry_run'
```

Catch-all scan: `scheduler (library_scan, 6 h) -> scan.start() -> walk roots -> needsRecheck(path+size+mtime+rulesKey) -> media.checkPath()`.

Job (audio):

```
worker picks queued job (concurrency, processing window, Plex auto-pause gates)
  -> media.setStatus(processing) -> re-probe source -> rules.plan() -> ffmpeg.buildAudioConversionArgs()
  -> ensureFreeSpace(dir, estimate * 1.05) -> run ffmpeg (nice/ionice) to "<stem>.wololo-tmp.mkv" in the same folder
  -> progress events (ffmpeg.createProgressParser) -> verify (duration +-100 ms, stream count, video streamhash md5, full audio decode)
  -> recycleBin.recycle(original) -> atomic rename temp -> original path (keep uid/gid/mode)
  -> media.recordJobResult(compatible, fresh probe) -> jobs.addHistory(completed, lostFeatures)
  -> notifier.fileChanged() -> arr.rescan(ref) -> plex.refreshPath(folder)
```

Job (bdmv): `bdmv.execute(runCtx)`: encryption check -> main title (decisions if ambiguous) -> Radarr lookup (decision if score < minMatchScore) -> ffmpeg encodes only failing audio tracks to side files -> mkvmerge reads the .mpls + side files in one write -> verify -> `arr.importMovieFolder()` -> notifier. The source disc is never modified; deletion only when `downloadClient` reports the seeding goal met and the user allows it.

Startup (`src/app/bootstrap.ts`): config -> logger -> `applyPendingRestore` -> open db + migrations -> context -> `profiles.ensureDefaults()` -> `jobs.recover()` -> `jobs.start()` -> `scheduler.start()` -> HTTP listen. Shutdown reverses: abort `ctx.shutdownSignal` -> `scheduler.stop()` -> `jobs.stop()` -> HTTP stop -> flush logs -> close db (15 s cap).

## Dependency container

`createAppContext()` builds one `AppContext` with `config`, `logs`, `log`, `db`, `dbHandle`, `events`, `settings`, `shutdownSignal` and `services`. Each module exports factories (`createXService(ctx)`) from its `index.ts`; the signatures are fixed by `src/app/context.ts`.

- Factories **must not call other services while constructing** (they are wired in one pass). Resolve them at call time: `ctx.services.rules.plan(...)`.
- Create a module logger once: `const log = ctx.logs.logger('jobs')`.
- Keep state inside the factory closure or a class instance returned by it; no module-level singletons.
- Lifecycle methods (`start`, `stop`, `recover`, `ensureDefaults`) must stay safe to call before your module is complete (stubs are no-ops).
- Tests replace services with `createTestContext({ overrides: { plex: fakePlex } })`.

## REST API

Base path `/api/v1` under the optional URL base. Auth: `X-Api-Key` header, `?apikey=` query (Radarr/Sonarr webhooks and EventSource) or `Authorization: Bearer`. Successful writes with nothing to return answer `204` (`NoContent`, `responseType: 'empty'`; handlers return `undefined`). Errors are `ApiErrorBody { error, message, details? }` with codes `not_found` 404, `validation` 400, `unprocessable` 422, `conflict` 409, `unauthorized` 401, `precondition_failed` 412, `upstream` 502, `not_implemented` 501, `internal` 500. Lists use `PageQuery { page, pageSize, sortDir }` -> `Paginated<T>`. Types are in `src/shared/api-types.ts` (`ApiRoutes`); owner, auth and response type in `src/shared/api-routes.ts` (`API_ROUTE_META`). Every route is registered at M0 (501 until implemented); `test/api/routes.test.ts` fails if a route goes missing.

Implementing a route (backend):

```ts
export function registerJobsRoutes(app: ApiApp, ctx: AppContext): void {
  route(app, 'GET /api/v1/jobs/:id', (c) => ctx.services.jobs.get(parseId(c)));
  route(app, 'POST /api/v1/jobs', async (c) =>
    ctx.services.jobs.enqueueMany(await parseBody(c, enqueueSchema)),
  );
  registerNotImplemented(
    app,
    routesOf('jobs').filter((key) => !DONE.has(key)),
  );
}
```

`route()` type-checks the return value against `ApiRoutes[key]['response']`. Register real handlers before the 501 stubs (first match wins) and static segments before `:param` ones (`/media/stats` before `/media/:id`). Text/blob routes return a `Response`.

Calling a route (web): `api('GET /api/v1/jobs/:id', { params: { id } })` from `web/src/lib/api/client.ts`.

| Route                                       | Module       | Auth   | Params / query / body                          | Response                           |
| ------------------------------------------- | ------------ | ------ | ---------------------------------------------- | ---------------------------------- |
| `GET /health`                               | core         | none   | -                                              | `HealthResponse`                   |
| `GET /api/v1/events`                        | core         | apikey | -                                              | sse                                |
| `GET /api/v1/system/status`                 | platform     | apikey | -                                              | `SystemStatus`                     |
| `GET /api/v1/system/health`                 | platform     | apikey | -                                              | `HealthCheck[]`                    |
| `GET /api/v1/system/tasks`                  | probe-scan   | apikey | -                                              | `ScheduledTaskInfo[]`              |
| `PUT /api/v1/system/tasks/:name`            | probe-scan   | apikey | params `{ name: TaskName }`, body `TaskUpdate` | `ScheduledTaskInfo`                |
| `POST /api/v1/system/tasks/:name/run`       | probe-scan   | apikey | params `{ name: TaskName }`                    | `ScheduledTaskInfo`                |
| `GET /api/v1/system/logs`                   | core         | apikey | query `LogQuery`                               | `LogEntry[]`                       |
| `GET /api/v1/system/logs/files`             | core         | apikey | -                                              | `LogFileInfo[]`                    |
| `GET /api/v1/system/logs/files/:name`       | core         | apikey | params `{ name: string }`                      | text                               |
| `GET /api/v1/system/backups`                | platform     | apikey | -                                              | `BackupInfo[]`                     |
| `POST /api/v1/system/backups`               | platform     | apikey | -                                              | `BackupInfo`                       |
| `GET /api/v1/system/backups/:name`          | platform     | apikey | params `{ name: string }`                      | blob                               |
| `DELETE /api/v1/system/backups/:name`       | platform     | apikey | params `{ name: string }`                      | 204 No Content                     |
| `POST /api/v1/system/backups/:name/restore` | platform     | apikey | params `{ name: string }`                      | `RestoreResult`                    |
| `POST /api/v1/system/backups/restore`       | platform     | apikey | body `FormData`                                | `RestoreResult`                    |
| `POST /api/v1/system/restart`               | platform     | apikey | -                                              | 204 No Content                     |
| `GET /api/v1/openapi.json`                  | platform     | apikey | -                                              | `Record<string, unknown>`          |
| `GET /api/v1/docs`                          | platform     | none   | -                                              | html                               |
| `GET /api/v1/settings`                      | core         | apikey | -                                              | `Settings`                         |
| `PUT /api/v1/settings`                      | core         | apikey | body `SettingsUpdate`                          | `Settings`                         |
| `GET /api/v1/settings/general`              | core         | apikey | -                                              | `GeneralConfigView`                |
| `PUT /api/v1/settings/general`              | core         | apikey | body `GeneralConfigUpdate`                     | `GeneralConfigView`                |
| `POST /api/v1/settings/general/apikey`      | core         | apikey | -                                              | `GeneralConfigView`                |
| `GET /api/v1/libraries`                     | probe-scan   | apikey | -                                              | `Library[]`                        |
| `POST /api/v1/libraries`                    | probe-scan   | apikey | body `LibraryInput`                            | `Library`                          |
| `GET /api/v1/libraries/:id`                 | probe-scan   | apikey | params `IdParams`                              | `Library`                          |
| `PUT /api/v1/libraries/:id`                 | probe-scan   | apikey | params `IdParams`, body `LibraryInput`         | `Library`                          |
| `DELETE /api/v1/libraries/:id`              | probe-scan   | apikey | params `IdParams`                              | 204 No Content                     |
| `GET /api/v1/filesystem`                    | probe-scan   | apikey | query `FilesystemQuery`                        | `FilesystemListing`                |
| `GET /api/v1/media`                         | probe-scan   | apikey | query `MediaQuery`                             | `Paginated<MediaFileSummary>`      |
| `GET /api/v1/media/stats`                   | probe-scan   | apikey | query `{ libraryId?: number }`                 | `MediaStats`                       |
| `GET /api/v1/media/:id`                     | probe-scan   | apikey | params `IdParams`                              | `MediaFileDetail`                  |
| `POST /api/v1/media/:id/probe`              | probe-scan   | apikey | params `IdParams`                              | `MediaFileDetail`                  |
| `GET /api/v1/media/:id/plan`                | probe-scan   | apikey | params `IdParams`                              | `ConversionPlan`                   |
| `PUT /api/v1/media/:id/ignore`              | probe-scan   | apikey | params `IdParams`, body `MediaIgnoreBody`      | `MediaFileSummary`                 |
| `POST /api/v1/scans`                        | probe-scan   | apikey | body `ScanRequest`                             | `ScanStatus`                       |
| `GET /api/v1/scans/current`                 | probe-scan   | apikey | -                                              | `ScanStatus \| null`               |
| `DELETE /api/v1/scans/current`              | probe-scan   | apikey | -                                              | 204 No Content                     |
| `GET /api/v1/dryrun`                        | probe-scan   | apikey | query `DryRunQuery`                            | `DryRunReport`                     |
| `GET /api/v1/profiles`                      | rules-ffmpeg | apikey | -                                              | `ProfileWithUsage[]`               |
| `POST /api/v1/profiles`                     | rules-ffmpeg | apikey | body `ProfileInput`                            | `ProfileWithUsage`                 |
| `GET /api/v1/profiles/codecs`               | rules-ffmpeg | apikey | -                                              | `CodecCatalog`                     |
| `GET /api/v1/profiles/:id`                  | rules-ffmpeg | apikey | params `IdParams`                              | `ProfileWithUsage`                 |
| `PUT /api/v1/profiles/:id`                  | rules-ffmpeg | apikey | params `IdParams`, body `ProfileInput`         | `ProfileWithUsage`                 |
| `DELETE /api/v1/profiles/:id`               | rules-ffmpeg | apikey | params `IdParams`                              | 204 No Content                     |
| `POST /api/v1/profiles/:id/clone`           | rules-ffmpeg | apikey | params `IdParams`, body `ProfileCloneBody`     | `ProfileWithUsage`                 |
| `GET /api/v1/queue`                         | jobs         | apikey | -                                              | `QueueResponse`                    |
| `POST /api/v1/queue/pause`                  | jobs         | apikey | -                                              | `QueueState`                       |
| `POST /api/v1/queue/resume`                 | jobs         | apikey | -                                              | `QueueState`                       |
| `GET /api/v1/jobs`                          | jobs         | apikey | query `JobQuery`                               | `Paginated<JobSummary>`            |
| `POST /api/v1/jobs`                         | jobs         | apikey | body `EnqueueRequest`                          | `EnqueueResponse`                  |
| `GET /api/v1/jobs/:id`                      | jobs         | apikey | params `IdParams`                              | `JobDetail`                        |
| `GET /api/v1/jobs/:id/log`                  | jobs         | apikey | params `IdParams`                              | text                               |
| `POST /api/v1/jobs/:id/cancel`              | jobs         | apikey | params `IdParams`                              | `JobSummary`                       |
| `POST /api/v1/jobs/:id/retry`               | jobs         | apikey | params `IdParams`                              | `JobSummary`                       |
| `DELETE /api/v1/jobs/:id`                   | jobs         | apikey | params `IdParams`                              | 204 No Content                     |
| `GET /api/v1/history`                       | jobs         | apikey | query `HistoryQuery`                           | `Paginated<HistoryEntry>`          |
| `GET /api/v1/recyclebin`                    | jobs         | apikey | query `PageQuery`                              | `Paginated<RecycleBinEntry>`       |
| `POST /api/v1/recyclebin/:id/restore`       | jobs         | apikey | params `IdParams`                              | `RecycleBinEntry`                  |
| `DELETE /api/v1/recyclebin/:id`             | jobs         | apikey | params `IdParams`                              | 204 No Content                     |
| `POST /api/v1/recyclebin/purge`             | jobs         | apikey | body `RecycleBinPurgeRequest`                  | `RecycleBinPurgeResult`            |
| `GET /api/v1/arr`                           | integrations | apikey | -                                              | `ArrInstance[]`                    |
| `POST /api/v1/arr`                          | integrations | apikey | body `ArrInstanceInput`                        | `ArrInstance`                      |
| `POST /api/v1/arr/test`                     | integrations | apikey | body `ArrTestRequest`                          | `ConnectionTestResult`             |
| `GET /api/v1/arr/:id`                       | integrations | apikey | params `IdParams`                              | `ArrInstance`                      |
| `PUT /api/v1/arr/:id`                       | integrations | apikey | params `IdParams`, body `ArrInstanceInput`     | `ArrInstance`                      |
| `DELETE /api/v1/arr/:id`                    | integrations | apikey | params `IdParams`                              | 204 No Content                     |
| `GET /api/v1/arr/:id/rootfolders`           | integrations | apikey | params `IdParams`                              | `ArrRootFolder[]`                  |
| `POST /api/v1/webhook/radarr`               | integrations | apikey | body `RadarrWebhookPayload`                    | `WebhookResponse`                  |
| `POST /api/v1/webhook/sonarr`               | integrations | apikey | body `SonarrWebhookPayload`                    | `WebhookResponse`                  |
| `GET /api/v1/plex`                          | integrations | apikey | -                                              | `PlexConnection`                   |
| `PUT /api/v1/plex`                          | integrations | apikey | body `PlexConnectionUpdate`                    | `PlexConnection`                   |
| `DELETE /api/v1/plex`                       | integrations | apikey | -                                              | `PlexConnection`                   |
| `POST /api/v1/plex/pin`                     | integrations | apikey | -                                              | `PlexPin`                          |
| `GET /api/v1/plex/pin/:id`                  | integrations | apikey | params `IdParams`                              | `PlexPinStatus`                    |
| `GET /api/v1/plex/servers`                  | integrations | apikey | -                                              | `PlexServer[]`                     |
| `GET /api/v1/plex/sections`                 | integrations | apikey | -                                              | `PlexSection[]`                    |
| `POST /api/v1/plex/test`                    | integrations | apikey | -                                              | `ConnectionTestResult`             |
| `GET /api/v1/plex/sessions`                 | integrations | apikey | -                                              | `PlexSessions`                     |
| `GET /api/v1/downloadclient`                | integrations | apikey | -                                              | `DownloadClientConnection \| null` |
| `PUT /api/v1/downloadclient`                | integrations | apikey | body `DownloadClientInput`                     | `DownloadClientConnection`         |
| `DELETE /api/v1/downloadclient`             | integrations | apikey | -                                              | 204 No Content                     |
| `POST /api/v1/downloadclient/test`          | integrations | apikey | body `DownloadClientInput`                     | `ConnectionTestResult`             |
| `GET /api/v1/pathmappings`                  | integrations | apikey | -                                              | `PathMapping[]`                    |
| `POST /api/v1/pathmappings`                 | integrations | apikey | body `PathMappingInput`                        | `PathMapping`                      |
| `PUT /api/v1/pathmappings/:id`              | integrations | apikey | params `IdParams`, body `PathMappingInput`     | `PathMapping`                      |
| `DELETE /api/v1/pathmappings/:id`           | integrations | apikey | params `IdParams`                              | 204 No Content                     |
| `GET /api/v1/bdmv/decisions`                | bdmv         | apikey | query `BdmvDecisionQuery`                      | `BdmvDecision[]`                   |
| `GET /api/v1/bdmv/decisions/:id`            | bdmv         | apikey | params `IdParams`                              | `BdmvDecision`                     |
| `POST /api/v1/bdmv/decisions/:id/resolve`   | bdmv         | apikey | params `IdParams`, body `BdmvDecisionChoice`   | `BdmvDecision`                     |
| `POST /api/v1/bdmv/decisions/:id/dismiss`   | bdmv         | apikey | params `IdParams`                              | `BdmvDecision`                     |
| `GET /api/v1/bdmv/discs/:id`                | bdmv         | apikey | params `IdParams`                              | `BdmvDiscInfo`                     |

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

**Configuration.** Bootstrap values (port, bind address, URL base, API key, log level, instance name) live in `<config>/config.json` and can be forced with `WOLOLO__PORT`, `WOLOLO__BIND_ADDRESS`, `WOLOLO__URL_BASE`, `WOLOLO__API_KEY`, `WOLOLO__LOG_LEVEL`, `WOLOLO__INSTANCE_NAME`. Tool paths: `WOLOLO__FFMPEG`, `WOLOLO__FFPROBE`, `WOLOLO__MKVMERGE`. Config dir: `WOLOLO_CONFIG_DIR` (default `/config` when writable, else `./config`). Runtime settings (`Settings`) live in the `settings` table and are read with `ctx.settings.section('processing')`; read them at use time, not at construction, so changes apply live.

**Errors.** Services throw `AppError(code, message, details?)` (`src/core/errors.ts`); unimplemented code calls `notImplemented('name')` (501). Per-file problems during scans, webhooks and jobs are recorded (status, history, log) and never crash the process or the scan. Never swallow errors silently: log them with context.

**Logging.** `const log = ctx.logs.logger('module')`, then `log.info('message', { path, jobId })`. No `console.*` outside the logger. Log entries go to the ring buffer (`/api/v1/system/logs`), `<config>/logs/wololo.txt` (1 MB x 5 rotation) and stdout. Per-job logs: `<config>/logs/jobs/<jobId>.txt`, written through `JobRunContext.log`.

**Child processes.** Use `runProcess` from `src/core/process.ts`. Jobs pass `lowPriority: { niceLevel, ioniceClass }` from settings (done for you by `JobRunContext.run`). Always pass an `AbortSignal`.

**Files.** Temp output next to the source: `<stem>.wololo-tmp.<ext>` (`TEMP_FILE_MARKER`). Never write across filesystems for a replace; recycle bin defaults to `<root>/.wololo-recycle`. Paths stored in the DB are absolute local container paths; translation to Radarr/Sonarr/Plex/qBittorrent paths happens only in integrations.

**Time.** ISO 8601 UTC strings in the DB and API.

**Database and migrations.** Schema changes go through the integrator: propose them in CONTRACT-CHANGES.md. The integrator edits `src/db/schema.ts`, runs `bun run db:generate` (writes `drizzle/NNNN_*.sql`) and commits both; `runMigrations()` applies them at startup. JSON columns are typed with `$type<T>()`.

**Tests.** `bun test`. Pure functions get table tests (`test.each`). Use `createTestContext()` from `test/helpers/context.ts` for a migrated temp DB and full AppContext, `ctx.request()` for authenticated HTTP calls. Media fixtures: `ensureFixture(FIXTURES.dts51)` (or your own `FixtureSpec`) from `test/helpers/fixtures.ts`, guarded by `describe.skipIf(!ffmpegAvailable())`; tools that may be missing locally (`mkvmerge`, `tsMuxeR`): `describe.skipIf(!hasBinary('mkvmerge'))`. Fixtures are generated with lavfi `testsrc2` + `aevalsrc` and the ac3, eac3, dca, truehd (`-strict -2`), flac, aac, pcm_s24le and libopus encoders, cached in `test/.cache/fixtures` (gitignored); `bun run fixtures` pre-generates the shared catalogue. ffmpeg's ac3/eac3/dca/truehd encoders cap at 5.1, so 7.1 fixtures use flac, pcm_s24le, aac or opus. Never commit media files.

**Style.** Biome (`bun run lint`, `bun run format`), 2 spaces, single quotes, 110 columns. Self-documenting code, comments only for non-obvious reasons. Small pure functions for anything the spec calls a rule or a command builder.

**Resources (Pi 4).** Idle RSS under 150 MB: no large in-memory caches, paginate DB reads, stream file reads, keep `ffprobe` JSON per file (not per library) in memory.

## Web UI

SvelteKit 3 (config lives in `web/vite.config.ts`), Svelte 5 runes, plain CSS with custom properties (`web/src/lib/styles/app.css`; light/dark via `prefers-color-scheme` and `data-theme`). Imports use subpath imports: `#lib/...` with explicit extensions. The backend injects `window.__WOLOLO__ = { apiKey, urlBase, version, instanceName }` into `index.html`; in `vite dev` set `VITE_WOLOLO_API_KEY` and the dev server proxies `/api` to `WOLOLO_BACKEND` (default `http://localhost:8585`). Shared types: `import type { JobSummary } from '#lib/shared.ts'`.

## Docker and CI

`Dockerfile`: web + production deps built on the build platform, runtime `debian:trixie-slim` with apt `ffmpeg` (built with libbluray) and `mkvtoolnix`, Bun copied from `oven/bun`. `docker/entrypoint.sh` remaps the `wololo` user to `PUID`/`PGID`, applies `UMASK` and `TZ`, chowns `/config` and drops privileges with `setpriv`. CI (`.github/workflows/ci.yml`): lint, typecheck, fixtures, tests, web check + build, then an amd64 smoke test of the image and a multi-arch (amd64 + arm64, QEMU) push to `ghcr.io/<owner>/wololo` on `main` and `v*` tags. tsMuxeR for the BDMV fixture is added to CI by the platform module.
