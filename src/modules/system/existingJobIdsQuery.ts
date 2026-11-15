import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { jobs } from '../../db/schema.ts';

export const JOB_ID_CHUNK_SIZE = 500;

/** One query per chunk of ids; together they return the ids that still have a jobs row. */
export function existingJobIdsQuery(db: Db, ids: readonly number[]) {
  const queries = [];
  for (let start = 0; start < ids.length; start += JOB_ID_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + JOB_ID_CHUNK_SIZE);
    queries.push(db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, chunk)));
  }
  return queries;
}
