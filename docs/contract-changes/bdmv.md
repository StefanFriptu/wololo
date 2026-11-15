# Contract change requests: bdmv

Only the `bdmv` module edits this file. The integrator applies accepted entries after the parallel phase.
Work around a missing contract locally until then.

Entry format:

```
### <short title>
- File: src/contracts/jobs.ts (or schema, api-types, ...)
- Change: exact proposed signature / column / type
- Why: what breaks or is impossible without it
- Workaround in place: yes/no, where
```

### MkvmergeOutputTrack needs the source codec (TrueHD and its AC-3 core share one PID)

- File: src/contracts/bdmv.ts
- Change: add to `MkvmergeOutputTrack`:

  ```ts
  /** ffprobe codec of the source stream; picks between mkvmerge tracks that share a PID (TrueHD + embedded AC-3 core). Null for side files. */
  codec?: string | null;
  ```
- Why: for an HDMV TrueHD PID, `mkvmerge -J` reports two tracks with the same `properties.number` (TrueHD and its
  AC-3 core, mkvtoolnix `r_mpeg_ts.cpp` coupled tracks), and ffprobe also exposes both streams with the same PID. With
  only `pid`, `buildMkvmergeArgs` cannot tell whether the plan kept the TrueHD track or the AC-3 core.
- Workaround in place: yes. `src/modules/bdmv/mkvmerge.ts` exports `MkvmergeTrackRequest extends MkvmergeOutputTrack`
  with the optional `codec`, and `buildMkvmergeArgs` accepts it (it still satisfies `BuildMkvmergeArgs`).

### Document how BdmvEvaluation reports "waiting for a decision" and "blocked"

- File: src/contracts/bdmv.ts (doc comment of `BdmvEvaluation` / `BdmvService.evaluate`)
- Change: add to the doc comment:

  ```
  status needs_work + plan null + decisionId set: a main_title or movie_match decision is pending; checkPath returns
  CheckAction "decision_required" and does not enqueue. status failed + plan set: the rules plan is "blocked" (reason
  "blocked: ..."); the plan is kept for the UI. status ignored: BDMV disabled globally or for the library.
  ```
- Why: probe-scan maps the evaluation in `media.checkPath`; without this it may try to enqueue a null plan.
- Workaround in place: no (behaviour implemented as described in `src/modules/bdmv/planner.ts`).

### VerifyRequest.decodeAudioStreams: absolute output stream indexes

- File: src/contracts/jobs.ts (doc comment of `VerifyRequest.decodeAudioStreams`)
- Change: "Absolute output stream indexes (ffprobe `index` of the output file) of audio streams to decode fully."
- Why: "output audio stream indexes" can be read as audio-relative (`0:a:N`) or absolute (`0:N`). The bdmv executor
  passes absolute indexes (position in the mkvmerge track order).
- Workaround in place: no.

### jobs worker must persist JobOutcome.outputPath on the jobs row

- File: src/contracts/jobs.ts (doc comment of `JobOutcome.outputPath`)
- Change: "Stored as jobs.output_path when the job completes."
- Why: `bdmv.evaluate` reports a converted disc as `compatible`, reason "converted to <jobs.output_path>" from the
  latest completed bdmv job, and `offerSourceDeletion` quotes it.
- Workaround in place: falls back to "converted to MKV" when the column is null.

### BDMV side-file timestamps: buildAudioConversionArgs must not shift the side file

- File: src/contracts/rules-ffmpeg.ts (doc comment of `AudioConversionInput.inputOptions`)
- Change: "With inputOptions (BDMV side file) the output starts at 0 (no -copyts, no -itsoffset); the caller applies the
  audio/video offset with mkvmerge --sync."
- Why: `MkvmergeOutputTrack.delayMs` (audio start - video start) is applied with `--sync`; if the side file kept the
  original offset the delay would be applied twice. The CI end-to-end test (`src/modules/bdmv/bdmv.e2e.test.ts`) checks
  that a converted and a copied track start within 50 ms of each other.
- Workaround in place: no.
