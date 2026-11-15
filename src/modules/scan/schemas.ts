import { z } from 'zod';
import { DEFAULT_TASK_INTERVALS } from '../../contracts/probe-scan.ts';
import type {
  DryRunQuery,
  FilesystemQuery,
  LibraryInput,
  MediaIgnoreBody,
  MediaQuery,
  ScanRequest,
  TaskUpdate,
} from '../../shared/api-types.ts';
import {
  LIBRARY_KINDS,
  LIBRARY_MODES,
  MEDIA_FILE_KINDS,
  MEDIA_FILE_STATUSES,
  type MediaFileStatus,
  type TaskName,
} from '../../shared/domain.ts';

const id = z.coerce.number().int().positive();
const queryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

export const LibraryInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(LIBRARY_KINDS),
  enabled: z.boolean().optional(),
  roots: z.array(z.string().trim().min(1)).min(1).max(50),
  profileIds: z.array(z.number().int().positive()).max(20),
  mode: z.enum(LIBRARY_MODES).optional(),
  keepLanguages: z.array(z.string().trim().min(1)).max(50).optional(),
  keepOriginalLanguage: z.boolean().optional(),
  keepUndetermined: z.boolean().optional(),
  fillMissingLanguage: z.string().trim().min(1).optional(),
  arrInstanceId: z.number().int().positive().nullable().optional(),
  bdmvEnabled: z.boolean().optional(),
}) satisfies z.ZodType<LibraryInput>;

export const FilesystemQuerySchema = z.object({
  path: z.string().min(1).optional(),
  includeFiles: queryBoolean.optional(),
}) satisfies z.ZodType<FilesystemQuery, unknown>;

const STATUS_SET: ReadonlySet<string> = new Set(MEDIA_FILE_STATUSES);

export const MediaQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sortDir: z.enum(['asc', 'desc']).optional(),
  sortKey: z.enum(['path', 'size', 'status', 'updatedAt', 'duration']).optional(),
  status: z
    .string()
    .refine(
      (value) =>
        value
          .split(',')
          .map((part) => part.trim())
          .every((part) => STATUS_SET.has(part)),
      { message: `expected one or more of ${MEDIA_FILE_STATUSES.join(', ')}` },
    )
    .optional(),
  libraryId: id.optional(),
  profileId: id.optional(),
  codec: z.string().trim().min(1).optional(),
  failingCodec: z.string().trim().min(1).optional(),
  kind: z.enum(MEDIA_FILE_KINDS).optional(),
  search: z.string().trim().min(1).optional(),
}) satisfies z.ZodType<MediaQuery, unknown>;

export function parseStatusList(value: string | undefined): MediaFileStatus[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is MediaFileStatus => STATUS_SET.has(part));
}

export const MediaStatsQuerySchema = z.object({ libraryId: id.optional() });

export const MediaIgnoreBodySchema = z.object({ ignored: z.boolean() }) satisfies z.ZodType<MediaIgnoreBody>;

export const ScanRequestSchema = z.object({
  libraryId: z.number().int().positive().optional(),
  force: z.boolean().optional(),
}) satisfies z.ZodType<ScanRequest>;

export const DryRunQuerySchema = z.object({
  libraryId: id.optional(),
  profileId: id.optional(),
}) satisfies z.ZodType<DryRunQuery, unknown>;

const TASK_NAMES = Object.keys(DEFAULT_TASK_INTERVALS) as [TaskName, ...TaskName[]];

export const TaskParamsSchema = z.object({ name: z.enum(TASK_NAMES) });

export const TaskUpdateSchema = z.object({
  intervalMinutes: z.number().int().min(1).max(525_600).optional(),
  enabled: z.boolean().optional(),
}) satisfies z.ZodType<TaskUpdate>;
