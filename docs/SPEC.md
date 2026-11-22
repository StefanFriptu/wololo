# Project Wololo: requirements

> Plain-text export of the requirements doc. Tables are flattened: each table lists its header cells first (one per line), then each row's cells in the same order.

Project Wololo (working name, after the Age of Empires II monks who convert units) is a self-hosted arr-stack app that rewrites imported media so every TV in the household can play it directly, without Plex transcoding on a Raspberry Pi.

## Goals and scope
v1 ships two features: automatic audio conversion to a codec every TV decodes, and lossless BDMV-to-MKV conversion. Both run without anyone touching a file.
Why it exists. Samsung Tizen TVs reject DTS and, in practice, E-AC3. Plex then converts the audio on the fly, which is fragile over a remote connection and on a Raspberry Pi 4 server. Fixing the file once, at import time, removes the problem for every later play.
Goals

Every file in the library direct-plays on the target devices (audio and container).

No manual steps after a download: the import triggers processing, and Radarr, Sonarr and Plex see the new file.

Smallest possible quality loss: copy everything that does not need changing, convert only what fails the device profile.

Never lose a file: the original is replaced only after the new one passes verification.

Runs well on a Raspberry Pi 4 (arm64, 4-8 GB RAM, USB disks) and ships as one Docker image.
Out of scope for v1

Video re-encoding as a default (the Pi has no usable hardware encoder). Allowed only as an opt-in rule.

Decrypting copy-protected discs (AACS/BD+). Input must already be a decrypted BDMV folder or ISO.

Multiple worker nodes, GPU scheduling, cloud storage.

Media servers other than Plex (Jellyfin is a v2 candidate: same refresh call shape).

## Existing tools
Unmanic is the closest free option; the owner chose to build Wololo instead. None of these tools combines arr-native triggers, BDMV handling and device-profile rules in one place, which is Wololo's gap. Licensing details are from memory as of 2026 and approximate.
Tool
License / cost
Audio rules
BDMV to MKV
Arr integration
Fit for this setup
Unmanic
Open source (GPL-3.0), free
Yes, via plugins
No
Library watch, no import hooks
Closest match; plugin quality varies
Tdarr
Closed source; free tier, paid Pro adds features
Yes, via plugins and flows
No
Library watch
Powerful, heavy on a Pi, complex UI
FileFlows
Free tier, paid tiers
Yes, visual flows
No
Library watch
Flexible, flow editor is a learning curve
MakeMKV
Free while in beta
No
Yes, including encrypted discs
None
Best ripper; manual, no automation
HandBrake
Open source, free
Re-encodes everything
Partial
Watch folder only
Built for video re-encoding, not lossless remux
ffmpeg + cron script
Free
Yes
Partial (drops disc language tags)
None
What we would do today; no UI, no history
Gaps Wololo fills: triggers on Radarr/Sonarr import events, rules defined per target device instead of per codec, correct BDMV metadata (languages, chapters), and the rescan of Radarr, Sonarr and Plex after each change.

## How it fits the stack
Wololo sits between the Radarr/Sonarr import and Plex, and tells both sides when a file changes.

qBittorrent finishes a download; Radarr or Sonarr imports it into /data/media (hardlink).

The arr app calls Wololo's webhook (Settings -> Connect -> Webhook, events On Import and On Upgrade).

Wololo probes the file and checks it against the active device profile. If it passes, it is marked done and nothing is written.

If it fails, a job joins the queue. ffmpeg writes the new file to a temp path in the same folder.

Wololo verifies the output, then atomically renames it over the original.

Wololo asks the arr app to rescan that movie or series, so its media info and file size stay correct.

Wololo asks Plex for a partial scan of that folder only.
Catch-all scan. A scheduled library scan (default every 6 hours) runs steps 3-7 for files that arrived without a webhook, such as a manual copy or a BDMV folder dropped into a watch path.
Integrations (v1)

Radarr and Sonarr: inbound webhook, outbound API (RescanMovie, RescanSeries, root folders, path mappings).

Plex: partial scan of one path via the server API, server picked from plex.tv sign-in.

qBittorrent (optional): see whether the source torrent is still seeding, and remove it once its ratio or time goal is met.

Path mapping between containers (/vault/media on the host vs /data/media in Plex), as Radarr does.

