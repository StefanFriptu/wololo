import { afterEach, expect, test } from 'bun:test';
import { compileRunes } from '#lib/testing/compileRunes.ts';

compileRunes();
const { Resource } = await import('#lib/resource.svelte.ts');
const { effectScope } = await import('#lib/testing/effectScope.svelte.ts');
const { clampPage } = await import('./clampPage.svelte.ts');

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

const result = (page: number, items: number[], total: number) => ({ page, pageSize: 10, total, items });

function setup() {
  const data = new Resource<ReturnType<typeof result>>(async () => result(1, [], 0));
  const jumps: number[] = [];
  const scope = effectScope(() =>
    clampPage(
      () => data.data,
      (page) => jumps.push(page),
    ),
  );
  stops.push(scope.stop);
  return { data, jumps, scope };
}

test('clampPage - jumps to the last page when the current one is past the end', () => {
  const { data, jumps, scope } = setup();
  data.set(result(5, [], 25));
  scope.flush();
  expect(jumps).toEqual([3]);
});

test('clampPage - stays put while the page has rows or nothing is loaded', () => {
  const { data, jumps, scope } = setup();
  expect(jumps).toEqual([]);
  data.set(result(2, [1, 2], 12));
  scope.flush();
  data.set(result(1, [], 0));
  scope.flush();
  expect(jumps).toEqual([]);
});
