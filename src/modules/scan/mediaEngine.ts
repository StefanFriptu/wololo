import { basename, extname } from 'node:path';
import { and, eq, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import type { AppContext } from '../../app/context.ts';
import type { CheckAction, CheckResult, DiscoveredEntry, MediaRefs } from '../../contracts/probe-scan.ts';
import { errorMessage, notFound } from '../../core/errors.ts';
import { arrInstances, type MediaFileRow, mediaFiles } from '../../db/schema.ts';
import type {
  ArrItemRef,
  BdmvJobPlan,
  ConversionPlan,
  EffectiveProfile,
  Library,
  MediaFileStatus,
  PlanAction,
  ProbeResult,
} from '../../shared/domain.ts';
import { eligibilityRules, exclusionReason } from './eligibility.ts';
import { statEntry } from './entries.ts';
import { checkActionFor, statusFromPlan, summarizeProbe } from './evaluation.ts';
import { libraryQuery } from './libraryQuery.ts';
import { type MediaSummaryRow, mediaDetailQuery, toSummary } from './mediaQuery.ts';

export interface RulesContext {
  profile: EffectiveProfile;
  rulesKey: string;
}

export interface EvaluateOptions {
  /** Run ffprobe even when size and mtime match the stored probe. */
  forceProbe?: boolean;
  /** Re-evaluate rows that are ignored or being processed (force scans). */
  force?: boolean;
  /** Queue a job when the row needs work and processing is enabled (default true). */
  enqueue?: boolean;
  /** Already stat-ed by the scanner. */
  entry?: DiscoveredEntry;
  /** Precomputed per library by the scanner. */
  rules?: RulesContext;
  /** Apply the scanner's eligibility rules (enabled library, extensions, hidden/temp/recycle-bin paths, ignore globs). */
  screen?: boolean;
  signal?: AbortSignal;
}

export interface EvaluateOutcome {
  result: CheckResult;
  probed: boolean;
}

interface Evaluation {
  status: MediaFileStatus;
  reason: string | null;
  rulesKey: string | null;
  plan: ConversionPlan | null;
  planAction: PlanAction | null;
  failingCodecs: string[];
  decisionId?: number | null;
  probe?: ProbeResult | null;
  bdmvPlan?: BdmvJobPlan | null;
}

function jobTitle(path: string): string {
  return basename(path, extname(path)) || path;
}

function messageFor(action: CheckAction, evaluation: Evaluation): string {
  switch (action) {
    case 'compatible':
      return 'compatible with the profile';
    case 'dry_run':
      return `needs work (dry run): ${evaluation.reason ?? evaluation.planAction ?? 'see plan'}`;
    case 'decision_required':
      return evaluation.reason ?? 'a decision is required';
    default:
      return evaluation.reason ?? action;
  }
}

/**
 * Evaluation shared by media.checkPath, media.reprobe and the scanner. Stateless: every call reads what it needs, so
 * each service may create its own engine.
 */
export function createMediaEngine(ctx: AppContext) {
  const log = ctx.logs.logger('media');

  const rowById = (id: number): MediaFileRow => {
    const row = ctx.db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).get();
    if (!row) throw notFound(`media file ${id}`);
    return row;
  };

  const summaryOf = (id: number) => {
    const row = mediaDetailQuery(ctx.db, { id });
    if (!row) throw notFound(`media file ${id}`);
    return toSummary(row as MediaSummaryRow);
  };

  const emitUpdated = (row: Pick<MediaFileRow, 'id' | 'status' | 'path'>) =>
    ctx.events.emit('media.updated', { mediaFileId: row.id, status: row.status, path: row.path });

  const update = (id: number, values: Partial<typeof mediaFiles.$inferInsert>): MediaFileRow => {
    const row = ctx.db
      .update(mediaFiles)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(mediaFiles.id, id))
      .returning()
      .get();
    if (!row) throw notFound(`media file ${id}`);
    emitUpdated(row);
    return row;
  };

  const rulesFor = async (library: Library): Promise<RulesContext> => {
    const profile = await ctx.services.rules.effectiveProfileForLibrary(library.id);
    return { profile, rulesKey: ctx.services.rules.rulesKey(profile, library) };
  };

  const hasEnabledArr = () =>
    ctx.db.select({ id: arrInstances.id }).from(arrInstances).where(eq(arrInstances.enabled, true)).get() !== undefined;

  const resolveArr = async (row: MediaFileRow, refs: MediaRefs) => {
    let arr: ArrItemRef | null = refs.arr ?? null;
    let language = refs.originalLanguage ?? row.originalLanguage ?? null;
    if (!arr && row.arrInstanceId !== null && row.arrKind !== null && row.arrItemId !== null)
      arr = { instanceId: row.arrInstanceId, kind: row.arrKind, itemId: row.arrItemId, fileId: row.arrFileId };
    if (!arr && row.kind === 'file' && hasEnabledArr()) {
      try {
        const found = await ctx.services.arr.findByPath(row.path);
        if (found) {
          arr = found.ref;
          language ??= found.originalLanguage;
        }
      } catch (error) {
        log.warn('arr lookup failed', { path: row.path, error: errorMessage(error) });
      }
    }
    return { arr, originalLanguage: language };
  };

  const evaluateFile = async (
    row: MediaFileRow,
    library: Library,
    rules: RulesContext,
    originalLanguage: string | null,
    options: { reuseProbe: boolean; signal?: AbortSignal },
  ): Promise<{ evaluation: Evaluation; probed: boolean }> => {
    let probe = options.reuseProbe ? row.probe : null;
    let probed = false;
    if (!probe) {
      try {
        probe = await ctx.services.probe.probe(row.path, { signal: options.signal });
        probed = true;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return {
          probed: true,
          evaluation: {
            status: 'failed',
            reason: `probe failed: ${errorMessage(error)}`,
            rulesKey: null,
            plan: null,
            planAction: null,
            failingCodecs: [],
            probe: null,
          },
        };
      }
    }
    const plan = ctx.services.rules.plan({ probe, profile: rules.profile, library, originalLanguage });
    const { status, reason } = statusFromPlan(plan);
    return {
      probed,
      evaluation: {
        status,
        reason,
        rulesKey: rules.rulesKey,
        plan,
        planAction: plan.action,
        failingCodecs: plan.failingCodecs,
        probe,
      },
    };
  };

  const evaluateDisc = async (row: MediaFileRow, rules: RulesContext): Promise<Evaluation> => {
    const result = await ctx.services.bdmv.evaluate(row.id);
    const audioPlan = result.plan?.audioPlan ?? null;
    const plan =
      audioPlan && result.plan ? { ...audioPlan, estimatedOutputBytes: result.plan.estimatedOutputBytes } : audioPlan;
    const needsWork = result.status === 'needs_work';
    const workAction: PlanAction = plan?.action === 'convert' ? 'convert' : 'remux';
    return {
      status: result.status,
      reason: result.reason,
      rulesKey: rules.rulesKey,
      plan,
      planAction: needsWork ? workAction : result.status === 'compatible' ? 'skip' : (plan?.action ?? null),
      failingCodecs: needsWork ? ['bdmv'] : [],
      decisionId: result.decisionId,
      bdmvPlan: result.plan,
    };
  };

  const persist = (row: MediaFileRow, evaluation: Evaluation, keepStatus: boolean): MediaFileRow => {
    const values: Partial<typeof mediaFiles.$inferInsert> = {
      status: keepStatus ? row.status : evaluation.status,
      statusReason: keepStatus ? row.statusReason : evaluation.reason,
      rulesKey: evaluation.rulesKey,
      plan: evaluation.plan,
      planAction: evaluation.planAction,
      failingCodecs: evaluation.failingCodecs,
    };
    if (evaluation.probe !== undefined) {
      const probe = evaluation.probe;
      const summary = probe
        ? summarizeProbe(probe)
        : { videoCodec: null, audioCodecs: [], streamCodecs: [], subtitleLanguages: [] };
      Object.assign(values, {
        probe,
        durationSec: probe?.durationSec ?? null,
        formatName: probe?.formatName ?? null,
        videoCodec: summary.videoCodec,
        audioCodecs: summary.audioCodecs,
        streamCodecs: summary.streamCodecs,
        subtitleLanguages: summary.subtitleLanguages,
        probedAt: probe?.probedAt ?? row.probedAt,
      });
    }
    return update(row.id, values);
  };

  const enqueue = async (row: MediaFileRow, evaluation: Evaluation, refs: MediaRefs) => {
    const isFile = row.kind === 'file';
    const job = await ctx.services.jobs.enqueue({
      type: isFile ? 'audio' : 'bdmv',
      trigger: refs.trigger,
      mediaFileId: row.id,
      title: jobTitle(row.path),
      plan: isFile ? evaluation.plan : null,
      ...(isFile ? {} : { bdmvPlan: evaluation.bdmvPlan ?? null }),
    });
    return job.id;
  };

  const upsert = (entry: DiscoveredEntry, libraryId: number, rootId: number, existing: MediaFileRow | undefined) => {
    const values = {
      libraryId,
      rootId,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      mtimeMs: Math.trunc(entry.mtimeMs),
    };
    if (existing) return update(existing.id, values);
    const now = new Date().toISOString();
    const row = ctx.db
      .insert(mediaFiles)
      .values({ ...values, path: entry.path, status: 'pending', createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: mediaFiles.path, set: { ...values, updatedAt: now } })
      .returning()
      .get();
    emitUpdated(row);
    return row;
  };

  const outcome = (action: CheckAction, row: MediaFileRow | null, message: string, jobId: number | null = null) => ({
    action,
    mediaFile: row ? summaryOf(row.id) : null,
    jobId,
    message,
  });

  const evaluatePath = async (
    path: string,
    refs: MediaRefs,
    options: EvaluateOptions = {},
  ): Promise<EvaluateOutcome> => {
    const found = await ctx.services.libraries.findRootForPath(path);
    if (!found) return { probed: false, result: outcome('unknown_path', null, `${path} is not inside a library root`) };
    const { library, rootId, rootPath } = found;
    const entry = options.entry ?? (await statEntry(path));
    const existing = ctx.db.select().from(mediaFiles).where(eq(mediaFiles.path, path)).get();
    if (!entry) {
      if (existing && existing.status !== 'ignored' && existing.status !== 'processing')
        update(existing.id, { status: 'failed', statusReason: 'file not found' });
      return { probed: false, result: outcome('failed', existing ?? null, `${path} is missing or not a media file`) };
    }
    if (entry.kind !== 'file' && !(library.bdmvEnabled && ctx.settings.section('bdmv').enabled))
      return { probed: false, result: outcome('ignored', existing ?? null, 'disc handling is disabled') };
    if (entry.kind === 'file' && library.discsOnly)
      return { probed: false, result: outcome('ignored', existing ?? null, 'library only converts discs') };
    if (options.screen) {
      const excluded = library.enabled
        ? exclusionReason(rootPath, path, entry.kind, eligibilityRules(ctx.settings.get(), library))
        : 'library is disabled';
      if (excluded) return { probed: false, result: outcome('ignored', existing ?? null, `not checked: ${excluded}`) };
    }
    if (existing?.status === 'processing' && !options.force)
      return {
        probed: false,
        result: outcome('queued', existing, 'a job is processing this file', existing.lastJobId),
      };

    const unchanged =
      existing !== undefined &&
      existing.sizeBytes === entry.sizeBytes &&
      Math.trunc(existing.mtimeMs) === Math.trunc(entry.mtimeMs) &&
      existing.kind === entry.kind;
    const row = upsert(entry, library.id, rootId, existing);
    const keepStatus = row.status === 'ignored' || row.status === 'processing';
    const { arr, originalLanguage } = await resolveArr(row, refs);
    if (arr || originalLanguage !== row.originalLanguage) {
      update(row.id, {
        originalLanguage,
        arrInstanceId: arr?.instanceId ?? row.arrInstanceId,
        arrKind: arr?.kind ?? row.arrKind,
        arrItemId: arr?.itemId ?? row.arrItemId,
        arrFileId: arr?.fileId ?? row.arrFileId,
      });
    }

    let evaluation: Evaluation;
    let probed = false;
    try {
      const rules = options.rules ?? (await rulesFor(library));
      if (row.kind === 'file') {
        const file = await evaluateFile(row, library, rules, originalLanguage, {
          reuseProbe: unchanged && !options.forceProbe,
          signal: options.signal,
        });
        evaluation = file.evaluation;
        probed = file.probed;
      } else {
        evaluation = await evaluateDisc(row, rules);
      }
    } catch (error) {
      if (options.signal?.aborted) {
        const restored = existing
          ? update(row.id, { sizeBytes: existing.sizeBytes, mtimeMs: existing.mtimeMs, kind: existing.kind })
          : row;
        return { probed, result: outcome('failed', restored, 'check cancelled') };
      }
      log.error('evaluation failed', { path, error: errorMessage(error) });
      const failed = keepStatus
        ? row
        : update(row.id, { status: 'failed', statusReason: errorMessage(error), rulesKey: null });
      return { probed, result: outcome('failed', failed, `evaluation failed: ${errorMessage(error)}`) };
    }

    const saved = persist(row, evaluation, keepStatus);
    if (evaluation.status === 'failed' && evaluation.planAction === null)
      log.warn('file could not be evaluated', { path, reason: evaluation.reason });
    if (keepStatus) return { probed, result: outcome(checkActionFor(saved.status), saved, `file is ${saved.status}`) };
    if (evaluation.decisionId != null)
      return { probed, result: outcome('decision_required', saved, messageFor('decision_required', evaluation)) };

    const wantsJob = saved.status === 'needs_work' && (options.enqueue ?? true);
    if (wantsJob && ctx.settings.section('processing').enabled) {
      try {
        const jobId = await enqueue(saved, evaluation, refs);
        return { probed, result: outcome('queued', saved, `queued job ${jobId}`, jobId) };
      } catch (error) {
        log.error('could not queue a job', { path, error: errorMessage(error) });
        return { probed, result: outcome('failed', saved, `could not queue a job: ${errorMessage(error)}`) };
      }
    }
    const action = checkActionFor(saved.status);
    return { probed, result: outcome(action, saved, messageFor(action, evaluation)) };
  };

  /** Marks rows whose rules key differs from the library's current one as pending. */
  const invalidateLibrary = async (library: Library): Promise<number> => {
    const { rulesKey } = await rulesFor(library);
    const changed = ctx.db
      .update(mediaFiles)
      .set({
        status: 'pending',
        statusReason: 'rules changed, waiting for re-check',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(mediaFiles.libraryId, library.id),
          notInArray(mediaFiles.status, ['ignored', 'processing', 'pending']),
          or(isNull(mediaFiles.rulesKey), ne(mediaFiles.rulesKey, rulesKey)),
        ),
      )
      .returning({ id: mediaFiles.id, status: mediaFiles.status, path: mediaFiles.path })
      .all();
    for (const row of changed) emitUpdated(row);
    return changed.length;
  };

  const librariesForProfile = (profileId: number | undefined, libraryId: number | undefined): Library[] => {
    const all = libraryQuery(ctx.db, libraryId === undefined ? {} : { id: libraryId });
    if (profileId === undefined) return all;
    return all.filter((library) => library.profileIds.length === 0 || library.profileIds.includes(profileId));
  };

  const deleteRows = (ids: readonly number[]) => {
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      ctx.db.delete(mediaFiles).where(inArray(mediaFiles.id, chunk)).run();
      for (const id of chunk) ctx.events.emit('media.removed', { mediaFileId: id });
    }
  };

  return {
    rowById,
    summaryOf,
    update,
    rulesFor,
    evaluatePath,
    invalidateLibrary,
    librariesForProfile,
    deleteRows,
    jobTitle,
  };
}

export type MediaEngine = ReturnType<typeof createMediaEngine>;
