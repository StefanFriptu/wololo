# Contract change requests: platform

Only the `platform` module edits this file. The integrator applies accepted entries after the parallel phase.
Work around a missing contract locally until then.

Entry format:

```
### <short title>
- File: src/contracts/jobs.ts (or schema, api-types, ...)
- Change: exact proposed signature / column / type
- Why: what breaks or is impossible without it
- Workaround in place: yes/no, where
```

### Response type name in the route metadata

- File: src/shared/api-routes.ts
- Change: add `responseTypeName: string` to `RouteMeta` (e.g. `'HealthCheck[]'`, `'Paginated<JobSummary>'`, `'ScanStatus | null'`), filled for every key of `API_ROUTE_META`; the `json()`/`empty()` helpers take it as a third argument.
- Why: the OpenAPI document must name each response type, but TypeScript types do not exist at runtime and `RouteMeta` only carries `responseType` ('json', 'blob', ...). Today the names are mirrored by hand.
- Workaround in place: yes. `src/modules/system/responseTypeNames.ts` (`RESPONSE_TYPE_NAMES: { [K in RouteKey]: string }`, so a new route breaks the build until it is added) plus `responseTypeNames.test.ts`, which parses `ApiRoutes` in `src/shared/api-types.ts` and fails on any drift. Once the field exists, `platformOpenApi.ts` reads it and both files go away.

### Large backup uploads (replaces the withdrawn 2 GiB body limit request)

- File: src/contracts/platform.ts (`SystemService.restoreUpload`), src/shared/api-routes.ts and src/shared/api-types.ts (`POST /api/v1/system/backups/restore`), src/app/bootstrap.ts
- Change: none requested for now. The earlier request to raise `maxRequestBodySize` to 2 GiB is withdrawn: `restoreUpload(bytes: Uint8Array)` takes the whole upload in memory (multipart body plus `arrayBuffer()` copy), so a 1.5 GiB upload would need about 3 GiB of RAM on a 4 GB Pi, and the limit is global for every route. Bun's default 128 MiB stays. If large uploads must work from the browser later, the change would be: the route takes a raw `application/zip` body, and `restoreUpload(body: ReadableStream<Uint8Array>)` spools it to `<config>/restore.staging-*` on disk while extracting (the extractor already reads chunks), with an explicit cap such as 512 MiB.
- Why: the zip is deflate-compressed, so 128 MiB already admits a database of roughly 0.6-1.3 GB; only very large libraries exceed it.
- Workaround in place: yes. The README troubleshooting table tells users to copy the zip into `/config/backups` (original file name, readable by PUID) and restore it from the list; `POST /api/v1/system/backups/:name/restore` streams from disk.

### ARCHITECTURE.md "Docker and CI" paragraph

- File: docs/ARCHITECTURE.md (section "Docker and CI", and the `docker/` line of the directory map)
- Change: replace the CI description with: "CI (`.github/workflows/ci.yml`, shared setup in `.github/actions/setup`; `.github/workflows/supply-chain.yml` runs `npm audit signatures` + `bun audit --audit-level=high` for root and web, and fails a PR that adds `trustedDependencies` entries without the `dependencies-reviewed` label): commit hygiene (no fixup!/squash!/amend! on PRs), lint + typecheck + fixtures + tests with ffmpeg, MKVToolNix, 7-Zip and a pinned, checksummed tsMuxeR 2.7.0, and web check + build; drafts are skipped. Images are built natively per architecture (`ubuntu-24.04` for amd64, `ubuntu-24.04-arm` for arm64, no QEMU) and both run `docker/smoke-test.sh` (health, 401 without key, public docs, PID 1 as PUID/PGID, /config chowned, TZ, ffmpeg bluray protocol, mkvmerge, 7z, all tools available in /system/status, no tool/config health warnings, backup, openapi.json, Docker health `healthy`, restart via the API brought back by the restart policy, graceful stop exit 0). On `main` and `v*` tags each architecture is pushed by digest and a `manifest` job publishes the multi-arch list to `ghcr.io/<owner>/wololo` with docker/metadata-action tags (`main`, `X.Y.Z`, `X.Y`, `latest`, `sha-<short>`), labels and index annotations. The build version (`VERSION` build arg, `WOLOLO_VERSION`, `org.opencontainers.image.version` label and annotation) is computed once: `X.Y.Z` on `vX.Y.Z` tags, `<branch>-<sha7>` on branches, `pr-<n>-<sha7>` on PRs. `ARG VERSION` sits after every `RUN` so a new version only changes metadata layers. The Dockerfile verifies bun, ffmpeg (bluray protocol), ffprobe, mkvmerge, 7z, nice, ionice and setpriv at build time." Directory map: `docker/  entrypoint.sh (PUID/PGID/UMASK/TZ), healthcheck.ts, smoke-test.sh`.
- Why: the old text describes a single amd64 job with an arm64 QEMU run; the workflow now builds without emulation and the smoke test is a script shared by CI and local runs.
- Workaround in place: n/a (documentation only).

### Note for module owners: platform reads two tables directly

- File: none (information)
- Change: none. `system.health()` reads `libraries` + `library_roots` (enabled roots, for the reachability check) and `system.cleanupLogs()` reads `jobs.id`. Both are reads, allowed by golden rule 6; renaming those columns needs a matching change in `src/modules/system/libraryRootsQuery.ts` / `existingJobIdsQuery.ts`.
- Workaround in place: n/a.

### One export per file in src/modules/system

- File: docs/CONVENTIONS.md ("One export per file, named exactly like the file")
- Change: decide whether a file may export its main function together with the types and constants that belong to it (e.g. `backupNames.ts`: `BackupKind`, `BACKUPS_KEPT`, `formatBackupName`, `parseBackupKind`, `selectBackupsToPrune`). If not, the integrator (or a follow-up in this module) splits the 12 multi-export files of `src/modules/system`; if yes, add the exception to CONVENTIONS.md.
- Why: the frozen skeleton itself groups exports the same way (`src/core/errors.ts`, `src/core/process.ts`, `src/core/config.ts`, `src/shared/api-routes.ts`), so the system module followed that precedent; splitting now would be churn across files every reviewer is reading, with no behaviour change.
- Workaround in place: no; the files new in this round (`rootProblem.ts`, `withTimeout.ts`) export one function each, plus the types and constants of that function.
