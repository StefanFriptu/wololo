# Integration decisions

Outcome of the contract change requests the seven module owners filed while building in parallel (formerly
`docs/contract-changes/<module>.md`, removed after this round). New contract changes go to the integrator as an issue or
PR; record the outcome here.

Legend: **applied** (contract, shared types, core or test helpers changed, modules updated), **doc** (contract comment
only, behaviour already implemented), **rejected** (with the reason), **deferred** (sound, but not for v1; owner to
confirm).

## Cross-module conflicts

- **Blocked plans** (probe-scan, web-ui, rules-ffmpeg): applied as a media status of its own. `MEDIA_FILE_STATUSES`
  gains `blocked`; `checkPath`, `bdmv.evaluate`, the dry run (`totals.blocked`) and the audio executor (a plan that
  turned blocked after queueing completes as `skipped` and marks the file `blocked`) all use it. "Process all
  needs-work" and the scan backlog never queue it. `failed` now only means an evaluation or a job failed.
- **Plex flags stored twice** (jobs, integrations, web-ui): the Plex connection is the single source.
  `PlexConnection.pauseWhileStreaming` (read by the jobs worker) and `PlexConnection.partialScan` (read by
  `plex.refreshPath`) stay; `Settings.processing.pauseWhilePlexStreaming` and `Settings.notifications.plexPartialScan`
  are gone. No schema change; stored settings rows lose the keys on the next save (zod strips them).
- **TorrentInfo paths** (integrations, bdmv): local. `downloadClient` applies qbittorrent mappings; bdmv no longer maps
  `contentPath` a second time (a mapping whose remote prefix also matched the local path would have doubled it).

## probe-scan

| Request                                                 | Outcome                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Blocked plans have no media status                      | applied (see above)                                                                                                                    |
| Backlog/enqueueMany carry no BdmvJobPlan                | doc: `NewJob.bdmvPlan` is informational; executors re-plan. `enqueueMany` re-evaluates discs, the scan backlog enqueues without a plan |
| Recycle-bin path must be absolute                       | applied (`settingsSchema` refine)                                                                                                      |
| ClassifyEntry / NeedsRecheck wording                    | doc                                                                                                                                    |
| `ScanStats.probeErrors` counts every evaluation failure | doc (kept the name: no churn in the UI)                                                                                                |
| Shared rules fake in test/helpers                       | rejected: the real rules engine is merged; `src/modules/scan/test-fakes.ts` stays a module-local test double, imported only by tests   |

## rules-ffmpeg

| Request                                                                | Outcome                                                                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| DroppedStream.reason, keep-both stream mapping                         | doc                                                                                                                               |
| Original-language fallback                                             | doc                                                                                                                               |
| buildAudioConversionArgs example (`+default`, decoder options, `.mka`) | doc                                                                                                                               |
| ac3/eac3 output layout name                                            | doc                                                                                                                               |
| When a compatible track counts as a duplicate                          | doc                                                                                                                               |
| Keep both: converted track first                                       | doc                                                                                                                               |
| Disjoint profiles block the plan                                       | doc; the optional 422 on profile assignment is rejected (the blocked status already surfaces it)                                  |
| Output path guards, temp-file precondition                             | doc; the audio executor now removes a leftover temp path with `rmSync` (never follows a symlink) before ffmpeg starts. `-y` stays |

## jobs

