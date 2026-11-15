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
- Workaround in place: yes. The audio executor records its plan through an internal hook (`recordPlan` in `src/modules/jobs/audioExecutor.ts`). For bdmv jobs `src/modules/jobs/lifecycle.ts` falls back to `jobs.bdmv_plan.audioPlan` (the enqueue-time plan), so `retagged` reflects the plan at enqueue time, not the one the bdmv executor applied.

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

### recover(): a job interrupted in step "notifying" has already been swapped

- File: src/contracts/jobs.ts (`JobsService.recover` doc comment)
- Change: replace "2. any other step: ..." with:

  ```
   *   2. step "notifying" (audio) and the output path exists -> the swap completed: finish the job as completed
   *      (fresh probe, media.recordJobResult, notifier.fileChanged, "completed" history).
   *   3. any other step: delete jobs.temp_path (...), re-queue with trigger "recovery".
  ```

  and add to step 1:

  ```
   *      - temp file and a new output path (mp4 -> mkv) are the same inode -> the no-clobber link happened: unlink the
   *        temp file and the old source, finish the job as completed.
   *      - temp file exists, original missing, and an unrelated file sits at a new output path -> never overwrite it:
   *        restore the original from the bin (delete the temp file, re-queue), else mark failed.
  ```
- Why: step "notifying" is persisted after the swap (temp_path already null). Re-queuing it re-runs the executor on the new file: an in-place mkv ends as "skipped" and Radarr/Sonarr/Plex are never told; an mp4/avi/ts source is already gone, so the job fails with "source file is missing" although the conversion succeeded. The notify step makes HTTP calls, so a kill or the 15 s shutdown cap can land in it.
- Workaround in place: yes. `decideRecovery` in `src/modules/jobs/recovery.ts` implements the wording above; tests in `recovery.test.ts` and `recover.test.ts`.

### Replace sequence: a new output path must never overwrite an existing file

- File: src/contracts/jobs.ts (header comment of the replace sequence)
- Change: step 3 becomes:

  ```
   *   3. fsync(temp). Same path (mkv): rename(temp, original) atomically swaps the inode. New path (mp4 -> mkv):
   *      link(temp, output) (fails with EEXIST instead of overwriting), then unlink(temp) and unlink(original);
   *      without hard links: re-check that output does not exist, then rename. fsync(parent dir).
  ```
- Why: `rename` silently replaces a file that appeared at `<stem>.mkv` during a 20-minute encode, and that file had no recycle-bin entry. Without fsync a power cut right after the rename can leave a truncated file that recovery then treats as a completed swap.
- Workaround in place: yes. `src/modules/jobs/replace.ts`.

### Queue state cannot say "waiting for free space"

- File: src/shared/domain.ts
- Change: add `'low_disk_space'` to `QueuePauseReason` (next to the `'dry_run'` request above).
- Why: a free-space shortage is transient (the recycle bin empties after its retention period, downloads move away). Failing the job would fail every queued job within seconds and mark every media file `failed`, which "Process all needs-work" then skips. The worker now re-queues the job without counting an attempt, puts the media row back to `needs_work` and holds the queue for 15 minutes (or until settings change), but `QueueState` cannot show why nothing runs.
- Workaround in place: yes. `src/modules/jobs/worker.ts` (hold), `src/modules/jobs/freeSpace.ts` (`freeSpaceShortage` marks the error). The job's history and log say "waiting for free space: ...".

### Real pause for running children

- File: src/core/process.ts (`RunOptions`) and src/contracts/jobs.ts (`JobRunContext`)
- Change: `RunOptions.control?: { onSpawn(handle: { suspend(): void; resume(): void }): void }` (SIGSTOP/SIGCONT of the child, no-op where unsupported), and `JobRunContext.paused: { readonly current: boolean; onChange(listener: (paused: boolean) => void): () => void }` so executors can suspend their children instead of being aborted.
- Why: SPEC Resources asks for auto-pause while Plex streams and a processing window. `runProcess` gives no handle to the child, so a running ffmpeg cannot be suspended.
- Workaround in place: yes. When the window closes or Plex starts streaming, `src/modules/jobs/worker.ts` aborts running jobs and re-queues them without counting the attempt (same path as shutdown); they restart from the beginning when the gate opens. The audio executor ignores the abort once verification has passed, so a swap is never interrupted. A user pause still only holds new jobs.

### The user's queue pause is not persisted

- File: src/shared/settings.ts
- Change: add `processing.paused: boolean` (default false); `POST /api/v1/queue/pause|resume` set it through `ctx.settings.update`.
- Why: the pause must survive restarts and container updates; jobs may not write the `settings` table.
- Workaround in place: yes. `src/modules/jobs/worker.ts` keeps a marker file `<configDir>/queue-paused` and restores the pause on start. It is not part of settings backups.

### Scanners must skip Wololo temp files

- File: src/shared/settings.ts (`DEFAULT_SETTINGS.media.ignorePatterns`)
- Change: add `'**/*.wololo-tmp.*'` and `'**/.wololo-tmp-*/**'`.
- Why: an audio temp file is a plain `<stem>.wololo-tmp.mkv` next to the movie for the whole encode. A user-edited pattern list should keep these defaults visible.
- Workaround in place: partly. The audio executor refuses a source whose name carries `TEMP_FILE_MARKER`; orphaned temp entries are swept by `jobs.recover()` (library root level) and `jobs.housekeeping()` (recursive). I could not verify the scanner's own filtering (probe-scan is not merged).

### Recycle-bin preflight

- File: src/contracts/jobs.ts (`RecycleBinService`)
- Change: `checkLocation(path: string): Promise<void>`: resolves and creates the bin for path, throws `AppError('precondition_failed')` when it is not writable or on another filesystem.
- Why: the bin location was first checked at step "replacing", after up to 20 minutes of encoding and verification. bdmv needs the same check before it extracts a disc.
- Workaround in place: yes. `src/modules/recycle-bin/checkRecycleBinLocation.ts`, called by the audio executor in step "preparing" and by `recycleForReplace`.

### Platform integration test for the real acceptance case

- File: test/integration/ (platform)
- Change: after the merge, run the jobs acceptance case (5.1 DTS -> one AC3 5.1 640 kbps track, bit-identical video, duration within 100 ms) with the real `rules.plan` and `ffmpeg.buildAudioConversionArgs` instead of the test doubles in `src/modules/jobs/test-support.ts`.
- Why: the jobs tests prove the pipeline (verify, replace, recover) but the 640 kbps / 5.1 result comes from the doubles.
- Workaround in place: no.
