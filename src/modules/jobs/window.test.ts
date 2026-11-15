import { expect, test } from 'bun:test';
import { isWithinProcessingWindow } from './window.ts';

const at = (hhmm: string) => {
  const [hours = 0, minutes = 0] = hhmm.split(':').map(Number);
  return new Date(2026, 10, 15, hours, minutes, 30);
};

test.each([
  ['01:00', '08:00', '00:59', false],
  ['01:00', '08:00', '01:00', true],
  ['01:00', '08:00', '07:59', true],
  ['01:00', '08:00', '08:00', false],
  ['01:00', '08:00', '23:00', false],
  ['22:00', '06:00', '21:59', false],
  ['22:00', '06:00', '22:00', true],
  ['22:00', '06:00', '23:59', true],
  ['22:00', '06:00', '00:00', true],
  ['22:00', '06:00', '05:59', true],
  ['22:00', '06:00', '06:00', false],
  ['22:00', '06:00', '12:00', false],
  ['00:00', '00:00', '13:37', true],
  ['09:30', '09:30', '09:29', true],
])('isWithinProcessingWindow - %s-%s at %s is %p', (start, end, time, expected) => {
  expect(isWithinProcessingWindow({ enabled: true, start, end }, at(time))).toBe(expected);
});

test('isWithinProcessingWindow - a disabled window is always open', () => {
  expect(isWithinProcessingWindow({ enabled: false, start: '01:00', end: '02:00' }, at('12:00'))).toBe(true);
});