## Feature 1: audio transcoding
Any audio track the device profile cannot decode is converted to AC3, at 640 kbps for 5.1 sources. Video, subtitles, chapters and compatible audio tracks are copied untouched.
Trigger codecs (the "Basic" capability template, which matches Samsung Tizen TVs)
Source codec (ffprobe name)
Default action
Why
DTS, DTS-HD MA, DTS:X (dts)
Convert
Tizen dropped DTS decoding
Dolby TrueHD, incl. Atmos (truehd)
Convert
Not decoded by TVs; bitstream only via AV receiver
E-AC3 / DD+, incl. Atmos JOC (eac3)
Convert
Fails on the household's Tizen models (observed)
LPCM (pcm_*)
Convert
Unreliable in MKV on TVs, very large
FLAC (flac)
Convert (toggle)
Support varies by Tizen year
Opus, Vorbis (opus, vorbis)
Convert (toggle)
Support varies by model
AC3 (ac3), AAC (aac), MP3 (mp3)
Copy
Decoded natively
A profile is a named list of codecs the device decodes plus a target codec. Users can clone the default and edit it per device; Wololo converts whatever is outside the strictest profile assigned to the library.
Target rules
Source layout
Target
Bitrate
7.1 or more
AC3 5.1, standard downmix (back and side channels merged)
640 kbps
5.1 / 5.0
AC3 5.1 / 5.0
640 kbps
Stereo
AC3 2.0
448 kbps
Mono
AC3 1.0
192 kbps
640 kbps is AC3's ceiling and the rate Blu-rays use for their own AC3 tracks. Target codec is configurable per profile: AC3 (default), E-AC3, AAC.
Rules that keep loss minimal

Skip conversion when the file already has a compatible track in the same language with at least as many channels (many Blu-rays ship TrueHD plus AC3): drop or demote the incompatible one instead.

Decode from the best source available: the full lossless stream (DTS-HD MA, TrueHD), never the lossy DTS core.

No loudness normalisation, no dynamic range compression, no resampling (48 kHz in, 48 kHz out).

Already-compatible tracks are never re-encoded.
Track handling

Mode per library: Replace (default) keeps only the converted track; Keep both puts the converted track first and marks it default.

Language filter: keep audio and subtitle tracks only in listed languages plus the original language; never remove the last audio track.

Set the default flag on the original-language track; keep track titles and language tags.

Record lost features in the job history ("Atmos height channels dropped", "7.1 downmixed to 5.1").
Acceptance

A 5.1 DTS-HD MA movie ends up with one AC3 5.1 640 kbps track, bit-identical video, same duration within 100 ms.

A file with TrueHD plus AC3 in the same language is remuxed without any audio encoding.

A Tizen TV direct-plays the result (Plex dashboard shows Direct Play for audio and video).

## Feature 2: BDMV to MKV
A decrypted Blu-ray folder or ISO becomes one MKV with the main feature, its language tags and its chapters, with no video re-encoding. Audio goes through Feature 1's rules in the same pass, so the file is written once.
Input

A BDMV folder (with PLAYLIST, CLIPINF, STREAM) or a Blu-ray .iso, found in a watch path or the Radarr download folder.

Encrypted discs are rejected with a clear message ("decrypt with MakeMKV first").
Main title detection

Read every .mpls playlist; drop duplicates that reference the same clips; pick the longest.

Follow multi-clip playlists (feature split across several .m2ts files) and seamless branching.

Two candidates within 5% of each other (theatrical vs extended cut) -> ask in the UI, or export both as Plex editions: Title (Year) {edition-Extended}.mkv.

Optional: export extras longer than N minutes (default 2) into Featurettes/, which Plex shows as extras.
Metadata kept (the gap plain ffmpeg leaves)

Audio and subtitle languages from the playlist's stream table. Example: Jamón Jamón's disc tags audio spa and subtitles eng, but ffmpeg wrote the subtitle as untagged.

Chapters from the playlist marks.

Forced-subtitle flags and track order.

Proposed engine: mkvmerge reads .mpls directly and keeps languages and chapters; ffmpeg only encodes the audio tracks that need it.
Video

Default: copy (H.264, HEVC, VC-1, MPEG-2), bit-identical.

UHD discs: HDR10 copied as-is. Dual-layer Dolby Vision (profile 7) -> option per profile: keep, convert to profile 8.1, or drop to HDR10 (Samsung TVs do not support Dolby Vision).

