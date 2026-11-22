import { afterEach, expect, test } from 'bun:test';
import { compileRunes } from '#lib/testing/compileRunes.ts';

compileRunes();
const { watch } = await import('#lib/testing/watch.svelte.ts');
const { Clock } = await import('./clock.svelte.ts');

const TICK_MS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

test('Clock - a reader re-runs on every tick while mounted', async () => {
  const clock = new Clock(TICK_MS);
  const seen: number[] = [];
  stops.push(
    watch(
      () => clock.now,
      (now) => seen.push(now),
    ),
  );
  expect(seen).toHaveLength(1);

  await sleep(TICK_MS * 8);
  expect(seen.length).toBeGreaterThan(1);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
});

test('Clock - stops ticking once the last reader is gone', async () => {
  const clock = new Clock(TICK_MS);
  let runs = 0;
  const stop = watch(
    () => clock.now,
    () => (runs += 1),
  );
  await sleep(TICK_MS * 4);
  stop();
  await sleep(TICK_MS);
  const settled = runs;
  expect(settled).toBeGreaterThan(1);

  await sleep(TICK_MS * 6);
  expect(runs).toBe(settled);
});
