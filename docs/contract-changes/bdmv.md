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

### CI must run the BDMV end-to-end test instead of skipping it

- File: .github/workflows/ci.yml (platform)
- Change: install tsMuxeR next to ffmpeg, mkvtoolnix and 7zip (no Debian/Ubuntu package: download the static Linux
  build from the justdan96/tsMuxer GitHub releases, pinned version, to /usr/local/bin/tsMuxeR) and set
  `WOLOLO_REQUIRE_BDMV_E2E: '1'` on the `bun test` step. Ubuntu's ffmpeg is built with libbluray (bluray protocol).
- Why: `src/modules/bdmv/bdmv.e2e.test.ts` is the acceptance proof for Feature 2 (language tags from the MPLS,
  chapters, bit-identical video). Without tsMuxeR it skips and CI stays green without ever running it. With the
  variable set, a missing tool or a disc authored without PGS subtitles fails the run instead of skipping.
- Workaround in place: yes. The variable is opt-in so CI keeps passing until tsMuxeR is installed; set it in the same
  change that installs tsMuxeR.

### BdmvDiscInfo should expose unreadable playlists

- File: src/shared/api-types.ts (`BdmvDiscInfo`)
- Change: add

  ```ts
  /** "<file>: <error>" for every MPLS that could not be parsed; the main title may be among them. */
  parseErrors: string[];
  /** Non-fatal problems, e.g. a CLPI that could not be parsed for the language fallback. */
  warnings: string[];
  ```
- Why: an unreadable playlist could be the real feature. `evaluate` now raises a `main_title` decision naming the
  unreadable files, but the disc page (`GET /api/v1/bdmv/discs/:id`) cannot show which files failed.
- Workaround in place: yes. `DiscAnalysis.parseErrors` / `warnings` are logged (warn) on every evaluation and quoted
  in the decision message and evaluation reason.

### Document that a failed Radarr import does not fail a bdmv job

- File: src/contracts/bdmv.ts (doc comment of `BdmvService.execute`)
- Change: append "importing is best effort: when arr.addMovie / arr.importMovieFolder fails, the job still completes
  (the MKV is in place and verified), writes a history entry `failed` with `data.error`, and calls
  arr.rescan({ kind: 'radarr', itemId: movieId }) when the movie id is known; the outcome message carries the error.
  A blocked rules plan for an extra skips that extra (noted in the message); for an edition it fails the job."
- Why: failing the job after the output is placed would leave an orphan that blocks every retry ("output already
  exists"); the current contract is silent on both cases.
- Workaround in place: yes, implemented as described in `src/modules/bdmv/execute.ts`.

### Encode every failing audio track of a title in one ffmpeg pass

- File: src/contracts/rules-ffmpeg.ts (`FfmpegService.buildAudioConversionArgs` / `AudioConversionInput`)
- Change: accept several planned streams with one output path each, e.g.
  `outputs?: { stream: PlannedStream; outputPath: string }[]` (one `-map 0:N -c:a ... <path>` group per entry after a
  single `-i`), so one demux of the playlist feeds every side file.
- Why: the executor now starts one ffmpeg per encoded track over `bluray:<disc>`, and each reads the whole 30-50 GB
  playlist. A disc with five DTS-HD tracks is read five times for encoding alone, which costs tens of minutes per title
  on a Raspberry Pi with a USB disk.
- Workaround in place: no (one ffmpeg per track, correct but slow). Building the combined command locally would mean
  parsing another module's argument list.

### TorrentInfo paths: local or download-client paths?

- File: src/shared/domain.ts (`TorrentInfo.savePath` / `contentPath` doc) and src/contracts/integrations.ts
- Change: document "contentPath and savePath are as qBittorrent reports them (remote); map them with
  pathMappings.toLocal('qbittorrent', ...)" (or the opposite, if integrations maps them already).
- Why: `bdmv.deleteSource` deletes the torrent with its files only when the torrent's content is the disc or lies
  inside it, and refuses when the torrent holds more (a multi-disc pack). It must compare local paths.
- Workaround in place: yes. bdmv always applies `pathMappings.toLocal('qbittorrent', contentPath)`, which leaves an
  already-local path unchanged.

### Contract docs for detect, deleteSource and the free-space numbers

- File: src/contracts/bdmv.ts and src/shared/domain.ts
- Change:
  - `BdmvService.detect`: "... or an .iso whose 7z listing contains BDMV/index.bdmv (an .iso that 7z cannot list is
    still reported, so evaluate shows the 7z error)".
  - `BdmvService.deleteSource`: "Refuses unless the latest completed bdmv job has an output_path that is a non-empty
    file outside the source. Deletes the torrent with its files only when its content path is the disc or inside it,
    and refuses when the torrent holds more than the disc."
  - `BdmvJobPlan.estimatedOutputBytes` / `extractBytes`: "sum over the titles; a clip shared by two titles counts for
    each, because every title is extracted and muxed into its own file."
  - `BdmvService.evaluate`: "an output path inside the source disc folder fails the evaluation (the source must stay
    untouched and deleteSource would remove the output with it)".
- Why: these are the behaviours the review asked for; the contract text still says "any .iso" and nothing about the
  output checks.
- Workaround in place: yes, implemented in `src/modules/bdmv/{index,planner,disc}.ts`.