3D (MVC) discs -> 2D base view only.

Opt-in re-encode rule (for example VC-1 or MPEG-2 to H.264) only where a device cannot play the source codec. Off by default on a Pi.
Output and hand-off

Identify the movie through Radarr's lookup (folder name -> TMDB). Ask in the UI when the match score is low.

Write Title (Year)/Title (Year).mkv into the Radarr root folder, then trigger Radarr's import so Radarr owns the file.

Leave the source folder alone while it seeds; offer to delete it when the qBittorrent seeding goal is met.

Needs free space equal to the feature size on the target disk; check before starting.
Acceptance

Jamón Jamón's BDMV becomes one MKV of 1h 35m 06s: video bit-identical, audio spa, subtitle eng, chapters present, matched in Plex without a manual fix.

## More features worth adding
Picture-subtitle OCR is the most valuable addition: Tizen cannot draw Blu-ray PGS subtitles, so Plex burns them into the video, which a Pi cannot do at 1080p. Ranked by value for this setup:
Feature
What it does
Value here
Effort
Release
PGS/VobSub to SRT
OCR picture subtitles into text (Tesseract), keep the PGS as a fallback track
High: removes video transcodes away from home
Medium
v1.1
Library dry run
Report how many files fail each profile, with estimated time and disk space, before processing anything
High: needed for first run on 7 TB
Low
v1
Track cleanup
Drop audio/subtitle languages outside a keep-list; fix missing language tags
High: saves space, cleaner menus
Low
v1
Plex playback insights
Read Plex play history; list files that were transcoded and why; queue them first
High: finds the real problem files
Medium
v1.1
Recycle bin
Keep replaced originals for N days (default 7) before deleting
High: undo for a bad rule
Low
v1
Seeding-aware cleanup
Remove the torrent and its files from qBittorrent once its ratio or time goal is met
Medium: a replaced file no longer shares space with the torrent, so each title takes twice the space until then
Medium
v1.1
Container normalisation
MP4, AVI, TS, M2TS to MKV; fix broken timestamps
Medium
Low
v1.1
Integrity check
Full decode test; on failure ask Radarr/Sonarr to blocklist and search again
Medium: catches corrupt downloads early
Low
v1.1
Dolby Vision profile 5 alert
Flag files with no HDR10 fallback (wrong colours on Samsung) and trigger a new search
Medium
Low
v1.1
Notifications
ntfy, Discord, Telegram on failure or daily summary
Low
Low
v1.1
Jellyfin support
Same scan hand-off for Jellyfin (already running on the Pi)
Low today
Low
v2
Remote workers
Send jobs to a faster machine on the LAN
Low for audio-only work
High
v2

## UI, packaging and non-functional requirements
The UI follows the arr layout people already know, the image follows LinuxServer.io conventions, and no file is ever replaced without passing verification.
UI (arr-style, modern)

Left sidebar like Radarr: Library, Activity (Queue, History), Profiles, Settings (Media, Connect, Plex, Download clients, General), System (Status, Tasks, Logs, Backup).

Guided setup: a fresh install opens an 8-step setup (Welcome, Players, Media folders, Sonarr/Radarr, Plex and qBittorrent optional, New imports, Check everything) that tests each part as it goes and saves progress in `settings.setup`. Wololo adds its own webhook in Sonarr/Radarr (opt-out), matches path mappings against a real file and confirms the test event arrives. Existing installs get a banner, never a forced wizard.

Library view: every file with a status (Compatible, Needs work, Processing, Failed, Ignored) and filters by codec, profile and library.

File detail: streams before and after, side by side, with what changed and what was lost.

Live progress over a push channel (speed, ETA, current step); the full ffmpeg/mkvmerge log per job.

Light and dark theme, usable on a phone.

REST API with an OpenAPI description and API-key auth; the same key secures the inbound webhook.
Packaging

One multi-arch Docker image (amd64, arm64) on GHCR, with ffmpeg (built with libbluray), mkvtoolnix and, from v1.1, Tesseract.

LinuxServer conventions: PUID, PGID, TZ, UMASK; /config for the SQLite database and settings; media mounted at the same path the arr apps use (/data) so renames stay atomic.

One web port, a /health endpoint, a Compose example in the README, settings backup and restore from the UI.
Safety

