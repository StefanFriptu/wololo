# Engineering conventions

Stack: TypeScript on Bun, Hono, SQLite with Drizzle, SvelteKit SPA, `bun test`, Biome, GitHub Actions, Docker.

## TypeScript

- Run `strict: true`, `verbatimModuleSyntax: true`, `noEmit: true`; type-check in CI.
- Never use `any`; use `unknown` and narrow, or a specific type.
- Define the Zod schema first, then derive the type with `z.infer`.
- Pin a schema to a hand-written type with `satisfies z.ZodType<T>`. Why: drift becomes a compile error.
- Use `import type` for type-only imports and keep the `.ts` extension in relative imports.
- Prefer `const`; make a new variable instead of reassigning.
- Use `Readonly<T>`, `ReadonlyArray<T>`, `ReadonlyMap`, `ReadonlySet` for data that must not change.
- Make shared enum metadata exhaustive: a `Record<Enum, X>` map, or a `switch` whose default assigns to `never`. Why: a new member breaks the build until every consumer handles it.
- Use string enums for domain values and API error codes (`Foo = 'foo'`), never numeric ones.
- Use `as const` for literal tables; use `== null` to test null or undefined.
- Keep `@ts-ignore` and `@ts-expect-error` to near zero, with a reason where used.
- Name types, interfaces, classes, schemas and enums in PascalCase (`FooSchema`). Name functions and variables in camelCase. Name module-level constants in ALL_CAPS.

## Structure and naming

- One export per file, named exactly like the file (`getFoo.ts` exports `getFoo`). Tests and barrel files are exempt. Exception: a file may group the functions of one concern, with the types and constants they share (the queries of one table in a `*Query.ts` file, the pure functions ARCHITECTURE.md assigns to one file); split it once it holds a second concern.
- Local non-exported helpers and types are fine. Move one to its own file once a second file needs it.
- Extract a step only when a second module reuses it, when it is a unit worth naming, or when its edge cases need their own test table. Otherwise keep it in the caller.
- Name files after what they export: PascalCase for types, schemas and enums, camelCase for functions.
- Suffix read-only data access `*Query.ts`. Suffix read-then-reshape logic `*Processor.ts`. Name pure writes with a verb and no suffix (`createFoo.ts`).
- Put code shared by several entry points in one `core` area. Never import across sibling apps.
- Co-locate tests: `foo.test.ts` sits next to `foo.ts`.
- Search for an existing helper or pattern in the same folder before writing a new one.
- Never commit one-off scripts (backfills, probes). Keep them in a gitignored folder and delete them after the run. Commit a script only if CI, a package script or a runbook calls it.

## Functions and modules

- Write pure functions first and push I/O (DB, HTTP, logging, env) to the edges: entry points and handlers.
- Pass dependencies in (db handle, clients, clock); never construct them inside a function. Why: testable without mocks.
- Put the db handle first, then one object parameter: `fetchFoo(db, { userId, limit })`.
- Use a single object parameter once a function takes 3 or more arguments.
- Use guard clauses and early returns; avoid nested `if`s.
- Declare helpers above their callers so files read top-down.
- Prefer `map`/`filter`/`reduce`, but use a plain `for` loop when it reads clearer. Readability wins.
- Give each function one reason to change; split god functions.
- Keep entry points thin: they wire, orchestrate and own I/O; logic lives in modules.
- Keep each layer behind one boundary and do not leak internals (for example raw third-party response shapes) to the next layer.
- Write top-level functions as `export function` or `export const x = (...) =>`; use no default exports except a route module's single app.

## Errors and validation

- Validate every request body, param and external payload with Zod `safeParse` at the boundary. Never trust a cast.
- Parse JSON defensively: `await c.req.json().catch(() => undefined)`, then `safeParse`.
- Return stable error codes from an enum in the JSON body (`{ error: Code }`), with the right status (400 invalid, 404 missing, 422 semantic, 401 unauthenticated).
- Wrap every handler in one error guard that catches, logs and answers a generic 500. Never leak SQL, params or stack traces to clients.
- Log failures with a bracketed context prefix, `console.error('[context] ...', error)`. Flatten `error.cause` chains when logging. Why: wrapped DB errors hide the real reason in `cause`.
- Return small discriminated results (`{ ok: true } | { ok: false, reason }`) for expected failures. Throw only for unexpected ones.
- Read env and config only at the entry point and pass values down; do not touch `process.env` in deep modules.
- Fail loudly (throw) on a missing required precondition; never swallow errors silently.

## Data access

