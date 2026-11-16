import { expect, test } from 'bun:test';
import { ApiError } from './ApiError.ts';
import { errorMessage } from './errorMessage.ts';

test('errorMessage - API errors show the server message', () => {
  expect(errorMessage(new ApiError(409, 'conflict', 'profile is in use'))).toBe('profile is in use');
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

test('errorMessage - validation errors list the failing fields', () => {
  const details = {
    errors: [],
    properties: {
      definition: {
        errors: [],
        properties: {
          audio: { errors: [], properties: { targetCodec: { errors: ['must be one of allowedCodecs'] } } },
        },
      },
    },
  };
  expect(errorMessage(new ApiError(400, 'validation', 'invalid body', details))).toBe(
    'invalid body: definition.audio.targetCodec: must be one of allowedCodecs',
  );
});

test('errorMessage - more than three validation errors are counted, not listed', () => {
  const field = (message: string) => ({ errors: [message] });
  const details = {
    errors: [],
    properties: { a: field('1'), b: field('2'), c: field('3'), d: field('4'), e: field('5') },
  };
  expect(errorMessage(new ApiError(400, 'validation', 'invalid body', details))).toBe(
    'invalid body: a: 1; b: 2; c: 3 (+2 more)',
  );
});
