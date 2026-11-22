# Wololo agent guide

Wololo is one Bun process: a Hono API, SQLite via Drizzle, an in-process job worker and scheduler, and a static SvelteKit SPA. It converts media files that Radarr/Sonarr import so every TV direct-plays them. It **replaces and deletes real media files**, so correctness and safety beat speed.

## Read before you change code

- Any code: [docs/CONVENTIONS.md](docs/CONVENTIONS.md) (shared and backend rules).
- `web/`: [docs/CONVENTIONS-WEB.md](docs/CONVENTIONS-WEB.md).
- A module, route, table, event, config key or test helper: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (module rules, directory map, ownership, REST API, conventions).
- `src/contracts`, `src/shared`, `src/db/schema.ts`: ARCHITECTURE.md module rule 3 and [docs/DECISIONS.md](docs/DECISIONS.md).
- Product behaviour and scope: [docs/SPEC.md](docs/SPEC.md).
- User-facing setup, config or troubleshooting: [docs/GUIDE.md](docs/GUIDE.md).

Search the same folder for an existing helper or pattern before writing a new one, and match it.

## Setup and checks

```sh
bun install --frozen-lockfile && (cd web && bun install --frozen-lockfile)
bun run format && bun run lint && bun run typecheck && bun test && (cd web && bun run check && bun run build)
```

- That chain is the gate CI runs. A change is not done until it passes; report what you ran and its result.
- Run one file while iterating: `bun test src/modules/jobs/jobQueries.test.ts`.
- Media tests need `ffmpeg`/`ffprobe`; `mkvmerge`, `7z` and `tsMuxeR` are optional locally and their tests skip. `bun run fixtures` pre-generates synthetic fixtures into `test/.cache`.
- Web unit tests (`web/src/**/*.test.ts`) run under the root `bun test`, not Vite.

## Hard rules

- **Never run the app against a real media library or a real `/config`.** For a manual run use `WOLOLO_CONFIG_DIR=<scratch dir>` and a unique `WOLOLO__PORT`; tests use `createTestContext()` or `createRuntime({ port: 0 })`.
- Cross-module calls go through `ctx.services.<name>`; a table is written only by its owning module.
- A change to `src/contracts/*`, `src/shared/*` or `src/db/schema.ts` updates every dependent module in the same change. Schema changes run `bun run db:generate`; commit the schema and the generated `drizzle/` files together.
- Expected failures throw `AppError`; log through `ctx.logs.logger(...)`, never `console.*`.
- Transaction callbacks stay synchronous and do no I/O (bun:sqlite).
- New automation and destructive actions ship off by default and show in the dry run first.
- Bun only (`bun install`, `bun test`, `bun run`); never npm, never Prettier.
- Never commit media files, `.env`, `config/` or one-off scripts (keep those in `.scratch/`).

## Git

- Branch off `origin/main`. Conventional Commits: `type(scope): lowercase imperative summary`.
- Stage explicit paths, never `git add -A` or `git add .`.
- Fold review fixes into their commit: `git commit --fixup <sha>`, then `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/main`. CI rejects leftover `fixup!` commits. PRs merge by rebase.
- Design rationale goes in the PR body, not in code comments.

## Keep the docs true

- Changed a route, module, table, event or flow: update ARCHITECTURE.md.
- Changed user-visible behaviour, a setting or an env var: update GUIDE.md.
- Settled a contract question: add it to DECISIONS.md.
- Set a reusable pattern or fixed a recurring mistake: add the rule to CONVENTIONS.md or CONVENTIONS-WEB.md.
