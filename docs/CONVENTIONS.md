# Engineering conventions

Stack: TypeScript on Bun, Hono, SQLite (bun:sqlite) with Drizzle, SvelteKit SPA, `bun test`, Biome, GitHub Actions, Docker.

This file holds the shared and backend rules. Frontend rules live in [CONVENTIONS-WEB.md](CONVENTIONS-WEB.md). Module boundaries, configuration, logging, files and test helpers are in [ARCHITECTURE.md](ARCHITECTURE.md). Where this file and a contract in `src/contracts` disagree, the contract wins.

## TypeScript

- Run `strict: true`, `verbatimModuleSyntax: true`, `noEmit: true`; `bun run typecheck` in CI.
- Never use `any`; use `unknown` and narrow, or a specific type.
- Never use the non-null assertion `!`; handle `null` and `undefined` with a guard, `?.` or `??`. Biome enforces it.
- Define the Zod schema first, then derive the type with `z.infer`.
- Pin a schema to a hand-written type with `satisfies z.ZodType<T>`. Why: drift becomes a compile error.
- Use `import type` for type-only imports and keep the `.ts` extension in relative imports.
- Prefer `const`; make a new variable instead of reassigning.
- Use `Readonly<T>`, `ReadonlyArray<T>`, `ReadonlyMap`, `ReadonlySet` for data that must not change.
- Model a closed set of domain values as an `as const` array with a derived union (`JOB_STATES` -> `JobState`), never a TypeScript `enum`. Why: the array doubles as the Zod enum source and the runtime list.
- Make metadata keyed by such a union exhaustive: a `Record<Union, X>` map, or a `switch` whose default assigns to `never`. Why: a new member breaks the build until every consumer handles it.
- Use `as const` for literal tables; use `== null` to test null or undefined.
- Keep `@ts-ignore` and `@ts-expect-error` to near zero, with a reason where used.
- Name types, interfaces, classes and schemas in PascalCase (`FooSchema`). Name functions and variables in camelCase. Name module-level constants in ALL_CAPS.

## Structure and naming

- One export per file, named exactly like the file (`getFoo.ts` exports `getFoo`). Tests and a module's `index.ts` are exempt.
- A file may group exports only in these shapes, each holding one concern:
  - type and constant catalogues in `src/shared`, `src/contracts` and `src/db/schema.ts`;
  - one table's queries in a `*Queries.ts` file, or one boundary's Zod schemas in a `*schemas.ts` file;
  - a family of pure functions with the types and constants they share, when ARCHITECTURE.md assigns them to one file.
