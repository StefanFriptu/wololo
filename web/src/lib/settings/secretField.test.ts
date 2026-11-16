import { expect, test } from 'bun:test';
import { secretForForm, secretForRequest } from './secretField.ts';

test('secretForForm - a stored secret loads as an empty input', () => {
  expect(secretForForm('********')).toBe('');
});

test('secretForForm - no stored secret stays empty', () => {
  expect(secretForForm('')).toBe('');
});

test('secretForRequest - typing over a stored secret sends only the new value', () => {
  const typed = `${secretForForm('********')}newsecret`;
  expect(secretForRequest(typed, '********')).toBe('newsecret');
});

test('secretForRequest - an empty input with a stored secret sends the mask', () => {
  expect(secretForRequest('', '********')).toBe('********');
});

test('secretForRequest - an empty input without a stored secret sends empty', () => {
  expect(secretForRequest('', '')).toBe('');
});
