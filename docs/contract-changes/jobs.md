# Contract change requests: jobs

Only the `jobs` module edits this file. The integrator applies accepted entries after the parallel phase.
Work around a missing contract locally until then.

Entry format:

```
### <short title>
- File: src/contracts/jobs.ts (or schema, api-types, ...)
- Change: exact proposed signature / column / type
- Why: what breaks or is impossible without it
- Workaround in place: yes/no, where
```

### Queue state cannot say "processing is off"

- File: src/shared/domain.ts
- Change: `export type QueuePauseReason = 'user' | 'window' | 'plex_streaming' | 'shutdown' | 'dry_run';`
- Why: while `settings.processing.enabled` is false the worker starts nothing, but `QueueState` reports `paused: false`, so the UI shows a queue that looks stuck.
- Workaround in place: yes. `src/modules/jobs/worker.ts` skips picking jobs while processing is off; `POST /api/v1/jobs` answers 412. The reason is not reported in `QueueState`.

### Two toggles for the Plex streaming pause

- File: src/shared/settings.ts (`processing.pauseWhilePlexStreaming`) and src/shared/domain.ts (`PlexConnection.pauseWhileStreaming`)
- Change: keep one. Proposal: drop `PlexConnection.pauseWhileStreaming` (and the `plex_connection.pause_while_streaming` column); the Plex settings page edits `processing.pauseWhilePlexStreaming`.
- Why: two switches for one behaviour; turning one off while the other is on still pauses.
- Workaround in place: yes. `src/modules/jobs/worker.ts` pauses when either is true.

### Executors cannot hand back the plan they used

- File: src/contracts/jobs.ts
- Change: add `plan?: ConversionPlan | null` to `JobOutcome`.
- Why: the worker writes the `completed` history entry, and `HistoryData.retagged` comes from the plan the executor actually applied (recomputed from a fresh probe). The bdmv executor has no way to report it.
- Workaround in place: yes. The audio executor records its plan through an internal hook (`recordPlan` in `src/modules/jobs/audioExecutor.ts`). bdmv jobs get `retagged` from the enqueue-time plan only.

### No runtime list of history event types

- File: src/shared/domain.ts
- Change: `export const HISTORY_EVENT_TYPES = ['queued', 'started', 'completed', 'failed', 'cancelled', 'retried', 'skipped', 'recycled', 'restored', 'purged', 'imported', 'source_deleted'] as const; export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];`
- Why: `GET /api/v1/history?event=` needs a zod enum. Jobs and web-ui otherwise each keep a copy.
- Workaround in place: yes. `src/modules/jobs/routes.ts` keeps an exhaustive `Record<HistoryEventType, true>`.

### Verification has no check name for an unreadable output

- File: src/shared/domain.ts (`VerificationCheck['name']`)
- Change: add `'output_readable'`.
- Why: when ffprobe cannot read the temp output, the failure is reported under `stream_count`, which is misleading in the UI.
- Workaround in place: yes. `src/modules/jobs/verify.ts` reports it as `stream_count` with the detail "cannot read output: ...".

### Shared fakes for services backed by real ffmpeg

- File: test/helpers/ (new `media-tools.ts`)
- Change: move `ffprobeResult`, `ac3Plan`, `ac3ConversionArgs`, `simpleProgressParser`, `recordingMediaService`, `realMediaToolServices`, `waitForEvent` and `sha256` from `src/modules/jobs/test-support.ts` into test/helpers.
- Why: they are test-only code living under src/ because test/helpers is frozen. platform's integration tests need the same fakes until probe-scan and rules-ffmpeg are merged.
- Workaround in place: yes. `src/modules/jobs/test-support.ts`, imported only by tests.
