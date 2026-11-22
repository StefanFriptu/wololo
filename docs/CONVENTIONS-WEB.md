# Web conventions

Rules for `web/` (SvelteKit SPA, adapter-static, Svelte 5 runes, plain CSS). The shared rules in [CONVENTIONS.md](CONVENTIONS.md) (TypeScript, structure and naming, functions, comments, git) apply here too. Layout and runtime details (URL base, injected `window.__WOLOLO__`, dev proxy) live in [ARCHITECTURE.md](ARCHITECTURE.md#web-ui).

## Imports and types

- Import through `#lib/...` with the explicit extension, never `../../lib/...`.
- Take backend types from `#lib/shared.ts` only (`import type { JobSummary } from '#lib/shared.ts'`); never import `src/` from `web/`. Why: `web/` is a separate package with one doorway to the backend.
- `noUncheckedIndexedAccess` is on: handle the `undefined` from `array[i]` and `record[key]` with a guard or `??`, never with `!`.

## Components and runes

- Use runes only: `$props`, `$state`, `$derived`, `$effect`, `{#snippet}` / `{@render}`. Never `export let`, `$:`, `<slot>` or `createEventDispatcher`. Why: one reactivity model.
- Order a `<script>`: imports, props type, `$props()`, `$state`, `$derived`, functions, effects.
- Pass content with `Snippet` props. If a snippet prop shares a name with a local, rename it on destructure. Why: a same-name snippet renders itself recursively.
- Extend a generic component with a snippet or an option, never with a prop shaped like one feature's data. Why: primitives in `lib/components` stay domain-free (see `Async.svelte`).
- A new look for an existing control is a variant of it (a `tone` or size option), never a copied component. Why: a fix lands once.
- A shared component owns its states and variants. Never restyle it from the consumer with `:global(...)`; add the option to the component instead.
- Prefer native elements (`<button>`, `<a href>`, `<dialog>`, `<details>`) over a clickable `<div>`. Why: keyboard, focus and semantics for free.
- `$bindable` is fine for an `open` flag on a modal or form; avoid it for data. Why: two-way data binding hides who owns the value.
- Key every `{#each}` on identity the data owns (`(job.id)`), never on rendered text or a formatted value. Use `(index)` only for rows without identity (skeletons, fixed layouts). Why: duplicate keys throw and blank the page.

## State

- Compute with `$derived`. Use `$effect` only to talk to something outside Svelte: the DOM, the network, timers, `localStorage`, the event stream. Never use an effect to copy one state into another.
- Seed a form from loaded data by mounting it once the data exists (`{#if resource.data}<Form initial={resource.data} />{/if}`) or by keying it. If a reset effect cannot be avoided, gate it on the trigger and wrap the writes in `untrack`.
- Keep shareable view state (filters, search, sort, page) in the query string and read it with `$derived` off `page.url`. Never mirror it into `$state`. Why: back, reload and pasted links keep working.
- Write query-string state with `goto(href(...), { replace: true, reset: false })` unless the change is a real navigation. Why: filter tweaks should not flood history or reset the page.
- Keep transient UI state (modal open, hover, a draft) in component `$state`.
- Put cross-component state in a `*.svelte.ts` module that exports one instance or class (`toast.svelte.ts`, `theme.svelte.ts`).
- Wrap every `localStorage` read and write in `try`/`catch` with a default. Why: private windows and blocked storage throw.
- Return a cleanup from every effect that adds a listener, timer or subscription.

## Data fetching

- Call the backend only through `api('METHOD /api/v1/...')` from `lib/api/client.ts`; never call `fetch` in a component. Why: the route key types params, body and response, and the client handles the API key, URL base and 401.
- Hold read state in a `Resource` and render it with `Async` (loading, error, empty, data). Pass the `AbortSignal` the resource hands you to `api()`.
- Refresh after a live event with a silent reload so the view does not flash a spinner.
- Show failures with `errorMessage(error)`. Never invent client-side wording for a server error code.
- Never recompute in the UI what the API already sends (status, available actions). Tone and label maps for enum values live in `lib/labels/` as exhaustive `Record<Enum, ...>` maps.
- Build every app link and redirect with `href('/path')` from `lib/paths.ts`, never a bare `'/path'`. Why: it applies the URL base the backend may run under.
- Make navigation an `<a href>`, not a button that calls `goto`. Why: middle-click and copy-link work.

## Styling and theming

- Style with the custom properties in `lib/styles/app.css`. No raw hex, rgb or named colours in components. Why: light and dark themes are defined in one file.
- Define every theme-dependent value as a token in both the light and the dark block. Components never read `data-theme` or `prefers-color-scheme`.
- Use the existing utility and `tone-*` classes from `app.css` before writing new CSS; keep the rest in the component's scoped `<style>`.
- Animate `transform` and `opacity` where possible, and wrap non-essential motion in `@media (prefers-reduced-motion: reduce)`.

## Accessibility

- `svelte-check --fail-on-warnings` enforces Svelte's a11y checks; fix the markup, never silence the warning.
- Give every icon-only button an `aria-label`. Pair colour-only signals with text or an `aria-*` attribute.
- Never remove a focus outline without a visible replacement; style `:focus-visible`.
- Every form control has a `<label>`; group related controls in a `<fieldset>` with a `<legend>`.

## Testing

- Put view logic in plain `.ts` modules and test them next to the source (`foo.ts` + `foo.test.ts`). The root `bun test` runs them and the root `bun run typecheck` checks them.
- Web tests never import `$app/*`, `.svelte` files or code that reads `import.meta.env`. Why: they run under Bun, not Vite.
- Test `.svelte.ts` rune modules with `compileRunes()` and `effectScope()` from `lib/testing/`.
- Run `cd web && bun run check && bun run build` after any change in `web/`.
