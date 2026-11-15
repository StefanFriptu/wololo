import { expect, test } from 'bun:test';
import { isActiveChild, NAV, sectionOf } from './nav.ts';

test.each([
  ['/library', '/library'],
  ['/library/12', '/library'],
  ['/activity/jobs/4', '/activity'],
  ['/', '/'],
])('sectionOf - %p is in %p', (pathname, expected) => {
  expect(sectionOf(pathname)).toBe(expected);
});

const library = NAV.find((item) => item.href === '/library')?.children ?? [];
const activity = NAV.find((item) => item.label === 'Activity')?.children ?? [];

test('isActiveChild - precondition: sections have children', () => {
  expect(library.length).toBeGreaterThan(0);
  expect(activity.length).toBeGreaterThan(0);
});

test.each([
  ['/library', '/library', true],
  ['/library/dryrun', '/library', false],
  ['/library/dryrun', '/library/dryrun', true],
  ['/library/12', '/library', true],
  ['/library/12', '/library/dryrun', false],
])('isActiveChild - library %p marks %p active: %p', (pathname, child, expected) => {
  expect(isActiveChild(pathname, child, library)).toBe(expected);
});

test.each([
  ['/activity/jobs/4', '/activity/queue', false],
  ['/activity/history', '/activity/history', true],
])('isActiveChild - activity %p marks %p active: %p', (pathname, child, expected) => {
  expect(isActiveChild(pathname, child, activity)).toBe(expected);
});

test('NAV - every entry links inside its own section', () => {
  for (const item of NAV) {
    for (const child of item.children ?? []) expect(sectionOf(child.href)).toBe(sectionOf(item.href));
  }
});
