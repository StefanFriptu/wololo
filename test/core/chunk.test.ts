import { expect, test } from 'bun:test';
import { chunk, IN_LIST_CHUNK_SIZE } from '../../src/core/chunk.ts';

test('chunk - empty input gives no chunks', () => {
  expect(chunk([], 3)).toEqual([]);
});

const CASES: { items: number[]; size: number; expected: number[][] }[] = [
  { items: [1, 2, 3], size: 3, expected: [[1, 2, 3]] },
  { items: [1, 2, 3, 4], size: 3, expected: [[1, 2, 3], [4]] },
  {
    items: [1, 2, 3, 4, 5, 6],
    size: 3,
    expected: [
      [1, 2, 3],
      [4, 5, 6],
    ],
  },
  { items: [1, 2], size: 5, expected: [[1, 2]] },
  { items: [1, 2], size: 1, expected: [[1], [2]] },
];

test.each(CASES)('chunk - $items.length items by $size', ({ items, size, expected }) => {
  expect(chunk(items, size)).toEqual(expected);
});

test('chunk - keeps order and does not mutate a readonly input', () => {
  const items: readonly number[] = Object.freeze(
    Array.from({ length: IN_LIST_CHUNK_SIZE * 2 + 1 }, (_, index) => index),
  );
  const chunks = chunk(items, IN_LIST_CHUNK_SIZE);
  expect(chunks.map((part) => part.length)).toEqual([IN_LIST_CHUNK_SIZE, IN_LIST_CHUNK_SIZE, 1]);
  expect(chunks.flat()).toEqual([...items]);
});
