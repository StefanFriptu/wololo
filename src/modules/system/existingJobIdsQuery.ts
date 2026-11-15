import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { jobs } from '../../db/schema.ts';

const CHUNK_SIZE = 500;

/** The subset of ids that still have a jobs row. */
export function existingJobIdsQuery(db: Db, ids: readonly number[]): Set<number> {
  const existing = new Set<number>();
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    const chunk = ids.slice(start, start + CHUNK_SIZE);
    for (const row of db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, chunk)).all()) existing.add(row.id);
  }
  return existing;
}
