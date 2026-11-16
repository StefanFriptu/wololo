import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { AppContext } from '../../app/context.ts';
import type { ScanService } from '../../contracts/probe-scan.ts';
import { errorMessage, notFound } from '../../core/errors.ts';
import { yieldToEventLoop } from '../../core/yieldToEventLoop.ts';
import type { ScanRequest, ScanStatus } from '../../shared/api-types.ts';
import type { Library, LibraryRoot, MediaFileKind, MediaFileStatus } from '../../shared/domain.ts';
import type { ScanStats } from '../../shared/events.ts';
import { needsRecheck } from './change-detection.ts';
import { eligibilityRules } from './eligibility.ts';
import { rootDiskInfo } from './libraries.ts';
import { libraryQuery } from './libraryQuery.ts';
import { createMediaEngine, type RulesContext } from './mediaEngine.ts';
import { activeJobMediaIdsQuery, rootEntriesPageQuery, storedEntryQuery } from './mediaQuery.ts';
import { isWithin } from './paths.ts';
import { walkRoot } from './walker.ts';

const PROGRESS_INTERVAL_MS = 1000;
const ENQUEUE_SLICE = 50;
const REMOVAL_PAGE_SIZE = 1000;

type Presence = 'missing' | 'present' | 'unknown';

async function presenceOf(path: string): Promise<Presence> {
  try {
    await stat(path);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
  }
}

/**
 * Pure: may a stored row the walk did not yield be deleted? Only when its path is gone, or when it still exists but the
 * settings now exclude it, unless it carries state a re-add would lose (the user's ignore flag, a disc's conversion).
 */
export function removable(row: { kind: MediaFileKind; status: MediaFileStatus }, presence: Presence): boolean {
  if (presence === 'missing') return true;
  if (presence === 'unknown') return false;
  return row.status !== 'ignored' && row.kind === 'file';
}

function emptyStats(): ScanStats {
  return {
    filesSeen: 0,
    filesNew: 0,
    filesChanged: 0,
    filesRemoved: 0,
    filesProbed: 0,
    probeErrors: 0,
    jobsQueued: 0,
  };
}

