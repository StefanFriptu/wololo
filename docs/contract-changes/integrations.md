# Contract change requests: integrations

Only the `integrations` module edits this file. The integrator applies accepted entries after the parallel phase.
Work around a missing contract locally until then.

Entry format:

```
### <short title>
- File: src/contracts/jobs.ts (or schema, api-types, ...)
- Change: exact proposed signature / column / type
- Why: what breaks or is impossible without it
- Workaround in place: yes/no, where
```

### WebhookResponse.action cannot express every CheckAction

- File: src/shared/api-types.ts
- Change: `action: 'test' | 'ignored' | 'compatible' | 'queued' | 'dry_run' | 'unknown_path' | 'blocked' | 'decision_required' | 'error';`
- Why: `media.checkPath` returns `blocked` (video codec outside the profile) and `decision_required` (BDMV needs a
  user choice). The current union has no matching value, so Radarr/Sonarr webhook history shows them as `ignored`.
  `failed` correctly maps to `error`.
- Workaround in place: yes, `webhookActionFor` in src/modules/integrations/webhook-payload.ts maps `blocked` and
  `decision_required` to `ignored`. The `message` still carries checkPath's own message.

### Remember the torrent hash of a webhook import

- File: src/db/schema.ts (media_files), src/contracts/probe-scan.ts (MediaRefs)
- Change: column `downloadId: text('download_id')` on media_files, plus `MediaRefs.downloadId?: string | null`.
  The webhook passes Radarr/Sonarr `downloadId` (the qBittorrent hash, upper case) and checkPath stores it.
- Why: `checkSeedingGoals` must decide whether a torrent's content "was replaced by an audio job". Radarr imports by
  hard link, so the torrent path and the library path differ, and after the replace they no longer share an inode.
  Without a stored hash the only links are (a) an active recycle-bin entry sharing the torrent file's inode, which is
  gone once the bin purges it (default 7 days, usually before a seeding goal is met) and never exists when the recycle
  bin is disabled (jobs contract step 2: "no link, no row"), and (b) Radarr/Sonarr import history, which needs the arr
  app to be reachable, has no DownloadId when Radarr could not match the grab, and goes stale when the library file is
  renamed. A stored hash makes the match local and permanent.
- Workaround in place: yes, download-client-service.ts. It reads the torrent's own file list from qBittorrent
  (`/api/v2/torrents/files`), asks every enabled Radarr/Sonarr for `GET /api/v3/history?downloadId=<HASH>&eventType=3`
  (droppedPath -> importedPath) and checks the imported paths for a completed audio job; the recycle-bin inode match
  stays as a fallback. A torrent is removed only when every media file has a library copy and at least one was
  replaced. Covered by tests for a live bin entry, bin off/purged (history), partial imports and an unreachable arr.

### Two switches for the Plex partial scan

- File: src/shared/settings.ts (`notifications.plexPartialScan`) and src/shared/domain.ts
  (`PlexConnection.partialScan`, column `plex_connection.partial_scan`)
- Change: keep one. Proposal: drop `Settings.notifications.plexPartialScan` and keep `PlexConnection.partialScan`,
  because the Plex row is what integrations stores and what the Plex page edits.
- Why: notifier.fileChanged skips Plex when the setting is off, plex.refreshPath skips when the row flag is off. Both
  default to true and the UI can set them independently, so turning one on does nothing while the other is off.
- Workaround in place: yes, partial. Whichever flag skips the scan now logs it at info level, naming where to turn it
  on (notifier-service.ts, plex-service.ts).

### Two sources of truth for "pause while Plex is streaming"

- File: src/shared/settings.ts (`processing.pauseWhilePlexStreaming`) and src/shared/domain.ts
  (`PlexConnection.pauseWhileStreaming`, column `plex_connection.pause_while_streaming`)
- Change: keep one. Proposal: drop `Settings.processing.pauseWhilePlexStreaming`, and let the jobs gate read
  `plex.connection().pauseWhileStreaming`.
- Why: the UI can set both, and they can disagree. Integrations only stores the PlexConnection flag.
- Workaround in place: no.

### Document path conventions of TorrentInfo and ArrRootFolder

- File: src/contracts/integrations.ts, src/shared/api-types.ts
- Change: on `findTorrentByPath` add "TorrentInfo.savePath/contentPath are local paths (qbittorrent path mappings
  applied)"; the same holds for the torrent passed to `bdmv.offerSourceDeletion`. Make `ArrRootFolder.localPath` a
  non-null `string`: it is always the mapped path (unchanged when no mapping matches), and `accessible` says whether
  it exists in the container.
- Why: ARCHITECTURE says paths leaving integrations are local; the contract does not say so for these types.
- Workaround in place: yes, implemented that way.

### PlexConnectionUpdate: manual server URL and its token

- File: src/shared/api-types.ts
- Change: add `serverToken?: string` (write-only, masked like other secrets) to `PlexConnectionUpdate`, and document:
  "serverMachineId selects a server from plex.tv resources; serverUrl may pick one of the addresses plex.tv lists for
  it. serverUrl alone keeps the selected server's token only when plex.tv lists that host for it; any other URL uses
  serverToken when given, else no token."
- Why: the stored plex.tv account token and server token must never go to a URL the caller chose: any LAN client gets
  the API key and could otherwise read the tokens back on its own server. Without a token field, a server reachable
  only through an unlisted address (for example a Docker hostname such as http://plex:32400) works only when Plex
  allows that network without auth.
- Workaround in place: yes, plex-service.ts. A manual URL not listed by plex.tv is stored with no token and clears
  serverMachineId/serverName; serverMachineId + an unlisted serverUrl is 422.

### Masked secrets resolve only for the URL they were saved with

- File: src/shared/api-types.ts (`ArrTestRequest`, `ArrInstanceInput.apiKey`, `DownloadClientInput.password`)
- Change: doc comment only: "The mask '********' keeps the stored secret only when url is the stored URL (scheme,
  host, port and path; trailing slashes ignored). With a different URL it is 422 on create/update/save and
  `ok: false` on test; enter the secret again."
- Why: otherwise any API caller could send the stored API key or password to a server of their choice.
- Workaround in place: yes, implemented in secrets.ts and used by arr-service.ts and download-client-service.ts.

### findRootForPath must compare normalised paths

- File: src/contracts/probe-scan.ts (`LibraryService.findRootForPath` / `MediaService.checkPath` doc comments)
- Change: doc comment: "Compares `path.posix.normalize`d, absolute paths on segment boundaries; a path with '..'
  segments is never inside a root."
- Why: webhook paths come from Radarr/Sonarr payloads. Integrations now rejects '..' segments and normalises the
  mapped local path before checkPath, but probe-scan is the module that decides whether a path is inside a library
  root, and other callers (scan, manual checks) should get the same guarantee.
- Workaround in place: yes, webhook-service.ts rejects '..' segments and passes a normalised path.
