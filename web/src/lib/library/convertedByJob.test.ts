import { expect, test } from 'bun:test';
import type { ConversionPlan } from '#lib/shared.ts';
import { convertedByJob } from './convertedByJob.ts';

const plan = (action: ConversionPlan['action']) => ({ action }) as ConversionPlan;

test('convertedByJob - a converted file points at its last job', () => {
  expect(convertedByJob({ plan: plan('skip'), lastJobId: 7 })).toBe(7);
});

test('convertedByJob - a file with work left shows its plan instead', () => {
  expect(convertedByJob({ plan: plan('convert'), lastJobId: 7 })).toBeNull();
});

test('convertedByJob - a compatible file never processed has no job', () => {
  expect(convertedByJob({ plan: plan('skip'), lastJobId: null })).toBeNull();
});

test('convertedByJob - an unplanned or unloaded file has no job', () => {
  expect(convertedByJob({ plan: null, lastJobId: 7 })).toBeNull();
  expect(convertedByJob(undefined)).toBeNull();
});