export function createScanService(ctx: AppContext): ScanService {
  const log = ctx.logs.logger('scan');
  const engine = createMediaEngine(ctx);
  let status: ScanStatus | null = null;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let lastProgressAt = 0;

  const snapshot = (): ScanStatus | null => (status ? { ...status, stats: { ...status.stats } } : null);

  const progress = (scan: ScanStatus, path: string | null) => {
    scan.currentPath = path;
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    ctx.events.emit('scan.progress', { scanId: scan.scanId, stats: { ...scan.stats }, currentPath: path });
  };

  const enqueueBacklog = async (scan: ScanStatus, rows: { id: number; kind: string; path: string }[]) => {
    if (rows.length === 0 || !ctx.settings.section('processing').enabled) return;
    const active = activeJobMediaIdsQuery(
      ctx.db,
      rows.map((row) => row.id),
    );
    const pending = rows.filter((candidate) => !active.has(candidate.id));
    for (const [position, row] of pending.entries()) {
      if (position > 0 && position % ENQUEUE_SLICE === 0) await yieldToEventLoop();
      try {
        await ctx.services.jobs.enqueue({
          type: row.kind === 'file' ? 'audio' : 'bdmv',
          trigger: 'scan',
          mediaFileId: row.id,
          title: engine.jobTitle(row.path),
        });
        scan.stats.jobsQueued += 1;
      } catch (error) {
        log.error('could not queue a job for a needs-work file', { path: row.path, error: errorMessage(error) });
      }
    }
  };

  const scanRoot = async (
    scan: ScanStatus,
    library: Library,
    root: LibraryRoot,
    rules: RulesContext,
    options: { force: boolean; signal: AbortSignal },
  ): Promise<string | null> => {
    const { accessible } = await rootDiskInfo(root.path);
    if (!accessible) {
      log.warn('library root is not accessible, skipped (rows kept)', { root: root.path });
      return `root ${root.path} is not accessible`;
    }
    const report = { unreadable: [] as string[] };
    const seen = new Set<number>();
    const backlog: { id: number; kind: string; path: string }[] = [];
    const storedAt = (path: string) => storedEntryQuery(ctx.db, { rootId: root.id, path }) ?? null;

    const entries = walkRoot(
      root.path,
      { ...eligibilityRules(ctx.settings.get(), library), signal: options.signal },
      report,
    );
    for await (const entry of entries) {
      if (options.signal.aborted) break;
      scan.stats.filesSeen += 1;
      progress(scan, entry.path);
      const row = storedAt(entry.path);
      if (row) seen.add(row.id);
      if (!needsRecheck(entry, row, rules.rulesKey, options.force)) {
        if (row?.status === 'needs_work') backlog.push({ id: row.id, kind: row.kind, path: row.path });
        continue;
      }
      const { result, probed } = await engine.evaluatePath(
        entry.path,
        { trigger: 'scan' },
        { entry, rules, force: options.force, forceProbe: options.force, signal: options.signal },
      );
      const saved = row ?? storedAt(entry.path);
      if (saved) seen.add(saved.id);
      if (options.signal.aborted) break;
      if (!row) scan.stats.filesNew += 1;
      else if (row.sizeBytes !== entry.sizeBytes || row.mtimeMs !== entry.mtimeMs) scan.stats.filesChanged += 1;
      if (probed) scan.stats.filesProbed += 1;
      if (result.action === 'failed') scan.stats.probeErrors += 1;
      if (result.action === 'queued' && result.jobId !== null) scan.stats.jobsQueued += 1;
    }
    if (options.signal.aborted) return null;

    const candidatePages = function* () {
      let afterId = 0;
      while (true) {
        const page = rootEntriesPageQuery(ctx.db, { rootId: root.id, afterId, limit: REMOVAL_PAGE_SIZE });
        yield page.filter(
          (row) =>
            !seen.has(row.id) &&
            row.status !== 'processing' &&
            !report.unreadable.some((dir) => isWithin(row.path, dir)),
        );
        const last = page.at(-1);
        if (!last || page.length < REMOVAL_PAGE_SIZE) return;
        afterId = last.id;
      }
    };
    const problems: string[] = [];
    const looksEmpty = seen.size === 0 && !options.force;
    const kept = looksEmpty ? [...candidatePages()].reduce((sum, page) => sum + page.length, 0) : 0;
    if (kept > 0) {
      log.warn('library root looks empty, rows kept', { root: root.path, rows: kept });
      problems.push(`root ${root.path} looks empty (not mounted?), kept ${kept} file(s); force scan removes them`);
    } else {
      let unchecked = 0;
      for (const page of candidatePages()) {
        const removed: number[] = [];
        for (const row of page) {
          const presence = await presenceOf(row.path);
          if (presence === 'unknown') unchecked += 1;
          if (removable(row, presence)) removed.push(row.id);
        }
        engine.deleteRows(removed);
        scan.stats.filesRemoved += removed.length;
      }
      if (unchecked > 0) problems.push(`${unchecked} file(s) under ${root.path} could not be checked`);
    }
    await enqueueBacklog(scan, backlog);
    if (report.unreadable.length > 0)
      problems.push(`${report.unreadable.length} folder(s) under ${root.path} unreadable`);
    return problems.length > 0 ? problems.join('; ') : null;
  };

  const run = async (scan: ScanStatus, libraries: Library[], force: boolean, signal: AbortSignal) => {
    const problems: string[] = [];
    for (const library of libraries) {
      if (signal.aborted) break;
      let rules: RulesContext;
      try {
        rules = await engine.rulesFor(library);
      } catch (error) {
        log.error('library skipped: no effective profile', { library: library.name, error: errorMessage(error) });
        problems.push(`${library.name}: ${errorMessage(error)}`);
        continue;
      }
      for (const root of library.roots) {
        if (signal.aborted) break;
        const problem = await scanRoot(scan, library, root, rules, { force, signal });
        if (problem) problems.push(problem);
      }
    }
    if (signal.aborted) return 'cancelled';
    return problems.length > 0 ? problems.join('; ') : null;
  };

  const finish = (scan: ScanStatus, error: string | null) => {
    scan.running = false;
    scan.finishedAt = new Date().toISOString();
    scan.currentPath = null;
    scan.error = error;
    ctx.events.emit('scan.finished', { scanId: scan.scanId, stats: { ...scan.stats }, error });
    log.info('scan finished', { scanId: scan.scanId, ...scan.stats, error });
  };

  const service: ScanService = {
    start: async (request: ScanRequest) => {
      if (status?.running) return snapshot() as ScanStatus;
      const libraries =
        request.libraryId === undefined
          ? libraryQuery(ctx.db).filter((library) => library.enabled)
          : libraryQuery(ctx.db, { id: request.libraryId });
      if (request.libraryId !== undefined && libraries.length === 0) throw notFound(`library ${request.libraryId}`);

      const scan: ScanStatus = {
        scanId: randomUUID(),
        libraryId: request.libraryId ?? null,
        running: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        currentPath: null,
        stats: emptyStats(),
        error: null,
      };
      status = scan;
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ctx.shutdownSignal]);
      lastProgressAt = 0;
      ctx.events.emit('scan.started', { scanId: scan.scanId, libraryId: scan.libraryId });
      log.info('scan started', { scanId: scan.scanId, libraryId: scan.libraryId, force: request.force ?? false });
      running = run(scan, libraries, request.force ?? false, signal)
        .catch((error: unknown) => {
          log.error('scan failed', { scanId: scan.scanId, error: errorMessage(error) });
          return errorMessage(error);
        })
        .then((error) => finish(scan, error));
      return snapshot() as ScanStatus;
    },

    current: snapshot,

    cancel: async () => {
      if (!status?.running) return;
      controller?.abort();
      await running;
    },
  };
  return service;
}
