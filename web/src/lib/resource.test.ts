import { expect, test } from 'bun:test';
import { compileRunes } from '#lib/testing/compileRunes.ts';

compileRunes();
const { Resource } = await import('./resource.svelte.ts');

test('Resource - reset drops the previous data and error so the next load shows a spinner', async () => {
  let fail = true;
  const resource = new Resource(async () => {
    if (fail) throw new Error('down');
    return 'job 5';
  });
  fail = false;
  await resource.load();
  fail = true;
  await resource.load({ silent: true });
  expect(resource.data).toBe('job 5');
  expect(resource.error).toBeInstanceOf(Error);
  resource.reset();
  expect(resource.data).toBeUndefined();
  expect(resource.error).toBeNull();
});

test('Resource - reset aborts the request in flight', async () => {
  let release = (): void => {};
  const resource = new Resource(
    (signal) =>
      new Promise<string>((resolve) => {
        release = () => resolve(signal.aborted ? 'aborted' : 'old');
      }),
  );
  const pending = resource.load();
  expect(resource.inFlight).toBe(true);
  resource.reset();
  expect(resource.inFlight).toBe(false);
  release();
  await pending;
  expect(resource.data).toBeUndefined();
});
