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

### Incremental job log reads

- File: src/shared/api-types.ts, src/contracts/jobs.ts
- Change: `'GET /api/v1/jobs/:id/log': { params: IdParams; query: { offset?: number }; response: string }`, returning the text from byte `offset` on, with the next offset in an `X-Log-Offset` response header (`JobsService.log(id, offset?)`).
- Why: the job page refreshes the log every 3 s while a job runs; a long ffmpeg/mkvmerge log is re-sent in full each time, which is wasteful on a Raspberry Pi and on a phone.
- Workaround in place: yes, `web/src/routes/activity/jobs/[id]/+page.svelte` polls the full log every 3 s, only while the job is running.

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
