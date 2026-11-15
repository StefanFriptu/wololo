# Contract change requests: probe-scan

Only the `probe-scan` module edits this file. The integrator applies accepted entries after the parallel phase.
Work around a missing contract locally until then.

Entry format:

```
### <short title>
- File: src/contracts/jobs.ts (or schema, api-types, ...)
- Change: exact proposed signature / column / type
- Why: what breaks or is impossible without it
- Workaround in place: yes/no, where
```

### Blocked plans have no media status of their own

- File: src/shared/domain.ts (MEDIA_FILE_STATUSES), src/contracts/probe-scan.ts (MediaService.checkPath doc)
- Change: either add `'blocked'` to `MEDIA_FILE_STATUSES` (and `byStatus`), or document the mapping used now:
  plan action `blocked` -> `status: 'failed'`, `planAction: 'blocked'`, `statusReason: 'blocked: <reasons>'`.
- Why: a blocked file needs work that cannot be done automatically. Storing it as `needs_work` would make
  "Process all needs-work" (`jobs.enqueueMany` with `status: 'needs_work'`) and the scan backlog queue jobs that can only fail.
  `DryRunReport.totals.blocked` and `CheckAction 'blocked'` already exist; only the stored status is missing.
- Workaround in place: yes, `statusFromPlan` in src/modules/scan/evaluation.ts; dry-run totals count `failed` + `blocked` rows as blocked.

### Backlog and enqueueMany carry no BdmvJobPlan for disc rows

- File: src/contracts/jobs.ts (`JobsService.enqueueMany` doc)
- Change (doc only): replace "disc rows (kind bdmv|iso) are enqueued with their evaluated plan" with "disc rows (kind
  bdmv|iso) are enqueued without a BdmvJobPlan; bdmv.execute re-analyzes the disc in preparing". No schema change.
- Why: `media.checkPath` passes the `BdmvJobPlan` from `bdmv.evaluate` as `NewJob.bdmvPlan` when it queues a disc
  directly, but `media_files.plan` only holds the disc's audio plan (with `estimatedOutputBytes` taken from the
  BdmvJobPlan), so the scan backlog and `enqueueMany` have no full plan to hand over. bdmv.execute re-analyzes anyway.
- Workaround in place: yes, the scan backlog enqueues disc rows with `type: 'bdmv'` and no plan.

### Recycle-bin path should be validated as absolute

- File: src/shared/settings.ts (settings schema, `recycleBin.path`)
- Change: `z.string().min(1).refine(isAbsolute, 'must be an absolute path').nullable()`.
- Why: a relative path has no defined base. The scanner skips the recycle bin by path, so it has to resolve it.
- Workaround in place: yes, `skipPathsFor` in src/modules/scan/eligibility.ts resolves and normalises the path
  (trailing slash, `..`) before the walker and `media.checkPath` compare against it.

### Clarify ClassifyEntry childNames and NeedsRecheck for processing rows

- File: src/contracts/probe-scan.ts
- Change (doc only):
  - `ClassifyEntry`: "childNames are the folder's entries plus `BDMV/<name>` for each entry of a BDMV subfolder; a disc root
    is recognised by `BDMV/index.bdmv` (case-insensitive). Files: `.iso` -> iso, anything else -> file (the scanner filters
    extensions first). A folder named BDMV itself -> null."
  - `NeedsRecheck`: "Rows with status `processing` are treated like `ignored` (only when force): a running job owns the file."
- Why: the current wording does not say how nested `BDMV/index.bdmv` reaches a pure function that only gets child names.
- Workaround in place: yes, implemented as described in src/modules/scan/change-detection.ts.

### ScanStats.probeErrors counts every per-file evaluation failure

- File: src/shared/events.ts (ScanStats)
- Change: rename to `errors` or document "files whose evaluation failed (ffprobe error, missing file, bdmv.evaluate error,
  queue error)".
- Why: disc rows are never probed by ffprobe, but their evaluation can fail the same way and the UI needs the count.
- Workaround in place: yes, counted under `probeErrors`.

### Shared rules-engine fake for module tests

- File: test/helpers/ (new `rules.ts`)
- Change: move `fakeRules`, `fakeJobs` and `TEST_DEFINITION` from src/modules/scan/test-fakes.ts into test/helpers so other modules
  can use them, then delete the module-local copy.
- Why: until rules-ffmpeg lands, any test that calls `media.checkPath` needs a stand-in planner.
- Workaround in place: yes, src/modules/scan/test-fakes.ts (only imported by tests).