| Request                                                 | Outcome                                                                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dry_run` pause reason                                  | applied                                                                                                                                                                                |
| Two toggles for the Plex streaming pause                | applied (see above)                                                                                                                                                                    |
| `JobOutcome.plan`                                       | applied; both executors return it, the worker stores it and takes `retagged` from it                                                                                                   |
| `HISTORY_EVENT_TYPES`                                   | applied                                                                                                                                                                                |
| `output_readable` verification check                    | applied                                                                                                                                                                                |
| Shared fakes for real-ffmpeg services                   | rejected: `src/modules/jobs/test-support.ts` stays test-only; cross-module coverage now runs on real services in `test/integration/pipeline.test.ts`                                   |
| recover(): step "notifying"                             | doc                                                                                                                                                                                    |
| Replace sequence never overwrites, fsync                | doc                                                                                                                                                                                    |
| `low_disk_space` pause reason                           | applied                                                                                                                                                                                |
| Real pause (SIGSTOP) for running children               | deferred to v1.1: abort + re-queue without counting an attempt is safe; suspending ffmpeg for hours keeps temp files and locks open                                                    |
| Persist the user's queue pause                          | applied as `settings.processing.paused` (in backups); the marker file is gone                                                                                                          |
| Scanners must skip temp files (default ignore patterns) | rejected as a pattern change: the scanner and `checkPath` always skip `TEMP_FILE_MARKER` and dot-prefixed names, whatever the user's pattern list says (verified in the pipeline test) |
| `RecycleBinService.checkLocation`                       | rejected: only jobs needs it (bdmv never recycles; the source disc is untouched), so it stays internal                                                                                 |
| Integration test for the real acceptance case           | applied (`test/integration/pipeline.test.ts`)                                                                                                                                          |

## integrations

| Request                                               | Outcome                                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebhookResponse.action `blocked`, `decision_required` | applied                                                                                                                                                  |
| Store the torrent hash (`media_files.download_id`)    | deferred: the bin-inode + arr-history match works and is tested; a stored hash needs a schema change and only matters for the opt-in `removeWhenGoalMet` |
| Two switches for the Plex partial scan                | applied (see above)                                                                                                                                      |
| Two sources for "pause while Plex is streaming"       | applied (see above)                                                                                                                                      |
| TorrentInfo / ArrRootFolder path conventions          | applied: documented local paths, `ArrRootFolder.localPath` is non-null                                                                                   |
| PlexConnectionUpdate.serverToken                      | applied: a manual URL plex.tv does not list uses the token sent with it, never a stored one                                                              |
| Masked secrets resolve only for the stored URL        | doc                                                                                                                                                      |
| findRootForPath compares normalised paths             | doc                                                                                                                                                      |

## bdmv

| Request                                    | Outcome                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `MkvmergeOutputTrack.codec`                | applied; the module-local `MkvmergeTrackRequest` is gone                              |
| BdmvEvaluation states                      | doc (with `blocked` instead of `failed`)                                              |
| decodeAudioStreams are absolute indexes    | doc (both executors already pass absolute indexes)                                    |
| JobOutcome.outputPath stored on the job    | doc (the worker already stores it)                                                    |
| Side files start at 0                      | doc                                                                                   |
| CI runs the BDMV e2e test                  | applied: `WOLOLO_REQUIRE_BDMV_E2E=1` on the test step (tsMuxeR was already installed) |
| BdmvDiscInfo.parseErrors / warnings        | applied                                                                               |
| Failed Radarr import does not fail the job | doc                                                                                   |
| One ffmpeg pass for every failing track    | deferred to v1.1 (performance; one ffmpeg per track is correct)                       |
| TorrentInfo paths                          | applied (local, see above)                                                            |
| detect / deleteSource / free-space docs    | doc                                                                                   |

## web-ui

| Request                                 | Outcome                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `GeneralConfigView.envOverrides`        | applied; Settings > General disables env-locked inputs                                 |
| Docs: event helper and Recycle bin page | applied in ARCHITECTURE.md                                                             |
| StreamHello                             | applied                                                                                |
| One stored flag per Plex behaviour      | applied (see above); `plexFlagWrites` is gone                                          |
| Keep the stored qBittorrent password    | doc (integrations already honours the mask)                                            |
| EnqueueFilter search and codec          | applied; "Process needs-work" sends every list filter                                  |
| MediaQuery.kind as a list               | applied (also `EnqueueFilter.kind`); the dry-run "bdmv" group links to `kind=bdmv,iso` |
| Shape of a blocked plan                 | doc                                                                                    |

## platform

| Request                                   | Outcome                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `responseTypeName` in RouteMeta           | rejected: `RESPONSE_TYPE_NAMES` is already exhaustive over `RouteKey` and drift-tested against `ApiRoutes`                                                        |
| Large backup uploads                      | withdrawn by the owner                                                                                                                                            |
| ARCHITECTURE "Docker and CI"              | applied                                                                                                                                                           |
| platform reads two tables directly        | noted (reads are allowed)                                                                                                                                         |
| One export per file in src/modules/system | applied as a CONVENTIONS.md exception: a file may group the functions of one concern (every module, and ARCHITECTURE.md's own file table, already does); no split |

## Integration changes beyond the requests

- Every route has exactly one real handler; `registerNotImplemented`, `notImplemented` and the `not_implemented` (501)
  error code are gone. `test/api/routes.test.ts` sweeps every route with network calls blocked and fails on a 501.
- Startup: migrations -> profile seed -> crash recovery -> scheduler (seeds its task rows) -> worker -> HTTP.
- The web settings pages send only the changed leaves (`diffSettings`), so a save never overwrites a value it did not
  edit, such as the queue pause.
- README: the first run turns processing on before queueing a file (queueing answers 412 in dry-run mode), and points
  recycle-bin restores at Activity > Recycle bin.

## Player profiles

| Change                                                                    | Outcome                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardcoded Samsung Tizen default                                           | applied: no seed, no fallback, no builtin flag. A library without profiles is not checked (scans skip it, `checkPath` answers `ignored`). Migration 0006 assigns the old builtin row to every library that relied on it, so existing installs keep their results           |
| Device presets                                                            | rejected: codec support differs per model and year, so device lists go stale. Capability templates named after formats instead (`GET /api/v1/profiles/templates`)                                                                                                          |
| Per-profile results                                                       | applied: `checkProfiles` plans each assigned profile alone; stored whole as `media_files.profile_results` and refreshed with the rules key (migration 0006 clears file rules keys so the next scan fills them, reusing the stored probe)                                   |
| `Settings.media.importAction` replaces automatic conversion               | applied: `check_only` (default), `convert_strictest`, `convert_for_profile` + `importProfileId`. Covers webhook imports, `checkPath` and the scan backlog. **Behaviour change**: existing installs stop auto-converting until the owner opts in                            |
| Convert for one profile                                                   | applied for audio jobs (`jobs.profile_id`, `EnqueueRequest.profileId`, `NewJob.profileId`); the executor re-plans for that profile alone. A profile not assigned to the file's library is skipped with a reason. BDMV jobs always use the strictest combination (deferred) |
| Per-codec test clips that build a profile from what played on the real TV | deferred to a follow-up                                                                                                                                                                                                                                                    |

## Guided setup

- **W1, webhook added for you**: applied. `PUT /api/v1/arr/:id/webhook` creates (from `/api/v3/notification/schema`)
  or updates the Webhook whose URL is Wololo's webhook path with `?instance=<id>`, named "Wololo", POST, On Import
  and On Upgrade. The setup does it behind a checkbox that is on by default; unticked, it shows the URL to paste.
- **W2, existing installs**: applied. Only an install with no library and no Radarr/Sonarr opens the setup by itself;
  others get a dismissable banner (`settings.setup.dismissed`), and System > Status links to it.
- **Test event round trip**: the webhook emits `webhook.test`; `testWebhook` listens while Radarr/Sonarr run their
  own notification test, which POSTs before it answers. Their failure text is read from the 400 body
  (`UpstreamRequest.keepErrorBody`).
- **Writable roots**: `LibraryRoot.writable` (W_OK on the root). A read-only root is a warning, not a failure: dry
  run works without writing.
- **New imports** sets `media.importAction` (and `importProfileId`); a convert choice also turns
  `processing.enabled` on, since a job is queued only when both say so.
- **Deferred**: the Players step lists the profiles and links to Profiles to add one from a template (embedding
  `PlayerSetup` in the step is a follow-up); the sample is the library's status counts, not 20 files per player.
  Matching Plex sections against library folders is deferred too: the Plex check reports reachability and the
  movie/TV sections.
