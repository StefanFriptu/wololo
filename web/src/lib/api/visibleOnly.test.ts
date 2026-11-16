import { expect, test } from 'bun:test';
import { visibleOnly } from './visibleOnly.ts';

function fakePage(initial: 'visible' | 'hidden') {
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: initial as string,
    addEventListener: (_: 'visibilitychange', listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: 'visibilitychange', listener: () => void) => void listeners.delete(listener),
  };
  const set = (state: 'visible' | 'hidden') => {
    page.visibilityState = state;
    for (const listener of listeners) listener();
  };
  return { page, set, listeners };
}

function setup(initial: 'visible' | 'hidden') {
  const visibility = fakePage(initial);
  const log: string[] = [];
  const stop = visibleOnly(visibility.page, (resumed) => {
    log.push(resumed ? 'resume' : 'start');
    return () => log.push('stop');
  });
  return { ...visibility, log, stop };
}

test('visibleOnly - hiding the page stops the stream and showing it resumes', () => {
  const { log, set } = setup('visible');
  set('hidden');
  set('visible');
  expect(log).toEqual(['start', 'stop', 'resume']);
});

test('visibleOnly - a page hidden at start starts nothing until it is visible', () => {
  const { log, set } = setup('hidden');
  expect(log).toEqual([]);
  set('visible');
  expect(log).toEqual(['start']);
});

test('visibleOnly - repeated visibility events do not start twice', () => {
  const { log, set } = setup('visible');
  set('visible');
  set('hidden');
  set('hidden');
  expect(log).toEqual(['start', 'stop']);
});

test('visibleOnly - stopping for good stops the stream and ignores later events', () => {
  const { log, set, stop, listeners } = setup('visible');
  stop();
  expect(listeners.size).toBe(0);
  set('hidden');
  set('visible');
  expect(log).toEqual(['start', 'stop']);
});

test('visibleOnly - without a page it simply runs', () => {
  const log: string[] = [];
  const stop = visibleOnly(null, () => {
    log.push('start');
    return () => log.push('stop');
  });
  stop();
  expect(log).toEqual(['start', 'stop']);
});
