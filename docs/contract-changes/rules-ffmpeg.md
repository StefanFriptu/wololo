# Contract change requests: rules-ffmpeg

Only the `rules-ffmpeg` module edits this file. The integrator applies accepted entries after the parallel phase.
Work around a missing contract locally until then.

Entry format:

```
### <short title>
- File: src/contracts/jobs.ts (or schema, api-types, ...)
- Change: exact proposed signature / column / type
- Why: what breaks or is impossible without it
- Workaround in place: yes/no, where
```

### Document DroppedStream.reason and keep-both stream mapping

- File: src/shared/domain.ts (comments only)
- Change: on `DroppedStream.reason`:
  `/** incompatible_replaced: Replace mode, the source track was encoded in place (its encoded copy is in streams with the same sourceIndex). compatible_duplicate: an incompatible track dropped because a compatible track in the same language with >= target channels exists. language_filter: keep-list. unsupported: data streams Matroska cannot hold (dropped only when the file is written anyway; never a reason to write). */`
  and on `ConversionPlan.streams`: `/** Output streams in output order. In keep_both mode a converted source appears twice (encode first, copy after), so the output stream count is streams.length, not probe streams minus dropped. */`
- Why: jobs verification ("expected stream count") and web-ui ("what changed") must read the plan the same way; with keep_both a sourceIndex repeats and a replaced original is listed in `dropped`.
- Workaround in place: no code workaround needed; behaviour is covered by src/modules/rules/engine.test.ts.

### Document the original-language fallback

- File: src/contracts/rules-ffmpeg.ts (`RulesInput.originalLanguage` comment)
- Change: `/** ... when null the engine falls back to the first default audio track's language, then to the first tagged audio track. */`
- Why: files whose default track is untagged still get a usable original language for the default flag and `fillMissingLanguage: 'original'`.
- Workaround in place: yes, implemented in `fallbackOriginalLanguage` (src/modules/rules/engine.ts).

### Update the buildAudioConversionArgs example

- File: src/contracts/rules-ffmpeg.ts (`BuildAudioConversionArgs` comment)
- Change: replace `"-disposition:a:0", "default"` with `"-disposition:a:0", "+default"` and add:
  `Decoder options before -i: "-core_only 0" when a dts track is encoded (full DTS-HD MA, never the core), "-drc_scale 0" when ac3/eac3 is decoded (no dynamic range compression). Output format from the extension (.mp4/.m4v -> mp4, else matroska); ".mka" side files get "-map_chapters -1" so mkvmerge does not merge chapters twice. Encoded tracks get stale mkvmerge statistics tags (BPS, NUMBER_OF_BYTES, ...) cleared.`
- Why: `"default"` would overwrite every other disposition flag (commentary, visual/hearing impaired); `+default`/`-default` only toggles the default flag. bdmv relies on the `.mka` chapter behaviour.
- Workaround in place: yes, implemented in src/modules/ffmpeg/args.ts; verified with real ffmpeg in args.fixtures.test.ts.

### Note the ac3/eac3 output layout name

- File: src/shared/domain.ts (`AudioEncodeSpec.channelLayout` comment)
- Change: `/** Output layout: the source layout when channels are kept, else "5.1" / "stereo" / "mono" for the downmix target. ffmpeg's ac3/eac3 encoders label 6 channels "5.1(side)" and 5 channels "5.0(side)" in the written file. */`
- Why: jobs/web-ui must not compare the plan's layout string with the output probe literally.
- Workaround in place: no.

### Document when a compatible track counts as a duplicate

- File: src/contracts/rules-ffmpeg.ts (`PlanConversion` comment, first bullet)
- Change: `- skip conversion when a compatible track of the same programme exists: same tagged language (sameLanguage, so untagged tracks never match; fillMissingLanguage tags them first), >= target channels, neither title names a role (commentary, description, descriptive, narration, karaoke, isolated, score, trivia, DVS) and durations within max(5 s, 2 %) when both are known (drop/demote the incompatible one); otherwise encode,`
  and on the default-flag bullet: `- default flag on the original-language track, never on a role-titled track (commentary, description, ...) while another playable track exists,`
- Why: untagged scene releases and Blu-rays with a compatible commentary or audio-description track lost their main audio in Replace mode.
- Workaround in place: yes, implemented in `samePresentation` and `chooseDefaultAudio` (src/modules/rules/engine.ts), table-tested in engine.test.ts.

### Keep both: "converted track first" means first audio stream

- File: src/contracts/rules-ffmpeg.ts (`PlanConversion` comment) and src/shared/domain.ts (`ConversionPlan.streams` comment)
- Change: `- Replace (only converted track) vs KeepBoth (each converted track is written before its original; the default converted track moves to the first audio position, every other audio stream keeps source order),`
- Why: players that ignore the default flag play the first audio stream; with several languages the default converted track was not first.
- Workaround in place: yes, `leadAudioWith` in src/modules/rules/engine.ts; verified with real ffmpeg in args.fixtures.test.ts.

### Profiles without a common audio target codec block the plan

- File: src/contracts/rules-ffmpeg.ts (`ResolveEffectiveProfile` and `PlanConversion` comments)
- Change: on `ResolveEffectiveProfile`: `... first profile's target codec when it is allowed by all, else the first of the profiles' targets then ac3/eac3/aac allowed by all; when none is, the first profile's target is kept and planConversion blocks.`
  On `PlanConversion`: `- an encode whose target codec is not in profile.audio.allowedCodecs (assigned profiles share no target) -> action "blocked" with reason "assigned profiles share no audio target codec (<codec> is not allowed by all)"; files needing no encode still skip or remux.`
  Optional (libraries module): reject a profile assignment whose resolved target codec is not in its resolved allowed list with AppError('unprocessable').
- Why: two valid profiles with disjoint audio lists produced an effective target outside the allowed list, so already-compatible tracks were re-encoded on every scan (generation loss loop).
- Workaround in place: yes, in `planConversion` (src/modules/rules/engine.ts), tested in engine.test.ts.

### buildAudioConversionArgs output path guards and the temp-file precondition

- File: src/contracts/rules-ffmpeg.ts (`AudioConversionInput.outputPath` / `BuildAudioConversionArgs` comments), src/contracts/jobs.ts (executor note)
- Change: on `BuildAudioConversionArgs`: `Throws when outputPath equals inputPath (after path normalisation) or starts with "-" (ffmpeg would read it as an option).`
  On `AudioConversionInput.outputPath`: `Must not exist when ffmpeg starts: the caller lstat()s it and unlinks a leftover file or symlink first. The argv carries -y, and ffmpeg's in-place guard only compares names, so a symlink or hardlink to the input at this path truncates the original.`
- Why: verified by a reviewer with ffmpeg: `-y ... link.mkv` where link.mkv is a symlink to the input truncates the source. The pure builder cannot lstat; only the executor can guarantee a fresh file. `-y` stays because the frozen contract example includes it; dropping it is the integrator's call.
- Workaround in place: partly, the builder throws on identical or dash-prefixed paths (src/modules/ffmpeg/args.ts); the lstat/unlink step belongs to the jobs executor.