- Split a grouped file once it holds a second concern or exports more than 8 functions. Why: past that, the file name no longer tells a reader what the file owns.
- Never add a barrel that only re-exports siblings. A module's `index.ts` is its factory and public surface, not a re-export list.
- Local non-exported helpers and types are fine. Move one to its own file once a second file needs it.
- Extract a step only when a second caller reuses it, when it is a unit worth naming, or when its edge cases need their own test table. Otherwise keep it in the caller.
- Name files after what they export: PascalCase for types and schemas, camelCase for functions.
- Suffix data access `*Query.ts` (one query) or `*Queries.ts` (one table's queries). Keep JS reshaping out of them.
- Respect module boundaries: cross-module calls go through `ctx.services.<name>`, tables are written only by their owner (ARCHITECTURE.md, Module rules).
- Put code several modules need in `src/core` (backend only) or `src/shared` (backend and web, no runtime deps). Never import another module's files.
- Co-locate tests: `foo.test.ts` sits next to `foo.ts`.
- Search the same folder and `src/core` for an existing helper before writing a new one.
- Never commit one-off scripts (backfills, probes, measurements). Keep them in `.scratch/` (gitignored) and delete them after the run. Commit a script only if CI, a package script or a runbook calls it.

## Functions and modules

- Write pure functions first and push I/O (DB, HTTP, filesystem, child processes, logging) to the edges: services, workers and route handlers.
- Pass dependencies in (db handle, clients, clock, logger); never construct them inside a function. Why: testable without mocks.
- Put the db handle (or `tx`) first. Use one object parameter for the rest once a function takes 3 or more arguments besides the handle.
- Pass the current time in (`now` or `nowIso`) instead of calling `new Date()` in queries and pure logic. Why: deterministic tests and one clock per operation.
- Use guard clauses and early returns; avoid nested `if`s.
- Declare helpers above their callers so files read top-down.
- Prefer `map`/`filter`/`reduce`, but use a plain `for` loop when it reads clearer or needs `await` in order. Readability wins.
- Give each function one reason to change; split god functions.
- Keep each layer behind one boundary and do not leak internals (raw third-party response shapes, Drizzle rows with internal columns) to the next layer.
- Write top-level functions as `export function` or `export const x = (...) =>`; no default exports outside tool config files (`*.config.ts`).

## Errors and validation

- Validate every request body, param, query and external payload with Zod at the boundary (`parseParams`, `parseQuery`, `parseBody` in `src/api/http.ts`). Never trust a cast.
- Throw `AppError(code, message, details?)` from `src/core/errors.ts` for expected failures that reach HTTP. Add a new `ErrorCode` there with its status; never answer an ad hoc status from a handler.
- Let the global error handler answer: `AppError` becomes `{ error, message, details }` with the mapped status, anything else becomes a generic 500. Never leak SQL, params, paths of other users or stack traces to clients.
- Return small discriminated results (`{ ok: true } | { ok: false, reason }`) for expected failures inside the backend. Throw only for unexpected ones.
- Never catch a transport or upstream error and return "no data". Return `null` only for a real "not found" and throw otherwise. Why: a transient outage must not be recorded as a final result.
- Log through `ctx.logs.logger('<module>')` with a message and a context object (`log.error('probe failed', { path, error })`). No `console.*` outside the logger. Error causes are serialised for you.
- Per-file problems in scans, webhooks and jobs are recorded (status, history, log) and never crash the process.
- Read `process.env` only in `src/core` and `src/index.ts`. Modules take bootstrap values from `ctx.config` and runtime settings from `ctx.settings`, read at use time so changes apply live.
- Fail loudly (throw) on a missing required precondition; never swallow errors silently.

## Data access

- Model schema lean: every column needs a named reader today.
- Never store a value you can compute cheaply. If you store a derived value for speed, store a key of its inputs next to it and recompute when the key changes.
- Make a column nullable only when `NULL` means something the reader acts on; otherwise `NOT NULL` with an honest `DEFAULT`.
- Use typed columns for anything filtered or sorted, and JSON (typed with `$type<T>()`) only for payloads read whole.
- Store times as ISO 8601 UTC text. Compare them in SQL against an injected `nowIso`; pure scheduling logic with an injected clock may compare in JS.
- Prefer Drizzle operators (`eq`, `and`, `inArray`, `exists`, `onConflictDoUpdate`) over raw `sql` templates. When raw SQL is needed, wrap it in a small typed helper. Why: type safety and rename-safe refactors.
- Never negate a condition over a nullable column (`not(eq(col, x))`); write the NULL-safe complement (`or(isNull(col), ne(col, x))`). Why: `NOT (NULL)` is `NULL`, so rows vanish silently.
- Order, filter and `LIMIT` in SQL; drop rows in SQL, not after loading them.
- Bound every list: list routes take a `pageSize` with a schema maximum and return the total. Why: the target is a Raspberry Pi; unbounded reads stall the only process.
- Chunk every `inArray` over a caller-sized list and every bulk write with a named constant, never a literal.
- Walk large tables in keyset chunks (`id > last ORDER BY id LIMIT n`), not `OFFSET`, and `await yieldToEventLoop()` between chunks. Why: bun:sqlite is synchronous and blocks HTTP while it runs.
- Index every foreign-key column and every column a hot filter or sort reads. Prove a new query on a growing table uses its index with an `EXPLAIN QUERY PLAN` assertion in a test.

## Writes and transactions

- Wrap multi-statement writes that form one invariant in `db.transaction((tx) => ...)` and run every statement on `tx`. Skip the transaction for a single statement.
- Keep transaction callbacks synchronous and free of I/O (filesystem, fetch, child processes, event emits). Why: bun:sqlite commits when the callback returns, so awaited work escapes the transaction.
- Type a function that is only atomic inside a transaction to take the transaction type, not the db handle.
- Clear pointer columns without a foreign key in the same transaction as the delete they point at.
- Skip no-op writes: compare with stored values and open no transaction on an empty diff. Why: no write lock, no noisy change events.
- Guard a state change with the state it expects (`WHERE state = 'queued'`) and check the affected row count; answer a lost race with `conflict` (409).
- Do side effects (HTTP, events, file moves) after commit, and make them safe to repeat.

## Jobs and long work

- Make long work resumable: persist the step before each irreversible action (replace, delete, rescan), and keep recovery a pure, table-tested decision (step + observed state -> action).
- Make retried work idempotent: data write first, completion marker last.
- Do not enqueue a target that already has an active job.
- Treat "nothing to do" as an up-to-date outcome that writes nothing. Why: a timestamp bump can re-trigger the work.
- Ship every new automation or destructive action off by default and visible in the dry run first. Why: it touches the user's library.
- Run child processes through `runProcess` (`src/core/process.ts`) with an `AbortSignal`; jobs use `JobRunContext.run`.

## HTTP handlers

- Register each route with `route(app, 'METHOD /api/v1/...', handler, { params, query, body })` from `src/api/http.ts`. The key must exist in `src/shared/api-types.ts` and `API_ROUTE_META`; pass the schemas so OpenAPI stays complete.
- Keep a handler to: parse input, call `ctx.services.*`, return the result. Logic lives in the service, data access in queries.
- Return `undefined` for an empty success (the helper answers 204); throw `AppError('not_found', ...)` when the target does not exist.

## Testing

- Use `bun:test` only: `import { expect, test } from 'bun:test'`.
- Unit-test pure functions without mocks; table-test them with `test.each` when cases share a shape. Test single-use logic through its caller.
- Name tests `subject - behaviour` (`buildArgs - 7.1 source is downmixed`). Use `describe` only for shared setup or `describe.skipIf(...)` gates.
- Test queries and services against a real migrated temp database (`createTestContext()`), not mocks. Use `.toSQL()` only when the SQL shape itself is the point (chunking, parameter order).
- Test each multi-statement write's rollback: fail after the first statement and assert nothing persisted.
- Cover edges: empty input, boundaries, invalid values, clamping.
- Give a negative assertion ("absent from X") a precondition assertion so it cannot pass vacuously.
- Assert membership with a helper that prints the payload on failure, not `find` plus `toBeDefined`.
- Retry read-after-write checks with a polling helper that reports attempts and elapsed time, not a longer sleep.
- Use `mock.module` and `spyOn` sparingly, for process boundaries; restore them in `afterEach`/`afterAll`.
- Assert that error responses do not leak internals (no SQL or params in the body).
- Never commit media files; generate fixtures with `test/helpers/fixtures.ts`. Skip tests that need an optional binary with `describe.skipIf(!hasBinary(...))`.

## Tooling

- Run `bun run format` (Biome) and never Prettier; CI runs `bun run lint`. Biome: 2-space indent, single quotes, 120 columns, semicolons, trailing commas; `noExplicitAny`, `noNonNullAssertion` and `useImportType` are errors.
- Use Bun only: `bun install`, `bun install --frozen-lockfile` in CI; never `npm install` or a `package-lock.json`. `web/` has its own lockfile.
- Edit `src/db/schema.ts`, then `bun run db:generate`, and commit the schema and the generated `drizzle/` files together. Never hand-edit a generated migration.

## Git and CI

- Write Conventional Commits: `type(scope): lowercase imperative summary`. Types: feat, fix, chore, docs, refactor, test, perf, build, ci. Scope is the module or area (`jobs`, `web`, `integrations`).
- Keep commits small and single-purpose; `refactor`, `test` and `perf` are first-class.
- Stage explicit paths, never `git add -A` or `git add .`; check `git show --name-only HEAD` before pushing.
- Fold review fixes into the commit they fix with `git commit --fixup` and an autosquash rebase. CI fails a PR that still contains `fixup!`, `squash!` or `amend!` commits.
- Merge by rebase; no merge commits, no squash.
- Put design decisions and rationale in the PR body, not in code comments. Record a settled contract question in DECISIONS.md.
- A review bot's finding never overrides the design the owner chose. If the fix would replace or bypass the chosen mechanism or spread into another module, reply with the decision or ask the owner instead of building it.

## Comments and docs

- Write no comment by default. If code needs one to be understood, rewrite the code.
- Never write comments that restate code, label steps, narrate history ("replaces the old loop") or justify trade-offs.
- Allowed: a hidden constraint, a non-obvious invariant, a workaround with an issue link, or a one-line doc comment on an exported contract.
- Before finishing, re-read every comment you added and delete the ones a reader of the diff plus PR would not need.
- When a change sets a reusable pattern or fixes a recurring mistake, add it to this file or CONVENTIONS-WEB.md with a generic example and a "why", and update ARCHITECTURE.md when it changes a module, route or flow.
- Keep examples in rule files abstract and minimal: placeholders, not copied production code.
