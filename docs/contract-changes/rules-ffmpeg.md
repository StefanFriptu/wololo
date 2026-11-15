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
