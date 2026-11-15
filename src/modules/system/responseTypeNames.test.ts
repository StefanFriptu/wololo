import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_ROUTE_META } from '../../shared/api-routes.ts';
import { RESPONSE_TYPE_NAMES } from './responseTypeNames.ts';
import { typeExpressionSchema } from './typeExpressionSchema.ts';

function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error('unbalanced braces in api-types.ts');
}

function declaredResponseTypes(): Map<string, string> {
  const source = readFileSync(join(import.meta.dir, '..', '..', 'shared', 'api-types.ts'), 'utf8');
  const start = source.indexOf('{', source.indexOf('export interface ApiRoutes {'));
  const body = source.slice(start + 1, closingBrace(source, start));
  const declared = new Map<string, string>();
  for (const match of body.matchAll(/'([A-Z]+ [^']+)':\s*\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const entry = body.slice(open + 1, closingBrace(body, open)).replace(/\{[^{}]*\}/g, 'inline');
    const response = /response:\s*([^;]+?);?\s*$/.exec(entry.trim())?.[1];
    if (response) declared.set(match[1] as string, response.trim());
  }
  return declared;
}

test('RESPONSE_TYPE_NAMES - matches every response type declared in ApiRoutes', () => {
  const declared = declaredResponseTypes();
  expect(declared.size).toBe(Object.keys(API_ROUTE_META).length);
  expect(Object.fromEntries(declared)).toEqual({ ...RESPONSE_TYPE_NAMES });
});

test('RESPONSE_TYPE_NAMES - every JSON response type expression is understood by the OpenAPI generator', () => {
  const jsonRoutes = Object.entries(API_ROUTE_META).filter(([, meta]) => meta.responseType === 'json');
  expect(jsonRoutes.length).toBeGreaterThan(0);
  for (const [key] of jsonRoutes) {
    expect(() => typeExpressionSchema(RESPONSE_TYPE_NAMES[key as keyof typeof RESPONSE_TYPE_NAMES])).not.toThrow();
  }
});
