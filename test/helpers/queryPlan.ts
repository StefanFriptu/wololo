import type { SQLQueryBindings } from 'bun:sqlite';
import type { TestContext } from './context.ts';

export function queryPlan(context: TestContext, sql: string, params: readonly unknown[] = []): string[] {
  return context.ctx.dbHandle.sqlite
    .query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as SQLQueryBindings[]))
    .map((row) => row.detail);
}
