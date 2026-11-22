import { constants } from 'node:fs';
import { access, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { and, eq, inArray, notInArray, or } from 'drizzle-orm';
import type { AppContext } from '../../app/context.ts';
import type { LibraryService } from '../../contracts/probe-scan.ts';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import type { Db } from '../../db/client.ts';
import {
  arrInstances,
  deviceProfiles,
  jobs,
  libraries,
  libraryProfiles,
  libraryRoots,
  mediaFiles,
} from '../../db/schema.ts';
import type { FilesystemEntry, FilesystemListing, FilesystemQuery, LibraryInput } from '../../shared/api-types.ts';
import { ACTIVE_JOB_STATES, type Library, type LibraryRoot, type LibraryRuleSettings } from '../../shared/domain.ts';
import { normalizeLanguage } from '../../shared/language.ts';
import { allRootsQuery, libraryQuery } from './libraryQuery.ts';
import { matchRoot, normalizeRootPath, rootsOverlap } from './paths.ts';

export async function rootDiskInfo(path: string): Promise<Pick<LibraryRoot, 'freeBytes' | 'accessible' | 'writable'>> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) return { freeBytes: null, accessible: false, writable: false };
  const [fs, writable] = await Promise.all([
    statfs(path).catch(() => null),
    access(path, constants.W_OK | constants.X_OK).then(
      () => true,
      () => false,
    ),
  ]);
  return { freeBytes: fs ? Number(fs.bavail) * Number(fs.bsize) : null, accessible: true, writable };
}

async function withDiskInfo(library: Library): Promise<Library> {
  const roots = await Promise.all(library.roots.map(async (root) => ({ ...root, ...(await rootDiskInfo(root.path)) })));
  return { ...library, roots };
}

function normalizeLanguages(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const code = normalizeLanguage(value);
    if (code === null) throw new AppError('validation', `unknown language: ${value}`);
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

function normalizeFillLanguage(value: string): string {
  if (value === 'off' || value === 'original') return value;
  const code = normalizeLanguage(value);
  if (code === null) throw new AppError('validation', `unknown language for fillMissingLanguage: ${value}`);
  return code;
}

function normalizeRoots(paths: readonly string[]): string[] {
  const roots: string[] = [];
  for (const path of paths) {
    const root = normalizeRootPath(path);
    if (root === null) throw new AppError('validation', `root must be an absolute path: ${path}`);
    const clash = roots.find((other) => rootsOverlap(root, other));
    if (clash) throw new AppError('validation', `roots overlap: ${clash} and ${root}`);
    roots.push(root);
  }
  return roots;
}

interface ResolvedInput extends LibraryRuleSettings {
  name: string;
  kind: Library['kind'];
  enabled: boolean;
  roots: string[];
  profileIds: number[];
  arrInstanceId: number | null;
  bdmvEnabled: boolean;
  discsOnly: boolean;
}

function resolveInput(input: LibraryInput, existing: Library | null): ResolvedInput {
  return {
    name: input.name.trim(),
    kind: input.kind,
    enabled: input.enabled ?? existing?.enabled ?? true,
    roots: normalizeRoots(input.roots),
    profileIds: [...new Set(input.profileIds)],
    mode: input.mode ?? existing?.mode ?? 'replace',
    keepLanguages: normalizeLanguages(input.keepLanguages ?? existing?.keepLanguages ?? []),
    keepOriginalLanguage: input.keepOriginalLanguage ?? existing?.keepOriginalLanguage ?? true,
    keepUndetermined: input.keepUndetermined ?? existing?.keepUndetermined ?? true,
    fillMissingLanguage: normalizeFillLanguage(input.fillMissingLanguage ?? existing?.fillMissingLanguage ?? 'off'),
    arrInstanceId: input.arrInstanceId === undefined ? (existing?.arrInstanceId ?? null) : input.arrInstanceId,
    bdmvEnabled: input.bdmvEnabled ?? existing?.bdmvEnabled ?? true,
    discsOnly: input.discsOnly ?? existing?.discsOnly ?? false,
  };
}

function assertReferences(db: Db, input: ResolvedInput, libraryId: number | null): void {
  if (input.discsOnly && !input.bdmvEnabled)
    throw new AppError('validation', 'a library that only converts discs needs Blu-ray conversion turned on');
  const sameName = db.select({ id: libraries.id }).from(libraries).where(eq(libraries.name, input.name)).get();
  if (sameName && sameName.id !== libraryId) throw new AppError('conflict', `a library named "${input.name}" exists`);

  const otherRoots = allRootsQuery(db).filter((root) => root.libraryId !== libraryId);
  for (const root of input.roots) {
    const clash = otherRoots.find((other) => rootsOverlap(root, other.path));
    if (clash) throw new AppError('conflict', `root ${root} overlaps ${clash.path} of another library`);
  }

  if (input.profileIds.length > 0) {
    const found = db
      .select({ id: deviceProfiles.id })
      .from(deviceProfiles)
      .where(inArray(deviceProfiles.id, input.profileIds))
      .all();
    const missing = input.profileIds.filter((id) => !found.some((row) => row.id === id));
    if (missing.length > 0) throw new AppError('validation', `unknown profile ids: ${missing.join(', ')}`);
  }

  if (input.arrInstanceId !== null) {
    const arr = db.select({ id: arrInstances.id }).from(arrInstances).where(eq(arrInstances.id, input.arrInstanceId));
    if (!arr.get()) throw new AppError('validation', `unknown arr instance id: ${input.arrInstanceId}`);
  }
}

function rulesChanged(before: Library, after: ResolvedInput): boolean {
  const pick = (value: LibraryRuleSettings & { profileIds: number[] }) =>
    JSON.stringify([
      [...value.profileIds].sort((a, b) => a - b),
      value.mode,
      value.keepLanguages,
      value.keepOriginalLanguage,
      value.keepUndetermined,
      value.fillMissingLanguage,
    ]);
  return pick(before) !== pick(after);
}

function libraryValues(input: ResolvedInput) {
  return {
    name: input.name,
    kind: input.kind,
    enabled: input.enabled,
    mode: input.mode,
    keepLanguages: input.keepLanguages,
    keepOriginalLanguage: input.keepOriginalLanguage,
    keepUndetermined: input.keepUndetermined,
    fillMissingLanguage: input.fillMissingLanguage,
    arrInstanceId: input.arrInstanceId,
    bdmvEnabled: input.bdmvEnabled,
    discsOnly: input.discsOnly,
  };
}

async function listDirectory(query: FilesystemQuery): Promise<FilesystemListing> {
  const path = resolve(query.path ?? '/');
  const info = await stat(path).catch(() => null);
  if (!info) throw notFound(`directory ${path}`);
  if (!info.isDirectory()) throw new AppError('validation', `${path} is not a directory`);
  const dirents = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    throw new AppError('unprocessable', `cannot read ${path}: ${errorMessage(error)}`);
  });
  const entries: FilesystemEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    const full = join(path, dirent.name);
    const target = dirent.isSymbolicLink() ? await stat(full).catch(() => null) : null;
    const isDir = dirent.isDirectory() || (target?.isDirectory() ?? false);
    const isFile = dirent.isFile() || (target?.isFile() ?? false);
    if (isDir) entries.push({ name: dirent.name, path: full, type: 'dir', sizeBytes: null });
    else if (isFile && query.includeFiles) {
      const size = target?.size ?? (await stat(full).catch(() => null))?.size ?? null;
      entries.push({ name: dirent.name, path: full, type: 'file', sizeBytes: size });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, entries };
}

