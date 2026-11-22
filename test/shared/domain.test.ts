import { expect, test } from 'bun:test';
import { ACTIVE_JOB_STATES, isActiveJobState, JOB_STATES } from '../../src/shared/domain.ts';

test.each(JOB_STATES)('isActiveJobState - %s', (state) => {
  expect(isActiveJobState(state)).toBe(state === 'queued' || state === 'running');
});

test('ACTIVE_JOB_STATES - lists queued and running in that order', () => {
  expect(ACTIVE_JOB_STATES).toEqual(['queued', 'running']);
});