Write to a temp file in the same folder; verify before replacing: duration within 100 ms, expected stream count, video stream checksum unchanged, full decode of new audio tracks.

Replace with an atomic rename; keep owner and permissions; move the original to the recycle bin.

Check free space (output size + 5%) before starting.

On startup: delete stale temp files and re-queue interrupted jobs.

Never process the same file twice: track path, size, modified time and profile version; a profile edit re-checks only the files it affects.
Resources (Raspberry Pi 4 baseline)

Idle memory under 150 MB; one job at a time by default; jobs run at low CPU and disk priority.

Optional processing window (for example 01:00-08:00) and auto-pause while Plex is streaming.

Target: a 2-hour 5.1 DTS-HD MA movie converted in under 20 minutes on a Pi 4 with USB disks (to verify; the Jamón Jamón remux ran at 7.7x real time).

## Decisions for v1
These are the defaults to build against; the owner can still overturn any of them. Build, do not adopt an existing tool (owner's call, 2026-11-15).
Decision
v1 default
Name
Project Wololo (working name)
Backend
TypeScript on Bun, Hono HTTP server, SQLite via bun:sqlite + Drizzle
Frontend
SvelteKit static SPA, served by the backend on one port
Default device profile
None. New installs start with no profile; capability templates (Basic, Dolby, Lossless, Everything, Blank) are named after formats, never devices. Basic matches Feature 1's trigger table
5.1 / stereo target
AC3 640 kbps / AC3 448 kbps
Original track
Replace; "Keep both" is a per-library toggle
Image
ghcr.io/<owner>/wololo, amd64 + arm64
License
GPL-3.0, same as Radarr and Sonarr
Still open (owner)

Final name, checked on GitHub and Docker Hub.

Samsung model years in Romania: decides FLAC, Opus and E-AC3 defaults.

Confirm the license.

## Build plan for agents
Build in six milestones, in order. Each one ends with its checks passing and a Docker image that runs on the Pi. Stop for owner review after M1 (dry-run report) and before the first write to the real library.

M0 Skeleton. Repo, Bun + Hono API, SvelteKit SPA, SQLite migrations, settings, API key auth, /health, multi-arch Dockerfile, CI that builds amd64 and arm64.

Done when: the image runs on the Pi, the UI loads, /health returns 200.

M1 Probe, profiles, dry run. ffprobe -show_streams -show_format -of json into a typed stream model; profile CRUD with capability templates; scan of configured roots; dry-run report.

Done when: a dry run over the owner's library lists files per failing codec with estimated time and space, and writes nothing.

M2 Audio jobs. Queue, rules engine and ffmpeg command builder as pure functions, temp write, verification, atomic replace, recycle bin, crash recovery.

Done when: every synthetic fixture passes; one real movie, converted on a copy, direct-plays on a Tizen TV.

M3 Integrations. Radarr/Sonarr webhooks, rescan commands, Plex partial scan, path mapping.

Done when: a Radarr import is converted and Plex shows the new streams with no manual step.

M4 BDMV. MPLS parser, main-title pick, mkvmerge from the playlist, audio rules in the same pass, Radarr import.

Done when: Feature 2's Jamón Jamón acceptance passes.

M5 UI. Library status views, before/after streams, live progress, job logs, history.
Interfaces
System
Call
Notes
Plex
GET /library/sections/{key}/refresh?path=<path in Plex> with X-Plex-Token
Tested on the owner's server 2026-11-15; find key by matching the section's Location path from GET /library/sections
Radarr
Webhook event Download (isUpgrade flag); POST /api/v3/command {"name":"RescanMovie","movieId":N}
Check field names against the current Radarr API docs
Sonarr
Webhook event Download; POST /api/v3/command {"name":"RescanSeries","seriesId":N}
Same check
qBittorrent
Web API v2: torrent list, ratio, seeding time, delete with files
v1.1 only
Testing

Rules engine and command builder are pure functions with table tests per codec and channel layout.

Fixtures are generated in CI with ffmpeg lavfi sources and the ac3, eac3, dca, truehd and flac encoders (dca and truehd need -strict -2). No copyrighted media in the repo.

ffmpeg cannot encode DTS-HD MA; test that path manually on a real file.

BDMV fixture: author a 30-second disc with tsMuxeR in CI.
