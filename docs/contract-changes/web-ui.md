# Contract change requests: web-ui

Only the `web-ui` module edits this file. The integrator applies accepted entries after the parallel phase.
Work around a missing contract locally until then.

Entry format:

```
### <short title>
- File: src/contracts/jobs.ts (or schema, api-types, ...)
- Change: exact proposed signature / column / type
- Why: what breaks or is impossible without it
- Workaround in place: yes/no, where
```

### Expose env-locked general settings

- File: src/shared/api-types.ts (+ src/api/core-routes.ts `generalView`)
- Change: `export interface GeneralConfigView extends GeneralConfig { restartRequired: boolean; envOverrides: (keyof GeneralConfig)[]; }`, filled from `ctx.config.get().envOverrides`.
- Why: Settings > General cannot tell which fields WOLOLO__* variables pin, so it offers to edit them and only learns from the 409 on save. With the list it can disable those inputs and say "set by WOLOLO__PORT".
- Workaround in place: yes, `web/src/routes/settings/general/+page.svelte` shows the 409 message ("set by environment variables: port") as an error toast.

### Docs: web event helper signature and Recycle bin page

- File: docs/ARCHITECTURE.md (Events section and Web UI section)
- Change: replace "Web: `subscribeEvents(handler, names?)`" with "Web: pages use the shared stream `live.on(handler)` / `live.onReconnect(fn)` from `web/src/lib/api/live.svelte.ts`; a separate stream (for `log.entry`) uses `subscribeEvents(handler, { apiKey, names, onStatus, onOpen })` from `web/src/lib/api/events.ts`, which reconnects with back-off". Add "Activity > Recycle bin (`/activity/recyclebin`)" to the sidebar list.
- Why: the helper now takes an options object (API key, status and reopen callbacks for reconnect handling), and the recycle-bin routes (`/api/v1/recyclebin*`) needed a page; the arr-style place for it is under Activity.
- Workaround in place: not needed (documentation only).

### Name the SSE hello event in EventMap

- File: src/shared/events.ts
- Change: document the stream-only `hello` frame next to `EventMap`, e.g. `export interface StreamHello { version: string }` with a note that it is sent once per connection and never on the bus.
- Why: the web client relies on `hello` to know a (re)connection is live and to refetch after a drop; it is currently an unlisted string.
- Workaround in place: yes, `web/src/lib/api/events.ts` listens for the literal `'hello'` event.

### One stored flag per Plex behaviour

- File: src/shared/settings.ts, src/shared/domain.ts (`PlexConnection`), src/shared/api-types.ts (`PlexConnectionUpdate`)
- Change: drop `Settings.processing.pauseWhilePlexStreaming` and `Settings.notifications.plexPartialScan`; `PlexConnection.pauseWhileStreaming` and `PlexConnection.partialScan` become the only flags, and the worker (Plex auto-pause) and the notifier (partial scan) read them through `ctx.services.plex.get()`. If the integrator prefers the settings side, drop the two `PlexConnection` fields instead; either way, state in the doc comment which module reads the flag.
- Why: each behaviour is stored twice and no contract says which copy is honoured, so a toggle can show "Saved" and change nothing.
- Workaround in place: yes, `web/src/routes/settings/plex/+page.svelte` has one control per behaviour that writes both copies (`web/src/lib/settings/plexFlagWrites.ts`); the duplicate checkbox on Settings > Media is gone.

### Keep the stored qBittorrent password on save and test

- File: src/shared/api-types.ts (`DownloadClientInput`), src/contracts/integrations.ts (`DownloadClientService.save` / `test`)
- Change: `export interface DownloadClientInput extends DownloadClientConnection {}` with `password` documented as: Send "********" (the masked value from GET) to keep the stored password on `PUT /api/v1/downloadclient` and `POST /api/v1/downloadclient/test`. Mirrors `ArrInstanceInput.apiKey`.
- Why: GET returns the password masked, and the form sends it back. Without the rule, Test sends the mask as the password and fails, and a Save that only changes the category could overwrite the stored password with the mask.
- Workaround in place: partly. `web/src/routes/settings/downloadclients/+page.svelte` sends the masked value back unchanged (as the arr forms do) and tells the user the saved password is kept unless they type a new one. That only works once the backend honours the sentinel.

### Bulk enqueue with the library list's search and codec filters

- File: src/shared/api-types.ts (`EnqueueFilter`), src/contracts/jobs.ts (`enqueueMany`)
- Change: add `search?: string` and `codec?: string` to `EnqueueFilter`, with the same meaning as in `MediaQuery`, and pass them through to `media.list`.
- Why: "Process needs-work" on the Library page cannot send these two filters, so with them set it would queue more than the list shows.
- Workaround in place: yes, `web/src/lib/library/needsWorkScope.ts` disables the bulk button while either filter is set (and points to "Process selected"), and the confirm text names every field that is sent.

### Library list filter for all disc kinds

- File: src/shared/api-types.ts (`MediaQuery.kind`)
- Change: `/** One kind or a comma separated list. */ kind?: string;`, parsed like `status`.
- Why: the dry-run group "bdmv" covers BDMV folders and ISOs, but the Library list filters on one kind, so one link cannot show the whole group.
- Workaround in place: yes, `web/src/lib/library/dryRunGroupLinks.ts` gives the "bdmv" group two links (folders, ISOs).

### Shape of a blocked plan

- File: src/shared/domain.ts (`ConversionPlan`)
- Change: document on `ConversionPlan.streams` / `dropped`: "Filled for remux and convert; for blocked, lists what would be written if the block were lifted, or empty when no output can be planned."
- Why: the UI cannot tell whether an empty `streams` on a blocked plan means "nothing would be written" or "not computed".
- Workaround in place: yes, `web/src/lib/streams/pairStreams.ts` lists the probed source streams when a plan has no planned and no dropped streams.
