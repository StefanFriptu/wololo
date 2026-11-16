import { expect, test } from 'bun:test';
import { z } from 'zod';
import { zodTreeMessages } from './zodTreeMessages.ts';

test('zodTreeMessages - lists nested and array leaf errors', () => {
  const tree = {
    errors: ['root problem'],
    properties: {
      name: { errors: ['Too small'] },
      definition: {
        errors: [],
        properties: { audio: { errors: [], properties: { targetCodec: { errors: ['not allowed'] } } } },
      },
      languages: { errors: [], items: [undefined, { errors: ['bad code'] }] },
    },
  };
  expect(zodTreeMessages(tree)).toEqual([
    'root problem',
    'name: Too small',
    'definition.audio.targetCodec: not allowed',
    'languages.1: bad code',
  ]);
});

test('zodTreeMessages - reads a real treeifyError tree', () => {
  const schema = z.object({ name: z.string().min(1), tags: z.array(z.string()) });
  const result = schema.safeParse({ name: '', tags: ['ok', 3] });
  if (result.success) throw new Error('expected a validation failure');
  const messages = zodTreeMessages(z.treeifyError(result.error));
  expect(messages).toHaveLength(2);
  expect(messages[0]).toStartWith('name: ');
  expect(messages[1]).toStartWith('tags.1: ');
});

test.each([[undefined], [null], ['text'], [{ message: 'x' }], [{ errors: 'x' }]])(
  'zodTreeMessages - %p is not a tree and yields nothing',
  (details) => {
    expect(zodTreeMessages(details)).toEqual([]);
  },
);
