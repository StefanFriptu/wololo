import { expect, test } from 'bun:test';
import { ApiError } from './ApiError.ts';
import { errorMessage } from './errorMessage.ts';

test('errorMessage - API errors show the server message', () => {
  expect(errorMessage(new ApiError(409, 'conflict', 'profile is in use'))).toBe('profile is in use');
});

test('errorMessage - 501 explains the feature is not available yet', () => {
  expect(errorMessage(new ApiError(501, 'not_implemented', 'jobs.queue'))).toContain('Not available yet');
});

test('errorMessage - API error without message falls back to the status', () => {
  expect(errorMessage(new ApiError(500, 'internal', ''))).toBe('Request failed (500)');
});

test('errorMessage - network failures (status 0) read as unreachable', () => {
  expect(errorMessage(new ApiError(0, 'network', 'Failed to fetch'))).toContain('Cannot reach Wololo');
});

test('errorMessage - plain errors and other values', () => {
  expect(errorMessage(new Error('boom'))).toBe('boom');
  expect(errorMessage('text')).toBe('text');
});
