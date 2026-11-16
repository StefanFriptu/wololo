import { expect, test } from 'bun:test';
import { appendLogChunk } from './appendLogChunk.ts';

const chunk = (text: string, start: number, size = start + Buffer.byteLength(text)) => ({
  text,
  start,
  end: start + Buffer.byteLength(text),
  size,
});

test('appendLogChunk - the first chunk becomes the view', () => {
  expect(appendLogChunk(undefined, chunk('one\n', 100), 1000)).toEqual(chunk('one\n', 100));
});

test('appendLogChunk - a chunk that continues the view is appended', () => {
  expect(appendLogChunk(chunk('one\n', 0), chunk('two\n', 4), 1000)).toEqual(chunk('one\ntwo\n', 0));
});

test('appendLogChunk - an empty continuation keeps the text and takes the new size', () => {
  const view = chunk('one\n', 0);
  expect(appendLogChunk(view, { text: '', start: 4, end: 4, size: 4 }, 1000)).toEqual(view);
});

test('appendLogChunk - a chunk that skipped ahead replaces the view', () => {
  expect(appendLogChunk(chunk('one\n', 0), chunk('nine\n', 40), 1000)).toEqual(chunk('nine\n', 40));
});

test('appendLogChunk - growing past the limit drops whole lines from the front', () => {
  const view = appendLogChunk(chunk('aaaa\nbbbb\n', 0), chunk('cccc\n', 10), 12);
  expect(view).toEqual(chunk('bbbb\ncccc\n', 5));
});

test('appendLogChunk - trimming counts bytes of multibyte text', () => {
  const view = appendLogChunk(chunk('éé\n', 0), chunk('ok\n', 5), 4);
  expect(view).toEqual(chunk('ok\n', 5));
});

test('appendLogChunk - a single line longer than the limit is dropped whole', () => {
  expect(appendLogChunk(undefined, chunk('x'.repeat(20), 0), 10)).toEqual({ text: '', start: 20, end: 20, size: 20 });
});
