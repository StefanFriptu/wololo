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

### Request body limit for backup uploads

- File: src/app/bootstrap.ts
- Change: pass `maxRequestBodySize: 2 * 1024 ** 3` to `Bun.serve({ ... })`.
- Why: Bun's default limit is 128 MiB, so `POST /api/v1/system/backups/restore` rejects backups of large libraries (the database holds one ffprobe JSON per file) before the handler runs.
- Workaround in place: partial. The README tells users to copy the zip into `/config/backups` and restore it from the list (`POST /api/v1/system/backups/:name/restore` streams from disk, no size limit).

### ARCHITECTURE.md "Docker and CI" paragraph

- File: docs/ARCHITECTURE.md (section "Docker and CI", and the `docker/` line of the directory map)
- Change: replace the CI description with: "CI (`.github/workflows/ci.yml`, shared setup in `.github/actions/setup`): commit hygiene (no fixup!/squash!/amend! on PRs), lint + typecheck + fixtures + tests with ffmpeg, MKVToolNix, 7-Zip and a pinned, checksummed tsMuxeR 2.7.0, and web check + build; drafts are skipped. Images are built natively per architecture (`ubuntu-24.04` for amd64, `ubuntu-24.04-arm` for arm64, no QEMU) and both run `docker/smoke-test.sh` (health, 401 without key, public docs, PID 1 as PUID/PGID, /config chowned, TZ, ffmpeg bluray protocol, mkvmerge, 7z, all tools available in /system/status, no tool/config health warnings, backup, openapi.json, Docker health `healthy`, restart via the API brought back by the restart policy, graceful stop exit 0). On `main` and `v*` tags each architecture is pushed by digest and a `manifest` job publishes the multi-arch list to `ghcr.io/<owner>/wololo` with docker/metadata-action tags (`main`, `X.Y.Z`, `X.Y`, `latest`, `sha-<short>`), labels and index annotations. The Dockerfile verifies bun, ffmpeg (bluray protocol), ffprobe, mkvmerge, 7z, nice, ionice and setpriv at build time." Directory map: `docker/  entrypoint.sh (PUID/PGID/UMASK/TZ), healthcheck.ts, smoke-test.sh`.
- Why: the old text describes a single amd64 job with an arm64 QEMU run; the workflow now builds without emulation and the smoke test is a script shared by CI and local runs.
- Workaround in place: n/a (documentation only).

### Note for module owners: platform reads two tables directly

- File: none (information)
- Change: none. `system.health()` reads `libraries` + `library_roots` (enabled roots, for the reachability check) and `system.cleanupLogs()` reads `jobs.id`. Both are reads, allowed by golden rule 6; renaming those columns needs a matching change in `src/modules/system/libraryRootsQuery.ts` / `existingJobIdsQuery.ts`.
- Workaround in place: n/a.