- Model schema lean: every column needs a named reader today.
- Never store a value that can be computed from another column.
- Make a column nullable only when `NULL` means something the reader acts on; otherwise `NOT NULL` with an honest `DEFAULT`.
- Use the smallest type that fits, typed columns over JSON for anything filtered or sorted, and JSON only for payloads read whole.
- Prefer Drizzle operators (`eq`, `and`, `inArray`, `exists`, `onConflictDoUpdate`) over raw `sql` templates. When raw SQL is needed, wrap it in a small typed helper. Why: type safety and rename-safe refactors.
- Keep queries in dedicated scope files that take the db handle and return typed rows. Keep JS reshaping out of `*Query` files.
- Order, filter and `LIMIT` in SQL before building expensive projections; drop rows in SQL, not after loading them.
- Keep datetime comparisons in SQL, not JS.
- Wrap multi-statement writes that form one invariant in a single transaction and run every statement on the `tx`. Skip the transaction for a single atomic statement.
- Make retried or queued work idempotent: data write first, completion marker last.
- Do side effects (HTTP, queue, email) after commit and compensate on failure; a transaction cannot cover them.

## HTTP handlers

- Use three layers: route file (URL and middleware chain), handler (params, validate, call, respond), query (data access).
- Keep a fixed middleware order, with the error guard always last.
- Create the Hono app through one factory so every app shares settings.
- Define one Zod schema per route for query and params.
- Handler flow: extract params, validate, query, handle not-found, return JSON.
- Return `204` with no body for successful empty writes and `404` when nothing was mutated.

## Testing

- Use `bun:test` only: `import { expect, test } from 'bun:test'`.
- Unit-test pure functions without mocks; test single-use logic through its caller.
- Use one flat `test()` per case, named `subject - behaviour` (for example `chunk - empty input yields no groups`).
- Cover edges: empty input, boundaries, invalid values, clamping.
- Test Drizzle queries by asserting on `.toSQL()` output (SQL text and params separately), with a SQL formatter to ignore whitespace.
- Keep integration tests in a separate folder, grouped in steps, and run them against a real booted server.
- Never pin upstream-derived values (dates, counts) in fixtures; read the anchor back at test time and make the helper throw if it is absent.
- Give a negative assertion ("absent from X") a precondition assertion so it cannot pass vacuously.
- Use an `expectEntry`-style helper instead of `find` plus `toBeDefined`: it prints the predicate and a payload head on failure.
- Retry read-after-write checks with an `eventually` helper that reports attempts and elapsed time, not a longer sleep.
- Use `mock.module` and `spyOn` sparingly, for process boundaries (db handle, `console`); restore in `afterAll` and `mockRestore`.
- Assert that error responses do not leak internals (no SQL or params in the body).

## Formatting and lint

- Run `bun run format` (Biome) and never Prettier; CI runs the check variant.
- Use Bun only: `bun install`, `bun install --frozen-lockfile` in CI; never `npm install`.
- Stage explicit paths, never `git add -A` or `git add .`; check `git show --name-only HEAD` before pushing.

## Git and CI

- Write Conventional Commits: `type(scope): lowercase imperative summary`. Types: feat, fix, chore, docs, refactor, test, perf.
- Keep commits small and single-purpose; `refactor`, `test` and `perf` are first-class.
- Keep CI to unit tests, type-check and format-check on every PR; skip drafts.
- Fail CI if a PR contains `fixup!`, `squash!` or `amend!` commits. Fold them with autosquash before merge.
- Use a rebase-and-merge history, with auto-merge enabled once required checks pass.
- Use one composite setup action (install runtime, `--frozen-lockfile`) shared by all jobs.
- Set `concurrency` with `cancel-in-progress`, per-job `timeout-minutes`, and least-privilege `permissions`.
- Split slow test suites into a matrix of shards; fail a shard that plans zero files.
- Dump server logs on failure, and tear down test data with `if: always()`.
- Add a supply-chain job: audit signatures, and block growth of the install-script allowlist without a review label.
- Put design decisions and rationale in the PR body, not in code comments.

## Comments and docs

- Write no comment by default. If code needs one to be understood, rewrite the code.
- Never write comments that restate code, label steps, narrate history ("replaces the old loop") or justify trade-offs.
- Allowed: a hidden constraint, a non-obvious invariant, or a workaround with an issue link.
- Before finishing, re-read every comment you added and delete the ones a reader of the diff plus PR would not need.
- When a new reusable pattern emerges, add it to the rule files with a generic example and a "why".
- Keep examples in rule files abstract: no real names, minimal snippets, rationale and anti-patterns stated.

## Biome settings

- Formatter: 2-space indent, single quotes, line width 120, semicolons, trailing commas.
- Linter: recommended rules on, plus `noExplicitAny`, `noNonNullAssertion` and `useImportType` as errors. Why: the rules above are enforced by the tool, not only by review.
