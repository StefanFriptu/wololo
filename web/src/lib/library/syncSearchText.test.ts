import { afterEach, expect, test } from 'bun:test';
import { compileRunes } from '#lib/testing/compileRunes.ts';

compileRunes();
const { Resource } = await import('#lib/resource.svelte.ts');
const { effectScope } = await import('#lib/testing/effectScope.svelte.ts');
const { syncSearchText } = await import('./syncSearchText.svelte.ts');

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

function setup(initialUrl: string | undefined, initialText: string) {
  const url = new Resource<string | undefined>(async () => undefined);
  url.set(initialUrl);
  const box = { text: initialText, writes: 0 };
  const scope = effectScope(() =>
    syncSearchText({
      urlSearch: () => url.data,
      read: () => box.text,
      write: (text) => {
        box.text = text;
        box.writes += 1;
      },
    }),
  );
  stops.push(scope.stop);
  return { url, box, flush: scope.flush };
}

test('syncSearchText - clearing the URL search empties the input', () => {
  const { url, box, flush } = setup('Movie B', 'Movie B');
  expect(box.writes).toBe(0);
  url.set(undefined);
  flush();
  expect(box.text).toBe('');
});

test('syncSearchText - back navigation restores the URL search', () => {
  const { url, box, flush } = setup(undefined, '');
  url.set('Movie A');
  flush();
  expect(box.text).toBe('Movie A');
});

test('syncSearchText - the URL catching up with typed text leaves the input alone', () => {
  const { url, box, flush } = setup(undefined, '');
  box.text = 'Movie B ';
  url.set('Movie B');
  flush();
  expect(box.text).toBe('Movie B ');
  expect(box.writes).toBe(0);
});