export function createLibraryService(ctx: AppContext): LibraryService {
  const log = ctx.logs.logger('libraries');

  const load = (id: number): Library => {
    const [library] = libraryQuery(ctx.db, { id });
    if (!library) throw notFound(`library ${id}`);
    return library;
  };

  const invalidate = async (libraryId: number) => {
    try {
      const count = await ctx.services.media.invalidateRules({ libraryId });
      if (count > 0) log.info('library rules changed, files marked for re-check', { libraryId, count });
    } catch (error) {
      log.error('could not re-check files after a library edit', { libraryId, error: errorMessage(error) });
    }
  };

  const service: LibraryService = {
    list: async () => Promise.all(libraryQuery(ctx.db).map(withDiskInfo)),

    get: async (id) => withDiskInfo(load(id)),

    create: async (input) => {
      const resolved = resolveInput(input, null);
      assertReferences(ctx.db, resolved, null);
      const now = new Date().toISOString();
      const id = ctx.db.transaction((tx) => {
        const row = tx
          .insert(libraries)
          .values({ ...libraryValues(resolved), createdAt: now, updatedAt: now })
          .returning({ id: libraries.id })
          .get();
        for (const path of resolved.roots) tx.insert(libraryRoots).values({ libraryId: row.id, path }).run();
        for (const profileId of resolved.profileIds)
          tx.insert(libraryProfiles).values({ libraryId: row.id, profileId }).run();
        return row.id;
      });
      log.info('library created', { libraryId: id, name: resolved.name, roots: resolved.roots });
      return service.get(id);
    },

    update: async (id, input) => {
      const before = load(id);
      const resolved = resolveInput(input, before);
      assertReferences(ctx.db, resolved, id);
      ctx.db.transaction((tx) => {
        tx.update(libraries)
          .set({ ...libraryValues(resolved), updatedAt: new Date().toISOString() })
          .where(eq(libraries.id, id))
          .run();
        tx.delete(libraryRoots)
          .where(and(eq(libraryRoots.libraryId, id), notInArray(libraryRoots.path, resolved.roots)))
          .run();
        const kept = new Set(before.roots.map((root) => root.path));
        for (const path of resolved.roots.filter((root) => !kept.has(root)))
          tx.insert(libraryRoots).values({ libraryId: id, path }).run();
        tx.delete(libraryProfiles).where(eq(libraryProfiles.libraryId, id)).run();
        for (const profileId of resolved.profileIds)
          tx.insert(libraryProfiles).values({ libraryId: id, profileId }).run();
      });
      if (rulesChanged(before, resolved)) await invalidate(id);
      return service.get(id);
    },

    remove: async (id) => {
      load(id);
      const libraryMedia = ctx.db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.libraryId, id));
      const active = ctx.db
        .select({ id: jobs.id, state: jobs.state })
        .from(jobs)
        .where(
          and(
            or(eq(jobs.libraryId, id), inArray(jobs.mediaFileId, libraryMedia)),
            inArray(jobs.state, [...ACTIVE_JOB_STATES]),
          ),
        )
        .all();
      const running = active.find((job) => job.state === 'running');
      if (running) throw new AppError('conflict', `job ${running.id} is running for this library`);
      for (const job of active) {
        try {
          await ctx.services.jobs.cancel(job.id);
        } catch (error) {
          throw new AppError('conflict', `could not cancel queued job ${job.id}: ${errorMessage(error)}`);
        }
      }
      ctx.db.delete(libraries).where(eq(libraries.id, id)).run();
      log.info('library removed', { libraryId: id });
    },

    findRootForPath: async (path) => {
      const normalized = normalizeRootPath(path);
      if (normalized === null) return null;
      const root = matchRoot(normalized, allRootsQuery(ctx.db));
      if (!root) return null;
      return { library: load(root.libraryId), rootId: root.id, rootPath: root.path };
    },

    browse: listDirectory,
  };
  return service;
}
