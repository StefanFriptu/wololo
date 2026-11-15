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
  hard link, so the torrent path and the library path differ. Today the only link between them is a shared inode with
  a recycle-bin entry. Once the recycle bin purges that entry (default 7 days, usually before a seeding goal is met),
  the torrent can no longer be matched, so `removeWhenGoalMet` silently stops removing it.
- Workaround in place: yes, download-client-service.ts compares the inodes (dev + ino) of the torrent's media files
  with active recycle-bin entries of completed audio jobs. It never deletes a torrent whose content folder holds a
  media_files row, so the library is never deleted with a torrent.

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

### PlexConnectionUpdate: manual server URL

- File: src/shared/api-types.ts
- Change: doc comment only: "serverMachineId selects a server from plex.tv resources (serverUrl optionally picks one
  of its connections). serverUrl alone sets a manual URL that uses the account token."
- Why: the type does not say what serverUrl means without serverMachineId.
- Workaround in place: yes, implemented as described.
