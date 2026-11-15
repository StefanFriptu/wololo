import { expect, test } from 'bun:test';
import { typeExpressionSchema } from './typeExpressionSchema.ts';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

test.each([
  ['SystemStatus', ref('SystemStatus'), ['SystemStatus']],
  ['HealthCheck[]', { type: 'array', items: ref('HealthCheck') }, ['HealthCheck']],
  ['string', { type: 'string' }, []],
  ['Blob', { type: 'string', contentMediaType: 'application/octet-stream' }, []],
  ['ScanStatus | null', { anyOf: [ref('ScanStatus'), { type: 'null' }] }, ['ScanStatus']],
  ['Record<string, unknown>', { type: 'object', additionalProperties: {} }, []],
  ['Array<Library>', { type: 'array', items: ref('Library') }, ['Library']],
  ['Foo[][]', { type: 'array', items: { type: 'array', items: ref('Foo') } }, ['Foo']],
  ['  Library  ', ref('Library'), ['Library']],
])('typeExpressionSchema - %p', (expression, schema, refs) => {
  expect(typeExpressionSchema(expression)).toEqual({ schema, refs });
});

test('typeExpressionSchema - Paginated<T> becomes a page object with typed items', () => {
  const { schema, refs } = typeExpressionSchema('Paginated<JobSummary>');
  expect(refs).toEqual(['JobSummary']);
  expect(schema).toMatchObject({
    type: 'object',
    required: ['page', 'pageSize', 'total', 'items'],
    properties: { items: { type: 'array', items: ref('JobSummary') } },
  });
});

test('typeExpressionSchema - refs are deduplicated and sorted', () => {
  expect(typeExpressionSchema('B | A | B[]').refs).toEqual(['A', 'B']);
});

test.each(['', 'Foo<', 'Foo>', 'Map<string, number>', 'Foo | ', '{ a: string }', 'Foo Bar', 'Foo[x]'])(
  'typeExpressionSchema - rejects %p',
  (expression) => {
    expect(() => typeExpressionSchema(expression)).toThrow();
  },
);
