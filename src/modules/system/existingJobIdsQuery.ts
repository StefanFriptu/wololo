import { inArray } from 'drizzle-orm';
import { chunk, IN_LIST_CHUNK_SIZE } from '../../core/chunk.ts';
import type { Db } from '../../db/client.ts';
import { jobs } from '../../db/schema.ts';

/** One query per chunk of ids; together they return the ids that still have a jobs row. */
export function existingJobIdsQuery(db: Db, ids: readonly number[]) {
  const queries = [];
  for (const part of chunk(ids, IN_LIST_CHUNK_SIZE)) {
    queries.push(db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, part)));
  }
  return queries;
}
